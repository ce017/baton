import '@fontsource/ibm-plex-sans/400.css';
import '@fontsource/ibm-plex-sans/500.css';
import '@fontsource/ibm-plex-sans/600.css';
import '@fontsource/ibm-plex-mono/400.css';
import '@fontsource/ibm-plex-mono/500.css';
import './styles.css';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MotionConfig } from 'motion/react';
import { createContext, StrictMode, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { type Config, loadConfig, saveConfig } from './lib/api.ts';
import { Shell } from './screens/Shell.tsx';
import { SignIn } from './screens/SignIn.tsx';
import { ToastProvider } from './ui.tsx';

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 15_000, retry: 1, refetchOnWindowFocus: true } },
});

interface AppState {
  cfg: Config;
  update(patch: Partial<Config>): Promise<void>;
  signOut(): Promise<void>;
}

const AppCtx = createContext<AppState | null>(null);

export function useApp(): AppState {
  const v = useContext(AppCtx);
  if (!v) throw new Error('useApp outside the app');
  return v;
}

function App() {
  const [cfg, setCfg] = useState<Config | null>(null);
  useEffect(() => {
    loadConfig().then(setCfg);
  }, []);

  const update = useCallback(async (patch: Partial<Config>) => {
    let next: Config = {};
    setCfg((prev) => {
      next = { ...(prev ?? {}), ...patch };
      return next;
    });
    await saveConfig(next);
  }, []);

  const signOut = useCallback(async () => {
    // Keep the server and this PC's Claude key; drop only the person's key.
    let next: Config = {};
    setCfg((prev) => {
      next = { ...(prev ?? {}), userKey: undefined, user: undefined };
      return next;
    });
    await saveConfig(next);
    queryClient.clear();
  }, []);

  const value = useMemo(() => (cfg ? { cfg, update, signOut } : null), [cfg, update, signOut]);
  if (!value) return null;
  return <AppCtx.Provider value={value}>{value.cfg.userKey && value.cfg.server ? <Shell /> : <SignIn />}</AppCtx.Provider>;
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <MotionConfig reducedMotion="user">
        <ToastProvider>
          <App />
        </ToastProvider>
      </MotionConfig>
    </QueryClientProvider>
  </StrictMode>,
);
