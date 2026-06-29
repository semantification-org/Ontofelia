import { useState, useEffect, useRef } from 'react';
import { useAppContext } from '../context/AppContext';

interface DebugEvent {
  timestamp: string;
  phase: string;
  label: string;
  data?: unknown;
}

const PHASE_ICONS: Record<string, string> = {
  ner: '🔍',
  kg_context: '🧠',
  llm_call: '📤',
  llm_response: '📥',
  tool_call: '🔧',
  tool_result: '✅',
  final: '🏁',
  error: '❌',
};

const PHASE_COLORS: Record<string, string> = {
  ner: '#a78bfa',
  kg_context: '#60a5fa',
  llm_call: '#fbbf24',
  llm_response: '#34d399',
  tool_call: '#f97316',
  tool_result: '#22d3ee',
  final: '#10b981',
  error: '#ef4444',
};

interface LogOverlayProps {
  onClose: () => void;
}

export function LogOverlay({ onClose }: LogOverlayProps) {
  const { wsRef } = useAppContext();
  const [events, setEvents] = useState<DebugEvent[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [expandedIdx, setExpandedIdx] = useState<number | null>(null);

  useEffect(() => {
    const ws = wsRef.current;
    if (!ws) return;

    const unsub = ws.on('debug_log', (data: unknown) => {
      const event = data as DebugEvent;
      setEvents(prev => [...prev, event]);
    });

    return unsub;
  }, [wsRef]);

  // Auto-scroll to bottom
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [events]);

  const formatTime = (ts: string) => {
    try {
      return new Date(ts).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', fractionalSecondDigits: 3 });
    } catch {
      return ts;
    }
  };

  const formatData = (data: unknown): string => {
    if (data === undefined || data === null) return '';
    if (typeof data === 'string') return data;
    try {
      return JSON.stringify(data, null, 2);
    } catch {
      return String(data);
    }
  };

  return (
    <div style={{
      position: 'fixed',
      inset: 0,
      zIndex: 1000,
      backgroundColor: 'rgba(0, 0, 0, 0.7)',
      backdropFilter: 'blur(4px)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      animation: 'fadeIn 0.15s ease-out',
    }}>
      <div style={{
        width: '90vw',
        maxWidth: '900px',
        height: '80vh',
        backgroundColor: '#0d1117',
        borderRadius: '12px',
        border: '1px solid #30363d',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        boxShadow: '0 20px 60px rgba(0,0,0,0.5)',
      }}>
        {/* Header */}
        <div style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '12px 16px',
          borderBottom: '1px solid #30363d',
          backgroundColor: '#161b22',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span style={{ fontSize: '16px' }}>🖥️</span>
            <span style={{ color: '#e6edf3', fontWeight: 600, fontSize: '14px', fontFamily: 'monospace' }}>
              Debug Console
            </span>
            <span style={{
              color: '#8b949e',
              fontSize: '12px',
              backgroundColor: '#21262d',
              padding: '2px 8px',
              borderRadius: '10px',
              fontFamily: 'monospace',
            }}>
              {events.length} events
            </span>
          </div>
          <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
            <button
              onClick={() => setEvents([])}
              style={{
                color: '#8b949e',
                background: 'none',
                border: '1px solid #30363d',
                borderRadius: '6px',
                padding: '4px 10px',
                fontSize: '12px',
                cursor: 'pointer',
                fontFamily: 'monospace',
              }}
            >
              Clear
            </button>
            <button
              onClick={onClose}
              style={{
                color: '#e6edf3',
                background: 'none',
                border: 'none',
                fontSize: '20px',
                cursor: 'pointer',
                padding: '0 4px',
                lineHeight: 1,
              }}
            >
              ✕
            </button>
          </div>
        </div>

        {/* Log Area */}
        <div
          ref={scrollRef}
          style={{
            flex: 1,
            overflowY: 'auto',
            padding: '8px 0',
            fontFamily: '"JetBrains Mono", "Fira Code", "Cascadia Code", monospace',
            fontSize: '12px',
            lineHeight: '1.6',
          }}
        >
          {events.length === 0 && (
            <div style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              height: '100%',
              color: '#484f58',
              fontSize: '13px',
            }}>
              Send a message to see the debug log...
            </div>
          )}
          {events.map((event, idx) => (
            <div
              key={idx}
              onClick={() => setExpandedIdx(expandedIdx === idx ? null : idx)}
              style={{
                padding: '4px 16px',
                cursor: event.data ? 'pointer' : 'default',
                backgroundColor: expandedIdx === idx ? '#161b22' : 'transparent',
                borderLeft: `3px solid ${PHASE_COLORS[event.phase] || '#484f58'}`,
              }}
            >
              <div style={{ display: 'flex', gap: '8px', alignItems: 'baseline' }}>
                <span style={{ color: '#484f58', minWidth: '85px', flexShrink: 0 }}>
                  {formatTime(event.timestamp)}
                </span>
                <span style={{ fontSize: '13px' }}>
                  {PHASE_ICONS[event.phase] || '•'}
                </span>
                <span style={{
                  color: PHASE_COLORS[event.phase] || '#8b949e',
                  fontWeight: 500,
                  textTransform: 'uppercase',
                  fontSize: '10px',
                  minWidth: '80px',
                  flexShrink: 0,
                }}>
                  {event.phase}
                </span>
                <span style={{ color: '#e6edf3' }}>
                  {event.label}
                </span>
                {event.data ? (
                  <span style={{ color: '#484f58', fontSize: '11px' }}>
                    {expandedIdx === idx ? '▼' : '▶'}
                  </span>
                ) : null}
              </div>
              {expandedIdx === idx && event.data ? (
                <pre style={{
                  margin: '4px 0 4px 93px',
                  padding: '8px 12px',
                  backgroundColor: '#0d1117',
                  border: '1px solid #21262d',
                  borderRadius: '6px',
                  color: '#8b949e',
                  fontSize: '11px',
                  lineHeight: '1.4',
                  overflow: 'auto',
                  maxHeight: '200px',
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                }}>
                  {formatData(event.data)}
                </pre>
              ) : null}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
