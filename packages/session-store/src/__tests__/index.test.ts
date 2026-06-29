import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { SessionStore, computeSessionKey } from '../index.js';
import { SessionOrigin } from '@ontofelia/core';

describe('session-store', () => {
  let tempDir: string;
  let store: SessionStore;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ontofelia-session-test-'));
    store = new SessionStore(tempDir);
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('should compute session keys correctly', () => {
    const origin: SessionOrigin = { channel: 'webchat', chatType: 'dm', senderId: 'user1' };
    expect(computeSessionKey('main', origin)).toBe('main');
    expect(computeSessionKey('per-peer', origin)).toBe('peer:user1');
    expect(computeSessionKey('per-channel-peer', origin)).toBe('webchat:user1');
  });

  it('should create a new session', async () => {
    const origin: SessionOrigin = { channel: 'webchat', chatType: 'dm', senderId: 'user1' };
    const session = await store.getOrCreateSession('agent1', 'per-peer', origin);
    
    expect(session.agentId).toBe('agent1');
    expect(session.sessionKey).toBe('peer:user1');
    expect(session.messageCount).toBe(0);
    expect(session.status).toBe('active');
  });

  it('should return existing session if active', async () => {
    const origin: SessionOrigin = { channel: 'webchat', chatType: 'dm', senderId: 'user1' };
    const session1 = await store.getOrCreateSession('agent1', 'per-peer', origin);
    const session2 = await store.getOrCreateSession('agent1', 'per-peer', origin);
    
    expect(session1.sessionId).toBe(session2.sessionId);
  });

  it('should append and load transcript', async () => {
    const origin: SessionOrigin = { channel: 'webchat', chatType: 'dm', senderId: 'user1' };
    const session = await store.getOrCreateSession('agent1', 'per-peer', origin);
    
    await store.appendTranscript(session.sessionId, {
      timestamp: new Date().toISOString(),
      role: 'user',
      content: 'Hello'
    });
    
    await store.appendTranscript(session.sessionId, {
      timestamp: new Date().toISOString(),
      role: 'assistant',
      content: 'Hi there',
      tokenCount: 10
    });

    const transcript = await store.loadTranscript(session.sessionId);
    expect(transcript.length).toBe(2);
    expect(transcript[0].content).toBe('Hello');
    expect(transcript[1].content).toBe('Hi there');
    
    const updatedSession = await store.getSession(session.sessionId);
    expect(updatedSession?.messageCount).toBe(2);
    expect(updatedSession?.totalTokens).toBe(10);
  });

  it('should hard reset session', async () => {
    const origin: SessionOrigin = { channel: 'webchat', chatType: 'dm', senderId: 'user1' };
    const session = await store.getOrCreateSession('agent1', 'per-peer', origin);
    
    await store.appendTranscript(session.sessionId, {
      timestamp: new Date().toISOString(),
      role: 'user',
      content: 'Hello'
    });
    
    await store.resetSession(session.sessionId, 'hard');
    
    const updatedSession = await store.getSession(session.sessionId);
    expect(updatedSession?.messageCount).toBe(0);
    expect(updatedSession?.totalTokens).toBe(0);
    
    const transcript = await store.loadTranscript(session.sessionId);
    expect(transcript.length).toBe(0);
  });
});
