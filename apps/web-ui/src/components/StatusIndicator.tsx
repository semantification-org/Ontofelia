

interface StatusIndicatorProps {
  status: 'success' | 'error' | 'warning' | 'offline';
  label?: string;
}

export function StatusIndicator({ status, label }: StatusIndicatorProps) {
  return (
    <div style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--space-2)' }}>
      <div 
        style={{
          width: '8px',
          height: '8px',
          borderRadius: '50%',
          backgroundColor: `var(--color-${status})`,
          boxShadow: `0 0 8px var(--color-${status})`
        }}
      />
      {label && (
        <span style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
          {label}
        </span>
      )}
    </div>
  );
}
