import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { BoxartShelf } from '../components/BoxartShelf.js';
import { PageHeader } from '../components/PageHeader.js';
import { useSearchStore } from '../stores/search-store.js';
import { useCatalogStore } from '../stores/catalog-store.js';
import { useLibraryStore } from '../stores/library-store.js';
import { openCatalogGame } from '../lib/open-game.js';
import { installedGameKeys, isInstalled } from '../lib/installed.js';
import type { CatalogGame } from '../types/catalog-game.js';

export function SearchRoute(): JSX.Element {
  const navigate = useNavigate();
  const query = useSearchStore((s) => s.query);
  const index = useCatalogStore((s) => s.index);
  const load = useCatalogStore((s) => s.load);
  const detectedGames = useLibraryStore((s) => s.games);

  useEffect(() => { if (!index) void load(); }, [index, load]);

  const installedKeys = installedGameKeys(detectedGames);
  const allGames: CatalogGame[] = (index?.games ?? []).map(entry => ({
    ...entry,
    installed: isInstalled(installedKeys, entry),
  }));
  const matches = query.trim()
    ? allGames.filter((g) => g.name.toLowerCase().includes(query.trim().toLowerCase()))
    : [];

  async function onSelect(g: CatalogGame): Promise<void> {
    await openCatalogGame(g, navigate);
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
