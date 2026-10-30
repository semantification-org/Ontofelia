import { it } from 'vitest';

// Kills the worker process while the file is collected.
process.kill(process.pid, 'SIGKILL');

it('never runs', () => {});
