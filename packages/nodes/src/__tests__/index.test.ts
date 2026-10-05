import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import { NodeRegistry, PairingRefusedError } from '../index.js';

const chat = [{ type: 'chat' as const, capabilities: { text: true } }];

describe('NodeRegistry pairing limits', () => {
  let registry: NodeRegistry;

  beforeEach(() => {
    vi.useFakeTimers();
    registry = new NodeRegistry(path.join(os.tmpdir(), 'ontofelia-nodes-unused.json'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('creates a pending pairing with a code', async () => {
    const { code, nodeId } = await registry.createPairingRequest({ name: 'Kitchen', surfaces: chat });
    expect(code).toMatch(/^[A-Z2-9]{8}$/);
    expect(nodeId).toBeTruthy();
    expect(registry.hasPendingPairing(code)).toBe(true);
  });

  it('refuses when the pending cap is reached and creates nothing', async () => {
    const codes: string[] = [];
    for (let i = 0; i < NodeRegistry.MAX_PENDING_PAIRINGS; i++) {
      codes.push((await registry.createPairingRequest({ name: `n${i}`, surfaces: chat })).code);
    }
    await expect(registry.createPairingRequest({ name: 'extra', surfaces: chat })).rejects.toThrow('Too many pending pairing requests');
    expect(vi.getTimerCount()).toBe(NodeRegistry.MAX_PENDING_PAIRINGS);
    expect(codes.filter((c) => registry.hasPendingPairing(c))).toHaveLength(NodeRegistry.MAX_PENDING_PAIRINGS);
  });

  it('frees a slot on approve and on reject', async () => {
    const pending: string[] = [];
    for (let i = 0; i < NodeRegistry.MAX_PENDING_PAIRINGS; i++) {
      pending.push((await registry.createPairingRequest({ name: `n${i}`, surfaces: chat })).code);
    }
    // Avoid touching the disk in approvePairing.
    vi.spyOn(registry, 'save').mockResolvedValue();
    const node = await registry.approvePairing(pending[0].toLowerCase());
    expect(node?.status).toBe('paired');
    await expect(registry.createPairingRequest({ name: 'a', surfaces: chat })).resolves.toBeTruthy();
    expect(await registry.rejectPairing(pending[1])).toBe(true);
    await expect(registry.createPairingRequest({ name: 'b', surfaces: chat })).resolves.toBeTruthy();
    expect(await registry.rejectPairing('NOPE2345')).toBe(false);
  });

  it('expires pending pairings after PAIRING_EXPIRY_MS', async () => {
    expect(NodeRegistry.PAIRING_EXPIRY_MS).toBe(10 * 60 * 1000);
    const { code } = await registry.createPairingRequest({ name: 'Kitchen', surfaces: chat });
    vi.advanceTimersByTime(NodeRegistry.PAIRING_EXPIRY_MS - 1);
    expect(registry.hasPendingPairing(code)).toBe(true);
    vi.advanceTimersByTime(1);
    expect(registry.hasPendingPairing(code)).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('clears the expiry timer on approve and reject', async () => {
    vi.spyOn(registry, 'save').mockResolvedValue();
    const a = await registry.createPairingRequest({ name: 'a', surfaces: chat });
    const b = await registry.createPairingRequest({ name: 'b', surfaces: chat });
    await registry.approvePairing(a.code);
    await registry.rejectPairing(b.code);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('trims the name and enforces its length', async () => {
    const { nodeId, code } = await registry.createPairingRequest({ name: '  Kitchen  ', surfaces: chat });
    vi.spyOn(registry, 'save').mockResolvedValue();
    await registry.approvePairing(code);
    expect(registry.get(nodeId)?.name).toBe('Kitchen');
    await expect(registry.createPairingRequest({ name: 'x'.repeat(64), surfaces: chat })).resolves.toBeTruthy();
    await expect(registry.createPairingRequest({ name: 'x'.repeat(65), surfaces: chat })).rejects.toThrow(PairingRefusedError);
  });

  it('rejects empty and non-string names', async () => {
    for (const name of [undefined, '', '   ', 42, null, {}, ['a']]) {
      await expect(registry.createPairingRequest({ name: name as unknown as string, surfaces: chat })).rejects.toThrow(/Invalid name/);
    }
  });

  it('validates surfaces', async () => {
    const bad: unknown[] = [
      'chat',
      [{ type: 'chat' }],
      ['chat'],
      [{ type: 'bogus', capabilities: {} }],
      [{ type: 'chat', capabilities: { text: 'yes' } }],
      [{ type: 'chat', capabilities: { ['k'.repeat(33)]: true } }],
      Array.from({ length: NodeRegistry.MAX_SURFACES + 1 }, () => chat[0]),
    ];
    for (const surfaces of bad) {
      await expect(registry.createPairingRequest({ name: 'n', surfaces: surfaces as never })).rejects.toThrow(/Invalid surfaces/);
    }
    await expect(registry.createPairingRequest({ name: 'n' })).resolves.toBeTruthy();
    await expect(registry.createPairingRequest({ name: 'n', surfaces: [] })).resolves.toBeTruthy();
  });

  it('does not create anything when validation fails', async () => {
    await expect(registry.createPairingRequest({ name: '' })).rejects.toThrow();
    expect(vi.getTimerCount()).toBe(0);
  });
});
