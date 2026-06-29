import * as fs from 'fs/promises';
import * as path from 'path';
import * as crypto from 'crypto';
// cron-parser@4 is CommonJS: with `import * as` the functions land under
// `.default`, so `cronParser.parseExpression` was undefined ("is not a
// function") and every cron job failed to schedule. esModuleInterop is on, so a
// default import binds module.exports correctly.
import cronParser from 'cron-parser';
import { createLogger } from '@ontofelia/core';

export interface CronJob {
  id: string;
  name: string;
  cron: string;
  agentId: string;
  prompt: string;
  enabled: boolean;
  lastRun?: string;
  nextRun?: string;
  createdAt: string;
}

export interface OneTimeJob {
  id: string;
  name: string;
  runAt: string;
  agentId: string;
  prompt: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  createdAt: string;
  completedAt?: string;
}

export class JobScheduler {
  private cronJobs = new Map<string, { job: CronJob; timer: NodeJS.Timeout | null }>();
  private oneTimeJobs = new Map<string, { job: OneTimeJob; timer: NodeJS.Timeout | null }>();
  private jobHandler?: (job: CronJob | OneTimeJob) => Promise<void>;
  private logger = createLogger('scheduler');
  private jobsFilePath: string;

  constructor(private storePath: string) {
    this.jobsFilePath = path.join(this.storePath, 'jobs.json');
  }

  async load(): Promise<void> {
    try {
      await fs.mkdir(this.storePath, { recursive: true });
      const data = await fs.readFile(this.jobsFilePath, 'utf-8');
      const parsed = JSON.parse(data);

      if (parsed.cronJobs) {
        for (const job of parsed.cronJobs) {
          this.cronJobs.set(job.id, { job, timer: null });
        }
      }
      if (parsed.oneTimeJobs) {
        for (const job of parsed.oneTimeJobs) {
          this.oneTimeJobs.set(job.id, { job, timer: null });
        }
      }
      this.logger.info(`Loaded ${this.cronJobs.size} cron jobs and ${this.oneTimeJobs.size} one-time jobs.`);
    } catch (e: unknown) {
      const err = e as NodeJS.ErrnoException;
      if (err.code === 'ENOENT') {
        this.logger.info('No jobs file found, starting fresh.');
      } else {
        this.logger.error(`Failed to load jobs: ${err.message}`);
      }
    }
  }

  async save(): Promise<void> {
    try {
      await fs.mkdir(this.storePath, { recursive: true });
      const data = {
        cronJobs: Array.from(this.cronJobs.values()).map(c => c.job),
        oneTimeJobs: Array.from(this.oneTimeJobs.values()).map(o => o.job)
      };
      await fs.writeFile(this.jobsFilePath, JSON.stringify(data, null, 2), 'utf-8');
    } catch (e: unknown) {
      this.logger.error(`Failed to save jobs: ${(e as Error).message}`);
    }
  }

  onJob(handler: (job: CronJob | OneTimeJob) => Promise<void>): void {
    this.jobHandler = handler;
  }

  async addCronJob(job: Omit<CronJob, 'id' | 'createdAt'>): Promise<CronJob> {
    const id = crypto.randomUUID();
    const newJob: CronJob = {
      ...job,
      id,
      createdAt: new Date().toISOString()
    };
    
    // Validate and set nextRun
    try {
      const interval = cronParser.parseExpression(job.cron);
      newJob.nextRun = interval.next().toISOString();
    } catch (err: unknown) {
      throw new Error(`Invalid cron expression: ${(err as Error).message}`);
    }

    this.cronJobs.set(id, { job: newJob, timer: null });
    await this.save();
    
    if (newJob.enabled) {
      this.scheduleCronJob(id);
    }
    
    return newJob;
  }

  async addOneTimeJob(job: Omit<OneTimeJob, 'id' | 'createdAt' | 'status'>): Promise<OneTimeJob> {
    const id = crypto.randomUUID();
    const newJob: OneTimeJob = {
      ...job,
      id,
      status: 'pending',
      createdAt: new Date().toISOString()
    };

    if (new Date(newJob.runAt).getTime() < Date.now()) {
      throw new Error('runAt must be in the future');
    }

    this.oneTimeJobs.set(id, { job: newJob, timer: null });
    await this.save();
    this.scheduleOneTimeJob(id);
    
    return newJob;
  }

  async removeJob(id: string): Promise<boolean> {
    let removed = false;
    
    if (this.cronJobs.has(id)) {
      const { timer } = this.cronJobs.get(id)!;
      if (timer) clearTimeout(timer);
      this.cronJobs.delete(id);
      removed = true;
    }
    
    if (this.oneTimeJobs.has(id)) {
      const { timer } = this.oneTimeJobs.get(id)!;
      if (timer) clearTimeout(timer);
      this.oneTimeJobs.delete(id);
      removed = true;
    }

    if (removed) {
      await this.save();
    }
    return removed;
  }

