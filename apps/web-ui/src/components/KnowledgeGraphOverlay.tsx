import { useEffect, useMemo, useState } from 'react';
import { useAppContext } from '../context/AppContext';
import { fetchKnowledgeGraphs } from '../lib/api';
import type { KnowledgeGraphDump } from '../lib/api';

interface KnowledgeGraphOverlayProps {
  onClose: () => void;
}

function graphLabel(graph: KnowledgeGraphDump, agentId: string): string {
  if (graph.uri.startsWith('urn:shared:')) {
    return `shared:${graph.uri.slice('urn:shared:'.length)}`;
  }

  const agentPrefix = `urn:${agentId}:`;
  if (graph.uri.startsWith(agentPrefix)) {
    return graph.uri.slice(agentPrefix.length).replace(/_/g, ' ');
  }

  return graph.uri;
}

function graphStatus(graph: KnowledgeGraphDump): string {
  if (graph.error) return 'error';
  if (typeof graph.tripleCount === 'number') {
    return `${graph.tripleCount} triples`;
  }
  if (graph.turtle.trim()) return 'loaded';
  return 'empty';
}

export function KnowledgeGraphOverlay({ onClose }: KnowledgeGraphOverlayProps) {
  const { token } = useAppContext();
  const [agentId, setAgentId] = useState('ontofelia');
  const [graphs, setGraphs] = useState<KnowledgeGraphDump[]>([]);
  const [activeUri, setActiveUri] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const activeGraph = useMemo(
    () => graphs.find((graph) => graph.uri === activeUri) ?? graphs[0],
    [activeUri, graphs],
  );

  const loadGraphs = async () => {
    if (!token) {
      setError('Gateway token is missing.');
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);
    try {
      const response = await fetchKnowledgeGraphs(token);
      setAgentId(response.agentId);
      setGraphs(response.graphs);
      setActiveUri((current) => {
        if (current && response.graphs.some((graph) => graph.uri === current)) return current;
        return response.graphs[0]?.uri ?? null;
      });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    // Intentional data-fetch-on-mount: loadGraphs() sets state asynchronously.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadGraphs();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Knowledge Graph"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 1000,
        backgroundColor: 'rgba(0, 0, 0, 0.7)',
        backdropFilter: 'blur(4px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 'var(--space-4)',
      }}
    >
      <div
        className="animate-fade-in"
        style={{
          width: 'min(1120px, 94vw)',
          height: 'min(780px, 86vh)',
          backgroundColor: 'var(--color-bg-primary)',
          border: '1px solid var(--color-border)',
          borderRadius: 'var(--radius-lg)',
          boxShadow: 'var(--shadow-lg)',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 'var(--space-3)',
            padding: 'var(--space-4)',
            borderBottom: '1px solid var(--color-border)',
            backgroundColor: 'var(--color-surface)',
          }}
        >
          <div style={{ minWidth: 0 }}>
            <h2 style={{ fontSize: 'var(--font-size-lg)', fontWeight: 600, margin: 0 }}>
              Knowledge Graph
            </h2>
            <div
              style={{
                marginTop: '2px',
                fontSize: 'var(--font-size-xs)',
                color: 'var(--color-text-secondary)',
                fontFamily: 'var(--font-mono)',
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
              }}
            >
              {agentId} - {graphs.length} named graphs
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', flexShrink: 0 }}>
            <button
              onClick={loadGraphs}
              disabled={loading}
              style={{
                padding: 'var(--space-2) var(--space-3)',
                borderRadius: 'var(--radius-md)',
                border: '1px solid var(--color-border)',
                backgroundColor: 'var(--color-bg-secondary)',
                color: 'var(--color-text-primary)',
                fontSize: 'var(--font-size-sm)',
                cursor: loading ? 'wait' : 'pointer',
                opacity: loading ? 0.7 : 1,
              }}
            >
              Refresh
            </button>
            <button
              onClick={onClose}
              aria-label="Close Knowledge Graph"
              style={{
                width: '32px',
                height: '32px',
                borderRadius: 'var(--radius-md)',
                border: '1px solid var(--color-border)',
                backgroundColor: 'transparent',
                color: 'var(--color-text-primary)',
                fontSize: 'var(--font-size-lg)',
                lineHeight: 1,
                cursor: 'pointer',
              }}
            >
              X
            </button>
          </div>
        </div>

        <div
          role="tablist"
          aria-label="Named Graphs"
          style={{
            display: 'flex',
            gap: 'var(--space-1)',
            overflowX: 'auto',
            padding: 'var(--space-3) var(--space-4) 0',
            backgroundColor: 'var(--color-bg-secondary)',
            borderBottom: '1px solid var(--color-border)',
            minHeight: '52px',
            flexShrink: 0,
          }}
        >
          {graphs.map((graph) => {
            const active = activeGraph?.uri === graph.uri;
            return (
              <button
                key={graph.uri}
                role="tab"
                aria-selected={active}
                title={graph.uri}
                onClick={() => setActiveUri(graph.uri)}
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'flex-start',
                  justifyContent: 'center',
                  gap: '2px',
                  minWidth: '142px',
                  maxWidth: '210px',
                  height: '40px',
                  padding: '0 var(--space-3)',
                  border: '1px solid var(--color-border)',
                  borderBottomColor: active ? 'var(--color-bg-primary)' : 'var(--color-border)',
                  borderRadius: 'var(--radius-md) var(--radius-md) 0 0',
                  backgroundColor: active ? 'var(--color-bg-primary)' : 'var(--color-surface)',
                  color: active ? 'var(--color-text-primary)' : 'var(--color-text-secondary)',
                  cursor: 'pointer',
                  flexShrink: 0,
                }}
              >
                <span
                  style={{
                    width: '100%',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    fontSize: 'var(--font-size-sm)',
                    fontWeight: active ? 600 : 500,
                    textAlign: 'left',
                  }}
                >
                  {graphLabel(graph, agentId)}
                </span>
                <span
                  style={{
                    width: '100%',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    fontSize: 'var(--font-size-xs)',
                    color: graph.error ? 'var(--color-error)' : 'var(--color-text-secondary)',
                    textAlign: 'left',
                  }}
                >
                  {graphStatus(graph)}
                </span>
              </button>
            );
          })}
        </div>

        <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
          {loading && graphs.length === 0 ? (
            <div
              style={{
                flex: 1,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: 'var(--color-text-secondary)',
                fontSize: 'var(--font-size-sm)',
              }}
            >
              Loading named graphs...
            </div>
          ) : error ? (
            <div
              style={{
                flex: 1,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: 'var(--color-error)',
                fontSize: 'var(--font-size-sm)',
                padding: 'var(--space-4)',
                textAlign: 'center',
              }}
            >
              {error}
            </div>
          ) : activeGraph ? (
            <>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 'var(--space-3)',
                  padding: 'var(--space-3) var(--space-4)',
                  borderBottom: '1px solid var(--color-border)',
                  backgroundColor: 'var(--color-bg-primary)',
                  flexShrink: 0,
                }}
              >
                <div
                  title={activeGraph.uri}
                  style={{
                    minWidth: 0,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    fontFamily: 'var(--font-mono)',
                    fontSize: 'var(--font-size-xs)',
                    color: 'var(--color-text-secondary)',
                  }}
                >
                  {activeGraph.uri}
                </div>
                <div
                  style={{
                    flexShrink: 0,
                    fontSize: 'var(--font-size-xs)',
                    color: activeGraph.error ? 'var(--color-error)' : 'var(--color-text-secondary)',
                    fontFamily: 'var(--font-mono)',
                  }}
                >
                  {graphStatus(activeGraph)}
                </div>
              </div>

              {activeGraph.error ? (
                <div
                  style={{
                    padding: 'var(--space-4)',
                    color: 'var(--color-error)',
                    fontSize: 'var(--font-size-sm)',
                  }}
                >
                  {activeGraph.error}
                </div>
              ) : activeGraph.turtle.trim() ? (
                <pre
                  style={{
                    flex: 1,
                    minHeight: 0,
                    margin: 0,
                    padding: 'var(--space-4)',
                    overflow: 'auto',
                    backgroundColor: '#0b0b10',
                    color: 'var(--color-text-primary)',
                    fontFamily: 'var(--font-mono)',
                    fontSize: '12px',
                    lineHeight: 1.6,
                    whiteSpace: 'pre',
                  }}
                >
                  {activeGraph.turtle}
                </pre>
              ) : (
                <div
                  style={{
                    flex: 1,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    color: 'var(--color-text-secondary)',
                    fontSize: 'var(--font-size-sm)',
                  }}
                >
                  This graph is empty.
                </div>
              )}
            </>
          ) : (
            <div
              style={{
                flex: 1,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: 'var(--color-text-secondary)',
                fontSize: 'var(--font-size-sm)',
              }}
            >
              No named graphs are registered.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
