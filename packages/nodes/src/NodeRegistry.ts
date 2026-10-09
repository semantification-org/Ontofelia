import * as fs from 'fs/promises';
import * as crypto from 'crypto';
import type { WebSocket } from 'ws';
import { NodeMessage, NodeSurface } from './NodeProtocol.js';

export interface NodeInfo {
  id: string;
  name: string;
  type: 'headless' | 'display' | 'iot';
  status: 'paired' | 'pending' | 'disconnected';
  surfaces: NodeSurface[];
  lastSeen?: string;
  pairedAt?: string;
  metadata?: Record<string, unknown>;
}

const SURFACE_TYPES = ['chat', 'canvas', 'file', 'status'];

export class PairingRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PairingRefusedError';
  }
}

export class NodeRegistry {
  /** Maximum number of simultaneously pending pairing requests. */
  static readonly MAX_PENDING_PAIRINGS = 20;
  /** How long a pending pairing request stays valid. */
  static readonly PAIRING_EXPIRY_MS = 10 * 60 * 1000;
  static readonly MAX_NAME_LENGTH = 64;
  static readonly MAX_SURFACES = 8;
  static readonly MAX_CAPABILITIES_PER_SURFACE = 16;
  static readonly MAX_CAPABILITY_KEY_LENGTH = 32;

  private pendingTimers = new Map<string, ReturnType<typeof setTimeout>>(); // code -> expiry timer
  private nodes = new Map<string, NodeInfo>();
  private pendingPairings = new Map<string, NodeInfo>(); // code -> NodeInfo
  private connections = new Map<string, WebSocket>();

  constructor(private dbPath: string) {}

  async load(): Promise<void> {
    try {
      const data = await fs.readFile(this.dbPath, 'utf-8');
      const parsed = JSON.parse(data) as NodeInfo[];
      for (const node of parsed) {
        node.status = 'disconnected'; // Reset status on load
        this.nodes.set(node.id, node);
      }
    } catch (e: unknown) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
  }

  async save(): Promise<void> {
    await fs.writeFile(this.dbPath, JSON.stringify(Array.from(this.nodes.values()), null, 2));
  }

  /** Create a pairing request. Throws PairingRefusedError on invalid input or when too many are pending. */
  async createPairingRequest(nodeInfo: Partial<NodeInfo>): Promise<{ code: string; nodeId: string }> {
    const name = NodeRegistry.validateName(nodeInfo.name);
    const surfaces = NodeRegistry.validateSurfaces(nodeInfo.surfaces);

    if (this.pendingPairings.size >= NodeRegistry.MAX_PENDING_PAIRINGS) {
      throw new PairingRefusedError('Too many pending pairing requests');
    }

    let code = this.generateCode();
    while (this.pendingPairings.has(code)) code = this.generateCode();
    const nodeId = crypto.randomUUID();

    const node: NodeInfo = {
      id: nodeId,
      name,
      type: nodeInfo.type || 'headless',
      status: 'pending',
      surfaces,
      metadata: nodeInfo.metadata
    };

    this.pendingPairings.set(code, node);

    const timer = setTimeout(() => {
      this.pendingPairings.delete(code);
      this.pendingTimers.delete(code);
    }, NodeRegistry.PAIRING_EXPIRY_MS);
    timer.unref?.();
    this.pendingTimers.set(code, timer);

    return { code, nodeId };
  }

  private static validateName(name: unknown): string {
    if (typeof name !== 'string') throw new PairingRefusedError('Invalid name: must be a string');
    const trimmed = name.trim();
    if (trimmed.length === 0) throw new PairingRefusedError('Invalid name: must not be empty');
    if (trimmed.length > NodeRegistry.MAX_NAME_LENGTH) {
      throw new PairingRefusedError(`Invalid name: at most ${NodeRegistry.MAX_NAME_LENGTH} characters`);
    }
    return trimmed;
  }

