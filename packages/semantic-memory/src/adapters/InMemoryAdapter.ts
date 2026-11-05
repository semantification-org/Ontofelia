 
import { TriplestoreAdapter, TriplestoreConfig, SparqlResult, RdfFormat, Triple, HealthResult } from '@ontofelia/core';

const XSD_STRING = 'http://www.w3.org/2001/XMLSchema#string';

function escapeLiteral(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
}

function unescapeLiteral(value: string): string {
  return value.replace(/\\(["\\nrt])/g, (_m, c: string) =>
    c === 'n' ? '\n' : c === 'r' ? '\r' : c === 't' ? '\t' : c);
}

// One N-Quads statement: <s>|_:b <p> <o>|_:b|"lit"[^^<dt>|@lang] [<g>] .
const NQUADS_LINE =
  /^\s*(<[^>]*>|_:\S+)\s+(<[^>]*>)\s+(<[^>]*>|_:\S+|"(?:[^"\\]|\\.)*"(?:\^\^<[^>]*>|@[A-Za-z0-9-]+)?)\s*(<[^>]*>)?\s*\.\s*$/;

export class InMemoryAdapter implements TriplestoreAdapter {
  readonly backend = 'memory';
  status: 'stopped' | 'starting' | 'running' | 'error' = 'stopped';
  private config!: TriplestoreConfig;
  private store: Map<string, Triple[]> = new Map();

  async initialize(config: TriplestoreConfig): Promise<void> {
    this.config = config;
    this.status = 'running';
  }

  async start(): Promise<void> {
    this.status = 'running';
  }

  async stop(): Promise<void> {
    this.status = 'stopped';
  }

  async healthCheck(): Promise<HealthResult> {
    return { healthy: true, component: 'InMemoryAdapter', checkedAt: new Date().toISOString() };
  }

  async query(sparql: string, _namedGraph?: string): Promise<SparqlResult> {
    // Very basic parsing just to support tests where needed, normally not full SPARQL.
    // Supported exception: a COUNT(*) query returns the total triple count of the
    // store (all graphs) as ?n, so callers can size the store before destructive work.
    if (/COUNT\s*\(\s*\*\s*\)/i.test(sparql)) {
      let n = 0;
      for (const triples of this.store.values()) n += triples.length;
      return {
        type: 'bindings',
        variables: ['n'],
        bindings: [{ n: { type: 'literal', value: String(n), datatype: 'http://www.w3.org/2001/XMLSchema#integer' } }],
      };
    }
    if (sparql.toUpperCase().includes('ASK')) {
      return { type: 'boolean', boolean: true };
    }
    
    // In-Memory mock response for SELECT
    return {
      type: 'bindings',
      variables: ['s', 'p', 'o'],
      bindings: []
    };
  }

  async update(sparql: string): Promise<void> {
    // Basic implementation for testing purposes: only DROP ALL / CLEAR ALL is understood.
    if (/^\s*(DROP|CLEAR)\s+(SILENT\s+)?ALL\s*;?\s*$/i.test(sparql)) {
      this.store.clear();
    }
  }

  async getGraph(graphUri: string, _format: RdfFormat = 'turtle'): Promise<string> {
    const triples = this.store.get(graphUri) || [];
    // Super basic NTriples formatting for testing
    return triples.map(t => {
      const s = t.subject.startsWith('_:') ? t.subject : `<${t.subject}>`;
      const p = `<${t.predicate}>`;
      let o = '';
      if (typeof t.object === 'string') {
        if (t.object.startsWith('http') || t.object.startsWith('urn:')) {
          o = `<${t.object}>`;
        } else {
          o = `"${t.object}"`;
        }
      } else {
        if (t.object.type === 'uri') {
          o = `<${t.object.value}>`;
        } else {
          o = `"${t.object.value}"`;
        }
      }
      return `${s} ${p} ${o} .`;
    }).join('\\n');
  }

  async putGraph(graphUri: string, _data: string, _format?: RdfFormat): Promise<void> {
    // Dummy implementation
    this.store.set(graphUri, []);
  }

  async deleteGraph(graphUri: string): Promise<void> {
    this.store.delete(graphUri);
  }

  async insertTriples(graphUri: string, triples: Triple[]): Promise<void> {
    const existing = this.store.get(graphUri) || [];
    this.store.set(graphUri, [...existing, ...triples]);
  }

  async deleteTriples(graphUri: string, triples: Triple[]): Promise<void> {
    let existing = this.store.get(graphUri) || [];
    existing = existing.filter(e => !triples.some(t => t.subject === e.subject && t.predicate === e.predicate && (
      (typeof t.object === 'string' && typeof e.object === 'string' && t.object === e.object) ||
      (typeof t.object !== 'string' && typeof e.object !== 'string' && t.object.value === e.object.value)
    )));
    this.store.set(graphUri, existing);
  }

  async ask(_sparql: string): Promise<boolean> {
    return true; // Mock true for tests
  }

  /**
   * Serialises every stored triple as N-Quads (one statement per line, graph as
   * fourth term), whatever format is requested. Matches OxigraphAdapter, which
   * also always dumps N-Quads. Returns '' only when the store holds no triples.
   */
  async exportDataset(_format?: RdfFormat): Promise<string> {
    const lines: string[] = [];
    for (const [graphUri, triples] of this.store) {
      for (const t of triples) {
        const s = t.subject.startsWith('_:') ? t.subject : `<${t.subject}>`;
        let o: string;
        if (typeof t.object === 'string') {
          o = t.object.startsWith('_:') ? t.object
            : /^(https?:|urn:)/.test(t.object) ? `<${t.object}>`
            : `"${escapeLiteral(t.object)}"`;
        } else if (t.object.type === 'uri') {
          o = `<${t.object.value}>`;
        } else if (t.object.type === 'bnode') {
          o = t.object.value;
        } else {
          o = `"${escapeLiteral(t.object.value)}"`;
          if (t.object.language) o += `@${t.object.language}`;
          else if (t.object.type && t.object.type !== XSD_STRING) o += `^^<${t.object.type}>`;
        }
        const g = graphUri ? ` <${graphUri}>` : '';
        lines.push(`${s} <${t.predicate}> ${o}${g} .`);
      }
    }
    return lines.length ? lines.join('\n') + '\n' : '';
  }

  /**
   * Loads N-Quads / N-Triples statements (the format exportDataset emits).
   * Lines that are not N-Quads statements are ignored; other RDF syntaxes are
   * not parsed by this test adapter.
   */
  async importDataset(data: string, _format?: RdfFormat): Promise<void> {
    for (const line of data.split('\n')) {
      const m = NQUADS_LINE.exec(line);
      if (!m) continue;
      const [, s, p, o, g] = m;
      let object: Triple['object'];
      if (o.startsWith('<')) object = { value: o.slice(1, -1), type: 'uri' };
      else if (o.startsWith('_:')) object = { value: o, type: 'bnode' };
      else {
        const lit = /^"((?:[^"\\]|\\.)*)"(?:\^\^<([^>]*)>|@([A-Za-z0-9-]+))?$/.exec(o)!;
        object = { value: unescapeLiteral(lit[1]) };
        if (lit[3]) object.language = lit[3];
        else if (lit[2]) object.type = lit[2];
      }
      const triple: Triple = {
        subject: s.startsWith('<') ? s.slice(1, -1) : s,
        predicate: p.slice(1, -1),
        object,
      };
      await this.insertTriples(g ? g.slice(1, -1) : '', [triple]);
    }
  }

  async backup(_targetDir: string): Promise<string> {
    return 'in-memory backup';
  }

  async restore(_backupPath: string): Promise<void> {}
}
