export interface GatewayStatus {
  running: boolean;
  uptime: number;
  version: string;
  bind: string;
  port: number;
  agents: { total: number; running: number };
  channels: { total: number; connected: number };
  memory: { backend: string; status: string; tripleCount: number };
}

export interface KnowledgeGraphDump {
  uri: string;
  role: string;
  agentId: string | null;
  shared: boolean;
  turtle: string;
  tripleCount: number | null;
  error?: string;
}

export interface KnowledgeGraphsResponse {
  agentId: string;
  graphs: KnowledgeGraphDump[];
}

export interface AgentState {
  agentId: string;
  lifecycle: string;
  activeRuns: number;
  totalRuns: number;
  lastActivity?: string;
  error?: string;
}

export interface SessionRecord {
  sessionId: string;
  agentId: string;
  scope: string;
  sessionKey: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  totalTokens: number;
  status: 'active' | 'idle' | 'reset' | 'archived';
  origin: { channel: string; chatType: string; senderId: string };
  displayName?: string;
  transcriptPath: string;
}

// Minimal implementation of chat message for UI
export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  text: string;
  timestamp: string;
  isError?: boolean;
  model?: string;
  provider?: string;
  isStreaming?: boolean;
  attachments?: { name: string; type: string; data: string }[];
}

async function apiFetch<T>(endpoint: string, token: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(`/api${endpoint}`, {
    ...options,
    headers: {
      ...options.headers,
      'Authorization': `Bearer ${token}`
    }
  });
  
  if (!response.ok) {
    if (response.status === 401) throw new Error('Unauthorized');
    throw new Error(`API Error: ${response.status}`);
  }
  
  return response.json();
}

export async function fetchSessions(token: string): Promise<SessionRecord[]> {
  return apiFetch<SessionRecord[]>('/sessions?channel=webchat', token);
}

export async function fetchAgents(token: string): Promise<AgentState[]> {
  return apiFetch<AgentState[]>('/agents', token);
}

export async function fetchStatus(token: string): Promise<GatewayStatus> {
  return apiFetch<GatewayStatus>('/status', token);
}

export async function fetchHealth(): Promise<{ status: string }> {
  const response = await fetch('/api/health');
  if (!response.ok) throw new Error('Gateway unavailable');
  return response.json();
}

export interface TranscriptEntry {
  timestamp: string;
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  channel?: string;
  senderId?: string;
}

export async function fetchTranscript(token: string, sessionId: string): Promise<TranscriptEntry[]> {
  return apiFetch<TranscriptEntry[]>(`/sessions/${sessionId}/transcript`, token);
}

export async function deleteSession(token: string, sessionId: string): Promise<void> {
  await apiFetch(`/sessions/${sessionId}`, token, { method: 'DELETE' });
}

export async function renameSession(token: string, sessionId: string, displayName: string): Promise<void> {
  await apiFetch(`/sessions/${sessionId}`, token, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ displayName })
  });
}

export async function changeModel(token: string, model: string): Promise<{ success: boolean; model: string }> {
  return apiFetch('/config/model', token, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model })
  });
}

export async function clearKnowledge(token: string): Promise<{ success: boolean; message: string }> {
  return apiFetch('/knowledge', token, {
    method: 'DELETE'
  });
}

export async function fetchKnowledgeGraphs(token: string): Promise<KnowledgeGraphsResponse> {
  return apiFetch<KnowledgeGraphsResponse>('/knowledge/graphs', token);
}

// ---- Cognitive debug panel (Phase I) ---------------------------------------
// Read-only projections; the gateway answers 403 when cog.flagDebugPanel is off.

export interface CogCycleSummary {
  cycleId: string;
  cycleUri: string;
  status: string;
  startedAt: string;
  endedAt: string;
  durationMs: number;
}

export interface CogPhase {
  phaseUri: string;
  ordinal: number;
  phaseKind: string;
  startedAt: string;
  endedAt: string;
}

export interface CogWMEntry {
  id: string;
  buffer: string;
  entryKind: string;
  payload: string;
  salience: number;
  writtenBy: string;
  writtenAt: string;
  refersTo?: string;
  forGoal?: string;
  sourceGraph?: string;
}

