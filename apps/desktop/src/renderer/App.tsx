import { useEffect } from 'react';
import { Routes, Route } from 'react-router-dom';
import { Sidebar } from './components/Sidebar.js';
import { TopBar } from './components/TopBar.js';
import { TitleBar } from './components/TitleBar.js';
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
  return (
    <div className="flex flex-col h-screen">
      <TitleBar />
      <div className="flex flex-1 min-h-0">
        <Sidebar />
        <div className="flex flex-col flex-1 min-w-0">
          <TopBar latchState={latchState} />
          <main className="flex-1 overflow-y-auto p-5">
            <Routes>
              <Route path="/"        element={<HomeRoute />} />
              <Route path="/library" element={<LibraryRoute />} />
              <Route path="/browse"  element={<BrowseRoute />} />
              <Route path="/search"  element={<SearchRoute />} />
              <Route path="/active"  element={<ActiveTrainerRoute />} />
              <Route path="/settings" element={<SettingsRoute />} />
            </Routes>
          </main>
        </div>
      </div>
    </div>
  );
}
