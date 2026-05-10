import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { BoxartGrid } from '../components/BoxartGrid.js';
import { PageHeader } from '../components/PageHeader.js';
import { useCatalogStore } from '../stores/catalog-store.js';
import { useLibraryStore } from '../stores/library-store.js';
import { useTrainerStore } from '../stores/trainer-store.js';
import type { CatalogGame } from '../types/catalog-game.js';

export function SearchRoute(): JSX.Element {
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const index = useCatalogStore((s) => s.index);
  const load = useCatalogStore((s) => s.load);
  const fetchTrainer = useCatalogStore((s) => s.trainer);
  const detectedGames = useLibraryStore((s) => s.games);
  const setActiveTrainerFromCatalog = useTrainerStore((s) => s.setActiveTrainerFromCatalog);

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
    const trainer = await fetchTrainer(g.trainerPath);
    if (!trainer) return;
    await setActiveTrainerFromCatalog(trainer);
    navigate('/active');
  }

  return (
    <>
      <PageHeader title="Search" />
      <input
        autoFocus
        type="text"
        placeholder="Type a game name…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        className="w-full max-w-[480px] h-9 rounded bg-panel border border-line px-3 text-sm text-ink placeholder:text-muted/80 focus:outline-none focus:border-neon-cyan mb-4"
      />
      {query.trim() && matches.length === 0 ? (
        <div className="text-xs text-muted">No games match.</div>
      ) : (
        <BoxartGrid games={matches} onSelect={(g) => void onSelect(g)} />
      )}
    </>
  );
}
