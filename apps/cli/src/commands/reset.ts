 
import { Command } from 'commander';
import { stopGateway } from '../utils/process.js';
import { confirm } from '@inquirer/prompts';
import chalk from 'chalk';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';


import { loadConfig } from '@ontofelia/config';



export function registerResetCommand(program: Command) {
  // ---- RESET COMMAND ----
  program
    .command('reset')
    .description('Factory reset — clears all data and re-seeds from bootstrap')
    .option('--yes', 'Skip confirmation prompt')
    .option('--keep-config', 'Keep ontofelia.json5 configuration')
    .action(async (options) => {
      console.log('');
      console.log(chalk.red.bold('  ⚠️  Ontofelia Factory Reset'));
      console.log(chalk.gray('  This will delete ALL data:'));
      console.log(chalk.gray('    • Triplestore (Knowledge Graph — all knowledge)'));
      console.log(chalk.gray('    • All sessions and transcripts'));
      console.log(chalk.gray('    • All logs and audit data'));
      console.log('');
  
      if (!options.yes) {
        const confirmed = await confirm({
          message: chalk.red('Really delete EVERYTHING and start over?'),
          default: false
        });
        if (!confirmed) {
          console.log(chalk.gray('Cancelled.'));
          process.exit(0);
        }
      }
  
      const homeDir = os.homedir();
      const ontoDir = path.join(homeDir, '.ontofelia');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let cfg: any;
      try { cfg = await loadConfig(); } catch { cfg = {}; }
      const tsPort = cfg?.memory?.triplestore?.port || 18787;
  
      // 1. Stop Gateway (which also owns the Triplestore processes/threads)
      console.log(chalk.cyan('  [1/5] Stopping gateway + triplestore...'));
      await stopGateway();
      // Also kill Fuseki directly in case it survived
      try {
        const { execSync } = await import('child_process');
        execSync(`lsof -ti :${tsPort} | xargs kill -9 2>/dev/null || true`, { stdio: 'ignore' });
      } catch { /* ignored */ }
      // Wait for processes to fully exit and release file locks
      await new Promise(r => setTimeout(r, 2000));
      console.log(chalk.green('  ✔ Gateway + triplestore stopped'));
  
      // 2. Delete ALL data (with correct paths)
      console.log(chalk.cyan('  [2/5] Deleting data...'));
      const dirsToDelete = [
        path.join(ontoDir, 'agents'),                           // sessions.db + transcripts + audit
        path.join(ontoDir, 'logs'),                              // gateway logs
        path.join(ontoDir, 'triplestore', 'tdb2'),               // TDB2 database files (the actual data!)
        path.join(ontoDir, 'triplestore', 'fuseki', 'run', 'databases'),  // Fuseki runtime DB copies
        path.join(ontoDir, 'triplestore', 'fuseki', 'run', 'system'),     // Fuseki system catalog
        path.join(ontoDir, 'triplestore', 'fuseki', 'run', 'logs'),       // Fuseki access logs
        path.join(ontoDir, 'triplestore', 'fuseki', 'run', 'backups'),    // any backups
        path.join(ontoDir, 'triplestore', 'oxigraph'),                    // Oxigraph embedded DB
      ];
      let deletedCount = 0;
      for (const dir of dirsToDelete) {
        try {
          await fs.rm(dir, { recursive: true, force: true });
          deletedCount++;
        } catch { /* ignored */ }
      }
      // Also clear PID file and Fuseki config (will be regenerated)
      try { await fs.unlink(path.join(ontoDir, 'gateway.pid')); } catch { /* ignored */ }
      try { await fs.unlink(path.join(ontoDir, 'triplestore', 'fuseki-config.ttl')); } catch { /* ignored */ }
      console.log(chalk.green(`  ✔ ${deletedCount} directories deleted (sessions, logs, triplestore)`));
  
      // 3. Restart Gateway (will recreate Triplestore dataset + re-seed bootstrap)
      console.log(chalk.cyan('  [3/5] Restarting gateway...'));
      try {
        const { spawn } = await import('child_process');
        const child = spawn(process.execPath, [process.argv[1], 'gateway', 'start'], {
          detached: true,
          stdio: 'ignore'
        });
        child.unref();
  
        // Wait for gateway + Fuseki to be fully ready
        let ready = false;
        for (let i = 0; i < 15; i++) {
          await new Promise(r => setTimeout(r, 1000));
          try {
            const res = await fetch(`http://127.0.0.1:${tsPort}/$/ping`);
            if (res.ok) { ready = true; break; }
          } catch { /* not ready yet */ }
        }
        if (ready) {
          console.log(chalk.green('  ✔ Gateway + Fuseki started'));
        } else {
          console.log(chalk.yellow('  ⚠ Gateway started, but Fuseki is not ready yet'));
        }
      } catch {
        console.log(chalk.yellow('  ⚠ Gateway could not be started automatically'));
        console.log(chalk.gray('    Start it manually with: ontofelia gateway start'));
      }
  
      // 4. Bootstrap seeding is handled by the gateway on startup.
      // KnowledgeEngine.seedCoreGraphs() seeds the concept-conformant Named
      // Graphs (urn:ontofelia:self, …) into empty graphs — no manual,
      // backend-specific HTTP seeding here.
      console.log(chalk.cyan('  [4/5] Bootstrap data...'));
      console.log(chalk.gray('  Named Graphs are re-seeded automatically when the gateway starts.'));

      // 5. Verify
      console.log(chalk.cyan('  [5/5] Verifying...'));
      try {
        const sessRes = await fetch(`http://127.0.0.1:${cfg?.gateway?.port || 18780}/api/sessions`);
        const sessions = await sessRes.json() as unknown[];
        console.log(chalk.green(`  ✔ Sessions: ${sessions.length} (expected: 0)`));
      } catch {
        console.log(chalk.yellow('  ⚠ Sessions API is not reachable'));
      }
      try {
        const sparql = 'SELECT (COUNT(*) AS ?c) WHERE { ?s ?p ?o }';
        const kgRes = await fetch(`http://127.0.0.1:${tsPort}/ontofelia/sparql`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/sparql-results+json' },
          body: `query=${encodeURIComponent(sparql)}`
        });
         
        const kgData = await kgRes.json() as Record<string, unknown>;
        const count = (kgData as { results?: { bindings?: Array<{ c?: { value?: string } }> } })?.results?.bindings?.[0]?.c?.value || '?';
        console.log(chalk.green(`  ✔ Triplestore: ${count} triples (bootstrap only)`));
      } catch {
        console.log(chalk.yellow('  ⚠ Triplestore is not reachable'));
      }
  
      console.log('');
      console.log(chalk.green.bold('  🦉 Factory reset complete!'));
      console.log(chalk.gray('  Ontofelia is now a fresh system. Start a new conversation.'));
      console.log('');
      process.exit(0);
    });
}
