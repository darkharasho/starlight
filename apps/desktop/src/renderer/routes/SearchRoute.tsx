import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { BoxartShelf } from '../components/BoxartShelf.js';
import { PageHeader } from '../components/PageHeader.js';
import { useSearchStore } from '../stores/search-store.js';
import { useCatalogStore } from '../stores/catalog-store.js';
import { useLibraryStore } from '../stores/library-store.js';
import { useTrainerStore } from '../stores/trainer-store.js';
import { useCeSessionStore } from '../stores/ce-session-store.js';
import type { CatalogGame } from '../types/catalog-game.js';

export function SearchRoute(): JSX.Element {
  const navigate = useNavigate();
  const query = useSearchStore((s) => s.query);
  const index = useCatalogStore((s) => s.index);
  const load = useCatalogStore((s) => s.load);
  const fetchTrainer = useCatalogStore((s) => s.trainer);
  const detectedGames = useLibraryStore((s) => s.games);
  const setActiveTrainerFromCatalog = useTrainerStore((s) => s.setActiveTrainerFromCatalog);
  const startCeSession = useCeSessionStore((s) => s.start);

  useEffect(() => { if (!index) void load(); }, [index, load]);

  const installedSteamIds = new Set(
    detectedGames.filter(g => g.source === 'steam').map(g => Number(g.appId)),
  );
  const allGames: CatalogGame[] = (index?.games ?? []).map(entry => ({
    ...entry,
    installed: entry.steamAppId != null && installedSteamIds.has(entry.steamAppId),
  }));
  const matches = query.trim()
    ? allGames.filter((g) => g.name.toLowerCase().includes(query.trim().toLowerCase()))
    : [];

  async function onSelect(g: CatalogGame): Promise<void> {
    if (g.trainerSource) {
      const ok = await startCeSession({ source: g.trainerSource, cacheKey: g.id, game: { id: g.id, name: g.name, steamAppId: g.steamAppId ?? null } });
      if (ok) { navigate('/active'); return; }
      if (useCeSessionStore.getState().notRunning) navigate('/active');
      return;
    }
    const trainer = await fetchTrainer(g);
    if (!trainer) return;
    await setActiveTrainerFromCatalog(trainer);
    navigate('/active');
  }

  return (
    <>
      <PageHeader title="Search" />
      {!query.trim() ? (
        <div className="text-xs text-muted">Type in the search bar above to find a game or trainer.</div>
      ) : matches.length === 0 ? (
        <div className="text-xs text-muted">No games match “{query.trim()}”.</div>
      ) : (
        <BoxartShelf games={matches} onSelect={(g) => void onSelect(g)} limit={120} />
      )}
    </>
  );
}
