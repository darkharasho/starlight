import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { BoxartGrid } from '../components/BoxartGrid.js';
import { PageHeader } from '../components/PageHeader.js';
import { useCatalogStore } from '../stores/catalog-store.js';
import { useLibraryStore } from '../stores/library-store.js';
import { useTrainerStore } from '../stores/trainer-store.js';
import type { CatalogGame } from '../types/catalog-game.js';

export function BrowseRoute(): JSX.Element {
  const navigate = useNavigate();
  const index = useCatalogStore((s) => s.index);
  const loading = useCatalogStore((s) => s.loading);
  const error = useCatalogStore((s) => s.error);
  const load = useCatalogStore((s) => s.load);
  const fetchTrainer = useCatalogStore((s) => s.trainer);
  const detectedGames = useLibraryStore((s) => s.games);
  const setActiveTrainerFromCatalog = useTrainerStore((s) => s.setActiveTrainerFromCatalog);

  useEffect(() => { if (!index && !loading) void load(); }, [index, loading, load]);

  const installedSteamIds = new Set(
    detectedGames.filter(g => g.source === 'steam').map(g => Number(g.appId)),
  );

  const games: CatalogGame[] = (index?.games ?? []).map(entry => ({
    ...entry,
    installed: entry.steamAppId != null && installedSteamIds.has(entry.steamAppId),
  }));

  async function onSelect(g: CatalogGame): Promise<void> {
    const trainer = await fetchTrainer(g.trainerPath);
    if (!trainer) return;
    await setActiveTrainerFromCatalog(trainer);
    navigate('/active');
  }

  if (error && !index) {
    return (
      <>
        <PageHeader title="Browse" />
        <div className="text-xs text-neon-pink border border-neon-pink/40 bg-neon-pink/[0.06] rounded-sm px-3 py-2">
          Catalog unavailable: {error}
        </div>
        <button type="button" onClick={() => void load()}
                className="mt-3 px-3 py-1.5 text-xs rounded-sm border border-neon-cyan text-neon-cyan glow-cyan">
          Retry
        </button>
      </>
    );
  }

  return (
    <>
      <PageHeader title="Browse" subtitle={`${games.length} games in the catalog`}
        right={
          <button type="button" onClick={() => void load()}
                  className="px-3 py-1.5 text-xs rounded-sm border border-line text-muted hover:border-neon-cyan hover:text-neon-cyan">
            Refresh
          </button>
        }
      />
      {loading && games.length === 0
        ? <div className="text-xs text-muted">Loading catalog…</div>
        : <BoxartGrid games={games} onSelect={(g) => void onSelect(g)} />}
    </>
  );
}