export interface CogEpisode {
  uri: string;
  episodeId: string;
  episodeType: string;
  occurredAt: string;
  about: string[];
  payload?: string;
  outcome?: string;
  sessionId?: string;
}

export interface CogMarker {
  markerUri: string;
  createdAt?: string;
  noted?: string;
  flaggedImpasse: string[];
}

export interface CogCycleDetail {
  cycle: CogCycleSummary;
  phases: CogPhase[];
  buffer: CogWMEntry[];
  episodes: CogEpisode[];
  marker?: CogMarker;
}

export interface CogGoal {
  uri: string;
  goalId: string;
  goalType: string;
  goalLabel: string;
  status: string;
  priority: number;
  createdAt: string;
  updatedAt: string;
  triggeredByEpisode?: string;
  successCriterion?: string;
  deadline?: string;
  longTerm?: boolean;
}

export interface CogExplainAction {
  entryId: string;
  payload: string;
  forGoal?: string;
  goal?: CogGoal;
  triggeringEpisode?: CogEpisode;
}

export interface CogExplainRetrieval {
  entryId: string;
  payload: string;
  refersTo?: string;
  sourceGraph?: string;
  episode?: CogEpisode;
}

export interface CogExplanation {
  cycleId: string;
  cycleUri: string;
  found: boolean;
  actions: CogExplainAction[];
  retrievals: CogExplainRetrieval[];
}

/** Thrown when the debug panel flag is off (HTTP 403). */
export class CogDisabledError extends Error {
  constructor() {
    super('Cognitive debug panel is disabled. Enable it with `/cog debug on`.');
    this.name = 'CogDisabledError';
  }
}

async function cogFetch<T>(endpoint: string, token: string): Promise<T> {
  const response = await fetch(`/api${endpoint}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (response.status === 403) throw new CogDisabledError();
  if (!response.ok) {
    if (response.status === 401) throw new Error('Unauthorized');
    throw new Error(`API Error: ${response.status}`);
  }
  return response.json();
}

export function fetchCogCycles(token: string, sessionId: string, limit = 50): Promise<CogCycleSummary[]> {
  return cogFetch(`/cog/inspect/cycles?sessionId=${encodeURIComponent(sessionId)}&limit=${limit}`, token);
}

export function fetchCogCycle(token: string, sessionId: string, cycleId: string): Promise<CogCycleDetail> {
  return cogFetch(
    `/cog/inspect/cycle?sessionId=${encodeURIComponent(sessionId)}&cycleId=${encodeURIComponent(cycleId)}`,
    token,
  );
}

export function fetchCogGoals(token: string, sessionId: string): Promise<CogGoal[]> {
  return cogFetch(`/cog/inspect/goals?sessionId=${encodeURIComponent(sessionId)}`, token);
}

export function fetchCogEpisodes(token: string, entity?: string, limit = 50): Promise<CogEpisode[]> {
  const q = entity ? `&entity=${encodeURIComponent(entity)}` : '';
  return cogFetch(`/cog/inspect/episodes?limit=${limit}${q}`, token);
}

export function fetchCogExplain(token: string, sessionId: string, cycleId: string): Promise<CogExplanation> {
  return cogFetch(
    `/cog/inspect/explain?sessionId=${encodeURIComponent(sessionId)}&cycleId=${encodeURIComponent(cycleId)}`,
    token,
  );
}

export async function fetchProvider(token: string): Promise<{ name: string; model: string; healthy: boolean; autoFallback: boolean; fallbackModels: string[] }> {
  return apiFetch('/provider', token);
}

export async function fetchModels(token: string): Promise<Array<{ id: string; name?: string }>> {
  return apiFetch('/models', token);
}

export async function toggleFallback(token: string, enabled: boolean): Promise<{ autoFallback: boolean }> {
  return apiFetch('/config/fallback', token, {
    method: 'PUT',
    body: JSON.stringify({ enabled }),
  });
}

export async function changeFallbackModels(token: string, models: string[]): Promise<{ fallbackModels: string[] }> {
  return apiFetch('/config/fallback-models', token, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ models }),
  });
}
