export interface MediaEntry {
  id: string;              // UUID
  filename: string;
  mimeType: string;
  sizeBytes: number;
  storagePath: string;     // Relative path in mediaDir
  thumbnailPath?: string;
  width?: number;
  height?: number;
  uploadedAt: string;
  uploadedBy: string;      // agentId or senderId
  agentId?: string;
  sessionId?: string;
  metadata?: Record<string, unknown>;
}

export * from './MediaStore.js';
export * from './SignedUrl.js';
export * from './MimeDetector.js';
