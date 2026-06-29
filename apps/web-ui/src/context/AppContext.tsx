import { createContext, useContext, useReducer, useEffect, useRef, useCallback } from 'react';
import type { ReactNode, Dispatch, MutableRefObject } from 'react';
import { fetchSessions, fetchAgents, fetchStatus, fetchTranscript } from '../lib/api';
import type { SessionRecord, AgentState, GatewayStatus, ChatMessage } from '../lib/api';
import { OntofeliaWebSocket } from '../lib/websocket';

interface AppState {
  token: string | null;
  connected: boolean;
  sessions: SessionRecord[];
  activeSessionId: string | null;
  messages: Map<string, ChatMessage[]>;
  agents: AgentState[];
  gatewayStatus: GatewayStatus | null;
  isWaiting: boolean;
  error: string | null;
  pendingApprovals: { callId: string; command?: string }[];
}

type Action =
  | { type: 'SET_TOKEN'; payload: string | null }
  | { type: 'SET_CONNECTED'; payload: boolean }
  | { type: 'SET_SESSIONS'; payload: SessionRecord[] }
  | { type: 'SET_ACTIVE_SESSION'; payload: string }
  | { type: 'REMOVE_SESSION'; payload: string }
  | { type: 'RENAME_SESSION'; payload: { sessionId: string; displayName: string } }
  | { type: 'ADD_MESSAGE'; payload: { sessionId: string; message: ChatMessage } }
  | { type: 'UPDATE_LAST_MESSAGE'; payload: { sessionId: string; update: Partial<ChatMessage> } }
  | { type: 'APPEND_TEXT_TO_LAST_MESSAGE'; payload: { sessionId: string; text: string } }
  | { type: 'SET_MESSAGES'; payload: { sessionId: string; messages: ChatMessage[] } }
  | { type: 'SET_AGENTS'; payload: AgentState[] }
  | { type: 'SET_GATEWAY_STATUS'; payload: GatewayStatus }
  | { type: 'SET_WAITING'; payload: boolean }
  | { type: 'SET_ERROR'; payload: string | null }
  | { type: 'MIGRATE_SESSION'; payload: { fromSessionId: string; toSessionId: string } }
  | { type: 'ADD_APPROVAL'; payload: { callId: string; command?: string } }
  | { type: 'REMOVE_APPROVAL'; payload: { callId: string } };

const initialState: AppState = {
  token: localStorage.getItem('ontofelia_token'),
  connected: false,
  sessions: [],
  activeSessionId: null,
  messages: new Map(),
  agents: [],
  gatewayStatus: null,
  isWaiting: false,
  error: null,
  pendingApprovals: [],
};

function appReducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case 'SET_TOKEN':
      if (action.payload) {
        localStorage.setItem('ontofelia_token', action.payload);
      } else {
        localStorage.removeItem('ontofelia_token');
      }
      return { ...state, token: action.payload };
    case 'SET_CONNECTED':
      return { ...state, connected: action.payload };
    case 'SET_SESSIONS':
      return { ...state, sessions: action.payload };
    case 'SET_ACTIVE_SESSION':
      return { ...state, activeSessionId: action.payload };
    case 'REMOVE_SESSION': {
      const filtered = state.sessions.filter(s => s.sessionId !== action.payload);
      const newMessages = new Map(state.messages);
      newMessages.delete(action.payload);
      const newActiveId = state.activeSessionId === action.payload
        ? (filtered.length > 0 ? filtered[0].sessionId : null)
        : state.activeSessionId;
      return { ...state, sessions: filtered, messages: newMessages, activeSessionId: newActiveId };
    }
    case 'RENAME_SESSION': {
      const updated = state.sessions.map(s =>
        s.sessionId === action.payload.sessionId
          ? { ...s, displayName: action.payload.displayName }
          : s
      );
      return { ...state, sessions: updated };
    }
    case 'ADD_MESSAGE': {
      const { sessionId, message } = action.payload;
      const newMessages = new Map(state.messages);
      const sessionMessages = newMessages.get(sessionId) || [];
      newMessages.set(sessionId, [...sessionMessages, message]);
      return { ...state, messages: newMessages };
    }
    case 'UPDATE_LAST_MESSAGE': {
      const { sessionId, update } = action.payload;
      const newMessagesMap = new Map(state.messages);
      const sessionMessages = [...(newMessagesMap.get(sessionId) || [])];
      if (sessionMessages.length > 0) {
        const lastIndex = sessionMessages.length - 1;
        sessionMessages[lastIndex] = { ...sessionMessages[lastIndex], ...update };
      }
      newMessagesMap.set(sessionId, sessionMessages);
      return { ...state, messages: newMessagesMap };
    }
    case 'APPEND_TEXT_TO_LAST_MESSAGE': {
      const { sessionId, text } = action.payload;
      const newMessagesMap = new Map(state.messages);
      const sessionMessages = [...(newMessagesMap.get(sessionId) || [])];
      // Find the last assistant message (never append to user messages)
      let targetIndex = -1;
      for (let i = sessionMessages.length - 1; i >= 0; i--) {
        if (sessionMessages[i].role === 'assistant' && sessionMessages[i].isStreaming) {
          targetIndex = i;
          break;
        }
      }
      if (targetIndex >= 0) {
        sessionMessages[targetIndex] = { ...sessionMessages[targetIndex], text: sessionMessages[targetIndex].text + text };
      }
      newMessagesMap.set(sessionId, sessionMessages);
      return { ...state, messages: newMessagesMap };
    }
    case 'SET_MESSAGES': {
      const newMsgs = new Map(state.messages);
      newMsgs.set(action.payload.sessionId, action.payload.messages);
      return { ...state, messages: newMsgs };
    }
    case 'SET_AGENTS':
      return { ...state, agents: action.payload };
    case 'SET_GATEWAY_STATUS':
      return { ...state, gatewayStatus: action.payload };
    case 'SET_WAITING':
      return { ...state, isWaiting: action.payload };
    case 'SET_ERROR':
      return { ...state, error: action.payload };
    case 'MIGRATE_SESSION': {
      const { fromSessionId, toSessionId } = action.payload;
      const newMsgs = new Map(state.messages);
      const oldMessages = newMsgs.get(fromSessionId) || [];
      const existingMessages = newMsgs.get(toSessionId) || [];
      newMsgs.set(toSessionId, [...oldMessages, ...existingMessages]);
      newMsgs.delete(fromSessionId);
      return { ...state, messages: newMsgs };
    }
    case 'ADD_APPROVAL': {
      if (state.pendingApprovals.some(a => a.callId === action.payload.callId)) return state;
      return { ...state, pendingApprovals: [...state.pendingApprovals, action.payload] };
    }
    case 'REMOVE_APPROVAL':
      return { ...state, pendingApprovals: state.pendingApprovals.filter(a => a.callId !== action.payload.callId) };
    default:
      return state;
  }
}

interface AppContextValue extends AppState {
  dispatch: Dispatch<Action>;
  wsRef: MutableRefObject<OntofeliaWebSocket | null>;
  sendMessage: (text: string, attachments?: { name: string; type: string; data: string }[], options?: { echo?: boolean }) => void;
  setToken: (token: string | null) => void;
  loadSessionTranscript: (sessionId: string) => void;
  respondGuardian: (callId: string, approved: boolean, approveAll?: boolean) => void;
}

const AppContext = createContext<AppContextValue | undefined>(undefined);

