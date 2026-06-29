import { Command } from 'commander';
import { stopGateway } from '../utils/process.js';
import { confirm } from '@inquirer/prompts';
import chalk from 'chalk';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

import { loadConfig } from '@ontofelia/config';

/**
 * `ontofelia data-reset` — wipe all conversational data and reset the
 * triplestore, leaving the installation as fresh as a new install, WITHOUT
 * touching the LLM or Telegram configuration.
 *
 * Kept (configuration):
 *   - ontofelia.json5  — holds the LLM provider/model AND the Telegram channel
 *   - auth.json        — the LLM provider OAuth tokens
 *   - pairing.db       — paired Telegram devices and the allowlist
 *
 * Deleted (data / learned state):
 *   - agents/          — sessions, transcripts, audit logs
 *   - logs/            — gateway logs
 *   - triplestore/     — the entire knowledge graph
 *   - ontology/        — learned ontology versions (re-seeded on start)
 *   - media/           — cached media
 *   - scheduler/       — scheduled jobs
 *   - backups/         — triplestore backups
 *   - gateway.pid      — stale pid file
 */
export function registerDataResetCommand(program: Command) {
  program
    .command('data-reset')
    .description('Delete all conversations and reset the knowledge graph — keeps LLM and Telegram settings')
    .option('--yes', 'Skip confirmation prompt')
    .action(async (options) => {
      console.log('');
      console.log(chalk.yellow.bold('  🧹 Ontofelia Data Reset'));
      console.log(chalk.gray('  This deletes all data and resets the knowledge graph:'));
      console.log(chalk.gray('    • Triplestore (Knowledge Graph — all learned knowledge)'));
      console.log(chalk.gray('    • All conversations, sessions and transcripts'));
      console.log(chalk.gray('    • Logs, scheduled jobs, cached media, backups'));
      console.log('');
      console.log(chalk.green('  Kept untouched:'));
      console.log(chalk.green('    • LLM settings (provider, model, auth tokens)'));
      console.log(chalk.green('    • Telegram settings (bot token, paired devices)'));
      console.log('');

      if (!options.yes) {
        const confirmed = await confirm({
          message: chalk.yellow('Delete all conversations and reset the knowledge graph?'),
          default: false,
        });
        if (!confirmed) {
          console.log(chalk.gray('Cancelled.'));
          process.exit(0);
        }
      }

      const ontoDir = path.join(os.homedir(), '.ontofelia');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let cfg: any;
      try { cfg = await loadConfig(); } catch { cfg = {}; }
      const tsPort = cfg?.memory?.triplestore?.port || 18787;
      const gatewayPort = cfg?.gateway?.port || 18780;

      // ── 1. Stop the gateway (it owns the embedded triplestore) ──
      console.log(chalk.cyan('  [1/4] Stopping gateway...'));
      await stopGateway();
      try {
        const { execSync } = await import('child_process');
        execSync(`lsof -ti :${tsPort} | xargs kill -9 2>/dev/null || true`, { stdio: 'ignore' });
      } catch { /* ignored */ }
      // Wait for processes to exit and release file locks.
      await new Promise(r => setTimeout(r, 2000));
      console.log(chalk.green('  ✔ Gateway stopped'));

      // ── 2. Delete data — but NEVER the config or auth/pairing files ──
      console.log(chalk.cyan('  [2/4] Deleting data...'));

      // Files that must survive a data reset. Guards against accidental
      // deletion if a data directory below is ever changed to overlap.
      const KEEP = new Set(['ontofelia.json5', 'auth.json', 'pairing.db']);

      const dataDirs = [
        'agents',       // sessions.db + transcripts + audit
        'logs',         // gateway logs
        'triplestore',  // the entire knowledge graph (Oxigraph / TDB2)
        'ontology',     // learned ontology versions — re-seeded on start
        'media',        // cached media
        'scheduler',    // scheduled jobs
        'backups',      // triplestore backups
      ];

      let deletedCount = 0;
      for (const dir of dataDirs) {
        if (KEEP.has(dir)) continue; // defensive — dirs and KEEP never overlap
        try {
          await fs.rm(path.join(ontoDir, dir), { recursive: true, force: true });
          deletedCount++;
        } catch { /* ignored */ }
      }
      // Stale pid file — regenerated on next start.
      try { await fs.unlink(path.join(ontoDir, 'gateway.pid')); } catch { /* ignored */ }
      // Fuseki config, if a legacy install left one behind.
      try { await fs.unlink(path.join(ontoDir, 'triplestore', 'fuseki-config.ttl')); } catch { /* ignored */ }

      console.log(chalk.green(`  ✔ ${deletedCount} data directories deleted`));
      console.log(chalk.gray('    Kept: ontofelia.json5, auth.json, pairing.db'));

      // ── 3. Restart the gateway — it recreates the triplestore and re-seeds ──
      console.log(chalk.cyan('  [3/4] Restarting gateway...'));
      let started = false;
      try {
        const { spawn } = await import('child_process');
        const child = spawn(process.execPath, [process.argv[1], 'gateway', 'start'], {
          detached: true,
          stdio: 'ignore',
        });
        child.unref();

        // Wait for the gateway HTTP port to come up.
        for (let i = 0; i < 20; i++) {
          await new Promise(r => setTimeout(r, 1000));
          try {
            const res = await fetch(`http://127.0.0.1:${gatewayPort}/api/sessions`);
            if (res.ok) { started = true; break; }
          } catch { /* not ready yet */ }
        }
        console.log(
          started
            ? chalk.green('  ✔ Gateway restarted')
            : chalk.yellow('  ⚠ Gateway starting — give it a moment'),
        );
      } catch {
        console.log(chalk.yellow('  ⚠ Gateway could not be started automatically'));
        console.log(chalk.gray('    Start it manually with: ontofelia gateway start'));
      }

      // ── 4. Verify ──
      console.log(chalk.cyan('  [4/4] Verifying...'));
      if (started) {
        try {
          const sessRes = await fetch(`http://127.0.0.1:${gatewayPort}/api/sessions`);
          const sessions = await sessRes.json() as unknown[];
          console.log(chalk.green(`  ✔ Sessions: ${sessions.length} (expected: 0)`));
        } catch {
          console.log(chalk.yellow('  ⚠ Sessions API is not reachable'));
        }
      }

      console.log('');
      console.log(chalk.green.bold('  🦉 Data reset complete!'));
      console.log(chalk.gray('  Ontofelia is fresh again — LLM and Telegram settings are intact.'));
      console.log('');
      process.exit(0);
    });
}
