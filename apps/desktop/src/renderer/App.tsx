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

import { HomeRoute } from './routes/HomeRoute.js';
import { LibraryRoute } from './routes/LibraryRoute.js';
import { BrowseRoute } from './routes/BrowseRoute.js';
import { SearchRoute } from './routes/SearchRoute.js';
import { ActiveTrainerRoute } from './routes/ActiveTrainerRoute.js';
import { SettingsRoute } from './routes/SettingsRoute.js';

export default function App(): JSX.Element {
  const latchState = useLatchState((s) => s.state);

  useEffect(() => {
    attachConfigEvents();
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
    <div className="flex flex-col h-screen">
      <TitleBar />
      <div className="flex flex-1 min-h-0">
        <Sidebar />
        <div className="flex flex-col flex-1 min-w-0">
          <TopBar latchState={latchState} />
          <main className="flex-1 overflow-y-auto p-5">
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
