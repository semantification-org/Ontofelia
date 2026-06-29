/* eslint-disable @typescript-eslint/no-unused-vars */
import { Command } from 'commander';
import chalk from 'chalk';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';

import { fileURLToPath } from 'url';

const execFileAsync = promisify(execFile);

import { loadConfig } from '@ontofelia/config';
import { startGateway } from '@ontofelia/gateway';
import { createLogger } from '@ontofelia/core';
import { readPid, writePid, removePid, stopGateway } from '../utils/process.js';

const logger = createLogger('cli');


export function registerGatewayCommand(program: Command) {
  // ---- GATEWAY COMMAND ----
  const gatewayCmd = program
    .command('gateway')
    .description('Manage the Ontofelia Gateway server');
  
  const PID_FILE = path.join(os.homedir(), '.ontofelia', 'gateway.pid');
  
  // ontofelia gateway start (also triggered by bare 'ontofelia gateway')
  gatewayCmd
    .command('start', { isDefault: true })
    .description('Start the gateway server')
    .option('--port <port>', 'Port to listen on')
    .option('--bind <mode>', 'Network bind mode')
    .option('--token <token>', 'Gateway token')
    .option('--verbose', 'Enable verbose logging')
    .option('--foreground', 'Run in foreground (default is background)')
    .action(async (options) => {
      // Check if already running (skip in foreground mode — parent already wrote PID)
      if (!options.foreground) {
        const existingPid = await readPid();
        if (existingPid) {
          console.log(chalk.yellow(`Gateway is already running (PID ${existingPid})`));
          console.log(chalk.gray('Use "ontofelia gateway stop" to stop it first'));
          return;
        }
      }
  
      try {
        const config = await loadConfig();
        if (options.port) config.gateway.port = parseInt(options.port, 10);
        if (options.bind) config.gateway.bind = options.bind as 'loopback' | 'lan' | 'tailnet' | 'custom';
        if (options.token) config.gateway.token = options.token;
  
        if (options.foreground) {
          // Foreground mode (for debugging / development)
          await writePid(process.pid);
          
          const cleanup = async () => { await removePid(); process.exit(0); };
          process.on('SIGINT', cleanup);
          process.on('SIGTERM', cleanup);
          
          await startGateway(config);
        } else {
          // Default: background (daemon) mode
          const logFile = path.join(os.homedir(), '.ontofelia', 'logs', 'gateway.log');
          await fs.mkdir(path.dirname(logFile), { recursive: true });
          const logFd = await fs.open(logFile, 'a');
  
          const { spawn } = await import('child_process');
          
          // Determine the correct entry point for the background process.
          // When running via tsx (development), import.meta.url points to src/;
          // we must use tsx and the .ts entry point. When running from dist/,
          // use node directly with the compiled .js entry.
          const currentFile = fileURLToPath(import.meta.url);
          const isFromSource = currentFile.includes('/src/');
          
          let execBin: string;
          let entryPoint: string;
          if (isFromSource) {
            // Development: use tsx to run the TypeScript source
            execBin = path.resolve(path.dirname(currentFile), '..', '..', '..', '..', 'node_modules', '.bin', 'tsx');
            entryPoint = path.resolve(path.dirname(currentFile), '..', 'index.ts');
          } else {
            // Production: use node to run compiled JS
            execBin = process.execPath;
            entryPoint = path.resolve(path.dirname(currentFile), '..', 'index.js');
          }
          
          const child = spawn(execBin, [
            entryPoint,
            'gateway', 'start', '--foreground',
            ...(options.port ? ['--port', options.port] : []),
            ...(options.bind ? ['--bind', options.bind] : []),
            ...(options.token ? ['--token', options.token] : []),
          ], {
            detached: true,
            stdio: ['ignore', logFd.fd, logFd.fd],
          });
          child.unref();
          await writePid(child.pid!);
          await logFd.close();
          
          // Wait briefly and verify the process is still alive
          await new Promise(r => setTimeout(r, 1500));
          const stillRunning = await readPid();
          
          if (stillRunning) {
            console.log(chalk.green(`  🦉 Gateway started (PID ${child.pid})`));
            console.log(chalk.gray(`     http://127.0.0.1:${config.gateway.port}`));
            console.log(chalk.gray(`     Logs: ${logFile}`));
          } else {
            console.log(chalk.red('  ✘ Gateway failed to start'));
            console.log(chalk.gray(`  Check logs: cat ${logFile}`));
            process.exit(1);
          }
        }
      } catch (err: unknown) {
        await removePid();
        logger.error(`Failed to start gateway: ${(err as Error).message}`);
        process.exit(1);
      }
    });
  
  // ontofelia gateway run
  gatewayCmd
    .command('run')
    .description('Run gateway in foreground (for systemd)')
    .action(async () => {
      const config = await loadConfig();
      await startGateway(config);
      // Don't exit — keep running for systemd
    });
  
  // ontofelia gateway stop
  gatewayCmd
    .command('stop')
    .description('Stop the running gateway')
    .action(async () => {
      console.log(chalk.gray('Stopping gateway...'));
      const stopped = await stopGateway();
      if (stopped) {
        console.log(chalk.green('✔ Gateway stopped'));
      } else {
        console.log(chalk.yellow('No running gateway found'));
      }
    });
  
  // ontofelia gateway restart
  gatewayCmd
    .command('restart')
    .description('Restart the gateway')
    .action(async () => {
      console.log(chalk.gray('Restarting gateway...'));
      await stopGateway();
      
      // Wait briefly for ports to free up
      await new Promise(r => setTimeout(r, 1000));
      
      try {
        const config = await loadConfig();
        await writePid(process.pid);
        
        const cleanup = async () => { await removePid(); process.exit(0); };
        process.on('SIGINT', cleanup);
        process.on('SIGTERM', cleanup);
        
        await startGateway(config);
      } catch (err: unknown) {
        await removePid();
        logger.error(`Failed to start gateway: ${(err as Error).message}`);
        process.exit(1);
      }
    });
  
}