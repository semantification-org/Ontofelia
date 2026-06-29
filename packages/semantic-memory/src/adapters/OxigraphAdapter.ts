import { TriplestoreAdapter, TriplestoreConfig, SparqlResult, RdfFormat, Triple, HealthResult } from '@ontofelia/core';
import oxigraph from 'oxigraph';
import * as fs from 'fs/promises';
import { existsSync } from 'fs';
import * as path from 'path';
import * as os from 'os';

/**
 * Adapter for the embedded Oxigraph triplestore.
 *
 * NOTE: The `oxigraph` npm package (0.5.x) is a WebAssembly build whose
 * `Store` is purely in-memory — it has no on-disk RocksDB store and no
 * `Store.backup()`. The constructor signature is `new Store(quads?)`, so
 * passing a directory path (as an older API allowed) makes the WASM layer
 * treat the string as an iterable and throws `Reflect.get called on
 * non-object`.
 *
 * To still provide persistence we serialise the whole dataset to an
 * N-Quads file inside `dataDir` and reload it on startup. Every mutating
 * operation flushes back to that file.
 */
export class OxigraphAdapter implements TriplestoreAdapter {
  readonly backend = 'oxigraph';
  status: 'stopped' | 'starting' | 'running' | 'error' = 'stopped';
  private config!: TriplestoreConfig;
  private store!: oxigraph.Store;
  private dataDir!: string;
  private dataFile!: string;

  /** Serialised N-Quads format string understood by oxigraph. */
  private static readonly NQUADS_MIME = 'application/n-quads';

  async initialize(config: TriplestoreConfig): Promise<void> {
    this.config = config;

    // Replace ~ with home directory if needed
    let dataDir = this.config.dataDir;
    if (dataDir.startsWith('~')) {
      dataDir = dataDir.replace('~', os.homedir());
    }
    this.dataDir = dataDir;
    this.dataFile = path.join(dataDir, 'dataset.nq');

    // Ensure directory exists
    await fs.mkdir(dataDir, { recursive: true });

    // Initialize embedded (in-memory) store
    this.store = new oxigraph.Store();

    // Rehydrate from the persisted dataset if one exists
    if (existsSync(this.dataFile)) {
      try {
        const data = await fs.readFile(this.dataFile, 'utf-8');
        if (data.trim().length > 0) {
          this.store.load(data, { format: OxigraphAdapter.NQUADS_MIME });
        }
      } catch (e) {
        throw new Error(`Failed to load persisted Oxigraph dataset: ${(e as Error).message}`);
      }
    }

    this.status = 'running';
  }

  /** Serialise the full dataset back to disk. */
  private async flush(): Promise<void> {
    try {
      const nquads = this.store.dump({ format: OxigraphAdapter.NQUADS_MIME });
      // Atomic write: write to a temp file then rename
      const tmp = `${this.dataFile}.tmp`;
      await fs.writeFile(tmp, nquads, 'utf-8');
      await fs.rename(tmp, this.dataFile);
    } catch (e) {
      throw new Error(`Failed to persist Oxigraph dataset: ${(e as Error).message}`);
    }
  }

  async start(): Promise<void> {
    this.status = 'running';
  }

  async stop(): Promise<void> {
    // Persist on shutdown; the in-memory store is otherwise lost.
    if (this.status === 'running') {
      await this.flush();
    }
    this.status = 'stopped';
  }

  async healthCheck(): Promise<HealthResult> {
    return {
      healthy: this.status === 'running',
      component: 'OxigraphAdapter',
      checkedAt: new Date().toISOString()
    };
  }

  async query(sparql: string, _namedGraph?: string): Promise<SparqlResult> {
    try {
      const result = this.store.query(sparql);

      // oxigraph returns: boolean (ASK), Map<string,Term>[] (SELECT) or
      // Quad[] (CONSTRUCT/DESCRIBE). Both SELECT and CONSTRUCT are arrays,
      // so distinguish by the row type: SELECT rows are Map, CONSTRUCT rows
      // are Quad objects (which expose a `subject` field).
      if (typeof result === 'boolean') {
        return { type: 'boolean', boolean: result };
      }

      const isBindings = Array.isArray(result) &&
        (result.length === 0 || result[0] instanceof Map);

      if (isBindings) {
        const rows = result as Map<string, import('oxigraph').Term>[];
        let variables: string[] = [];
        if (rows.length > 0) {
          variables = [...rows[0].keys()];
        }

        const bindings = rows.map(row => {
          const bindingObj: Record<string, import('@ontofelia/core').RdfTerm> = {};
          for (const [key, value] of row.entries()) {
            if (value.termType === 'NamedNode') {
              bindingObj[key] = { type: 'uri', value: value.value };
            } else if (value.termType === 'Literal') {
              bindingObj[key] = { type: 'literal', value: value.value, language: value.language, datatype: value.datatype?.value };
            } else if (value.termType === 'BlankNode') {
              bindingObj[key] = { type: 'bnode', value: value.value };
            }
          }
          return bindingObj;
        });

        return {
          type: 'bindings',
          variables,
          bindings
        };
      }
      // CONSTRUCT or DESCRIBE — an array of Quads
      {
        // Format to Turtle
        let graphStr = '';
        type RdfTerm = { termType: string; value: string; language?: string; datatype?: { value: string } };
        type RdfQuad = { subject: RdfTerm; predicate: RdfTerm; object: RdfTerm };
        for (const quad of (result as Iterable<RdfQuad>)) {
            const subject = quad.subject.termType === 'NamedNode' ? `<${quad.subject.value}>` : `_:${quad.subject.value}`;
            const predicate = `<${quad.predicate.value}>`;
            const object = quad.object.termType === 'NamedNode' ? `<${quad.object.value}>` :
                           quad.object.termType === 'Literal' ? `"${quad.object.value.replace(/"/g, '\\"')}"` + (quad.object.language ? `@${quad.object.language}` : (quad.object.datatype && quad.object.datatype.value !== 'http://www.w3.org/2001/XMLSchema#string' ? `^^<${quad.object.datatype.value}>` : '')) :
                           `_:${quad.object.value}`;
            graphStr += `${subject} ${predicate} ${object} .\n`;
        }
        return { type: 'graph', graph: graphStr };
      }
    } catch (e) {
      throw new Error(`SPARQL Query failed in Oxigraph: ${(e as Error).message}`);
    }
  }

