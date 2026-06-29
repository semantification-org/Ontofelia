
import { AppContextProvider } from './context/AppContext';
import { AppShell } from './components/AppShell';

export function App() {
  return (
    <AppContextProvider>
      <AppShell />
    </AppContextProvider>
  );
}

export default App;
