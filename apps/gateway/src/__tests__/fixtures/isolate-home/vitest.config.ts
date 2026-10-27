// Config for the fixture run started by ../../isolateHomeCleanup.test.ts. The
// fixture files use a suffix the gateway's own vitest config does not collect.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['**/*.fixture.ts'],
    globalSetup: ['../../setup/global-isolate-home.ts'],
    setupFiles: ['../../setup/isolate-home.ts'],
  },
});
