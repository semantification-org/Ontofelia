import crypto from 'crypto';

/**
 * Performs a timing-safe string comparison.
 * Protects against timing attacks by ensuring the comparison time depends
 * only on the string length, not on the contents.
 * If the lengths differ, it compares the actual string against itself to
 * maintain constant time execution regardless of length match.
 */
export function safeCompareSecret(actual: string | undefined | null, expected: string): boolean {
  if (typeof actual !== 'string' || typeof expected !== 'string') {
    return false;
  }
  
  const expectedBuffer = Buffer.from(expected, 'utf-8');
  const actualBuffer = Buffer.from(actual, 'utf-8');

  if (expectedBuffer.length !== actualBuffer.length) {
    // Perform a timing-safe comparison of the expected buffer against itself
    // to maintain constant-time properties even on length mismatch.
    crypto.timingSafeEqual(expectedBuffer, expectedBuffer);
    return false;
  }

  return crypto.timingSafeEqual(actualBuffer, expectedBuffer);
}
