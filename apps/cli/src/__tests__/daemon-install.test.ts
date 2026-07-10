import { describe, it, expect } from 'vitest';
import * as path from 'path';
import { resolveDaemonCliEntry } from '../commands/channel.js';

// Regression: `daemon install` computed the systemd ExecStart cliPath as
// `<commandDir>/../dist/index.js`. The command compiles to
// apps/cli/dist/commands/channel.js, so that produced
// apps/cli/dist/dist/index.js — which does not exist — and the generated unit
// crash-looped. The entrypoint is exactly one level up from dist/commands.
describe('resolveDaemonCliEntry — daemon install ExecStart path', () => {
  it('maps dist/commands -> dist/index.js', () => {
    expect(resolveDaemonCliEntry('/opt/app/apps/cli/dist/commands'))
      .toBe('/opt/app/apps/cli/dist/index.js');
  });

  it('never emits a doubled dist segment', () => {
    const entry = resolveDaemonCliEntry('/opt/app/apps/cli/dist/commands');
    expect(entry).not.toContain(`dist${path.sep}dist`);
    expect(path.basename(entry)).toBe('index.js');
    expect(path.basename(path.dirname(entry))).toBe('dist');
  });
});
