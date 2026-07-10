import { describe, it, expect } from 'vitest';
import { ok, resolveAgentId, PRIMARY_AGENT_ID } from '../index.js';

describe('core', () => {
  it('should be true', () => {
    expect(ok(true).isOk()).toBe(true);
  });
});

describe('resolveAgentId', () => {
  it('maps the "default" placeholder to the primary agent (regression #1058)', () => {
    // `ontofelia cron add` stores agentId "default"; the scheduler/trigger must
    // resolve it to the primary agent rather than miss the registry.
    expect(resolveAgentId('default')).toBe(PRIMARY_AGENT_ID);
  });

  it('maps undefined / null / empty to the primary agent', () => {
    expect(resolveAgentId(undefined)).toBe(PRIMARY_AGENT_ID);
    expect(resolveAgentId(null)).toBe(PRIMARY_AGENT_ID);
    expect(resolveAgentId('')).toBe(PRIMARY_AGENT_ID);
  });

  it('passes an explicit non-default agent id through unchanged', () => {
    expect(resolveAgentId('scout')).toBe('scout');
  });
});
