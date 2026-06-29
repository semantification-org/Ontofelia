/* eslint-disable @typescript-eslint/no-unused-vars */
import { TriplestoreAdapter, TriplestoreConfig, SparqlResult, RdfFormat, Triple, HealthResult } from '@ontofelia/core';

export class FusekiAdapter implements TriplestoreAdapter {
  readonly backend = 'fuseki';
  status: 'stopped' | 'starting' | 'running' | 'error' = 'stopped';
  private config!: TriplestoreConfig;

  async initialize(config: TriplestoreConfig): Promise<void> {
    this.config = config;
    this.status = 'running';
  }

  async start(): Promise<void> {
    // Start is handled by FusekiManager. This adapter assumes running state if initialized.
    this.status = 'running';
  }

  async stop(): Promise<void> {
    this.status = 'stopped';
  }

  async healthCheck(): Promise<HealthResult> {
    try {
      const res = await fetch(`http://127.0.0.1:${this.config.port}/$/ping`);
      if (res.ok) {
        return { healthy: true, component: 'FusekiAdapter', checkedAt: new Date().toISOString() };
      }
    } catch (_e) {
      // Ignored
    }
    return { healthy: false, component: 'FusekiAdapter', message: 'Not reachable', checkedAt: new Date().toISOString() };
  }

  async query(sparql: string, namedGraph?: string): Promise<SparqlResult> {
    const url = new URL(this.config.endpoint + '/sparql');
    const params = new URLSearchParams();
    params.set('query', sparql);
    if (namedGraph) {
      params.set('default-graph-uri', namedGraph);
    }
    
    // Determine format based on query type (SELECT/ASK -> JSON, CONSTRUCT/DESCRIBE -> Turtle)
    const isConstruct = sparql.toUpperCase().includes('CONSTRUCT') || sparql.toUpperCase().includes('DESCRIBE');
    const accept = isConstruct ? 'text/turtle' : 'application/sparql-results+json';

    const res = await fetch(url.toString(), {
      method: 'POST',
      headers: {
        'Accept': accept,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Timeout': '30000'
      },
      body: params.toString()
    });

    if (!res.ok) {
      throw new Error(`SPARQL Query failed: ${res.statusText} - ${await res.text()}`);
    }

    if (isConstruct) {
      return { type: 'graph', graph: await res.text() };
    }

    const json = await res.json() as { boolean?: boolean, head?: { vars: string[] }, results?: { bindings: Record<string, import('@ontofelia/core').RdfTerm>[] } };
    if (json.boolean !== undefined) {
      return { type: 'boolean', boolean: json.boolean };
    }
    
    return {
      type: 'bindings',
      variables: json.head?.vars,
      bindings: json.results?.bindings
    };
  }

  async update(sparql: string): Promise<void> {
    const url = this.config.endpoint + '/update';
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/sparql-update'
      },
      body: sparql
    });

    if (!res.ok) {
      throw new Error(`SPARQL Update failed: ${res.statusText} - ${await res.text()}`);
    }
  }

  async getGraph(graphUri: string, format: RdfFormat = 'turtle'): Promise<string> {
    const acceptHeader = format === 'jsonld' ? 'application/ld+json' : 'text/turtle';
    const url = new URL(this.config.endpoint + '/data');
    url.searchParams.set('graph', graphUri);
    
    const res = await fetch(url.toString(), {
      headers: { 'Accept': acceptHeader }
    });
    
    if (res.status === 404) return ''; // Empty graph
    if (!res.ok) throw new Error(`getGraph failed: ${res.statusText}`);
    return res.text();
  }

  async putGraph(graphUri: string, data: string, format: RdfFormat = 'turtle'): Promise<void> {
    const contentType = format === 'jsonld' ? 'application/ld+json' : 'text/turtle';
    const url = new URL(this.config.endpoint + '/data');
    url.searchParams.set('graph', graphUri);
    
    const res = await fetch(url.toString(), {
      method: 'PUT',
      headers: { 'Content-Type': contentType },
      body: data
    });
    
    if (!res.ok) throw new Error(`putGraph failed: ${res.statusText}`);
  }

  async deleteGraph(graphUri: string): Promise<void> {
    const url = new URL(this.config.endpoint + '/data');
    url.searchParams.set('graph', graphUri);
    
    const res = await fetch(url.toString(), {
      method: 'DELETE'
    });
    
    if (!res.ok && res.status !== 404) throw new Error(`deleteGraph failed: ${res.statusText}`);
  }

  private formatObject(obj: Triple['object']): string {
    if (typeof obj === 'string') {
      if (obj.startsWith('http://') || obj.startsWith('https://') || obj.startsWith('urn:')) {
        return `<${obj}>`;
      }
      return `"${obj.replace(/"/g, '\\"')}"`; // Simple literal string
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
    }).join('\\n');
    
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
    }).join('\\n');
    
    const sparql = `DELETE DATA { GRAPH <${graphUri}> { ${lines} } }`;
    await this.update(sparql);
  }

  async ask(sparql: string): Promise<boolean> {
    const res = await this.query(sparql);
    return res.type === 'boolean' ? res.boolean! : false;
  }

  async exportDataset(format: RdfFormat = 'turtle'): Promise<string> {
    const acceptHeader = format === 'jsonld' ? 'application/ld+json' : 'text/turtle';
    const url = new URL(this.config.endpoint + '/data');
    
    const res = await fetch(url.toString(), {
      headers: { 'Accept': acceptHeader }
    });
    
    if (!res.ok) throw new Error(`exportDataset failed: ${res.statusText}`);
    return res.text();
  }

  async importDataset(data: string, format: RdfFormat = 'turtle'): Promise<void> {
    const contentType = format === 'jsonld' ? 'application/ld+json' : 'text/turtle';
    const url = new URL(this.config.endpoint + '/data');
    
    const res = await fetch(url.toString(), {
      method: 'PUT',
      headers: { 'Content-Type': contentType },
      body: data
    });
    
    if (!res.ok) throw new Error(`importDataset failed: ${res.statusText}`);
  }

  async backup(_targetDir: string): Promise<string> {
    // Using Fuseki backup API
    const url = new URL(this.config.endpoint.replace('/ontofelia', '/$/backup/ontofelia'));
    const res = await fetch(url.toString(), { method: 'POST' });
    if (!res.ok) throw new Error('Backup failed');
    return 'Backup initiated via Fuseki';
  }

  async restore(_backupPath: string): Promise<void> {
    throw new Error('Restore not fully supported via HTTP API automatically yet.');
  }

  /** Hole nur inferierte Tripel */
  async getInferredTriples(agentId: string): Promise<SparqlResult> {
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
