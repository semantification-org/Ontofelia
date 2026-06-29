

export function ConnectionBanner() {
  return (
    <div 
      className="animate-fade-in"
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        backgroundColor: 'var(--color-error)',
        color: '#fff',
        textAlign: 'center',
        padding: 'var(--space-2)',
        fontSize: 'var(--font-size-sm)',
        fontWeight: 600,
        zIndex: 50,
        display: 'flex',
        justifyContent: 'center',
        alignItems: 'center',
        gap: 'var(--space-2)'
      }}
    >
      <span>Disconnected — trying to reconnect...</span>
      <div className="animate-pulse" style={{ width: '8px', height: '8px', borderRadius: '50%', backgroundColor: '#fff' }} />
    </div>
  );
}
