import type { TriplestoreAdapter } from '@ontofelia/core';
import { KnowledgeEngine, GraphRegistry, GraphUriResolver } from '@ontofelia/semantic-memory';
import { fileURLToPath } from 'url';
import { seedDefaultsForFreshInstall, type SeedDefaultsResult } from '../cognitive/CognitiveDefaults.js';
import { AGENT } from './promptHarness.js';

// What the gateway boot does for a new install, on a test store: seed the core
// graphs from the repo's bootstrap files, then run the default-on step with the
// same "self graph was seeded in this boot" signal the gateway passes.

const BOOTSTRAP_DIR = fileURLToPath(new URL('../../../../bootstrap', import.meta.url));

export async function bootFreshInstall(store: TriplestoreAdapter, now?: Date): Promise<{ seeded: string[]; defaults: SeedDefaultsResult }> {
  const ke = new KnowledgeEngine(store, undefined, GraphRegistry.create([AGENT]));
  const { seeded } = await ke.seedCoreGraphs(BOOTSTRAP_DIR, AGENT);
  const fresh = seeded.includes(GraphUriResolver.getSelfGraph(AGENT));
  const defaults = await seedDefaultsForFreshInstall(store, AGENT, fresh, now);
  return { seeded, defaults };
}
