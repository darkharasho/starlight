import { useEffect, useMemo, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useLibraryStore } from '../stores/library-store.js';
import { useProcessStore, attachProcessEvents } from '../stores/process-store.js';
import { useCatalogStore } from '../stores/catalog-store.js';
import { openCatalogGame, openToolsOnly } from '../lib/open-game.js';
import { catalogMatcher } from '../../shared/catalog-match.js';
import type { DetectedGame } from '../../shared/ipc.js';
import { AddManualGameDialog } from '../components/AddManualGameDialog.js';
import { starlight } from '../ipc-client.js';
import { steamCoverUrl } from '../types/catalog-game.js';
import { useMyGamesStore } from '../stores/my-games-store.js';
import { myGameMatcher } from '../../shared/my-games.js';

function boxartUrl(g: DetectedGame): string | null {
  const id = g.boxartSteamAppId ?? (g.source === 'steam' ? Number(g.appId) : null);
  if (id == null || Number.isNaN(id)) return null;
  return steamCoverUrl(id);
}

function GameTile({
  game, running, hasTrainer, hasMine = false, onClick, onRemove,
}: {
  game: DetectedGame;
  running: boolean;
  hasTrainer: boolean;
  /** The player has their own cheats for it. */
  hasMine?: boolean;
  onClick?: () => void;
  onRemove?: () => void;
}): JSX.Element {
  const upfrontCover = boxartUrl(game);
  const [shownSrc, setShownSrc] = useState<string | null>(upfrontCover);
  const fallbackTried = useRef(false);

  useEffect(() => {
    if (shownSrc !== null) return;
    let cancelled = false;
    void (async () => {
      const req: { name: string; steamAppId?: number } = { name: game.name };
      if (game.boxartSteamAppId != null) req.steamAppId = game.boxartSteamAppId;
      const r = await starlight().resolveBoxart(req).catch(() => ({ url: null }));
      if (!cancelled && r.url) setShownSrc(r.url);
    })();
    return () => { cancelled = true; };
  }, [shownSrc, game.name, game.boxartSteamAppId]);

  async function handleImgError(): Promise<void> {
    if (fallbackTried.current) {
      setShownSrc(null);
      return;
    }
    fallbackTried.current = true;
    const req: { name: string; steamAppId?: number; forceFallback?: boolean } = { name: game.name, forceFallback: true };
    if (game.boxartSteamAppId != null) req.steamAppId = game.boxartSteamAppId;
    const r = await starlight().resolveBoxart(req).catch(() => ({ url: null }));
    setShownSrc(r.url && r.url !== shownSrc ? r.url : null);
  }

  const cover = shownSrc;
  const clickable = !!onClick;
  const tileTitle = !clickable
    ? game.name
    : hasTrainer
      ? `Open ${game.name} trainer`
      : `${game.name} — no table yet; open game speed and the memory scanner`;

  const tileClass = `aspect-[2/3] rounded-sm border bg-panel overflow-hidden relative transition-colors ${
    clickable ? 'border-line hover:border-neon-cyan cursor-pointer' : 'border-line cursor-default'
  } ${hasTrainer ? '' : 'opacity-70'}`;

  const InnerImage = (
    <>
      <div className="absolute inset-0 flex items-center justify-center text-[10px] text-muted px-2 text-center pointer-events-none">
        {game.name}
      </div>
      {cover && (
        <img
          key={cover}
          src={cover}
          alt=""
          className="absolute inset-0 w-full h-full object-cover"
          onError={() => void handleImgError()}
        />
      )}
    </>
  );

  return (
    <div className="flex flex-col gap-1.5 group">
      {clickable ? (
        <button type="button" onClick={onClick} title={tileTitle} className={tileClass}>
          {InnerImage}
          {onRemove && (
            <span
              role="button"
              aria-label={`Remove ${game.name}`}
              onClick={(e) => {
                e.stopPropagation();
                if (window.confirm(`Remove "${game.name}" from your library?`)) onRemove();
              }}
              className="absolute top-1.5 right-1.5 w-5 h-5 flex items-center justify-center text-[10px] rounded-sm border border-line bg-bg/80 text-muted opacity-0 group-hover:opacity-100 hover:border-neon-pink hover:text-neon-pink"
            >
              <X aria-hidden="true" className="size-3" />
            </span>
          )}
        </button>
      ) : (
        <div title={tileTitle} className={tileClass}>
          {InnerImage}
          {onRemove && (
            <button
              type="button"
              aria-label={`Remove ${game.name}`}
              onClick={() => {
                if (window.confirm(`Remove "${game.name}" from your library?`)) onRemove();
              }}
              className="absolute top-1.5 right-1.5 w-5 h-5 flex items-center justify-center text-[10px] rounded-sm border border-line bg-bg/80 text-muted opacity-0 group-hover:opacity-100 hover:border-neon-pink hover:text-neon-pink"
            >
              <X aria-hidden="true" className="size-3" />
            </button>
          )}
        </div>
      )}
      <div className="flex items-center gap-1.5 flex-wrap">
        <div className="text-[11px] font-semibold truncate">{game.name}</div>
        {running && (
          <span className="text-[9px] tracking-wider uppercase text-neon-cyan border border-neon-cyan/40 rounded-sm px-1.5 py-[1px]">Running</span>
        )}
        {hasTrainer && !hasMine && (
          <span className="text-[9px] tracking-wider uppercase text-neon-cyan border border-neon-cyan/40 rounded-sm px-1.5 py-[1px]">Trainer</span>
        )}
        {hasMine && (
          <span className="text-[9px] tracking-wider uppercase text-neon-cyan border border-neon-cyan/40 rounded-sm px-1.5 py-[1px]">My cheats</span>
        )}
      </div>
      <div className="text-[10px] text-muted truncate">{game.installDir}</div>
    </div>
  );
}

