export class OntofeliaWebSocket {
  private ws: WebSocket | null = null;
  private token: string;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 10;
  private listeners = new Map<string, Set<(data: unknown) => void>>();
  private pingInterval: ReturnType<typeof setInterval> | null = null;
  private reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
  private shouldReconnect = true;

  constructor(token: string) {
    this.token = token;
  }

  connect(): void {
    if (this.ws?.readyState === WebSocket.OPEN || this.ws?.readyState === WebSocket.CONNECTING) return;
    this.shouldReconnect = true;

    // Use current host, proxy will forward to Gateway if in dev
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws`;

    this.ws = new WebSocket(wsUrl);

    this.ws.onopen = () => {
      this.reconnectAttempts = 0;
      this.startPing();
      
      // Send auth token immediately upon connection
      this.ws?.send(JSON.stringify({ type: 'auth', token: this.token }));
      
      // We don't emit 'connected' here, we wait for the auth 'status' message
    };

    this.ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        
        if (data.type === 'status' && data.data?.status === 'authenticated') {
          this.emit('connected', null);
        } else if (data.type === 'chat_response') {
          this.emit('chat_response', data);
        } else if (data.type === 'stream_start') {
          this.emit('stream_start', data);
        } else if (data.type === 'text_delta') {
          this.emit('text_delta', data);
        } else if (data.type === 'tool_start') {
          this.emit('tool_start', data);
        } else if (data.type === 'tool_result') {
          this.emit('tool_result', data);
        } else if (data.type === 'stream_end') {
          this.emit('stream_end', data);
        } else if (data.type === 'chat_error') {
          this.emit('chat_error', data);
        } else if (data.type === 'debug_log') {
          this.emit('debug_log', data);
        } else if (data.type === 'guardian_confirm') {
          this.emit('guardian_confirm', data);
        } else if (data.type === 'error') {
          this.emit('error', data);
          if (data.code === 'UNAUTHORIZED') {
            this.shouldReconnect = false;
            this.disconnect();
          }
        }
      } catch (e: unknown) {
        console.error('Failed to parse WS message:', event.data, e);
      }
    };

    this.ws.onclose = () => {
      this.stopPing();
      this.emit('disconnected', null);
      if (this.shouldReconnect) {
        this.scheduleReconnect();
      }
    };

    this.ws.onerror = (error) => {
      console.error('WebSocket Error:', error);
    };
  }

  disconnect(): void {
    this.shouldReconnect = false;
    this.stopPing();
    if (this.reconnectTimeout) clearTimeout(this.reconnectTimeout);
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  sendChat(message: string, agentId?: string, sessionId?: string, attachments?: { name: string; type: string; data: string }[]): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({
      type: 'chat',
      message,
      agentId,
      sessionId,
      attachments
    }));
  }

  sendGuardianResponse(callId: string, approved: boolean, approveAll = false, agentId?: string): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({ type: 'guardian_response', callId, approved, approveAll, agentId }));
  }

  sendPing(): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'ping' }));
    }
  }

  private startPing(): void {
    this.stopPing();
    this.pingInterval = setInterval(() => this.sendPing(), 30000);
  }

  private stopPing(): void {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      this.emit('error', { message: 'Max reconnect attempts reached' });
      return;
    }

    const timeout = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000);
    this.reconnectAttempts++;

    this.reconnectTimeout = setTimeout(() => {
      this.connect();
    }, timeout);
  }

  on(event: 'connected' | 'disconnected' | 'chat_response' | 'chat_error' | 'debug_log' | 'guardian_confirm' | 'error' | 'status' | 'stream_start' | 'text_delta' | 'tool_start' | 'tool_result' | 'stream_end', handler: (data: unknown) => void): () => void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event)!.add(handler);

    return () => {
      this.listeners.get(event)?.delete(handler);
    };
  }

  private emit(event: string, data: unknown): void {
    if (this.listeners.has(event)) {
      for (const handler of this.listeners.get(event)!) {
        handler(data);
      }
    }
  }
}
