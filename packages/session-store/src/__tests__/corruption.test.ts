import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { SessionStore } from '../index.js';

describe('SessionStore corruption and edge cases', () => {
  let tmpDir: string;
  let sessionStore: SessionStore;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ontofelia-session-test-'));
    sessionStore = new SessionStore(tmpDir);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  it('handles empty database gracefully', async () => {
    const sessions = await sessionStore.listSessions('default');
    expect(sessions).toEqual([]);
  });

  it('recovers from corrupt transcript JSONL file', async () => {
    const session = await sessionStore.getOrCreateSession('default', 'main', { channel: 'webchat', chatType: 'dm', senderId: 'u1', accountId: 'none' });
    await sessionStore.appendTranscript(session.sessionId, { timestamp: '2023-01-01', role: 'user', content: 'hello' });
    
    const transcriptPath = path.join(tmpDir, 'transcripts', `${session.sessionId}.jsonl`);
    // Append corrupt line
    await fs.appendFile(transcriptPath, '\n{ invalid json }\n');
    // Append valid line
    await fs.appendFile(transcriptPath, '{"timestamp":"2023-01-02","role":"assistant","content":"world"}\n');

    const transcript = await sessionStore.loadTranscript(session.sessionId);
    // Should ignore the corrupt line and load the valid ones
    expect(transcript.length).toBe(2);
    expect(transcript[0].content).toBe('hello');
    expect(transcript[1].content).toBe('world');
  });
});
