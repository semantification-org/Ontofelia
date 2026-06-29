import { useState } from 'react';
import { useAppContext } from '../context/AppContext';
import { Header } from './Header';
import { Sidebar } from './Sidebar';
import { ChatArea } from './ChatArea';
import { SettingsPanel } from './SettingsPanel';
import { LogOverlay } from './LogOverlay';
import { ConnectionBanner } from './ConnectionBanner';

export function AppShell() {
  const { token, connected } = useAppContext();
  const [showSettings, setShowSettings] = useState(!token);
  const [showLog, setShowLog] = useState(false);

  // If no token at all, force settings panel open
  if (!token) {
    return (
      <div className="app-shell" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', backgroundColor: 'var(--color-bg-primary)' }}>
        <SettingsPanel onClose={() => setShowSettings(false)} forced />
      </div>
    );
  }

  return (
    <div className="app-shell animate-fade-in">
      <Header onOpenSettings={() => setShowSettings(true)} onOpenLog={() => setShowLog(true)} />
      <Sidebar />
      <div className="app-main">
        {!connected && <ConnectionBanner />}
        <ChatArea />
      </div>
      {showSettings && <SettingsPanel onClose={() => setShowSettings(false)} />}
      {showLog && <LogOverlay onClose={() => setShowLog(false)} />}
    </div>
  );
}
