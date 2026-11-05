import { it } from 'vitest';

// Fails while the file is collected, so no hook of this file ever runs.
throw new Error('intentional load failure');

it('never runs', () => {});
