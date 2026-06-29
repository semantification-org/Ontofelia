import { ToolDefinition, ToolPermission, ToolContext, ToolResult } from '@ontofelia/core';
import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

const execFileAsync = promisify(execFile);

async function installCrontab(content: string): Promise<void> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ontofelia-cron-'));
  const tempPath = path.join(tempDir, 'crontab');

  try {
    await fs.writeFile(tempPath, content, { mode: 0o600 });
    await execFileAsync('crontab', [tempPath], { timeout: 5000 });
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

interface CronInput {
  action: 'list' | 'add' | 'remove';
  /** For add: cron schedule expression, e.g. '0 9 * * *' (every day at 9:00) */
  schedule?: string;
  /** For add: a label/description for this job */
  label?: string;
  /** For add: the message to send to the agent when the cron fires */
  wakeMessage?: string;
  /** For remove: the label of the job to remove */
  removeLabel?: string;
}

export class CronManageTool implements ToolDefinition {
  name = 'cron_manage';
  description = 'Manage cron jobs on the host. Create, delete, or list cron jobs. Use this to wake yourself at specific times and handle tasks automatically.';
  category = 'shell' as const;
  permissions: ToolPermission[] = ['shell:exec'];
  hostOnly = true;
  
  inputSchema = {
    type: 'object',
    properties: {
      action: { 
        type: 'string', 
        enum: ['list', 'add', 'remove'],
        description: 'list=show crontab, add=add job, remove=remove job'
      },
      schedule: { type: 'string', description: 'Cron schedule (e.g. "0 9 * * *" = daily at 09:00)' },
      label: { type: 'string', description: 'Description/label for the job' },
      wakeMessage: { type: 'string', description: 'Message sent to the agent' },
      removeLabel: { type: 'string', description: 'Label of the job to remove' }
    },
    required: ['action']
  };

  private gatewayPort: number;

  constructor(gatewayPort = 18780) {
    this.gatewayPort = gatewayPort;
  }

  async execute(input: unknown, _context: ToolContext): Promise<ToolResult> {
    const data = input as CronInput;
    const startTime = Date.now();

    try {
      let output = '';

      switch (data.action) {
        case 'list': {
          try {
            const { stdout } = await execFileAsync('crontab', ['-l'], { timeout: 5000 });
            const ontoJobs = stdout.split('\n').filter(l => l.includes('# ontofelia:'));
            output = ontoJobs.length > 0 
              ? `⏰ Ontofelia cron jobs:\n\n${ontoJobs.map(l => {
                  const labelMatch = l.match(/# ontofelia:\s*(.*)/);
                  const label = labelMatch ? labelMatch[1] : '';
                  const schedule = l.replace(/#.*$/, '').replace(/curl.*$/, '').trim();
                  return `• ${label} — \`${schedule}\``;
                }).join('\n')}`
              : '⏰ No Ontofelia cron jobs found.';
          } catch {
            output = '⏰ No crontab exists or crontab is not available.';
          }
          break;
        }

        case 'add': {
          if (!data.schedule || !data.label) {
            output = '❌ Please provide schedule and label.';
            break;
          }
          
          if (!/^[a-zA-Z0-9_\-]{1,64}$/.test(data.label)) {
            output = '❌ Invalid label. Only alphanumeric characters, _ and - are allowed (max 64 characters).';
            break;
          }
          
          // Validate cron schedule: must be 5 fields with valid ranges
          const scheduleFields = data.schedule.split(/\s+/);
          if (scheduleFields.length !== 5) {
            output = '❌ Invalid cron schedule format. Exactly 5 fields expected (minute hour day month weekday).';
            break;
          }
          const fieldRanges = [
            { name: 'Minute', min: 0, max: 59 },
            { name: 'Hour', min: 0, max: 23 },
            { name: 'Day', min: 1, max: 31 },
            { name: 'Month', min: 1, max: 12 },
            { name: 'Weekday', min: 0, max: 7 },
          ];
          let scheduleValid = true;
          for (let i = 0; i < 5; i++) {
            const field = scheduleFields[i];
            // Allow *, */N, N, N-M, N,M,... patterns
            if (!/^[0-9*\/,\-]+$/.test(field)) {
              output = `❌ Invalid cron schedule: field "${fieldRanges[i].name}" contains invalid characters.`;
              scheduleValid = false;
              break;
            }
            // Extract all numeric values and check range
            const nums = field.match(/\d+/g);
            if (nums) {
              for (const n of nums) {
                const val = parseInt(n, 10);
                if (val < fieldRanges[i].min || val > fieldRanges[i].max) {
                  output = `❌ Invalid cron schedule: ${fieldRanges[i].name} value ${val} is outside the allowed range (${fieldRanges[i].min}-${fieldRanges[i].max}).`;
                  scheduleValid = false;
                  break;
                }
              }
            }
            if (!scheduleValid) break;
          }
          if (!scheduleValid) break;

          const cronDir = path.join(os.homedir(), '.ontofelia', 'cron');
          await fs.mkdir(cronDir, { recursive: true });
          
          const payloadPath = path.join(cronDir, `job_${data.label}.json`);
          const payloadStr = JSON.stringify({ message: data.wakeMessage || data.label });
          await fs.writeFile(payloadPath, payloadStr, 'utf-8');

          const curlCmd = `curl -s -X POST http://127.0.0.1:${this.gatewayPort}/api/cron-trigger -H 'Content-Type: application/json' -d @${payloadPath}`;
          const cronLine = `${data.schedule} ${curlCmd} # ontofelia: ${data.label}`;

          // Append to crontab
          let newCrontab = '';
          try {
            const { stdout: existing } = await execFileAsync('crontab', ['-l'], { timeout: 5000 });
            const lines = existing.split('\n').filter(l => !l.includes(`# ontofelia: ${data.label}`) && l.trim().length > 0);
            newCrontab = lines.join('\n') + '\n' + cronLine + '\n';
          } catch {
            newCrontab = cronLine + '\n';
          }
          
          await installCrontab(newCrontab);

          output = `✅ Cron job created:\n• Label: ${data.label}\n• Schedule: \`${data.schedule}\`\n• Wake message: ${data.wakeMessage || data.label}`;
          break;
        }

        case 'remove': {
          if (!data.removeLabel) {
            output = '❌ Please provide removeLabel.';
            break;
          }
          
          if (!/^[a-zA-Z0-9_\-]{1,64}$/.test(data.removeLabel)) {
             output = '❌ Invalid label format.';
             break;
          }
          
          try {
            const cronDir = path.join(os.homedir(), '.ontofelia', 'cron');
            const payloadPath = path.join(cronDir, `job_${data.removeLabel}.json`);
            await fs.rm(payloadPath, { force: true });
          
            const { stdout: existing } = await execFileAsync('crontab', ['-l'], { timeout: 5000 });
            const lines = existing.split('\n').filter(l => !l.includes(`# ontofelia: ${data.removeLabel}`) && l.trim().length > 0);
            const newCrontab = lines.length > 0 ? lines.join('\n') + '\n' : '';
            
            if (newCrontab === '') {
              await execFileAsync('crontab', ['-r'], { timeout: 5000 }).catch(() => {});
            } else {
              await installCrontab(newCrontab);
            }
            
            output = `✅ Cron job "${data.removeLabel}" removed.`;
          } catch {
            output = '❌ Error removing cron job.';
          }
          break;
        }

        default:
          output = `Unknown action: ${data.action}`;
      }

      return {
        success: true,
        output,
        auditEntry: {
          toolName: this.name,
          timestamp: new Date().toISOString(),
          duration: Date.now() - startTime,
          input,
          output: { action: data.action },
          success: true,
          permissions: this.permissions,
        },
      };
    } catch (e: unknown) {
      return {
        success: false,
        output: null,
        error: (e as Error).message,
        auditEntry: {
          toolName: this.name,
          timestamp: new Date().toISOString(),
          duration: Date.now() - startTime,
          input,
          output: null,
          success: false,
          error: (e as Error).message,
          permissions: this.permissions,
        },
      };
    }
  }
}
