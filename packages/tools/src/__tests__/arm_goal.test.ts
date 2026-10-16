import { describe, it, expect } from 'vitest';
import type { ToolContext } from '@ontofelia/core';
import { ArmGoalTool, type ArmGoalPortRequest, type ArmGoalPortResult } from '../cognitive/arm_goal.js';

const ctx = (over: Partial<ToolContext> = {}): ToolContext =>
  ({
    agentId: 'a',
    sessionId: 's',
    workspacePath: '/tmp',
    channelType: 'webchat',
    senderId: 'u',
    isOwner: true,
    ownerPresent: true,
    inboundEpisodeUri: 'urn:a:cog:episode:1',
    ...over,
  }) as ToolContext;

function makeTool(result: ArmGoalPortResult | undefined) {
  const calls: ArmGoalPortRequest[] = [];
  const tool = new ArmGoalTool({
    arm: async (req) => {
      calls.push(req);
      return result;
    },
  });
  return { tool, calls };
}

const armed = (over: Partial<Extract<ArmGoalPortResult, { ok: true }>> = {}): ArmGoalPortResult => ({
  ok: true,
  created: true,
  label: 'Review',
  goalUri: 'urn:a:cog:goal:1',
  wakeAt: '2026-06-01T14:00:00.000Z',
  scheduled: true,
  activated: false,
  initiativeEnabled: true,
  ...over,
});

describe('ArmGoalTool', () => {
  it('forwards the current turn\'s episode as the mandate and reports what was armed', async () => {
    const { tool, calls } = makeTool(armed({ every: 'P1D' }));
    const res = await tool.execute({ newGoal: 'Review', wakeIn: 'PT2H', every: 'P1D' }, ctx());
    expect(res.success).toBe(true);
    expect(calls).toEqual([
      expect.objectContaining({ mandateEpisodeUri: 'urn:a:cog:episode:1', newGoal: 'Review', wakeIn: 'PT2H', every: 'P1D', sessionId: 's' }),
    ]);
    expect(String(res.output)).toContain('2026-06-01T14:00:00.000Z');
    expect(String(res.output)).toContain('every P1D');
    expect(String(res.output)).not.toContain('/initiative on');
  });

  it('adds the reminder when initiative is off', async () => {
    const { tool } = makeTool(armed({ initiativeEnabled: false }));
    const res = await tool.execute({ newGoal: 'Review', wakeIn: 'PT2H' }, ctx());
    expect(String(res.output)).toContain('will not fire until the owner runs /initiative on');
  });

  it('refuses non-owners, unattended contexts and turns without an episode, without calling the port', async () => {
    const { tool, calls } = makeTool(armed());
    const nonOwner = await tool.execute({ newGoal: 'x', wakeIn: 'PT2H' }, ctx({ isOwner: false }));
    const unattended = await tool.execute({ newGoal: 'x', wakeIn: 'PT2H' }, ctx({ unattended: true }));
    const noEpisode = await tool.execute({ newGoal: 'x', wakeIn: 'PT2H' }, ctx({ inboundEpisodeUri: undefined }));
    expect([nonOwner.success, unattended.success, noEpisode.success]).toEqual([false, false, false]);
    expect(String(noEpisode.output)).toContain('cog.flagCycleManager');
    expect(calls).toHaveLength(0);
  });

  it('passes a port refusal through as a failure', async () => {
    const { tool } = makeTool({ ok: false, message: 'Wake interval "PT10M" is below the minimum' });
    const res = await tool.execute({ newGoal: 'x', wakeIn: 'PT2H', every: 'PT10M' }, ctx());
    expect(res.success).toBe(false);
    expect(String(res.output)).toContain('is below the minimum');
  });

  it('declares memory:write and is not a read-only tool', () => {
    expect(makeTool(undefined).tool.permissions).toEqual(['memory:write']);
  });
});
