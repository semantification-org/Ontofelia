import { expect, it } from 'vitest';

it('runs in an isolated home', () => {
  expect(process.env.HOME).toContain('ontofelia-gateway-home-');
});
