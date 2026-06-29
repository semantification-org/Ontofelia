import { useEffect, useRef, useMemo } from 'react';
import { useAppContext } from '../context/AppContext';
import { MessageBubble } from './MessageBubble';
import { ChatInput } from './ChatInput';

export function ChatArea() {
  const { messages, activeSessionId, isWaiting, loadSessionTranscript, pendingApprovals, respondGuardian } = useAppContext();
  const scrollRef = useRef<HTMLDivElement>(null);

  // Load transcript from server when session changes
  useEffect(() => {
    if (activeSessionId) {
      loadSessionTranscript(activeSessionId);
    }
  }, [activeSessionId, loadSessionTranscript]);

  // Show messages for active session, or 'new-session' (pre-session messages)
  const currentMessages = useMemo(() => {
    if (activeSessionId) return messages.get(activeSessionId) || [];
    // Before a session is created, messages are stored under 'new-session'
    return messages.get('new-session') || [];
  }, [activeSessionId, messages]);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [currentMessages, isWaiting]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', flex: 1 }}>
      <div 
        ref={scrollRef}
        style={{ 
          flex: 1, 
          overflowY: 'auto', 
          padding: 'var(--space-6) var(--space-4)',
          display: 'flex',
          flexDirection: 'column',
          gap: 'var(--space-4)',
          scrollBehavior: 'smooth'
        }}
      >
        {currentMessages.length === 0 ? (
          <div style={{ 
            margin: 'auto', 
            textAlign: 'center', 
            color: 'var(--color-text-secondary)',
            maxWidth: '400px'
          }}>
            <img
              src="/ontofelia-avatar.jpg"
              alt="Ontofelia"
              style={{
                width: '80px',
                height: '80px',
                borderRadius: '50%',
                objectFit: 'cover',
                margin: '0 auto var(--space-4)',
                display: 'block',
                opacity: 0.9,
              }}
            />
            <h2>Ontofelia</h2>
            <p style={{ marginTop: 'var(--space-2)' }}>
              Start a conversation or enter a command like /new, /status, /reset
            </p>
          </div>
        ) : (
          currentMessages.map(msg => (
            <MessageBubble key={msg.id} message={msg} />
          ))
        )}
        
        {isWaiting && (
          <div style={{ display: 'flex', gap: 'var(--space-2)', padding: 'var(--space-4)', alignSelf: 'flex-start', color: 'var(--color-text-secondary)', alignItems: 'center' }}>
            <img
              src="/ontofelia-avatar.jpg"
              alt="Ontofelia"
              style={{
                width: '32px',
                height: '32px',
                borderRadius: '50%',
                objectFit: 'cover',
                flexShrink: 0,
              }}
            />
            <span>Agent typing</span>
            <div style={{ display: 'flex', alignItems: 'flex-end', paddingBottom: '4px' }}>
              <div className="typing-dot" />
              <div className="typing-dot" />
              <div className="typing-dot" />
            </div>
          </div>
        )}
      </div>
      
      <div style={{ padding: 'var(--space-4)', borderTop: '1px solid var(--color-border)', backgroundColor: 'var(--color-bg-primary)' }}>
        {pendingApprovals.map(a => (
          <div key={a.callId} style={{ marginBottom: 'var(--space-3)', padding: 'var(--space-3)', border: '1px solid #f59e0b', borderRadius: 'var(--radius-md)', backgroundColor: 'rgba(245,158,11,0.08)' }}>
            <div style={{ fontSize: 'var(--font-size-sm)', fontWeight: 600, marginBottom: 'var(--space-2)' }}>
              ⚠️ Guardian approval required
            </div>
            {a.command && (
              <pre style={{ margin: '0 0 var(--space-2)', fontFamily: 'var(--font-mono)', fontSize: 'var(--font-size-xs)', whiteSpace: 'pre-wrap', wordBreak: 'break-all', color: 'var(--color-text-secondary)' }}>{a.command}</pre>
            )}
            <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
              <button onClick={() => respondGuardian(a.callId, true)} style={{ padding: 'var(--space-2) var(--space-4)', borderRadius: 'var(--radius-md)', border: 'none', backgroundColor: '#22c55e', color: '#fff', fontWeight: 600, cursor: 'pointer' }}>✅ Approve</button>
              <button onClick={() => respondGuardian(a.callId, false)} style={{ padding: 'var(--space-2) var(--space-4)', borderRadius: 'var(--radius-md)', border: '1px solid var(--color-border)', backgroundColor: 'transparent', color: 'var(--color-text-primary)', fontWeight: 600, cursor: 'pointer' }}>❌ Deny</button>
              <button onClick={() => respondGuardian(a.callId, true, true)} style={{ padding: 'var(--space-2) var(--space-4)', borderRadius: 'var(--radius-md)', border: '1px solid #22c55e', backgroundColor: 'transparent', color: '#22c55e', fontWeight: 600, cursor: 'pointer' }}>✅✅ Approve all (this task)</button>
            </div>
          </div>
        ))}
        <ChatInput />
      </div>
    </div>
  );
}