type TrainerFilter = 'all' | 'trainer' | 'none';

const FILTERS: { value: TrainerFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'trainer', label: 'Has trainer' },
  { value: 'none', label: 'No trainer' },
];

export function LibraryRoute(): JSX.Element {
  const games = useLibraryStore((s) => s.games);
  const loading = useLibraryStore((s) => s.loading);
  const error = useLibraryStore((s) => s.error);
  const scan = useLibraryStore((s) => s.scan);
  const addManual = useLibraryStore((s) => s.addManual);
  const removeManual = useLibraryStore((s) => s.removeManual);
  const [showAddDialog, setShowAddDialog] = useState(false);
  const [filter, setFilter] = useState<TrainerFilter>('all');
  const processes = useProcessStore((s) => s.processes);
  const navigate = useNavigate();

  useEffect(() => { void scan(); }, [scan]);
  useEffect(() => { attachProcessEvents(); }, []);

  const catalogIndex = useCatalogStore((s) => s.index);
  const loadCatalog = useCatalogStore((s) => s.load);
  useEffect(() => { if (!catalogIndex) void loadCatalog(); }, [catalogIndex, loadCatalog]);

  const findCatalogEntry = useMemo(() => catalogMatcher(catalogIndex?.games ?? []), [catalogIndex]);
  const mine = useMyGamesStore((s) => s.games);
  const loadMine = useMyGamesStore((s) => s.load);
  useEffect(() => { void loadMine(); }, [loadMine]);
  const findMine = useMemo(() => myGameMatcher(mine), [mine]);
  const steamIdOf = (g: DetectedGame): number | null => {
    const id = g.source === 'steam' ? Number(g.appId) : (g.boxartSteamAppId ?? null);
    return id == null || Number.isNaN(id) ? null : id;
  };

  async function openTrainerForGame(g: DetectedGame): Promise<void> {
    const entry = findCatalogEntry(g);
    const launch = { source: g.source, appId: g.appId };
    if (entry) { await openCatalogGame(entry, navigate, launch); return; }
    // No table in the catalog: the table-free tools still work on it.
    // The page's "My cheats" is keyed by the name the cheats were saved under.
    const steamAppId = steamIdOf(g);
    const mineGame = findMine({ name: g.name, steamAppId });
    await openToolsOnly({ name: mineGame?.name ?? g.name, steamAppId }, navigate, undefined, launch);
  }

  const withTrainer = games.map((g) => {
    const hasMine = !!findMine({ name: g.name, steamAppId: steamIdOf(g) });
    return { game: g, hasMine, hasTrainer: hasMine || !!findCatalogEntry(g) };
  });
  const counts: Record<TrainerFilter, number> = {
    all: withTrainer.length,
    trainer: withTrainer.filter((x) => x.hasTrainer).length,
    none: withTrainer.filter((x) => !x.hasTrainer).length,
  };
  const shown = withTrainer.filter((x) =>
    filter === 'all' ? true : filter === 'trainer' ? x.hasTrainer : !x.hasTrainer);

  const runningSet = useMemo(() => {
    return new Set(processes.map((p) => p.name.toLowerCase().replace(/\.exe$/i, '')));
  }, [processes]);

  return (
    <div className="flex flex-col gap-4 h-full">
      <div className="flex items-baseline justify-between">
        <h1 className="text-lg font-semibold">Library</h1>
        <div className="flex items-center gap-2">
          {games.length > 0 && (
            <div role="group" aria-label="Filter by trainer" className="flex rounded-full bg-bg p-[3px] text-xs mr-2">
              {FILTERS.map((f) => (
                <button
                  key={f.value}
                  type="button"
                  aria-pressed={filter === f.value}
                  onClick={() => setFilter(f.value)}
                  className={`rounded-full px-3 py-1 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neon-cyan ${
                    filter === f.value ? 'bg-neon-cyan font-semibold text-[#06231d]' : 'text-muted hover:text-ink'
                  }`}
                >
                  {f.label} <span className="tabular-nums opacity-70">{counts[f.value]}</span>
                </button>
              ))}
            </div>
          )}
          <button
            type="button"
            onClick={() => setShowAddDialog(true)}
            className="px-3 py-1.5 text-xs rounded-sm border border-line text-muted hover:border-neon-cyan hover:text-neon-cyan"
          >
            Add manually
          </button>
          <button
            type="button"
            onClick={() => void scan()}
            className="px-3 py-1.5 text-xs rounded-sm border border-line text-muted hover:border-neon-cyan hover:text-neon-cyan"
          >
            Refresh
          </button>
        </div>
      </div>

      {error && (
        <div className="text-xs text-neon-pink border border-neon-pink/40 bg-neon-pink/[0.06] rounded-sm px-3 py-2">
          {error}
        </div>
      )}

      {loading && games.length === 0 && (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(140px,1fr))] gap-3">
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="aspect-[2/3] rounded-sm border border-line bg-panel/40 animate-pulse" />
          ))}
        </div>
      )}

      {!loading && games.length === 0 && !error && (
        <div className="text-sm text-muted">
          No installed games detected. (Library auto-detection currently supports Steam.)
        </div>
      )}

      {games.length > 0 && shown.length === 0 && (
        <div className="text-sm text-muted">
          {filter === 'none' ? 'Every installed game has a trainer.' : 'None of your installed games has a trainer yet.'}
        </div>
      )}

      {shown.length > 0 && (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(140px,1fr))] gap-3 overflow-y-auto">
          {shown.map(({ game: g, hasTrainer, hasMine }) => {
            const dirName = (g.installDir.split(/[\\/]/).pop() ?? '').toLowerCase();
            return (
              <GameTile
                key={`${g.source}:${g.appId}`}
                game={g}
                running={runningSet.has(dirName)}
                hasTrainer={hasTrainer}
                hasMine={hasMine}
                onClick={() => void openTrainerForGame(g)}
                {...(g.source === 'manual' ? { onRemove: () => void removeManual(g.appId) } : {})}
              />
            );
          })}
        </div>
      )}
      {showAddDialog && (
        <AddManualGameDialog
          onCancel={() => setShowAddDialog(false)}
          onConfirm={async ({ name, exePath }) => {
            await addManual(name, exePath);
            setShowAddDialog(false);
          }}
        />
      )}
    </div>
  );
}
