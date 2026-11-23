import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { BoxartShelf } from '../components/BoxartShelf.js';
import { PageHeader } from '../components/PageHeader.js';
import { useCatalogStore } from '../stores/catalog-store.js';
import { useConfigStore, attachConfigEvents } from '../stores/config-store.js';
import { useLibraryStore } from '../stores/library-store.js';
import { useTrainerStore } from '../stores/trainer-store.js';
import { openCatalogGame, showGameScreen } from '../lib/open-game.js';
import { installedGameKeys } from '../lib/installed.js';
import { gameKey } from '../lib/dedupe-games.js';
import type { CatalogGame } from '../types/catalog-game.js';
import type { RecentTrainer } from '../../shared/ipc.js';

export function HomeRoute(): JSX.Element {
  const navigate = useNavigate();
  const index = useCatalogStore((s) => s.index);
  const loadCatalog = useCatalogStore((s) => s.load);
  const loadTrainer = useTrainerStore((s) => s.loadTrainer);
  const trainerLoaded = useTrainerStore((s) => s.trainer);
  const detectedGames = useLibraryStore((s) => s.games);
  const scanLibrary = useLibraryStore((s) => s.scan);

  useEffect(() => { if (!index) void loadCatalog(); }, [index, loadCatalog]);
  // Home leads with the user's own games, so it needs the library scan too.
  useEffect(() => { if (useLibraryStore.getState().games.length === 0) void scanLibrary(); }, [scanLibrary]);

  useEffect(() => { attachConfigEvents(); }, []);
  const config = useConfigStore((s) => s.config);
  const loadConfig = useConfigStore((s) => s.load);
  useEffect(() => { if (!config) void loadConfig(); }, [config, loadConfig]);

  const recents = config?.recents ?? [];

  async function selectRecent(r: RecentTrainer): Promise<void> {
    if (r.source !== 'catalog' || !index) return;
    const entry = index.games.find(g => g.id === r.id);
    if (entry) await openCatalogGame(entry, navigate);
  }

  const installedKeys = installedGameKeys(detectedGames);
  const allGames: CatalogGame[] = (index?.games ?? []).map(entry => ({
    ...entry,
    installed: installedKeys.has(gameKey(entry.name)),
  }));
  const installed = allGames.filter((g) => g.installed);
  const featured = allGames;
  const installedCount = installed.length;

  async function selectGame(g: CatalogGame): Promise<void> {
    await openCatalogGame(g, navigate);
  }

  return (
    <>
      <PageHeader title="Home"
        right={
          <span className="text-[13px] text-muted">
            <span className="inline-block size-1.5 rounded-full bg-neon-cyan mr-2 align-middle" />
            {installedCount} of your installed games {installedCount === 1 ? 'has' : 'have'} trainers
          </span>
        }
      />
      <div className="mb-5 flex items-center gap-3">
        <button type="button"
                onClick={async () => { await loadTrainer(); showGameScreen(navigate); }}
                className="rounded-full bg-panel px-4 py-2 text-[13px] text-soft transition-colors hover:bg-raised hover:text-ink">
          Load Trainer (.CT)
        </button>
        {trainerLoaded && <span className="text-[11px] text-muted">Loaded: {trainerLoaded.game.name}</span>}
      </div>
      {installed.length > 0 && <Section label="Your Games With Trainers" games={installed} onSelect={selectGame} limit={installed.length} />}
      {recents.length > 0 && (
        <section className="mb-8">
          <div className="text-[10px] tracking-wider uppercase text-muted mb-2.5">Recently Played</div>
          <div className="grid grid-cols-1 gap-1.5">
            {recents.slice(0, 6).map((r) => (
              <button
                key={`${r.source}:${r.id}:${r.openedAt}`}
                type="button"
                onClick={() => void selectRecent(r)}
                disabled={r.source === 'file' || !index?.games.some(g => g.id === r.id)}
                className="text-left flex items-center justify-between px-3 py-2 text-xs rounded-sm border border-line bg-panel hover:border-neon-cyan disabled:opacity-50 disabled:hover:border-line"
              >
                <span>{r.name}</span>
                <span className="text-[10px] text-muted">
                  {r.source === 'catalog' ? 'catalog' : 'file'} · {timeAgo(r.openedAt)}
                </span>
              </button>
            ))}
          </div>
        </section>
      )}
      <Section label="All Trainers" games={featured} onSelect={selectGame} />
    </>
  );
}

function Section({ label, games, onSelect, limit }: { label: string; games: CatalogGame[]; onSelect: (g: CatalogGame) => Promise<void>; limit?: number }): JSX.Element {
  return (
    <section className="mb-8">
      <h3 className="text-[15px] font-semibold text-ink mb-3">{label}</h3>
      <BoxartShelf games={games} onSelect={(g) => void onSelect(g)} {...(limit !== undefined ? { limit } : {})} />
    </section>
  );
}

function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return 'just now';
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`;
  return `${Math.floor(ms / 86_400_000)}d ago`;
}
