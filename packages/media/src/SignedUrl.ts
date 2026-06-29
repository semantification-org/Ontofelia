import * as crypto from 'crypto';

import { safeCompareSecret } from '@ontofelia/security';

export class SignedUrlService {
  constructor(private secret: string) {}

  /** Erstelle eine signierte URL mit Ablaufzeit */
  createSignedUrl(mediaId: string, expiresIn: number = 3600): string {
    const expires = Date.now() + expiresIn * 1000;
    const hmac = crypto.createHmac('sha256', this.secret);
    hmac.update(`${mediaId}:${expires}`);
    const sig = hmac.digest('hex');
    return `/media/${mediaId}?expires=${expires}&sig=${sig}`;
  }

  /** Validiere eine signierte URL */
  validateSignature(mediaId: string, expires: string, signature: string): boolean {
    const hmac = crypto.createHmac('sha256', this.secret);
    hmac.update(`${mediaId}:${expires}`);
    const expectedSig = hmac.digest('hex');
    return safeCompareSecret(signature, expectedSig);
  }
}
