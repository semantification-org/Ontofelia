import { useState, useEffect } from 'react';
import { useAppContext } from '../context/AppContext';
import { fetchProvider, fetchModels, changeModel, clearKnowledge, toggleFallback, changeFallbackModels } from '../lib/api';

interface SettingsPanelProps {
  onClose: () => void;
  forced?: boolean;
}

export function SettingsPanel({ onClose, forced = false }: SettingsPanelProps) {
  const { setToken, token } = useAppContext();
  const [inputToken, setInputToken] = useState(localStorage.getItem('ontofelia_token') || '');
  
  // LLM Settings
  const [currentProvider, setCurrentProvider] = useState('');
  const [currentModel, setCurrentModel] = useState('');
  const [modelInput, setModelInput] = useState('');
  const [models, setModels] = useState<Array<{ id: string; name?: string }>>([]);
  const [modelSaving, setModelSaving] = useState(false);
  const [modelMessage, setModelMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  
  // Knowledge Graph
  const [clearing, setClearing] = useState(false);
  const [clearConfirm, setClearConfirm] = useState(false);
  const [clearMessage, setClearMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  // Auto-Fallback
  const [autoFallback, setAutoFallback] = useState(true);
  const [fallbackA, setFallbackA] = useState('');
  const [fallbackB, setFallbackB] = useState('');

  // Load current provider info and available models
  useEffect(() => {
    const activeToken = token || inputToken.trim();
    if (!activeToken) return;
    
    fetchProvider(activeToken).then(p => {
      setCurrentProvider(p.name);
      setCurrentModel(p.model);
      setModelInput(p.model);
      setAutoFallback(p.autoFallback !== false);
      if (p.fallbackModels?.length >= 1) setFallbackA(p.fallbackModels[0]);
      if (p.fallbackModels?.length >= 2) setFallbackB(p.fallbackModels[1]);
    }).catch(() => {});
    
    fetchModels(activeToken).then(m => {
      setModels(m);
    }).catch(() => {});
  }, [token]);

  const handleSave = () => {
    if (inputToken.trim()) {
      const newToken = inputToken.trim();
      setToken(newToken);
      
      // Load models immediately with the new token
      fetchModels(newToken).then(m => setModels(m)).catch(() => {});
      fetchProvider(newToken).then(p => {
        setCurrentProvider(p.name);
        setCurrentModel(p.model);
        setModelInput(p.model);
        setAutoFallback(p.autoFallback !== false);
        if (p.fallbackModels?.length >= 1) setFallbackA(p.fallbackModels[0]);
        if (p.fallbackModels?.length >= 2) setFallbackB(p.fallbackModels[1]);
      }).catch(() => {});
      
      // Close after connecting — including the initial forced dialog, so the
      // user lands directly in the app instead of an empty settings popup.
      onClose();
    }
  };

  const handleModelChange = async () => {
    if (!token || !modelInput.trim() || modelInput === currentModel) return;
    setModelSaving(true);
    setModelMessage(null);
    try {
      await changeModel(token, modelInput.trim());
      setCurrentModel(modelInput.trim());
      setModelMessage({ type: 'success', text: `Model changed to ${modelInput.trim()}` });
    } catch (e) {
      setModelMessage({ type: 'error', text: (e as Error).message });
    } finally {
      setModelSaving(false);
    }
  };

  const handleClearKnowledge = async () => {
    if (!token) return;
    setClearing(true);
    setClearMessage(null);
    try {
      const res = await clearKnowledge(token);
      setClearMessage({ type: 'success', text: res.message });
      setClearConfirm(false);
    } catch (e) {
      setClearMessage({ type: 'error', text: (e as Error).message });
    } finally {
      setClearing(false);
    }
  };

  const inputStyle = {
    padding: 'var(--space-3)',
    borderRadius: 'var(--radius-md)',
    border: '1px solid var(--color-border)',
    backgroundColor: 'var(--color-surface)',
    color: 'var(--color-text-primary)',
    fontFamily: 'var(--font-mono)',
    width: '100%',
    boxSizing: 'border-box' as const,
    fontSize: 'var(--font-size-sm)',
  };

  const labelStyle = {
    fontSize: 'var(--font-size-sm)',
    color: 'var(--color-text-secondary)',
    fontWeight: 600 as const,
  };

  const sectionStyle = {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 'var(--space-2)',
  };

  const dividerStyle = {
    borderTop: '1px solid var(--color-border)',
    margin: 'var(--space-4) 0',
  };

  return (
    <div style={{
      position: 'fixed',
      top: 0, left: 0, right: 0, bottom: 0,
      backgroundColor: 'rgba(0, 0, 0, 0.7)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      zIndex: 100,
      padding: 'var(--space-4)',
      overflowY: 'auto',
    }}>
      <div 
        className="animate-fade-in"
        style={{
          backgroundColor: 'var(--color-bg-primary)',
          borderRadius: 'var(--radius-lg)',
          border: '1px solid var(--color-border)',
          padding: 'var(--space-6)',
          width: '100%',
          maxWidth: '480px',
          boxShadow: 'var(--shadow-lg)',
          maxHeight: '90vh',
          overflowY: 'auto',
        }}
      >
        <h2 style={{ fontSize: 'var(--font-size-xl)', fontWeight: 600, marginBottom: 'var(--space-4)' }}>
          Ontofelia Settings
        </h2>
        
        {/* --- Gateway Token --- */}
        <div style={sectionStyle}>
          <label htmlFor="token" style={labelStyle}>
            Gateway Token
          </label>
          <input
            id="token"
            type="password"
            value={inputToken}
            onChange={(e) => setInputToken(e.target.value)}
            placeholder="Enter your Gateway Token"
            style={inputStyle}
          />
          <p style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)' }}>
            Required to authenticate with the local Ontofelia Gateway.
          </p>
        </div>

        {/* Advanced settings need a live connection to load/populate, so they
            are hidden in the initial connect dialog (which only needs a token). */}
        {!forced && (<>
        <div style={dividerStyle} />

        {/* --- LLM Model --- */}
        <div style={sectionStyle}>
          <label htmlFor="model" style={labelStyle}>
            🤖 LLM Provider & Model
          </label>
          {currentProvider && (
            <div style={{
              display: 'flex',
              alignItems: 'center',
              gap: 'var(--space-2)',
              padding: 'var(--space-2) var(--space-3)',
              backgroundColor: 'var(--color-surface)',
              borderRadius: 'var(--radius-md)',
              border: '1px solid var(--color-border)',
            }}>
              <span style={{ fontSize: '14px' }}>
                {currentProvider === 'openai' ? '🟢' : currentProvider === 'openrouter' ? '🌐' : '🧪'}
              </span>
              <span style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-primary)', fontWeight: 600 }}>
                {currentProvider === 'openai' ? 'OpenAI (ChatGPT)' : currentProvider === 'openrouter' ? 'OpenRouter' : currentProvider}
              </span>
              <span style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)' }}>
                → {currentModel || '—'}
              </span>
            </div>
          )}
          {models.length > 0 ? (
            <>
              <select
                id="model"
                value={modelInput}
                onChange={async (e) => {
                  const newModel = e.target.value;
                  setModelInput(newModel);
                  if (!token || newModel === currentModel) return;
                  setModelSaving(true);
                  setModelMessage(null);
                  try {
                    await changeModel(token, newModel);
                    setCurrentModel(newModel);
                    setModelMessage({ type: 'success', text: `✔ ${(models.find(m => m.id === newModel)?.name || newModel)}` });
                  } catch (e) {
                    setModelMessage({ type: 'error', text: (e as Error).message });
                    setModelInput(currentModel);
                  } finally {
                    setModelSaving(false);
                  }
                }}
                disabled={modelSaving}
                style={{
                  ...inputStyle,
                  fontFamily: 'var(--font-sans)',
                  cursor: modelSaving ? 'wait' : 'pointer',
                  opacity: modelSaving ? 0.6 : 1,
                }}
              >
                {[...models].sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id)).map(m => (
                  <option key={m.id} value={m.id}>
                    {m.name || m.id}
                  </option>
                ))}
                {/* Allow custom model if current one isn't in list */}
                {!models.find(m => m.id === modelInput) && modelInput && (
                  <option value={modelInput}>{modelInput}</option>
                )}
              </select>
              {modelSaving && (
                <p style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)', margin: 0 }}>
                  Saving...
                </p>
              )}
            </>
          ) : (
            <>
              <input
                id="model"
                type="text"
                value={modelInput}
                onChange={(e) => setModelInput(e.target.value)}
                placeholder="e.g. deepseek/deepseek-v4-flash:free"
                style={inputStyle}
              />
              <button
                onClick={handleModelChange}
                disabled={modelSaving || !modelInput.trim() || modelInput === currentModel}
                style={{
                  padding: 'var(--space-2) var(--space-4)',
                  borderRadius: 'var(--radius-md)',
                  backgroundColor: 'var(--color-primary)',
                  color: '#fff',
                  fontWeight: 600,
                  fontSize: 'var(--font-size-sm)',
                  opacity: modelSaving || !modelInput.trim() || modelInput === currentModel ? 0.5 : 1,
                  cursor: modelSaving || !modelInput.trim() || modelInput === currentModel ? 'not-allowed' : 'pointer',
                  border: 'none',
                }}
              >
                {modelSaving ? 'Saving...' : 'Change Model'}
              </button>
            </>
          )}
          {modelMessage && (
            <p style={{
              fontSize: 'var(--font-size-xs)',
              color: modelMessage.type === 'success' ? '#22c55e' : '#ef4444',
              margin: 0,
            }}>
              {modelMessage.text}
            </p>
          )}
        </div>

        <div style={dividerStyle} />

        {/* --- Auto-Fallback Toggle --- */}
        <div style={sectionStyle}>
          <label style={labelStyle}>
            🔄 Auto-Fallback
          </label>
          <div style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 'var(--space-3)',
          }}>
            <p style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)', margin: 0, flex: 1 }}>
              Use a free LLM automatically when the primary model fails.
            </p>
            <button
              onClick={async () => {
                if (!token) return;
                const newVal = !autoFallback;
                setAutoFallback(newVal);
                try {
                  await toggleFallback(token, newVal);
                } catch { setAutoFallback(!newVal); }
              }}
              style={{
                width: '48px',
                height: '26px',
                borderRadius: '13px',
                border: 'none',
                backgroundColor: autoFallback ? 'var(--color-primary)' : 'var(--color-border)',
                cursor: 'pointer',
                position: 'relative',
                transition: 'background-color 0.2s ease',
                flexShrink: 0,
              }}
            >
              <div style={{
                width: '20px',
                height: '20px',
                borderRadius: '50%',
                backgroundColor: '#fff',
                position: 'absolute',
                top: '3px',
                left: autoFallback ? '25px' : '3px',
                transition: 'left 0.2s ease',
                boxShadow: '0 1px 3px rgba(0,0,0,0.3)',
              }} />
            </button>
          </div>
        </div>

        {/* --- Fallback Models --- */}
        {autoFallback && models.length > 0 && (
          <div style={{ ...sectionStyle, marginTop: 'var(--space-2)' }}>
            <label style={labelStyle}>
              Fallback A (1st attempt)
            </label>
            <select
              value={fallbackA}
              onChange={async (e) => {
                const val = e.target.value;
                setFallbackA(val);
                if (token) {
                  const newList = [val, fallbackB].filter(Boolean);
                  try { await changeFallbackModels(token, newList); } catch { /* ignore */ }
                }
              }}
              style={{ ...inputStyle, fontFamily: 'var(--font-sans)', cursor: 'pointer' }}
            >
              <option value="">— no fallback —</option>
              {[...models].sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id)).map(m => (
                <option key={m.id} value={m.id}>{m.name || m.id}</option>
              ))}
            </select>
            <label style={labelStyle}>
              Fallback B (2nd attempt)
            </label>
            <select
              value={fallbackB}
              onChange={async (e) => {
                const val = e.target.value;
                setFallbackB(val);
                if (token) {
                  const newList = [fallbackA, val].filter(Boolean);
                  try { await changeFallbackModels(token, newList); } catch { /* ignore */ }
                }
              }}
              style={{ ...inputStyle, fontFamily: 'var(--font-sans)', cursor: 'pointer' }}
            >
              <option value="">— no fallback —</option>
              {[...models].sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id)).map(m => (
                <option key={m.id} value={m.id}>{m.name || m.id}</option>
              ))}
            </select>
          </div>
        )}

        <div style={dividerStyle} />

        {/* --- Knowledge Graph --- */}
        <div style={sectionStyle}>
          <label style={labelStyle}>
            🧠 Knowledge Graph
          </label>
          <p style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)', margin: 0 }}>
            Delete all stored facts and provenance data. The ontology (TBox) will be re-initialized.
          </p>
          
          {!clearConfirm ? (
            <button
              onClick={() => setClearConfirm(true)}
              style={{
                padding: 'var(--space-2) var(--space-4)',
                borderRadius: 'var(--radius-md)',
                backgroundColor: 'transparent',
                color: '#ef4444',
                fontWeight: 600,
                fontSize: 'var(--font-size-sm)',
                border: '1px solid #ef4444',
                cursor: 'pointer',
                transition: 'all 0.15s ease',
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.backgroundColor = '#ef4444';
                e.currentTarget.style.color = '#fff';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.backgroundColor = 'transparent';
                e.currentTarget.style.color = '#ef4444';
              }}
            >
              Clear All Knowledge
            </button>
          ) : (
            <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center' }}>
              <span style={{ fontSize: 'var(--font-size-xs)', color: '#ef4444', fontWeight: 600 }}>
                ⚠️ Are you sure?
              </span>
              <button
                onClick={handleClearKnowledge}
                disabled={clearing}
                style={{
                  padding: 'var(--space-2) var(--space-4)',
                  borderRadius: 'var(--radius-md)',
                  backgroundColor: '#ef4444',
                  color: '#fff',
                  fontWeight: 600,
                  fontSize: 'var(--font-size-sm)',
                  border: 'none',
                  cursor: clearing ? 'not-allowed' : 'pointer',
                  opacity: clearing ? 0.5 : 1,
                }}
              >
                {clearing ? 'Clearing...' : 'Yes, delete everything'}
              </button>
              <button
                onClick={() => setClearConfirm(false)}
                style={{
                  padding: 'var(--space-2) var(--space-4)',
                  borderRadius: 'var(--radius-md)',
                  backgroundColor: 'transparent',
                  color: 'var(--color-text-secondary)',
                  fontSize: 'var(--font-size-sm)',
                  border: '1px solid var(--color-border)',
                  cursor: 'pointer',
                }}
              >
                Cancel
              </button>
            </div>
          )}
          {clearMessage && (
            <p style={{
              fontSize: 'var(--font-size-xs)',
              color: clearMessage.type === 'success' ? '#22c55e' : '#ef4444',
              margin: 0,
            }}>
              {clearMessage.text}
            </p>
          )}
        </div>
        </>)}

        <div style={dividerStyle} />

        {/* --- Action Buttons --- */}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 'var(--space-3)' }}>
          {!forced && (
            <button
              onClick={onClose}
              style={{
                padding: 'var(--space-2) var(--space-4)',
                borderRadius: 'var(--radius-md)',
                color: 'var(--color-text-secondary)',
                border: 'none',
                backgroundColor: 'transparent',
                cursor: 'pointer',
              }}
            >
              Close
            </button>
          )}
          <button
            onClick={handleSave}
            disabled={!inputToken.trim()}
            style={{
              padding: 'var(--space-2) var(--space-4)',
              borderRadius: 'var(--radius-md)',
              backgroundColor: 'var(--color-primary)',
              color: '#fff',
              fontWeight: 600,
              border: 'none',
              opacity: inputToken.trim() ? 1 : 0.5,
              cursor: inputToken.trim() ? 'pointer' : 'not-allowed'
            }}
          >
            Save & Connect
          </button>
        </div>
      </div>
    </div>
  );
}
