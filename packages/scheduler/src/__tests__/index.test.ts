import { describe, it, expect } from 'vitest';
import { JobScheduler, WebhookRegistry } from '../index.js';

describe('JobScheduler', () => {
  it('should initialize', () => {
    const scheduler = new JobScheduler('/tmp/test-scheduler');
    expect(scheduler).toBeDefined();
  });
});

describe('WebhookRegistry', () => {
  it('should initialize', () => {
    const registry = new WebhookRegistry('/tmp/test-webhooks');
    expect(registry).toBeDefined();
  });
});
