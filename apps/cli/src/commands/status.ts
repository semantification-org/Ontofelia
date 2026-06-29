 
import { Command } from 'commander';
import { readPid } from '../utils/process.js';
import chalk from 'chalk';


import { loadConfig } from '@ontofelia/config';



export function registerStatusCommand(program: Command) {
  // ---- STATUS COMMAND ----
  program
    .command('status')
    .description('Show system status summary')
    .option('--usage', 'Show usage statistics')
    .option('--json', 'Output as JSON')
    .action(async (options) => {
      const config = await loadConfig();
      
      // Check PID file first
      const pid = await readPid();
      const isRunning = pid !== null;
      
      if (options.json) {
        if (!isRunning) {
          console.log(JSON.stringify({ running: false }));
          return;
        }
        try {
          const res = await fetch(`http://127.0.0.1:${config.gateway.port}/api/status`, {
            headers: { 'Authorization': `Bearer ${config.gateway.token}` },
            signal: AbortSignal.timeout(3000),
          });
          if (res.ok) {
            console.log(JSON.stringify(await res.json(), null, 2));
          }
        } catch { 
          console.log(JSON.stringify({ running: false }));
        }
        return;
      }
  
      console.log('');
      console.log(chalk.blue.bold('  🦉 Ontofelia Status'));
      console.log('');
      
      // Gateway process
      if (isRunning) {
        console.log(chalk.green(`  ● Gateway        running (PID ${pid})`));
      } else {
        console.log(chalk.red('  ○ Gateway        stopped'));
        console.log('');
        console.log(chalk.gray('  Start with: ontofelia gateway start'));
        console.log('');
        return;
      }
      
      // Fetch detailed status from API
      try {
        const res = await fetch(`http://127.0.0.1:${config.gateway.port}/api/status`, {
          headers: { 'Authorization': `Bearer ${config.gateway.token}` },
          signal: AbortSignal.timeout(3000),
        });
        
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        
        const data = await res.json() as {
          running?: boolean; version?: string; uptime?: number;
          memory?: { backend?: string; status?: string; tripleCount?: number };
          agents?: { total: number; running: number };
          channels?: { total: number; connected: number };
        };
        
        // Uptime
        const uptime = data.uptime || 0;
        const hours = Math.floor(uptime / 3600);
        const minutes = Math.floor((uptime % 3600) / 60);
        const uptimeStr = hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
        console.log(chalk.gray(`                   uptime ${uptimeStr}, v${data.version || '?'}`));
        
        // Agents
        if (data.agents) {
          const agentStatus = data.agents.running > 0 ? chalk.green('●') : chalk.red('○');
          console.log(`  ${agentStatus} Agents         ${data.agents.running}/${data.agents.total} running`);
        }
        
        // Channels
        if (data.channels) {
          const channelStatus = data.channels.connected > 0 ? chalk.green('●') : chalk.yellow('○');
          console.log(`  ${channelStatus} Channels       ${data.channels.connected}/${data.channels.total} connected`);
        }
        
        // Knowledge Graph
        if (data.memory) {
          const memStatus = (data.memory.status === 'running' || data.memory.status === 'ok') ? chalk.green('●') : chalk.red('○');
          const tripleInfo = data.memory.tripleCount !== undefined ? ` (${data.memory.tripleCount} triples)` : '';
          console.log(`  ${memStatus} Knowledge Graph ${data.memory.backend}${tripleInfo}`);
        }
        
      } catch {
        console.log(chalk.yellow('  ⚠ Gateway process found but API not responding'));
      }
      
      console.log('');
      console.log(chalk.gray(`  Web UI: http://127.0.0.1:${config.gateway.port}`));
      console.log(chalk.gray(`  Token:  ${config.gateway.token}`));
      console.log('');
    });
  
}