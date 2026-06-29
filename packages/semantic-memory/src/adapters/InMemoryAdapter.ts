 
import { TriplestoreAdapter, TriplestoreConfig, SparqlResult, RdfFormat, Triple, HealthResult } from '@ontofelia/core';

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

  async update(_sparql: string): Promise<void> {
    // Basic implementation for testing purposes
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

  async exportDataset(_format?: RdfFormat): Promise<string> {
    return '';
  }

  async importDataset(_data: string, _format?: RdfFormat): Promise<void> {}

  async backup(_targetDir: string): Promise<string> {
    return 'in-memory backup';
  }

  async restore(_backupPath: string): Promise<void> {}
}
