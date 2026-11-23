import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { BoxartGrid } from '../components/BoxartGrid.js';
import { PageHeader } from '../components/PageHeader.js';
import { useCatalogStore } from '../stores/catalog-store.js';
import { useLibraryStore } from '../stores/library-store.js';
import { openCatalogGame } from '../lib/open-game.js';
import { installedGameKeys } from '../lib/installed.js';
import { gameKey } from '../lib/dedupe-games.js';
import type { CatalogGame } from '../types/catalog-game.js';

export function BrowseRoute(): JSX.Element {
  const navigate = useNavigate();
  const index = useCatalogStore((s) => s.index);
  const loading = useCatalogStore((s) => s.loading);
  const error = useCatalogStore((s) => s.error);
  const load = useCatalogStore((s) => s.load);
  const detectedGames = useLibraryStore((s) => s.games);

  useEffect(() => { if (!index && !loading) void load(); }, [index, loading, load]);

  const installedKeys = installedGameKeys(detectedGames);

  const games: CatalogGame[] = (index?.games ?? []).map(entry => ({
    ...entry,
    installed: installedKeys.has(gameKey(entry.name)),
  }));

  async function onSelect(g: CatalogGame): Promise<void> {
    await openCatalogGame(g, navigate);
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
    <div className="flex flex-col h-full min-h-0">
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
    </div>
  );
}
