import * as path from 'path';
import { Command } from 'commander';
import chalk from 'chalk';
import { loadConfig } from '@ontofelia/config';

interface VaultImportReport {
  runId: string;
  apply: boolean;
  notes: {
    path: string;
    status: string;
    reason?: string;
    facts: unknown[];
  }[];
  totals: Record<string, number>;
}

/** Directory basename reduced to [A-Za-z0-9_-], at most 64 characters. */
export function sanitiseVaultName(dir: string): string {
  const base = path.basename(path.resolve(dir));
  return base.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64);
}

export function registerVaultCommand(program: Command) {
  const vaultCmd = program.command('vault').description('Work with Vault-LD folders');

  vaultCmd
    .command('import')
    .description('Import a Vault-LD folder into the knowledge store (dry run unless --apply)')
    .argument('<dir>', 'Vault folder')
    .option('--apply', 'Write the facts (default: dry run)')
    .option('--name <vaultName>', 'Vault name (default: sanitised folder name)')
    .option('--agent <id>', 'Agent id')
    .option('--json', 'Print the raw report as JSON')
    .action(async (dir: string, opts: { apply?: boolean; name?: string; agent?: string; json?: boolean }) => {
      try {
        const config = await loadConfig();
        const body: Record<string, unknown> = {
          root: path.resolve(dir),
          vaultName: opts.name ?? sanitiseVaultName(dir),
          apply: opts.apply === true,
        };
        if (opts.agent) body.agentId = opts.agent;

        const res = await fetch(`http://127.0.0.1:${config.gateway.port}/api/knowledge/vault-import`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${config.gateway.token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(body),
        });
        if (!res.ok) {
          let detail = '';
          try {
            const err = await res.json() as { error?: string };
            detail = err.error ? ` - ${err.error}` : '';
          } catch { /* no JSON body */ }
          throw new Error(`HTTP ${res.status}${detail}`);
        }
        const report = await res.json() as VaultImportReport;

        if (opts.json) {
          console.log(JSON.stringify(report, null, 2));
          return;
        }
        if (!report.apply) {
          console.log(chalk.yellow('Dry run — nothing written. Re-run with --apply to import.'));
        }
        for (const n of report.notes) {
          const detail = `${n.facts.length} facts${n.reason ? `, ${n.reason}` : ''}`;
          console.log(`${n.status.padEnd(12)}  ${n.path}  (${detail})`);
        }
        const totals = Object.entries(report.totals).map(([k, v]) => `${k}: ${v}`).join(', ');
        console.log(`Totals: ${report.notes.length} notes${totals ? ` (${totals})` : ''}`);
      } catch (err: unknown) {
        console.error(chalk.red(`Vault import failed: ${(err as Error).message}`));
        process.exitCode = 1;
      }
    });
}
