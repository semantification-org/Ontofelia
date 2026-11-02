import { describe, it, expect } from 'vitest';
import type { ToolContext } from '@ontofelia/core';
import type { OntologyManager, OntologyProposal } from '@ontofelia/semantic-memory';
import { OntologyProposeTool } from '../memory/ontology_propose.js';

const ctx = (over: Partial<ToolContext> = {}): ToolContext =>
  ({
    agentId: 'a',
    sessionId: 's',
    workspacePath: '/tmp',
    channelType: 'webchat',
    senderId: 'u',
    isOwner: true,
    ownerPresent: true,
    ...over,
  }) as ToolContext;

function makeTool() {
  const saved: OntologyProposal[] = [];
  const approved: string[] = [];
  const manager = {
    saveProposal: async (p: OntologyProposal) => { saved.push(p); },
    approveProposal: async (id: string) => { approved.push(id); },
  } as unknown as OntologyManager;
  return { tool: new OntologyProposeTool(manager), saved, approved };
}

const input = { description: 'single-valued', turtlePatch: '<urn:x:p> a <http://www.w3.org/2002/07/owl#FunctionalProperty> .', autoApprove: true };

describe('OntologyProposeTool autoApprove', () => {
  it('approves at once for the owner in a live conversation', async () => {
    const { tool, saved, approved } = makeTool();
    const res = await tool.execute(input, ctx());
    expect(res.success).toBe(true);
    expect(String(res.output)).toContain('automatically approved');
    expect(approved).toEqual([saved[0].id]);
  });

  it.each([
    ['a non-owner', { isOwner: false, ownerPresent: false }],
    ['a non-owner who claims presence', { isOwner: false, ownerPresent: true }],
    ['a synthetic owner turn (scheduler, webhook)', { isOwner: true, ownerPresent: false }],
    ['an unattended initiative cycle', { isOwner: true, ownerPresent: true, unattended: true }],
  ])('leaves the proposal pending for %s and says so', async (_who, over) => {
    const { tool, saved, approved } = makeTool();
    const res = await tool.execute(input, ctx(over));
    expect(res.success).toBe(true);
    expect(approved).toEqual([]);
    expect(saved).toHaveLength(1);
    expect(saved[0].status).toBe('pending');
    expect(String(res.output)).toContain('pending approval');
    expect(String(res.output)).toContain('reserved for the owner');
  });

  it('without autoApprove nobody approves, and the message does not mention the reservation', async () => {
    const { tool, approved } = makeTool();
    const res = await tool.execute({ ...input, autoApprove: false }, ctx());
    expect(approved).toEqual([]);
    expect(String(res.output)).toContain('pending approval');
    expect(String(res.output)).not.toContain('reserved');
  });
});
