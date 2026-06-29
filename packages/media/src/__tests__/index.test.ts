import { describe, it, expect } from 'vitest';
import { MimeDetector } from '../MimeDetector.js';

describe('Media', () => {
  it('detects basic mime types', () => {
    const detector = new MimeDetector();
    expect(detector.detect(Buffer.from([]), 'test.txt')).toBe('text/plain');
  });
});