  private static validateSurfaces(surfaces: unknown): NodeSurface[] {
    if (surfaces === undefined) return [];
    if (!Array.isArray(surfaces)) throw new PairingRefusedError('Invalid surfaces: must be an array');
    if (surfaces.length > NodeRegistry.MAX_SURFACES) {
      throw new PairingRefusedError(`Invalid surfaces: at most ${NodeRegistry.MAX_SURFACES} entries`);
    }
    return surfaces.map((s): NodeSurface => {
      if (!s || typeof s !== 'object' || Array.isArray(s)) {
        throw new PairingRefusedError('Invalid surfaces: each entry must be an object');
      }
      const { type, capabilities } = s as { type?: unknown; capabilities?: unknown };
      if (typeof type !== 'string' || !SURFACE_TYPES.includes(type)) {
        throw new PairingRefusedError('Invalid surfaces: unknown surface type');
      }
      if (!capabilities || typeof capabilities !== 'object' || Array.isArray(capabilities)) {
        throw new PairingRefusedError('Invalid surfaces: capabilities must be an object');
      }
      const entries = Object.entries(capabilities as Record<string, unknown>);
      if (entries.length > NodeRegistry.MAX_CAPABILITIES_PER_SURFACE) {
        throw new PairingRefusedError('Invalid surfaces: too many capabilities');
      }
      const caps: Record<string, boolean> = {};
      for (const [key, value] of entries) {
        if (key.length === 0 || key.length > NodeRegistry.MAX_CAPABILITY_KEY_LENGTH || typeof value !== 'boolean') {
          throw new PairingRefusedError('Invalid surfaces: capabilities must map short names to booleans');
        }
        caps[key] = value;
      }
      return { type: type as NodeSurface['type'], capabilities: caps };
    });
  }

  /** True while a pairing code is still pending. */
  hasPendingPairing(code: string): boolean {
    return this.pendingPairings.has(code);
  }

  private clearPending(code: string): boolean {
    const timer = this.pendingTimers.get(code);
    if (timer) clearTimeout(timer);
    this.pendingTimers.delete(code);
    return this.pendingPairings.delete(code);
  }

  /** Genehmige Pairing */
  async approvePairing(code: string): Promise<NodeInfo | null> {
    const node = this.pendingPairings.get(code.toUpperCase());
    if (!node) return null;
    
    node.status = 'paired';
    node.pairedAt = new Date().toISOString();
    
    this.nodes.set(node.id, node);
    this.clearPending(code.toUpperCase());
    await this.save();
    
    return node;
  }

  /** Lehne Pairing ab */
  async rejectPairing(code: string): Promise<boolean> {
    return this.clearPending(code.toUpperCase());
  }

  /** Registriere WebSocket-Verbindung */
  registerConnection(nodeId: string, ws: WebSocket): void {
    const node = this.nodes.get(nodeId);
    if (node) {
      node.status = 'paired';
      node.lastSeen = new Date().toISOString();
      this.connections.set(nodeId, ws);
    }
  }

  /** Entferne Verbindung */
  removeConnection(nodeId: string): void {
    this.connections.delete(nodeId);
    const node = this.nodes.get(nodeId);
    if (node) {
      node.status = 'disconnected';
      node.lastSeen = new Date().toISOString();
    }
  }

  /** Send message to node. */
  async sendToNode(nodeId: string, message: NodeMessage): Promise<boolean> {
    const ws = this.connections.get(nodeId);
    if (!ws || ws.readyState !== 1) return false; // 1 = OPEN
    
    ws.send(JSON.stringify(message));
    return true;
  }

  list(): NodeInfo[] {
    return Array.from(this.nodes.values());
  }

  get(id: string): NodeInfo | undefined {
    return this.nodes.get(id);
  }

  getConnected(): NodeInfo[] {
    return Array.from(this.nodes.values()).filter(n => this.connections.has(n.id));
  }

  private generateCode(): string {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // No 0, O, 1, I
    let code = '';
    for (let i = 0; i < 8; i++) {
      code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return code;
  }
}
