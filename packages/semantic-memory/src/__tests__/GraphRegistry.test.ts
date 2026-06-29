import { describe, it, expect } from 'vitest';
import { GraphRegistry, GraphPolicyError } from '../utils/GraphRegistry.js';
import { GraphUriResolver, SHARED_GRAPHS } from '../utils/GraphUriResolver.js';

describe('GraphRegistry', () => {
  describe('shared graphs', () => {
    it('accepts every shared graph from the concept', () => {
      const registry = GraphRegistry.create(['ontofelia']);
      for (const uri of Object.values(SHARED_GRAPHS)) {
        expect(registry.isAllowed(uri)).toBe(true);
        expect(registry.describe(uri)?.role).toBe('shared');
      }
    });
  });

  describe('agent graphs', () => {
    const registry = GraphRegistry.create(['ontofelia']);

    it('accepts the nine fixed per-agent graphs', () => {
      const fixed = [
        GraphUriResolver.getSelfGraph('ontofelia'),
        GraphUriResolver.getSkillsGraph('ontofelia'),
        GraphUriResolver.getSetupGraph('ontofelia'),
        GraphUriResolver.getClaimsGraph('ontofelia'),
        GraphUriResolver.getEvidenceGraph('ontofelia'),
        GraphUriResolver.getWorldviewGraph('ontofelia'),
        GraphUriResolver.getSchemaGraph('ontofelia'),
        GraphUriResolver.getConflictsGraph('ontofelia'),
        GraphUriResolver.getInferredGraph('ontofelia'),
      ];
      for (const uri of fixed) {
        expect(registry.isAllowed(uri)).toBe(true);
      }
    });

    it('accepts parameterised user and session graphs of a registered agent', () => {
      expect(registry.isAllowed('urn:ontofelia:user:owner')).toBe(true);
      expect(registry.isAllowed('urn:ontofelia:user:testuser')).toBe(true);
      expect(registry.isAllowed('urn:ontofelia:session:sess_abc123')).toBe(true);
    });

    it('rejects parameterised graphs with an empty identifier', () => {
      expect(registry.isAllowed('urn:ontofelia:user:')).toBe(false);
    });
  });

  describe('cognitive architecture graphs', () => {
    const registry = GraphRegistry.create(['ontofelia']);

    it('exposes resolver helpers that match the concept URIs', () => {
      expect(GraphUriResolver.getCogEpisodicGraph('ontofelia')).toBe('urn:ontofelia:cog:episodic');
      expect(GraphUriResolver.getCogProceduralGraph('ontofelia')).toBe(
        'urn:ontofelia:cog:procedural',
      );
      expect(GraphUriResolver.getCogMetaGraph('ontofelia')).toBe('urn:ontofelia:cog:meta');
      expect(GraphUriResolver.getCogWorkingGraph('ontofelia', 's1', 'c1')).toBe(
        'urn:ontofelia:cog:working:s1:c1',
      );
      expect(GraphUriResolver.getCogGoalsSessionGraph('ontofelia', 's1')).toBe(
        'urn:ontofelia:cog:goals:s1',
      );
      expect(GraphUriResolver.getCogGoalsLongtermGraph('ontofelia')).toBe(
        'urn:ontofelia:cog:goals:longterm',
      );
      expect(GraphUriResolver.getCogCyclesGraph('ontofelia', 's1')).toBe(
        'urn:ontofelia:cog:cycles:s1',
      );
    });

    it('accepts the three fixed cog graphs with the right roles', () => {
      expect(registry.describe('urn:ontofelia:cog:episodic')?.role).toBe('cog-episodic');
      expect(registry.describe('urn:ontofelia:cog:procedural')?.role).toBe('cog-procedural');
      expect(registry.describe('urn:ontofelia:cog:meta')?.role).toBe('cog-meta');
      for (const uri of [
        'urn:ontofelia:cog:episodic',
        'urn:ontofelia:cog:procedural',
        'urn:ontofelia:cog:meta',
      ]) {
        expect(registry.describe(uri)?.parameterised).toBe(false);
      }
    });

    it('accepts parameterised working/goals/cycles graphs with the right roles', () => {
      const working = registry.describe('urn:ontofelia:cog:working:sessA:cyc1');
      expect(working?.role).toBe('cog-working');
      expect(working?.parameterised).toBe(true);
      expect(working?.agentId).toBe('ontofelia');

      expect(registry.describe('urn:ontofelia:cog:goals:sessA')?.role).toBe('cog-goals');
      // The reserved longterm scope is a normal goals graph.
      expect(registry.describe('urn:ontofelia:cog:goals:longterm')?.role).toBe('cog-goals');
      expect(registry.describe('urn:ontofelia:cog:cycles:sessA')?.role).toBe('cog-cycles');
    });

    it('enforces arity: working needs a cycle, goals/cycles must not have one', () => {
      // working without a cycle scope is malformed.
      expect(registry.isAllowed('urn:ontofelia:cog:working:sessA')).toBe(false);
      // goals/cycles with an extra scope segment is malformed.
      expect(registry.isAllowed('urn:ontofelia:cog:goals:sessA:extra')).toBe(false);
      expect(registry.isAllowed('urn:ontofelia:cog:cycles:sessA:extra')).toBe(false);
    });

    it('rejects cog graphs of an unregistered agent and unknown kinds', () => {
      expect(registry.isAllowed('urn:john:cog:episodic')).toBe(false);
      expect(registry.isAllowed('urn:john:cog:working:s:c')).toBe(false);
      expect(registry.isAllowed('urn:ontofelia:cog:bogus')).toBe(false);
      expect(registry.isAllowed('urn:ontofelia:cog:working::c')).toBe(false);
    });
  });

  describe('rejection of non-conformant graphs', () => {
    const registry = GraphRegistry.create(['ontofelia']);

    it('rejects the legacy "default" agent graphs', () => {
      // These are exactly the URIs the agentId bug produced.
      expect(registry.isAllowed('urn:default:claims')).toBe(false);
      expect(registry.isAllowed('urn:default:evidence')).toBe(false);
      expect(registry.isAllowed('urn:default:user:owner')).toBe(false);
    });

    it('rejects the non-concept inferred graph shape', () => {
      expect(registry.isAllowed('urn:ontofelia:agent:default:inferred')).toBe(false);
    });

    it('rejects graphs of an unregistered agent', () => {
      expect(registry.isAllowed('urn:john:claims')).toBe(false);
      expect(registry.isAllowed('urn:john:user:owner')).toBe(false);
    });

    it('rejects a freely hallucinated graph URI', () => {
      expect(registry.isAllowed('urn:ontofelia:worldview_proposal_v2')).toBe(false);
      expect(registry.isAllowed('http://example.com/graph')).toBe(false);
    });
  });

  describe('assertWritable', () => {
    const registry = GraphRegistry.create(['ontofelia']);

    it('returns a descriptor for a conformant graph', () => {
      const d = registry.assertWritable('urn:ontofelia:claims');
      expect(d.role).toBe('claims');
      expect(d.agentId).toBe('ontofelia');
    });

    it('throws GraphPolicyError for a non-conformant graph', () => {
      expect(() => registry.assertWritable('urn:default:claims')).toThrow(GraphPolicyError);
    });

    it('produces an LLM-readable message that lists the allowed graphs', () => {
      try {
        registry.assertWritable('urn:default:claims');
        throw new Error('should have thrown');
      } catch (e) {
        expect(e).toBeInstanceOf(GraphPolicyError);
        const err = e as GraphPolicyError;
        expect(err.attemptedGraph).toBe('urn:default:claims');
        expect(err.message).toContain('not a registered Named Graph');
        expect(err.message).toContain('urn:ontofelia:claims');
        expect(err.allowedGraphs.length).toBeGreaterThan(0);
      }
    });
  });

  describe('registerAgent', () => {
    it('widens the whitelist for a newly registered agent', () => {
      const registry = GraphRegistry.create(['ontofelia']);
      expect(registry.isAllowed('urn:john:claims')).toBe(false);

      registry.registerAgent('john');

      expect(registry.hasAgent('john')).toBe(true);
      expect(registry.isAllowed('urn:john:claims')).toBe(true);
      expect(registry.isAllowed('urn:john:user:owner')).toBe(true);
      // The original agent is untouched.
      expect(registry.isAllowed('urn:ontofelia:claims')).toBe(true);
    });

    it('rejects an agent id that is not a lowercase identifier', () => {
      const registry = GraphRegistry.create(['ontofelia']);
      expect(() => registry.registerAgent('John')).toThrow(GraphPolicyError);
      expect(() => registry.registerAgent('urn:evil')).toThrow(GraphPolicyError);
    });
  });
});
