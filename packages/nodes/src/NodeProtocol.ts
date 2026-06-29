// WebSocket message format.
export type NodeMessage =
  | { type: 'pair_request'; name: string; surfaces: NodeSurface[] }
  | { type: 'pair_response'; code: string; status: 'pending' }
  | { type: 'pair_approved'; nodeId: string }
  | { type: 'pair_rejected' }
  | { type: 'chat_message'; text: string; sessionId?: string }
  | { type: 'chat_response'; text: string; sessionId: string }
  | { type: 'file_upload'; filename: string; mimeType: string; data: string /* base64 */ }
  | { type: 'file_response'; mediaId: string; url: string }
  | { type: 'health_request' }
  | { type: 'health_response'; status: string; uptime: number }
  | { type: 'error'; message: string };

export interface NodeSurface {
  type: 'chat' | 'canvas' | 'file' | 'status';
  capabilities: Record<string, boolean>;
}
