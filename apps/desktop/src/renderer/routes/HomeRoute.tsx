import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { BoxartShelf } from '../components/BoxartShelf.js';
import { PageHeader } from '../components/PageHeader.js';
import { useCatalogStore } from '../stores/catalog-store.js';
import { useConfigStore, attachConfigEvents } from '../stores/config-store.js';
import { useLibraryStore } from '../stores/library-store.js';
import { useTrainerStore } from '../stores/trainer-store.js';
import type { CatalogGame } from '../types/catalog-game.js';
import type { RecentTrainer } from '../../shared/ipc.js';

export function HomeRoute(): JSX.Element {
  const navigate = useNavigate();
  const index = useCatalogStore((s) => s.index);
  const loadCatalog = useCatalogStore((s) => s.load);
  const fetchTrainer = useCatalogStore((s) => s.trainer);
  const setActiveTrainerFromCatalog = useTrainerStore((s) => s.setActiveTrainerFromCatalog);
  const loadTrainer = useTrainerStore((s) => s.loadTrainer);
  const trainerLoaded = useTrainerStore((s) => s.trainer);
  const detectedGames = useLibraryStore((s) => s.games);

  useEffect(() => { if (!index) void loadCatalog(); }, [index, loadCatalog]);

  useEffect(() => { attachConfigEvents(); }, []);
  const config = useConfigStore((s) => s.config);
  const loadConfig = useConfigStore((s) => s.load);
  useEffect(() => { if (!config) void loadConfig(); }, [config, loadConfig]);

  const recents = config?.recents ?? [];

  async function selectRecent(r: RecentTrainer): Promise<void> {
    if (r.source !== 'catalog' || !index) return;
    const entry = index.games.find(g => g.id === r.id);
    if (!entry) return;
    const trainer = await fetchTrainer(entry);
    if (!trainer) return;
    await setActiveTrainerFromCatalog(trainer);
    navigate('/active');
  }

  const installedSteamIds = new Set(
    detectedGames.filter(g => g.source === 'steam').map(g => Number(g.appId)),
  );
  const allGames: CatalogGame[] = (index?.games ?? []).map(entry => ({
    ...entry,
    installed: entry.steamAppId != null && installedSteamIds.has(entry.steamAppId),
  }));
  const installed = allGames.filter((g) => g.installed);
  const featured = allGames;
  const installedCount = installed.length;

  async function selectGame(g: CatalogGame): Promise<void> {
    const trainer = await fetchTrainer(g);
    if (!trainer) return;
    await setActiveTrainerFromCatalog(trainer);
    navigate('/active');
  }

  return (
    <>
      <PageHeader title="Home"
        right={
          <span className="text-[11px] text-muted">
            <span className="inline-block size-1.5 rounded-full bg-neon-cyan glow-cyan mr-1.5 align-middle" />
            {installedCount} installed games have trainers
          </span>
        }
      />
      <div className="mb-5 flex items-center gap-3">
        <button type="button"
                onClick={async () => { await loadTrainer(); navigate('/active'); }}
                className="px-3 py-1.5 text-xs rounded-sm border border-neon-cyan text-neon-cyan glow-cyan hover:bg-neon-cyan/[0.08]">
          Load Trainer (.CT)
        </button>
        {trainerLoaded && <span className="text-[11px] text-muted">Loaded: {trainerLoaded.game.name}</span>}
      </div>
      {recents.length > 0 && (
        <section className="mb-5">
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
      {installed.length > 0 && <Section label="Installed Games With Trainers" games={installed} onSelect={selectGame} />}
      <Section label="Featured Trainers" games={featured} onSelect={selectGame} />
    </>
  );
}

function Section({ label, games, onSelect }: { label: string; games: CatalogGame[]; onSelect: (g: CatalogGame) => Promise<void> }): JSX.Element {
  return (
    <section className="mb-5">
      <div className="text-[10px] tracking-wider uppercase text-muted mb-2.5">{label}</div>
      <BoxartShelf games={games} onSelect={(g) => void onSelect(g)} />
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
