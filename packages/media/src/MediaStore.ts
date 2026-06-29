import * as fs from 'fs/promises';
import { createReadStream, ReadStream } from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import sharp from 'sharp';
import { MediaEntry } from './index.js';

export class MediaStore {
  private entries = new Map<string, MediaEntry>();

  constructor(private mediaDir: string, private dbPath: string) {}

  async initialize(): Promise<void> {
    await fs.mkdir(path.join(this.mediaDir, 'files'), { recursive: true });
    await fs.mkdir(path.join(this.mediaDir, 'thumbs'), { recursive: true });
    
    try {
      const data = await fs.readFile(this.dbPath, 'utf-8');
      const parsed = JSON.parse(data) as MediaEntry[];
      for (const entry of parsed) {
        this.entries.set(entry.id, entry);
      }
    } catch (e: unknown) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
  }

  private async saveDb(): Promise<void> {
    await fs.writeFile(this.dbPath, JSON.stringify(Array.from(this.entries.values()), null, 2));
  }

  /** Store a file. */
  async store(file: {
    buffer: Buffer;
    filename: string;
    mimeType: string;
    uploadedBy: string;
    agentId?: string;
    sessionId?: string;
  }): Promise<MediaEntry> {
    const id = crypto.randomUUID();
    const ext = path.extname(file.filename) || '';
    const storageFilename = `${id}${ext}`;
    const storagePath = path.join('files', storageFilename);
    const fullPath = path.join(this.mediaDir, storagePath);

    await fs.writeFile(fullPath, file.buffer);

    let width, height;
    if (file.mimeType.startsWith('image/')) {
      try {
        const metadata = await sharp(file.buffer).metadata();
        width = metadata.width;
        height = metadata.height;
      } catch {
        // Ignore errors for invalid images.
      }
    }

    const entry: MediaEntry = {
      id,
      filename: file.filename,
      mimeType: file.mimeType,
      sizeBytes: file.buffer.length,
      storagePath,
      width,
      height,
      uploadedAt: new Date().toISOString(),
      uploadedBy: file.uploadedBy,
      agentId: file.agentId,
      sessionId: file.sessionId
    };

    this.entries.set(id, entry);
    await this.saveDb();
    return entry;
  }

  /** Hole Metadaten */
  async getEntry(id: string): Promise<MediaEntry | null> {
    return this.entries.get(id) || null;
  }

  /** Get file stream. */
  async getFile(id: string): Promise<{ stream: ReadStream; entry: MediaEntry } | null> {
    const entry = this.entries.get(id);
    if (!entry) return null;
    const fullPath = path.join(this.mediaDir, entry.storagePath);
    try {
      await fs.access(fullPath);
      return { stream: createReadStream(fullPath), entry };
    } catch {
      return null;
    }
  }
  
  /** Hole Thumbnail-Stream */
  async getThumbnail(id: string): Promise<{ stream: ReadStream; mimeType: string } | null> {
    const entry = this.entries.get(id);
    if (!entry || !entry.thumbnailPath) return null;
    const fullPath = path.join(this.mediaDir, entry.thumbnailPath);
    try {
      await fs.access(fullPath);
      return { stream: createReadStream(fullPath), mimeType: 'image/jpeg' };
    } catch {
      return null;
    }
  }

  /** Delete file. */
  async delete(id: string): Promise<boolean> {
    const entry = this.entries.get(id);
    if (!entry) return false;

    try {
      await fs.unlink(path.join(this.mediaDir, entry.storagePath));
    } catch { /* ignore */ }

    if (entry.thumbnailPath) {
      try {
        await fs.unlink(path.join(this.mediaDir, entry.thumbnailPath));
      } catch { /* ignore */ }
    }

    this.entries.delete(id);
    await this.saveDb();
    return true;
  }

  /** List media for agent/session. */
  async list(filter?: { agentId?: string; sessionId?: string; mimeType?: string }): Promise<MediaEntry[]> {
    let result = Array.from(this.entries.values());
    if (filter) {
      if (filter.agentId) result = result.filter(e => e.agentId === filter.agentId);
      if (filter.sessionId) result = result.filter(e => e.sessionId === filter.sessionId);
      if (filter.mimeType) result = result.filter(e => e.mimeType === filter.mimeType);
    }
    return result;
  }

  /** Create thumbnail for images (via sharp). */
  async createThumbnail(id: string, width: number = 256): Promise<string> {
    const entry = this.entries.get(id);
    if (!entry) throw new Error('Not found');

    const fullPath = path.join(this.mediaDir, entry.storagePath);
    const thumbFilename = `${id}_${width}.jpg`;
    const thumbRelPath = path.join('thumbs', thumbFilename);
    const thumbFullPath = path.join(this.mediaDir, thumbRelPath);

    await sharp(fullPath)
      .resize(width, null, { withoutEnlargement: true })
      .jpeg({ quality: 80 })
      .toFile(thumbFullPath);

    entry.thumbnailPath = thumbRelPath;
    this.entries.set(id, entry);
    await this.saveDb();

    return thumbRelPath;
  }
}
