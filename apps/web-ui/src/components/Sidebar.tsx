
import { useState, useRef, useEffect } from 'react';
import { useAppContext } from '../context/AppContext';
import { StatusIndicator } from './StatusIndicator';
import { deleteSession, renameSession } from '../lib/api';
import { KnowledgeGraphOverlay } from './KnowledgeGraphOverlay';
import { CognitivePanel } from './CognitivePanel';

function SessionMenu({ sessionId, displayName, onClose }: { sessionId: string; displayName?: string; onClose: () => void }) {
  const { token, dispatch } = useAppContext();
  const [mode, setMode] = useState<'menu' | 'rename'>('menu');
  const [newName, setNewName] = useState(displayName || '');
  const menuRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (mode === 'rename' && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [mode]);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [onClose]);

  const handleDelete = async () => {
    if (!token) return;
    try {
      await deleteSession(token, sessionId);
      dispatch({ type: 'REMOVE_SESSION', payload: sessionId });
      onClose();
    } catch (e) {
      console.error('Failed to delete session', e);
    }
  };

  const handleRename = async () => {
    if (!token || !newName.trim()) return;
    try {
      await renameSession(token, sessionId, newName.trim());
      dispatch({ type: 'RENAME_SESSION', payload: { sessionId, displayName: newName.trim() } });
      onClose();
    } catch (e) {
      console.error('Failed to rename session', e);
    }
  };

  return (
    <div
      ref={menuRef}
      style={{
        position: 'absolute',
        right: 0,
        top: '100%',
        zIndex: 100,
        backgroundColor: 'var(--color-surface)',
        border: '1px solid var(--color-border)',
        borderRadius: 'var(--radius-md)',
        boxShadow: '0 4px 12px rgba(0,0,0,0.3)',
        minWidth: '160px',
        overflow: 'hidden',
      }}
    >
      {mode === 'menu' ? (
        <>
          <button
            onClick={() => setMode('rename')}
            style={{
              display: 'block',
              width: '100%',
              textAlign: 'left',
              padding: '8px 12px',
              fontSize: 'var(--font-size-sm)',
              color: 'var(--color-text-primary)',
              backgroundColor: 'transparent',
              border: 'none',
              cursor: 'pointer',
            }}
            onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = 'var(--color-surface-hover)')}
            onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = 'transparent')}
          >
            ✏️ Rename
          </button>
          <button
            onClick={handleDelete}
            style={{
              display: 'block',
              width: '100%',
              textAlign: 'left',
              padding: '8px 12px',
              fontSize: 'var(--font-size-sm)',
              color: '#ef4444',
              backgroundColor: 'transparent',
              border: 'none',
              cursor: 'pointer',
            }}
            onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = 'var(--color-surface-hover)')}
            onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = 'transparent')}
          >
            🗑️ Delete
          </button>
        </>
      ) : (
        <div style={{ padding: '8px' }}>
          <input
            ref={inputRef}
            type="text"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleRename();
              if (e.key === 'Escape') onClose();
            }}
            placeholder="Session name..."
            style={{
              width: '100%',
              padding: '6px 8px',
              fontSize: 'var(--font-size-sm)',
              backgroundColor: 'var(--color-bg-primary)',
              color: 'var(--color-text-primary)',
              border: '1px solid var(--color-border)',
              borderRadius: 'var(--radius-sm)',
              outline: 'none',
              boxSizing: 'border-box',
            }}
          />
          <div style={{ display: 'flex', gap: '4px', marginTop: '6px' }}>
            <button
              onClick={handleRename}
              style={{
                flex: 1,
                padding: '4px 8px',
                fontSize: 'var(--font-size-xs)',
                backgroundColor: 'var(--color-primary)',
                color: '#fff',
                border: 'none',
                borderRadius: 'var(--radius-sm)',
                cursor: 'pointer',
              }}
            >
              Save
            </button>
            <button
              onClick={onClose}
              style={{
                flex: 1,
                padding: '4px 8px',
                fontSize: 'var(--font-size-xs)',
                backgroundColor: 'transparent',
                color: 'var(--color-text-secondary)',
                border: '1px solid var(--color-border)',
                borderRadius: 'var(--radius-sm)',
                cursor: 'pointer',
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export function Sidebar() {
  const { sessions, activeSessionId, dispatch, gatewayStatus, connected, sendMessage } = useAppContext();
  const [menuOpen, setMenuOpen] = useState<string | null>(null);
  const [showKnowledgeGraph, setShowKnowledgeGraph] = useState(false);
  const [showCognitive, setShowCognitive] = useState(false);

  const handleNewSession = () => {
    sendMessage('/new', undefined, { echo: false });
  };

  return (
    <>
    <aside className="app-sidebar">
      <div style={{ padding: 'var(--space-4)', flex: 1, display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 'var(--space-2)' }}>
          <h2 style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
            Sessions
          </h2>
          <button 
            onClick={handleNewSession}
            style={{ 
              fontSize: 'var(--font-size-xs)', 
              backgroundColor: 'var(--color-primary)', 
              color: '#fff', 
              padding: '4px 8px', 
              borderRadius: 'var(--radius-sm)' 
            }}
          >
            + New
          </button>
        </div>
        
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-1)', flex: 1, overflowY: 'auto' }}>
          {sessions.length === 0 ? (
            <div style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)', textAlign: 'center', marginTop: 'var(--space-4)' }}>
              No sessions yet.
            </div>
          ) : (
            sessions.map(session => (
              <div
                key={session.sessionId}
                style={{ position: 'relative', display: 'flex', alignItems: 'center' }}
              >
                <button
                  onClick={() => dispatch({ type: 'SET_ACTIVE_SESSION', payload: session.sessionId })}
                  style={{
                    flex: 1,
                    textAlign: 'left',
                    padding: 'var(--space-2) var(--space-3)',
                    paddingRight: '32px',
                    borderRadius: 'var(--radius-md)',
                    backgroundColor: activeSessionId === session.sessionId ? 'var(--color-surface-hover)' : 'transparent',
                    color: activeSessionId === session.sessionId ? 'var(--color-text-primary)' : 'var(--color-text-secondary)',
                    transition: 'background-color var(--transition-fast)',
                    fontSize: 'var(--font-size-sm)',
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    border: 'none',
                    cursor: 'pointer',
                  }}
                >
                  {session.displayName || new Date(session.createdAt).toLocaleString()}
                  <div style={{ fontSize: 'var(--font-size-xs)', opacity: 0.7, marginTop: '2px' }}>
                    {session.messageCount} messages
                  </div>
                </button>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    setMenuOpen(menuOpen === session.sessionId ? null : session.sessionId);
                  }}
                  style={{
                    position: 'absolute',
                    right: '4px',
                    top: '50%',
                    transform: 'translateY(-50%)',
                    width: '24px',
                    height: '24px',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontSize: '14px',
                    color: 'var(--color-text-secondary)',
                    backgroundColor: 'transparent',
                    border: 'none',
                    borderRadius: 'var(--radius-sm)',
                    cursor: 'pointer',
                    opacity: 0.5,
                    transition: 'opacity var(--transition-fast)',
                  }}
                  onMouseEnter={(e) => (e.currentTarget.style.opacity = '1')}
                  onMouseLeave={(e) => (e.currentTarget.style.opacity = '0.5')}
                >
                  ⋮
                </button>
                {menuOpen === session.sessionId && (
                  <SessionMenu
                    sessionId={session.sessionId}
                    displayName={session.displayName}
                    onClose={() => setMenuOpen(null)}
                  />
                )}
              </div>
            ))
          )}
        </div>
      </div>

      <div style={{ padding: 'var(--space-4)', borderTop: '1px solid var(--color-border)', display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
        <h2 style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 'var(--space-1)' }}>
          Status
        </h2>
        
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ fontSize: 'var(--font-size-sm)' }}>Gateway</span>
          <StatusIndicator status={connected && gatewayStatus?.running ? 'success' : 'error'} />
        </div>
        
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ fontSize: 'var(--font-size-sm)' }}>Agent</span>
          <StatusIndicator status={gatewayStatus?.agents.running && gatewayStatus.agents.running > 0 ? 'success' : 'offline'} />
        </div>
        
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <div>
            <button
              type="button"
              onClick={() => setShowKnowledgeGraph(true)}
              style={{
                padding: 0,
                border: 'none',
                backgroundColor: 'transparent',
                color: 'var(--color-text-primary)',
                fontSize: 'var(--font-size-sm)',
                cursor: 'pointer',
                textAlign: 'left',
              }}
              onMouseEnter={(e) => (e.currentTarget.style.color = 'var(--color-primary-hover)')}
              onMouseLeave={(e) => (e.currentTarget.style.color = 'var(--color-text-primary)')}
            >
              Knowledge Graph
            </button>
            <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)', marginTop: '1px' }}>
              ({gatewayStatus?.memory?.tripleCount ?? 0} triples)
            </div>
            <button
              type="button"
              onClick={() => setShowCognitive(true)}
              style={{
                padding: 0,
                marginTop: 'var(--space-2)',
                border: 'none',
                backgroundColor: 'transparent',
                color: 'var(--color-text-primary)',
                fontSize: 'var(--font-size-sm)',
                cursor: 'pointer',
                textAlign: 'left',
                display: 'block',
              }}
              onMouseEnter={(e) => (e.currentTarget.style.color = 'var(--color-primary-hover)')}
              onMouseLeave={(e) => (e.currentTarget.style.color = 'var(--color-text-primary)')}
            >
              Cognitive Panel
            </button>
          </div>
          <StatusIndicator status={gatewayStatus?.memory?.status === 'running' || gatewayStatus?.memory?.status === 'ok' ? 'success' : 'offline'} />
        </div>
      </div>
    </aside>
    {showKnowledgeGraph && <KnowledgeGraphOverlay onClose={() => setShowKnowledgeGraph(false)} />}
    {showCognitive && <CognitivePanel onClose={() => setShowCognitive(false)} />}
    </>
  );
}
