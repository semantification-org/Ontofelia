
import { useAppContext } from '../context/AppContext';
import { StatusIndicator } from './StatusIndicator';

interface HeaderProps {
  onOpenSettings: () => void;
  onOpenLog: () => void;
}

export function Header({ onOpenSettings, onOpenLog }: HeaderProps) {
  const { connected } = useAppContext();

  return (
    <header className="app-header">
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)' }}>
        <img 
          src="/logo.png" 
          alt="Ontofelia" 
          style={{ height: '32px', objectFit: 'contain' }} 
        />
        <StatusIndicator 
          status={connected ? 'success' : 'error'} 
          label={connected ? 'Connected' : 'Disconnected'} 
        />
      </div>
      
      <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
        <button 
          onClick={onOpenLog}
          style={{
            padding: 'var(--space-2) var(--space-3)',
            borderRadius: 'var(--radius-md)',
            backgroundColor: 'var(--color-bg-secondary)',
            border: '1px solid var(--color-border)',
            fontSize: 'var(--font-size-sm)',
            display: 'flex',
            alignItems: 'center',
            gap: 'var(--space-2)'
          }}
        >
          <span>🖥️</span> Log
        </button>
        <button 
          onClick={onOpenSettings}
          style={{
            padding: 'var(--space-2) var(--space-3)',
            borderRadius: 'var(--radius-md)',
            backgroundColor: 'var(--color-bg-secondary)',
            border: '1px solid var(--color-border)',
            fontSize: 'var(--font-size-sm)',
            display: 'flex',
            alignItems: 'center',
            gap: 'var(--space-2)'
          }}
        >
          <span>⚙</span> Settings
        </button>
      </div>
    </header>
  );
}
