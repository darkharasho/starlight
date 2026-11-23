import { useEffect } from 'react';
import { Routes, Route } from 'react-router-dom';
import { Sidebar } from './components/Sidebar.js';
import { TopBar } from './components/TopBar.js';
import { TitleBar } from './components/TitleBar.js';
import { TrainerLoadingOverlay } from './components/TrainerLoadingOverlay.js';
import { RuntimeSetupModal } from './components/RuntimeSetupModal.js';
import { ErrorBoundary } from './components/ErrorBoundary.js';
import { useLatchState } from './stores/latch-store.js';
import { useConfigStore, attachConfigEvents } from './stores/config-store.js';
import { useCatalogStore } from './stores/catalog-store.js';
import { useCeSessionStore } from './stores/ce-session-store.js';
import { attachProcessEvents } from './stores/process-store.js';
import { useLibraryStore } from './stores/library-store.js';
import { useFollowSession } from './lib/use-follow-session.js';

import { HomeRoute } from './routes/HomeRoute.js';
import { LibraryRoute } from './routes/LibraryRoute.js';
import { BrowseRoute } from './routes/BrowseRoute.js';
import { SearchRoute } from './routes/SearchRoute.js';
import { ActiveTrainerRoute } from './routes/ActiveTrainerRoute.js';
import { SettingsRoute } from './routes/SettingsRoute.js';

export default function App(): JSX.Element {
  const latchState = useLatchState((s) => s.state);
  const ceSessionId = useCeSessionStore((s) => s.sessionId);
  useFollowSession(ceSessionId);

  useEffect(() => {
    attachConfigEvents();
    // Subscribe before anything else: the main process announces a running
    // game once, so a listener attached later (e.g. only when the Library tab
    // is opened) would miss it and the pill would sit on "Waiting for game".
    if (window.starlight) attachProcessEvents();
    // Play needs to know what's installed, whichever screen the game is opened from.
    if (window.starlight) void useLibraryStore.getState().scan();
    void (async () => {
      await useConfigStore.getState().load();
      const cfg = useConfigStore.getState().config;
      if (cfg?.preferences.catalogRefreshOnLaunch !== false) {
        await useCatalogStore.getState().load();
      }
    })();
  }, []);

  useEffect(() => {
    if (!window.starlight) {
      console.error('[Starlight] preload bridge (window.starlight) is unavailable — IPC disabled.');
      return;
    }
    const unsub = window.starlight.onEvent((e) => {
      if (e.type === 'config:corrupted') {
        window.alert(
          `Your Starlight config was unreadable and has been backed up to:\n\n${e.backupPath}\n\nDefault settings have been restored.`,
        );
      } else if (e.type === 'hotkeys:unavailable') {
        window.alert(
          `Hotkeys are unavailable on this system.\n\n` +
          `Reason: ${e.message}\n\n` +
          `On Linux, ensure your user is in the 'input' group:\n` +
          `  sudo usermod -a -G input $USER\n` +
          `Then log out and back in.\n\n` +
          `On macOS, grant Accessibility permission to this app in System Settings → Privacy & Security → Accessibility.`,
        );
      }
    });
    return unsub;
  }, []);
  return (
    <div className="flex flex-col h-screen bg-shell">
      <TitleBar />
      <div className="flex flex-1 min-h-0">
        <Sidebar />
        <div className="flex flex-col flex-1 min-w-0 bg-bg rounded-tl-2xl">
          <TopBar latchState={latchState} />
          <main className="flex-1 overflow-y-auto px-6 pb-6 pt-1">
            <ErrorBoundary area="this view">
              <Routes>
                <Route path="/"        element={<HomeRoute />} />
                <Route path="/library" element={<LibraryRoute />} />
                <Route path="/browse"  element={<BrowseRoute />} />
                <Route path="/search"  element={<SearchRoute />} />
                <Route path="/active"  element={<ActiveTrainerRoute />} />
                <Route path="/settings" element={<SettingsRoute />} />
              </Routes>
            </ErrorBoundary>
          </main>
        </div>
      </div>
      <TrainerLoadingOverlay />
      <RuntimeSetupModal />
    </div>
  );
}
