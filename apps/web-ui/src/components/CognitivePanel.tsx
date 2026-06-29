import { useEffect, useState } from 'react';
import { useAppContext } from '../context/AppContext';
import {
  CogDisabledError,
  fetchCogCycle,
  fetchCogCycles,
  fetchCogEpisodes,
  fetchCogExplain,
  fetchCogGoals,
  type CogCycleDetail,
  type CogCycleSummary,
  type CogEpisode,
  type CogExplanation,
  type CogGoal,
} from '../lib/api';

interface CognitivePanelProps {
  onClose: () => void;
}

type Tab = 'cycles' | 'goals' | 'episodes';

const card: React.CSSProperties = {
  border: '1px solid var(--color-border)',
  borderRadius: 'var(--radius-md)',
  backgroundColor: 'var(--color-surface)',
  padding: 'var(--space-3)',
  marginBottom: 'var(--space-2)',
};
const mono: React.CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--font-size-xs)',
  color: 'var(--color-text-secondary)',
};
const label: React.CSSProperties = {
  fontSize: 'var(--font-size-xs)',
  fontWeight: 600,
  color: 'var(--color-text-secondary)',
  textTransform: 'uppercase',
  letterSpacing: '0.04em',
};

function fmt(iso?: string): string {
  if (!iso) return '-';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

export function CognitivePanel({ onClose }: CognitivePanelProps) {
  const { token, activeSessionId } = useAppContext();
  const [tab, setTab] = useState<Tab>('cycles');
  const [disabled, setDisabled] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const [cycles, setCycles] = useState<CogCycleSummary[]>([]);
  const [detail, setDetail] = useState<CogCycleDetail | null>(null);
  const [explanation, setExplanation] = useState<CogExplanation | null>(null);
  const [goals, setGoals] = useState<CogGoal[]>([]);
  const [episodes, setEpisodes] = useState<CogEpisode[]>([]);
  const [entityFilter, setEntityFilter] = useState('');

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  async function guard<T>(fn: () => Promise<T>, apply: (v: T) => void): Promise<void> {
    if (!token) {
      setError('Gateway token is missing.');
      return;
    }
    setLoading(true);
    setError(null);
    try {
      apply(await fn());
      setDisabled(false);
    } catch (e) {
      if (e instanceof CogDisabledError) setDisabled(true);
      else setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  function loadTab(next: Tab) {
    setTab(next);
    if (!token) return;
    if (next === 'cycles') {
      if (!activeSessionId) return;
      void guard(() => fetchCogCycles(token, activeSessionId), setCycles);
    } else if (next === 'goals') {
      if (!activeSessionId) return;
      void guard(() => fetchCogGoals(token, activeSessionId), setGoals);
    } else {
      void guard(() => fetchCogEpisodes(token, entityFilter || undefined), setEpisodes);
    }
  }

  useEffect(() => {
    // Intentional data-fetch-on-tab-change: loadTab() sets state asynchronously.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadTab('cycles');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, activeSessionId]);

  function openCycle(cycleId: string) {
    if (!token || !activeSessionId) return;
    setExplanation(null);
    void guard(() => fetchCogCycle(token, activeSessionId, cycleId), setDetail);
  }

  function explain(cycleId: string) {
    if (!token || !activeSessionId) return;
    void guard(() => fetchCogExplain(token, activeSessionId, cycleId), setExplanation);
  }

  const headerSub = activeSessionId
    ? `session ${activeSessionId}`
    : 'no active session selected';

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Cognitive Debug Panel"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
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
          width: 'min(1160px, 95vw)',
          height: 'min(800px, 88vh)',
          backgroundColor: 'var(--color-bg-primary)',
          border: '1px solid var(--color-border)',
          borderRadius: 'var(--radius-lg)',
          boxShadow: 'var(--shadow-lg)',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        }}
      >
        {/* Header */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: 'var(--space-4)',
            borderBottom: '1px solid var(--color-border)',
            backgroundColor: 'var(--color-surface)',
          }}
        >
          <div style={{ minWidth: 0 }}>
            <h2 style={{ fontSize: 'var(--font-size-lg)', fontWeight: 600, margin: 0 }}>
              Cognitive Debug Panel
            </h2>
            <div style={{ ...mono, marginTop: '2px' }}>{headerSub}</div>
          </div>
          <button
            onClick={onClose}
            aria-label="Close Cognitive Debug Panel"
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

        {/* Tabs */}
        <div
          role="tablist"
          style={{
            display: 'flex',
            gap: 'var(--space-1)',
            padding: 'var(--space-3) var(--space-4) 0',
            backgroundColor: 'var(--color-bg-secondary)',
            borderBottom: '1px solid var(--color-border)',
            flexShrink: 0,
          }}
        >
          {(['cycles', 'goals', 'episodes'] as Tab[]).map((t) => {
            const active = tab === t;
            return (
              <button
                key={t}
                role="tab"
                aria-selected={active}
                onClick={() => loadTab(t)}
                style={{
                  minWidth: '110px',
                  height: '38px',
                  padding: '0 var(--space-3)',
                  border: '1px solid var(--color-border)',
                  borderBottomColor: active ? 'var(--color-bg-primary)' : 'var(--color-border)',
                  borderRadius: 'var(--radius-md) var(--radius-md) 0 0',
                  backgroundColor: active ? 'var(--color-bg-primary)' : 'var(--color-surface)',
                  color: active ? 'var(--color-text-primary)' : 'var(--color-text-secondary)',
                  fontWeight: active ? 600 : 500,
                  fontSize: 'var(--font-size-sm)',
                  cursor: 'pointer',
                  textTransform: 'capitalize',
                }}
              >
                {t}
              </button>
            );
          })}
        </div>

        {/* Body */}
        <div style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: 'var(--space-4)' }}>
          {disabled ? (
            <div style={{ ...card, color: 'var(--color-text-secondary)' }}>
              The cognitive debug panel is disabled. Enable it from a chat with{' '}
              <code style={mono}>/cog debug on</code>, then refresh.
            </div>
          ) : error ? (
            <div style={{ ...card, color: 'var(--color-error)' }}>{error}</div>
          ) : loading ? (
            <div style={{ color: 'var(--color-text-secondary)', fontSize: 'var(--font-size-sm)' }}>
              Loading...
            </div>
          ) : tab === 'cycles' ? (
            <CyclesView
              sessionId={activeSessionId}
              cycles={cycles}
              detail={detail}
              explanation={explanation}
              onOpen={openCycle}
              onExplain={explain}
            />
          ) : tab === 'goals' ? (
            <GoalsView sessionId={activeSessionId} goals={goals} />
          ) : (
            <EpisodesView
              episodes={episodes}
              entityFilter={entityFilter}
              onEntityFilterChange={setEntityFilter}
              onApply={() => loadTab('episodes')}
            />
          )}
        </div>
      </div>
    </div>
  );
}

