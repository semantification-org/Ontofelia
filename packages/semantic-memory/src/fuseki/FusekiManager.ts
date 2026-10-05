 
import { ChildProcess, spawn } from 'child_process';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import { HealthResult } from '@ontofelia/core';
import * as fs from 'fs/promises';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export interface FusekiConfig {
  dataDir: string;         // ~/.ontofelia/triplestore/tdb2/
  port: number;            // 18787
  configPath: string;      // ~/.ontofelia/triplestore/fuseki-config.ttl
  fusekiHome: string;      // ~/.ontofelia/triplestore/fuseki/
  javaPath: string;        // /usr/bin/java
  dataset: string;         // ontofelia
  reasoning?: boolean;     // Whether OWL-DL reasoning should be active
}

/** A Fuseki distribution and the SHA-512 of its tarball. Change both together. */
export interface FusekiDownload {
  url: string;
  sha512: string;
}

/** Pinned against the `.sha512` published by Apache for exactly this URL. */
export const FUSEKI_DOWNLOAD: FusekiDownload = {
  url: 'https://archive.apache.org/dist/jena/binaries/apache-jena-fuseki-5.0.0.tar.gz',
  sha512:
    'c7b9fa452cdec19c50ee08ee191012b26c7b51f1ee5c5143db3047e0545c007599fbc08481fa61df5aef766a796e43262c209fc42578f2e532c0ab0c19dcbc51',
};

export interface FusekiManagerOptions {
  /** HTTP client used for the download; defaults to the global `fetch`. */
  fetch?: typeof fetch;
  /** Distribution to download; defaults to the pinned one. Intended for tests. */
  download?: FusekiDownload;
}

export class FusekiManager {
  private process: ChildProcess | null = null;
  private status: 'stopped' | 'starting' | 'running' | 'error' = 'stopped';
  private config: FusekiConfig;

  private fetchImpl: typeof fetch;
  private download: FusekiDownload;

  constructor(config: FusekiConfig, options: FusekiManagerOptions = {}) {
    this.config = config;
    this.fetchImpl = options.fetch ?? ((...args) => fetch(...args));
    this.download = options.download ?? FUSEKI_DOWNLOAD;
  }

  /** Download Fuseki distribution if missing. */
  async ensureFuseki(): Promise<void> {
    const jarPath = path.join(this.config.fusekiHome, 'fuseki-server.jar');
    if (existsSync(jarPath)) {
      return;
    }
    
    mkdirSync(this.config.fusekiHome, { recursive: true });
    
    // Instead of downloading a massive tar.gz, since this is an MVP and local setup,
    // we'll download just the server jar if possible, or the full tar.gz and extract.
    // For simplicity, we assume we fetch the tar.gz, extract the jar and libs.
    // However, downloading in Node without external deps:
    const { url, sha512 } = this.download;
    const tarPath = path.join(this.config.fusekiHome, 'fuseki.tar.gz');

    console.log(`Downloading Fuseki from ${url}...`);
    const res = await this.fetchImpl(url);
    if (!res.ok) throw new Error(`Failed to download Fuseki: ${res.statusText}`);

    const bytes = Buffer.from(await res.arrayBuffer());
    // Verify before anything touches the disk or the unpacker.
    const actual = createHash('sha512').update(bytes).digest('hex');
    if (actual !== sha512.toLowerCase()) {
      throw new Error(
        `Fuseki download failed integrity check (SHA-512 mismatch): expected ${sha512.slice(0, 16)}..., got ${actual.slice(0, 16)}...`,
      );
    }

    try {
      await fs.writeFile(tarPath, bytes);
      console.log('Extracting Fuseki...');
      // Use system tar; never adopt archive ownership or permission bits.
      await execFileAsync('tar', [
        '-xzf', tarPath,
        '-C', this.config.fusekiHome,
        '--strip-components=1',
        '--no-same-owner',
        '--no-same-permissions',
      ]);
    } finally {
      await fs.rm(tarPath, { force: true });
    }
    console.log('Fuseki ready.');
  }

