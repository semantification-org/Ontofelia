import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globalSetup: ['./src/__tests__/setup/global-isolate-home.ts'],
    setupFiles: ['./src/__tests__/setup/isolate-home.ts'],
  },
});