export function AppContextProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(appReducer, initialState);
  const wsRef = useRef<OntofeliaWebSocket | null>(null);

  const loadInitialData = async (token: string) => {
    try {
      const [sessions, agents, status] = await Promise.all([
        fetchSessions(token).catch(() => []),
        fetchAgents(token).catch(() => []),
        fetchStatus(token).catch(() => null)
      ]);
      
      dispatch({ type: 'SET_SESSIONS', payload: sessions });
      dispatch({ type: 'SET_AGENTS', payload: agents });
      if (status) dispatch({ type: 'SET_GATEWAY_STATUS', payload: status });
      
      if (!state.activeSessionId && sessions.length > 0) {
        // Sort sessions by updatedAt descending
        const sorted = [...sessions].sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
        dispatch({ type: 'SET_ACTIVE_SESSION', payload: sorted[0].sessionId });
      }
    } catch (e) {
      console.error('Failed to load initial data', e);
    }
  };

  // Track the session ID for the current streaming response
  const streamingSessionRef = useRef<string | null>(null);
  const pendingNewSessionRef = useRef(false);
  // Keep refs to the latest values so async WebSocket handlers always see them.
  // Updated after commit (not during render) per the rules-of-hooks.
  const activeSessionRef = useRef<string | null>(state.activeSessionId);
  const messagesRef = useRef(state.messages);
  useEffect(() => {
    activeSessionRef.current = state.activeSessionId;
    messagesRef.current = state.messages;
  });

   
  useEffect(() => {
    if (!state.token) return;

    const ws = new OntofeliaWebSocket(state.token);
    wsRef.current = ws;

    const unsubConnected = ws.on('connected', () => {
      dispatch({ type: 'SET_CONNECTED', payload: true });
      dispatch({ type: 'SET_ERROR', payload: null });
      loadInitialData(state.token!);
    });

    const unsubDisconnected = ws.on('disconnected', () => {
      dispatch({ type: 'SET_CONNECTED', payload: false });
    });

    const unsubError = ws.on('error', (err: unknown) => {
      const error = err as { code?: string; message?: string };
      if (error.code === 'UNAUTHORIZED') {
        dispatch({ type: 'SET_TOKEN', payload: null });
      }
      dispatch({ type: 'SET_ERROR', payload: error.message || 'WebSocket error' });
      dispatch({ type: 'SET_WAITING', payload: false });
    });

    const unsubChatResponse = ws.on('chat_response', (data: unknown) => {
      const chatData = data as { sessionId?: string; id?: string; text?: string; content?: string; model?: string; provider?: string; fallbackModel?: string };
      dispatch({ type: 'SET_WAITING', payload: false });
      
      const sessionId = chatData.sessionId || activeSessionRef.current || 'default';
      
      dispatch({
        type: 'ADD_MESSAGE',
        payload: {
          sessionId,
          message: {
            id: chatData.id || crypto.randomUUID(),
            role: 'assistant',
            text: chatData.text || chatData.content || '',
            timestamp: new Date().toISOString(),
            model: chatData.fallbackModel || chatData.model,
            provider: chatData.fallbackModel ? 'openrouter' : chatData.provider,
          }
        }
      });
      
      // Auto-select session if we didn't have one and refresh sessions
      if (!activeSessionRef.current) {
        dispatch({ type: 'SET_ACTIVE_SESSION', payload: sessionId });
      }
      loadInitialData(state.token!);
    });

    const unsubChatError = ws.on('chat_error', (data: unknown) => {
      const errData = data as { message?: string };
      dispatch({ type: 'SET_WAITING', payload: false });
      pendingNewSessionRef.current = false;
      
      const sessionId = activeSessionRef.current || 'default';
      dispatch({
        type: 'ADD_MESSAGE',
        payload: {
          sessionId,
          message: {
            id: crypto.randomUUID(),
            role: 'system',
            text: errData.message || 'An error occurred.',
            timestamp: new Date().toISOString(),
            isError: true,
          }
        }
      });
    });

    const unsubStreamStart = ws.on('stream_start', (data: unknown) => {
      dispatch({ type: 'SET_WAITING', payload: false });
      const streamData = data as { sessionId: string };
      const sessionId = streamData.sessionId || activeSessionRef.current || 'default';
      streamingSessionRef.current = sessionId;

      // If messages were stored under 'new-session' (before we had a real ID),
      // migrate them to the actual session ID
      if (sessionId !== 'new-session' && activeSessionRef.current === null) {
        dispatch({
          type: 'MIGRATE_SESSION',
          payload: { fromSessionId: 'new-session', toSessionId: sessionId }
        });
      }

      dispatch({
        type: 'ADD_MESSAGE',
        payload: {
          sessionId,
          message: {
            id: crypto.randomUUID(),
            role: 'assistant',
            text: '',
            timestamp: new Date().toISOString(),
            isStreaming: true,
          }
        }
      });
      if (!activeSessionRef.current) {
        dispatch({ type: 'SET_ACTIVE_SESSION', payload: sessionId });
      } else if (pendingNewSessionRef.current) {
        dispatch({ type: 'SET_ACTIVE_SESSION', payload: sessionId });
      }
    });

    const unsubTextDelta = ws.on('text_delta', (data: unknown) => {
      const deltaData = data as { content: string };
      const sessionId = streamingSessionRef.current || activeSessionRef.current || 'default';
      dispatch({
        type: 'APPEND_TEXT_TO_LAST_MESSAGE',
        payload: { sessionId, text: deltaData.content }
      });
    });

    const unsubStreamEnd = ws.on('stream_end', (data: unknown) => {
      const endData = data as { sessionId: string, model?: string, provider?: string, fallbackModel?: string };
      const sessionId = endData.sessionId || streamingSessionRef.current || activeSessionRef.current || 'default';
      streamingSessionRef.current = null;
      pendingNewSessionRef.current = false;
      dispatch({
        type: 'UPDATE_LAST_MESSAGE',
        payload: {
          sessionId,
          update: {
            isStreaming: false,
            model: endData.fallbackModel || endData.model,
            provider: endData.fallbackModel ? 'openrouter' : endData.provider
          }
        }
      });
      loadInitialData(state.token!);
    });

    const unsubGuardian = ws.on('guardian_confirm', (data: unknown) => {
      const g = data as { callId?: string; command?: string };
      if (g.callId) dispatch({ type: 'ADD_APPROVAL', payload: { callId: g.callId, command: g.command } });
    });

    ws.connect();

    return () => {
      unsubConnected();
      unsubDisconnected();
      unsubError();
      unsubChatResponse();
      unsubChatError();
      unsubStreamStart();
      unsubTextDelta();
      unsubStreamEnd();
      unsubGuardian();
      ws.disconnect();
    };
  }, [state.token]);

  const sendMessage = (text: string, attachments?: { name: string; type: string; data: string }[], options?: { echo?: boolean }) => {
    if (!wsRef.current || !state.connected) return;

    const shouldEcho = options?.echo !== false;
    pendingNewSessionRef.current = text.trim() === '/new';

    // Add user message to UI immediately, unless this is an internal UI command.
    const sessionId = state.activeSessionId || 'new-session';
    if (shouldEcho) {
      dispatch({
        type: 'ADD_MESSAGE',
        payload: {
          sessionId,
          message: {
            id: crypto.randomUUID(),
            role: 'user',
            text,
            timestamp: new Date().toISOString(),
            attachments: attachments?.map(a => ({ name: a.name, type: a.type, data: a.data })),
          }
        }
      });
    }

    dispatch({ type: 'SET_WAITING', payload: true });
    
    wsRef.current.sendChat(text, undefined, state.activeSessionId || undefined, attachments);
  };

  const setToken = (token: string | null) => {
    dispatch({ type: 'SET_TOKEN', payload: token });
  };

  const loadSessionTranscript = useCallback(async (sessionId: string) => {
    if (!state.token) return;
    // Don't reload if we already have messages for this session (use ref for current state)
    if (messagesRef.current.has(sessionId) && (messagesRef.current.get(sessionId)?.length || 0) > 0) return;
    // Don't load while we're actively streaming to this session
    if (streamingSessionRef.current === sessionId) return;
    try {
      const entries = await fetchTranscript(state.token, sessionId);
      const chatMessages: ChatMessage[] = entries
        .filter(e => e.role === 'user' || e.role === 'assistant')
        .map(e => ({
          id: `${e.timestamp}-${e.role}`,
          role: e.role as 'user' | 'assistant',
          text: e.content,
          timestamp: e.timestamp,
        }));
      dispatch({ type: 'SET_MESSAGES', payload: { sessionId, messages: chatMessages } });
    } catch (err) {
      console.error('Failed to load transcript', err);
    }
   
  }, [state.token]);

  const respondGuardian = (callId: string, approved: boolean, approveAll = false) => {
    wsRef.current?.sendGuardianResponse(callId, approved, approveAll);
    dispatch({ type: 'REMOVE_APPROVAL', payload: { callId } });
  };

  const value: AppContextValue = {
    ...state,
    dispatch,
    wsRef,
    sendMessage,
    setToken,
    loadSessionTranscript,
    respondGuardian
  };

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

// eslint-disable-next-line react-refresh/only-export-components
export function useAppContext() {
  const context = useContext(AppContext);
  if (context === undefined) {
    throw new Error('useAppContext must be used within an AppContextProvider');
  }
  return context;
}
