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

export class NodeRegistry {
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

  /** Erstelle Pairing-Request */
  async createPairingRequest(nodeInfo: Partial<NodeInfo>): Promise<{ code: string; nodeId: string }> {
    const code = this.generateCode();
    const nodeId = crypto.randomUUID();
    
    const node: NodeInfo = {
      id: nodeId,
      name: nodeInfo.name || 'Unknown Node',
      type: nodeInfo.type || 'headless',
      status: 'pending',
      surfaces: nodeInfo.surfaces || [],
      metadata: nodeInfo.metadata
    };
    
    this.pendingPairings.set(code, node);
    
    // Auto-expire after 1 hour
    setTimeout(() => {
      this.pendingPairings.delete(code);
    }, 3600000);
    
    return { code, nodeId };
  }

  /** Genehmige Pairing */
  async approvePairing(code: string): Promise<NodeInfo | null> {
    const node = this.pendingPairings.get(code.toUpperCase());
    if (!node) return null;
    
    node.status = 'paired';
    node.pairedAt = new Date().toISOString();
    
    this.nodes.set(node.id, node);
    this.pendingPairings.delete(code.toUpperCase());
    await this.save();
    
    return node;
  }

  /** Lehne Pairing ab */
  async rejectPairing(code: string): Promise<boolean> {
    const result = this.pendingPairings.delete(code.toUpperCase());
    return result;
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
