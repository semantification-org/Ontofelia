import mime from 'mime-types';

export class MimeDetector {
  /** Detect MIME type from buffer (magic bytes) and filename. */
  detect(buffer: Buffer, filename?: string): string {
    // For MVP, we'll just use the filename extension if available.
    // In a production system, we'd look at magic bytes (e.g., using 'file-type' package).
    if (filename) {
      const type = mime.lookup(filename);
      if (type) return type;
    }
    
    // Simple magic byte checks for common types if filename doesn't help
    if (buffer.length >= 4) {
      if (buffer[0] === 0xFF && buffer[1] === 0xD8 && buffer[2] === 0xFF) return 'image/jpeg';
      if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47) return 'image/png';
      if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x38) return 'image/gif';
      if (buffer[0] === 0x25 && buffer[1] === 0x50 && buffer[2] === 0x44 && buffer[3] === 0x46) return 'application/pdf';
    }
    
    return 'application/octet-stream';
  }

  /** Is it an image? */
  isImage(mimeType: string): boolean {
    return mimeType.startsWith('image/');
  }

  /** Is it a supported format? */
  isAllowed(mimeType: string): boolean {
    const allowedPrefixes = ['image/', 'text/', 'application/pdf', 'application/json', 'audio/', 'video/'];
    return allowedPrefixes.some(prefix => mimeType.startsWith(prefix));
  }
}