  /** Generate fuseki-config.ttl with RDFS inference or OWL reasoning. */
  generateConfig(): string {
    let configContent = '';
    
    if (this.config.reasoning) {
      configContent = `@prefix fuseki:  <http://jena.apache.org/fuseki#> .
@prefix ja:      <http://jena.hpl.hp.com/2005/11/Assembler#> .
@prefix tdb2:    <http://jena.apache.org/2016/tdb#> .
@prefix rdf:     <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .

<#service> rdf:type fuseki:Service ;
    fuseki:name "${this.config.dataset}" ;
    fuseki:endpoint [ fuseki:operation fuseki:query ;    fuseki:name "sparql" ] ;
    fuseki:endpoint [ fuseki:operation fuseki:update ;   fuseki:name "update" ] ;
    fuseki:endpoint [ fuseki:operation fuseki:gsp-rw ;   fuseki:name "data" ] ;
    fuseki:dataset <#dataset> .

<#dataset> rdf:type tdb2:DatasetTDB2 ;
    tdb2:location "${this.config.dataDir}" ;
    tdb2:unionDefaultGraph false .
`;
    } else {
      configContent = `@prefix fuseki:  <http://jena.apache.org/fuseki#> .
@prefix rdf:     <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .
@prefix rdfs:    <http://www.w3.org/2000/01/rdf-schema#> .
@prefix tdb2:    <http://jena.apache.org/2016/tdb#> .
@prefix ja:      <http://jena.hpl.hp.com/2005/11/Assembler#> .

<#service> rdf:type fuseki:Service ;
    fuseki:name "${this.config.dataset}" ;
    fuseki:endpoint [ fuseki:operation fuseki:query ;    fuseki:name "sparql" ] ;
    fuseki:endpoint [ fuseki:operation fuseki:update ;   fuseki:name "update" ] ;
    fuseki:endpoint [ fuseki:operation fuseki:gsp-rw ;   fuseki:name "data" ] ;
    fuseki:dataset <#dataset> .

<#dataset> rdf:type tdb2:DatasetTDB2 ;
    tdb2:location "${this.config.dataDir}" ;
    tdb2:unionDefaultGraph false .
`;
    }

    mkdirSync(path.dirname(this.config.configPath), { recursive: true });
    writeFileSync(this.config.configPath, configContent, 'utf-8');
    return configContent;
  }

  /** Starte Fuseki als Child-Prozess */
  async start(): Promise<void> {
    if (this.status === 'starting' || this.status === 'running') return;
    
    this.status = 'starting';
    this.generateConfig();
    mkdirSync(this.config.dataDir, { recursive: true });

    // Kill any stale Fuseki process on the port
    try {
      const { execSync } = await import('child_process');
      execSync(`lsof -ti :${this.config.port} | xargs kill -9 2>/dev/null`, { stdio: 'pipe' });
      await new Promise(r => setTimeout(r, 500));
    } catch { /* Expected: no process on port to kill */ }

    const jarPath = path.join(this.config.fusekiHome, 'fuseki-server.jar');

    this.process = spawn(this.config.javaPath, [
      '-jar', jarPath,
      '--config', this.config.configPath,
      '--port', this.config.port.toString(),
      '--localhost'
    ], {
      cwd: this.config.fusekiHome,
      stdio: 'pipe'
    });

    this.process.on('error', (err) => {
      console.error('Fuseki process error:', err);
      this.status = 'error';
    });

    this.process.on('exit', (code) => {
      if (code !== 0 && this.status !== 'stopped') {
        console.error(`Fuseki exited with code ${code}`);
        this.status = 'error';
      } else {
        this.status = 'stopped';
      }
      this.process = null;
    });

    // Wait until it's ready
    await this.waitUntilReady();
    this.status = 'running';
  }

  /** Stoppe Fuseki (SIGTERM, dann SIGKILL nach 5s) */
  async stop(): Promise<void> {
    if (!this.process || this.status === 'stopped') return;

    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        if (this.process) {
          this.process.kill('SIGKILL');
        }
      }, 5000);

      this.process!.on('exit', () => {
        clearTimeout(timeout);
        this.status = 'stopped';
        resolve();
      });

      this.process!.kill('SIGTERM');
    });
  }

  /** Health-Check via HTTP */
  async healthCheck(): Promise<HealthResult> {
    const start = Date.now();
    try {
      const res = await fetch(`http://127.0.0.1:${this.config.port}/$/ping`);
      if (res.ok) {
        return {
          healthy: true,
          component: 'Fuseki',
          checkedAt: new Date().toISOString(),
          details: { responseTime: Date.now() - start }
        };
      }
    } catch (_e) {
      // Ignored
    }
    return {
      healthy: false,
      component: 'Fuseki',
      message: 'Fuseki not reachable',
      checkedAt: new Date().toISOString()
    };
  }

  /** Warte bis Fuseki gesund ist (max 30s) */
  async waitUntilReady(timeoutMs: number = 30000): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const health = await this.healthCheck();
      if (health.healthy) {
        return;
      }
      await new Promise(r => setTimeout(r, 500));
    }
    throw new Error('Fuseki failed to start within timeout.');
  }
}