  async update(sparql: string): Promise<void> {
    try {
      this.store.update(sparql);
      await this.flush();
    } catch (e) {
      throw new Error(`SPARQL Update failed in Oxigraph: ${(e as Error).message}`);
    }
  }

  async getGraph(graphUri: string, _format: RdfFormat = 'turtle'): Promise<string> {
    // Construct query for a single graph
    const sparql = `CONSTRUCT { ?s ?p ?o } WHERE { GRAPH <${graphUri}> { ?s ?p ?o } }`;
    const result = await this.query(sparql);
    return result.graph || '';
  }

  async putGraph(graphUri: string, data: string, format: RdfFormat = 'turtle'): Promise<void> {
    const mime = format === 'jsonld' ? 'application/ld+json' :
                 format === 'ntriples' ? 'application/n-triples' :
                 format === 'rdfxml' ? 'application/rdf+xml' : 'text/turtle';

    try {
      const graphNode = oxigraph.namedNode(graphUri);
      this.store.load(data, { format: mime, to_graph_name: graphNode });
      await this.flush();
    } catch (e) {
      throw new Error(`putGraph failed in Oxigraph: ${(e as Error).message}`);
    }
  }

  async deleteGraph(graphUri: string): Promise<void> {
    const sparql = `CLEAR GRAPH <${graphUri}>`;
    await this.update(sparql);
  }

  private formatObject(obj: Triple['object']): string {
    if (typeof obj === 'string') {
      if (obj.startsWith('http://') || obj.startsWith('https://') || obj.startsWith('urn:')) {
        return `<${obj}>`;
      }
      return `"${obj.replace(/"/g, '\\"')}"`;
    }

    if (obj.type === 'uri') {
      return `<${obj.value}>`;
    }

    let literal = `"${obj.value.replace(/"/g, '\\"')}"`;
    if (obj.language) {
      literal += `@${obj.language}`;
    }
    return literal;
  }

  async insertTriples(graphUri: string, triples: Triple[]): Promise<void> {
    if (triples.length === 0) return;

    const lines = triples.map(t => {
      const s = t.subject.startsWith('_:') ? t.subject : `<${t.subject}>`;
      const p = `<${t.predicate}>`;
      const o = this.formatObject(t.object);
      return `${s} ${p} ${o} .`;
    }).join('\n');

    const sparql = `INSERT DATA { GRAPH <${graphUri}> { ${lines} } }`;
    await this.update(sparql);
  }

  async deleteTriples(graphUri: string, triples: Triple[]): Promise<void> {
    if (triples.length === 0) return;

    const lines = triples.map(t => {
      const s = t.subject.startsWith('_:') ? t.subject : `<${t.subject}>`;
      const p = `<${t.predicate}>`;
      const o = this.formatObject(t.object);
      return `${s} ${p} ${o} .`;
    }).join('\n');

    const sparql = `DELETE DATA { GRAPH <${graphUri}> { ${lines} } }`;
    await this.update(sparql);
  }

  async ask(sparql: string): Promise<boolean> {
    const res = await this.query(sparql);
    return res.type === 'boolean' ? res.boolean! : false;
  }

  async exportDataset(_format: RdfFormat = 'turtle'): Promise<string> {
    return this.store.dump({ format: OxigraphAdapter.NQUADS_MIME });
  }

  async importDataset(data: string, format: RdfFormat = 'turtle'): Promise<void> {
    const mime = format === 'jsonld' ? 'application/ld+json' :
                 format === 'ntriples' ? 'application/n-triples' :
                 format === 'rdfxml' ? 'application/rdf+xml' : 'text/turtle';
    this.store.load(data, { format: mime });
    await this.flush();
  }

  async backup(targetDir: string): Promise<string> {
    // The WASM Oxigraph build has no Store.backup(); serialise the dataset
    // to an N-Quads file in the target directory instead.
    await fs.mkdir(targetDir, { recursive: true });
    const backupPath = path.join(targetDir, `oxigraph-backup-${Date.now()}.nq`);
    const nquads = this.store.dump({ format: OxigraphAdapter.NQUADS_MIME });
    await fs.writeFile(backupPath, nquads, 'utf-8');
    return backupPath;
  }

  async restore(backupPath: string): Promise<void> {
    if (!existsSync(backupPath)) {
      throw new Error(`Backup file not found: ${backupPath}`);
    }
    const data = await fs.readFile(backupPath, 'utf-8');
    // Replace current dataset with the backup contents.
    this.store = new oxigraph.Store();
    if (data.trim().length > 0) {
      this.store.load(data, { format: OxigraphAdapter.NQUADS_MIME });
    }
    await this.flush();
  }

  async getInferredTriples(_agentId: string): Promise<SparqlResult> {
    const sparql = `
      SELECT ?s ?p ?o WHERE {
        ?s ?p ?o .
        FILTER NOT EXISTS {
          GRAPH ?g { ?s ?p ?o }
        }
      } LIMIT 1000
    `;
    return this.query(sparql);
  }
}