function Empty({ text }: { text: string }) {
  return (
    <div style={{ color: 'var(--color-text-secondary)', fontSize: 'var(--font-size-sm)' }}>{text}</div>
  );
}

function CyclesView({
  sessionId,
  cycles,
  detail,
  explanation,
  onOpen,
  onExplain,
}: {
  sessionId: string | null;
  cycles: CogCycleSummary[];
  detail: CogCycleDetail | null;
  explanation: CogExplanation | null;
  onOpen: (cycleId: string) => void;
  onExplain: (cycleId: string) => void;
}) {
  if (!sessionId) return <Empty text="Select a session to inspect its cognitive cycles." />;
  if (cycles.length === 0) return <Empty text="No cycles recorded for this session yet." />;

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '320px 1fr', gap: 'var(--space-4)' }}>
      <div style={{ minWidth: 0 }}>
        <div style={{ ...label, marginBottom: 'var(--space-2)' }}>Cycles (newest first)</div>
        {cycles.map((c) => {
          const active = detail?.cycle.cycleId === c.cycleId;
          return (
            <button
              key={c.cycleId}
              onClick={() => onOpen(c.cycleId)}
              style={{
                ...card,
                display: 'block',
                width: '100%',
                textAlign: 'left',
                cursor: 'pointer',
                borderColor: active ? 'var(--color-primary, #6366f1)' : 'var(--color-border)',
              }}
            >
              <div style={{ fontSize: 'var(--font-size-sm)', fontWeight: 600 }}>{c.cycleId}</div>
              <div style={mono}>
                {c.status} · {c.durationMs}ms · {fmt(c.startedAt)}
              </div>
            </button>
          );
        })}
      </div>

      <div style={{ minWidth: 0 }}>
        {!detail ? (
          <Empty text="Select a cycle to see its phases, working memory and episodes." />
        ) : (
          <>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div style={{ ...label }}>Cycle {detail.cycle.cycleId}</div>
              <button
                onClick={() => onExplain(detail.cycle.cycleId)}
                style={{
                  padding: 'var(--space-1) var(--space-3)',
                  borderRadius: 'var(--radius-md)',
                  border: '1px solid var(--color-border)',
                  backgroundColor: 'var(--color-bg-secondary)',
                  color: 'var(--color-text-primary)',
                  fontSize: 'var(--font-size-sm)',
                  cursor: 'pointer',
                }}
              >
                Explain this response
              </button>
            </div>

            {detail.marker && (
              <div style={{ ...card, marginTop: 'var(--space-2)' }}>
                <div style={label}>Reflection</div>
                <div style={{ fontSize: 'var(--font-size-sm)' }}>{detail.marker.noted ?? '-'}</div>
                {detail.marker.flaggedImpasse.length > 0 && (
                  <div style={{ ...mono, color: 'var(--color-error)' }}>
                    impasse: {detail.marker.flaggedImpasse.join(', ')}
                  </div>
                )}
              </div>
            )}

            <div style={{ ...label, marginTop: 'var(--space-3)' }}>Phase timeline</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-1)', marginTop: 'var(--space-1)' }}>
              {detail.phases.map((p) => (
                <span
                  key={p.phaseUri}
                  title={`${fmt(p.startedAt)} → ${fmt(p.endedAt)}`}
                  style={{
                    ...mono,
                    padding: '2px 8px',
                    border: '1px solid var(--color-border)',
                    borderRadius: 'var(--radius-sm)',
                    backgroundColor: 'var(--color-surface)',
                  }}
                >
                  {p.ordinal}. {p.phaseKind}
                </span>
              ))}
            </div>

            <div style={{ ...label, marginTop: 'var(--space-3)' }}>Working memory ({detail.buffer.length})</div>
            {detail.buffer.length === 0 ? (
              <Empty text="No working-memory entries." />
            ) : (
              detail.buffer.map((e) => (
                <div key={e.id} style={card}>
                  <div style={mono}>
                    {e.buffer} · {e.entryKind} · salience {e.salience}
                  </div>
                  <div style={{ fontSize: 'var(--font-size-sm)' }}>{e.payload}</div>
                  {e.forGoal && <div style={mono}>→ goal {e.forGoal}</div>}
                  {e.refersTo && <div style={mono}>→ refers {e.refersTo}</div>}
                </div>
              ))
            )}

            <div style={{ ...label, marginTop: 'var(--space-3)' }}>Episodes ({detail.episodes.length})</div>
            {detail.episodes.length === 0 ? (
              <Empty text="No episodes written in this cycle." />
            ) : (
              detail.episodes.map((ep) => (
                <div key={ep.uri} style={card}>
                  <div style={mono}>
                    {ep.episodeType} · {fmt(ep.occurredAt)}
                  </div>
                  {ep.payload && <div style={{ fontSize: 'var(--font-size-sm)' }}>{ep.payload}</div>}
                </div>
              ))
            )}

            {explanation && (
              <div style={{ ...card, marginTop: 'var(--space-3)', borderColor: 'var(--color-primary, #6366f1)' }}>
                <div style={label}>Why this response — WM → action → goal → episode</div>
                {explanation.actions.length === 0 ? (
                  <Empty text="No action entries to explain." />
                ) : (
                  explanation.actions.map((a) => (
                    <div key={a.entryId} style={{ marginTop: 'var(--space-2)' }}>
                      <div style={{ fontSize: 'var(--font-size-sm)', fontWeight: 600 }}>action: {a.payload}</div>
                      {a.goal && <div style={mono}>↳ goal: {a.goal.goalLabel} ({a.goal.status})</div>}
                      {a.triggeringEpisode && (
                        <div style={mono}>↳ triggered by: {a.triggeringEpisode.payload ?? a.triggeringEpisode.episodeId}</div>
                      )}
                    </div>
                  ))
                )}
                {explanation.retrievals.length > 0 && (
                  <div style={{ marginTop: 'var(--space-2)' }}>
                    <div style={label}>Retrievals into workspace</div>
                    {explanation.retrievals.map((r) => (
                      <div key={r.entryId} style={mono}>
                        • {r.payload}
                        {r.episode ? ` ← ${r.episode.episodeId}` : ''}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function GoalsView({ sessionId, goals }: { sessionId: string | null; goals: CogGoal[] }) {
  if (!sessionId) return <Empty text="Select a session to inspect its goals." />;
  if (goals.length === 0) return <Empty text="No goals recorded for this session." />;
  return (
    <div>
      {goals.map((g) => (
        <div key={g.uri} style={card}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
            <span style={{ fontSize: 'var(--font-size-sm)', fontWeight: 600 }}>{g.goalLabel}</span>
            <span style={mono}>
              {g.status} · p{g.priority}
              {g.longTerm ? ' · long-term' : ''}
            </span>
          </div>
          <div style={mono}>{fmt(g.createdAt)}</div>
          {g.successCriterion && <div style={{ fontSize: 'var(--font-size-xs)' }}>✓ {g.successCriterion}</div>}
          {g.triggeredByEpisode && <div style={mono}>← {g.triggeredByEpisode}</div>}
        </div>
      ))}
    </div>
  );
}

function EpisodesView({
  episodes,
  entityFilter,
  onEntityFilterChange,
  onApply,
}: {
  episodes: CogEpisode[];
  entityFilter: string;
  onEntityFilterChange: (v: string) => void;
  onApply: () => void;
}) {
  return (
    <div>
      <div style={{ display: 'flex', gap: 'var(--space-2)', marginBottom: 'var(--space-3)' }}>
        <input
          value={entityFilter}
          onChange={(e) => onEntityFilterChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') onApply();
          }}
          placeholder="Filter by entity IRI (cogt:about), e.g. urn:entity:weather"
          style={{
            flex: 1,
            padding: 'var(--space-2) var(--space-3)',
            borderRadius: 'var(--radius-md)',
            border: '1px solid var(--color-border)',
            backgroundColor: 'var(--color-bg-secondary)',
            color: 'var(--color-text-primary)',
            fontSize: 'var(--font-size-sm)',
            fontFamily: 'var(--font-mono)',
          }}
        />
        <button
          onClick={onApply}
          style={{
            padding: 'var(--space-2) var(--space-4)',
            borderRadius: 'var(--radius-md)',
            border: '1px solid var(--color-border)',
            backgroundColor: 'var(--color-bg-secondary)',
            color: 'var(--color-text-primary)',
            fontSize: 'var(--font-size-sm)',
            cursor: 'pointer',
          }}
        >
          Apply
        </button>
      </div>
      {episodes.length === 0 ? (
        <Empty text="No episodes match." />
      ) : (
        episodes.map((ep) => (
          <div key={ep.uri} style={card}>
            <div style={mono}>
              {ep.episodeType} · {fmt(ep.occurredAt)}
              {ep.outcome ? ` · ${ep.outcome}` : ''}
            </div>
            {ep.payload && <div style={{ fontSize: 'var(--font-size-sm)' }}>{ep.payload}</div>}
            {ep.about.length > 0 && <div style={mono}>about: {ep.about.join(', ')}</div>}
          </div>
        ))
      )}
    </div>
  );
}