  listCronJobs(): CronJob[] {
    return Array.from(this.cronJobs.values()).map(c => c.job);
  }

  listOneTimeJobs(): OneTimeJob[] {
    return Array.from(this.oneTimeJobs.values()).map(o => o.job);
  }

  start(): void {
    for (const id of this.cronJobs.keys()) {
      const { job } = this.cronJobs.get(id)!;
      if (job.enabled) {
        this.scheduleCronJob(id);
      }
    }
    
    for (const id of this.oneTimeJobs.keys()) {
      const { job } = this.oneTimeJobs.get(id)!;
      if (job.status === 'pending') {
        this.scheduleOneTimeJob(id);
      }
    }
  }

  stop(): void {
    for (const { timer } of this.cronJobs.values()) {
      if (timer) clearTimeout(timer);
    }
    for (const { timer } of this.oneTimeJobs.values()) {
      if (timer) clearTimeout(timer);
    }
  }

  async triggerJob(id: string): Promise<void> {
    if (this.cronJobs.has(id)) {
      await this.executeJob(this.cronJobs.get(id)!.job);
    } else if (this.oneTimeJobs.has(id)) {
      await this.executeJob(this.oneTimeJobs.get(id)!.job);
    } else {
      throw new Error(`Job not found: ${id}`);
    }
  }

  private scheduleCronJob(id: string) {
    const entry = this.cronJobs.get(id);
    if (!entry) return;
    
    if (entry.timer) {
      clearTimeout(entry.timer);
      entry.timer = null;
    }
    
    const { job } = entry;
    if (!job.enabled) return;

    try {
      const interval = cronParser.parseExpression(job.cron);
      const nextDate = interval.next().toDate();
      job.nextRun = nextDate.toISOString();
      
      const delay = nextDate.getTime() - Date.now();
      
      // If delay is huge, we cap it due to setTimeout 32-bit limit (max ~24.8 days)
      const MAX_DELAY = 2147483647;
      
      if (delay > MAX_DELAY) {
        entry.timer = setTimeout(() => this.scheduleCronJob(id), MAX_DELAY);
      } else {
        entry.timer = setTimeout(async () => {
          await this.executeJob(job);
          this.scheduleCronJob(id); // schedule next
        }, Math.max(0, delay));
      }
      
      // Save nextRun state
      this.save().catch(e => this.logger.error(`Failed to save job nextRun: ${e.message}`));
    } catch (e: unknown) {
      this.logger.error(`Failed to schedule cron job ${id}: ${(e as Error).message}`);
    }
  }

  private scheduleOneTimeJob(id: string) {
    const entry = this.oneTimeJobs.get(id);
    if (!entry) return;
    
    if (entry.timer) {
      clearTimeout(entry.timer);
      entry.timer = null;
    }
    
    const { job } = entry;
    if (job.status !== 'pending') return;
    
    const delay = new Date(job.runAt).getTime() - Date.now();
    const MAX_DELAY = 2147483647;
    
    if (delay > MAX_DELAY) {
      entry.timer = setTimeout(() => this.scheduleOneTimeJob(id), MAX_DELAY);
    } else {
      entry.timer = setTimeout(async () => {
        job.status = 'running';
        await this.save();
        await this.executeJob(job);
      }, Math.max(0, delay));
    }
  }

  private async executeJob(job: CronJob | OneTimeJob) {
    const isCron = 'cron' in job;
    const startedAt = new Date().toISOString();
    
    try {
      if (this.jobHandler) {
        await this.jobHandler(job);
      }
      
      const completedAt = new Date().toISOString();
      if (isCron) {
        (job as CronJob).lastRun = completedAt;
      } else {
        (job as OneTimeJob).status = 'completed';
        (job as OneTimeJob).completedAt = completedAt;
      }
      
      await this.save();
      await this.logJobExecution(job.id, job.name, startedAt, completedAt, true);
    } catch (e: unknown) {
      const err = e as Error;
      this.logger.error(`Job execution failed: ${job.name} - ${err.message}`);
      
      const completedAt = new Date().toISOString();
      if (!isCron) {
        (job as OneTimeJob).status = 'failed';
        (job as OneTimeJob).completedAt = completedAt;
      }
      
      await this.save();
      await this.logJobExecution(job.id, job.name, startedAt, completedAt, false, undefined, err.message);
    }
  }

  private async logJobExecution(jobId: string, jobName: string, startedAt: string, completedAt: string, success: boolean, response?: string, error?: string) {
    const logsDir = path.join(this.storePath, 'logs');
    await fs.mkdir(logsDir, { recursive: true });
    
    const dateStr = startedAt.split('T')[0];
    const logFile = path.join(logsDir, `${dateStr}.jsonl`);
    
    const entry = {
      jobId,
      jobName,
      startedAt,
      completedAt,
      success,
      response,
      error
    };
    
    await fs.appendFile(logFile, JSON.stringify(entry) + '\n', 'utf-8');
  }
}
