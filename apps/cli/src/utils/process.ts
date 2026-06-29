import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { execFile, exec } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);
const execAsync = promisify(exec);
const PID_FILE = path.join(os.homedir(), '.ontofelia', 'gateway.pid');

export async function readPid(): Promise<number | null> {
  try {
    const content = await fs.readFile(PID_FILE, 'utf-8');
    const pid = parseInt(content.trim(), 10);
    if (isNaN(pid)) return null;
    // Check if process is alive
    try { process.kill(pid, 0); return pid; } catch { return null; }
  } catch { return null; }
}

export async function writePid(pid: number): Promise<void> {
  await fs.writeFile(PID_FILE, String(pid), 'utf-8');
}

export async function removePid(): Promise<void> {
  try { await fs.unlink(PID_FILE); } catch { /* ignore */ }
}

export async function getPidsByPort(port: number): Promise<number[]> {
  if (process.platform === 'win32') {
    try {
      const { stdout } = await execAsync('netstat -ano');
      const lines = stdout.split('\n');
      const pids = new Set<number>();
      const portStr = `:${port}`;
      for (const line of lines) {
        if (line.includes(portStr) && (line.includes('LISTENING') || line.includes('ESTABLISHED'))) {
          const parts = line.trim().split(/\s+/);
          const pid = parseInt(parts[parts.length - 1], 10);
          if (!isNaN(pid) && pid > 0) {
            pids.add(pid);
          }
        }
      }
      return Array.from(pids);
    } catch {
      return [];
    }
  } else {
    try {
      const { stdout } = await execFileAsync('lsof', ['-ti', `:${port}`]);
      return stdout.trim().split('\n').filter(Boolean).map(Number);
    } catch {
      return [];
    }
  }
}

export async function stopGateway(): Promise<boolean> {
  const pid = await readPid();
  if (!pid) {
    // Fallback: find by port
    try {
      const pids = await getPidsByPort(18780);
      if (pids.length === 0) return false;
      for (const p of pids) {
        try { process.kill(p, 'SIGTERM'); } catch { /* ignore */ }
      }
      // Also kill Fuseki
      try {
        const fusekiPids = await getPidsByPort(18787);
        for (const p of fusekiPids) {
          try { process.kill(p, 'SIGTERM'); } catch { /* ignore */ }
        }
      } catch { /* no fuseki */ }
      await removePid();
      return true;
    } catch { return false; }
  }
  
  try {
    process.kill(pid, 'SIGTERM');
    // Wait up to 5s for graceful shutdown
    for (let i = 0; i < 50; i++) {
      await new Promise(r => setTimeout(r, 100));
      try { process.kill(pid, 0); } catch { break; }
    }
    // Force kill if still alive
    try { process.kill(pid, 'SIGKILL'); } catch { /* already dead */ }
  } catch { /* already dead */ }
  
  await removePid();
  return true;
}

