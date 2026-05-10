import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useLibraryStore } from '../stores/library-store.js';
import { useProcessStore, attachProcessEvents } from '../stores/process-store.js';
import { useCatalogStore } from '../stores/catalog-store.js';
import { useTrainerStore } from '../stores/trainer-store.js';
import type { DetectedGame } from '../../shared/ipc.js';
import { AddManualGameDialog } from '../components/AddManualGameDialog.js';
import { starlight } from '../ipc-client.js';

function boxartUrl(g: DetectedGame): string | null {
  const id = g.boxartSteamAppId ?? (g.source === 'steam' ? Number(g.appId) : null);
  if (id == null || Number.isNaN(id)) return null;
  return `https://cdn.cloudflare.steamstatic.com/steam/apps/${id}/library_600x900.jpg`;
}

function GameTile({
  game, running, hasTrainer, onClick, onRemove,
}: {
  game: DetectedGame;
  running: boolean;
  hasTrainer: boolean;
  onClick?: () => void;
  onRemove?: () => void;
}): JSX.Element {
  const upfrontCover = boxartUrl(game);
  const [resolvedCover, setResolvedCover] = useState<string | null>(null);
  const [errored, setErrored] = useState(false);

  // Proactive resolve when no upfront cover (e.g., manual entries without boxartSteamAppId).
  useEffect(() => {
    if (upfrontCover !== null || resolvedCover !== null) return;
    let cancelled = false;
    void (async () => {
      const req: { name: string; steamAppId?: number } = { name: game.name };
      if (game.boxartSteamAppId != null) req.steamAppId = game.boxartSteamAppId;
      const r = await starlight().resolveBoxart(req).catch(() => ({ url: null }));
      if (!cancelled && r.url) setResolvedCover(r.url);
    })();
    return () => { cancelled = true; };
  }, [upfrontCover, resolvedCover, game.name, game.boxartSteamAppId]);

  // Fallback resolve when upfront cover errors out.
  async function handleImgError(): Promise<void> {
    if (errored) return;
    setErrored(true);
    const req: { name: string; steamAppId?: number; forceFallback?: boolean } = { name: game.name, forceFallback: true };
    if (game.boxartSteamAppId != null) req.steamAppId = game.boxartSteamAppId;
    const r = await starlight().resolveBoxart(req).catch(() => ({ url: null }));
    if (r.url && r.url !== upfrontCover) setResolvedCover(r.url);
  }

  const cover = resolvedCover ?? (errored ? null : upfrontCover);
  const clickable = !!onClick && hasTrainer;
  const tileTitle = clickable
    ? `Open ${game.name} trainer`
    : hasTrainer
      ? game.name
      : `${game.name} — no trainer in catalog yet`;

  const tileClass = `aspect-[2/3] rounded-sm border bg-panel overflow-hidden relative transition-colors ${
    clickable ? 'border-line hover:border-neon-cyan cursor-pointer' : 'border-line cursor-default'
  } ${hasTrainer ? '' : 'opacity-70'}`;

  const InnerImage = (
    <>
      {cover ? (
        <img
          src={cover}
          alt={game.name}
          className="w-full h-full object-cover"
          onError={() => void handleImgError()}
        />
      ) : (
        <div className="w-full h-full flex items-center justify-center text-[10px] text-muted px-2 text-center">
          {game.name}
        </div>
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
              ×
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
              ×
            </button>
          )}
        </div>
      )}
      <div className="flex items-center gap-1.5 flex-wrap">
        <div className="text-[11px] font-semibold truncate">{game.name}</div>
        {running && (
          <span className="text-[9px] tracking-wider uppercase text-neon-cyan border border-neon-cyan/40 rounded-sm px-1.5 py-[1px]">Running</span>
        )}
        {hasTrainer && (
          <span className="text-[9px] tracking-wider uppercase text-neon-cyan border border-neon-cyan/40 rounded-sm px-1.5 py-[1px]">Trainer</span>
        )}
      </div>
      <div className="text-[10px] text-muted truncate">{game.installDir}</div>
    </div>
  );
}

export function LibraryRoute(): JSX.Element {
  const games = useLibraryStore((s) => s.games);
  const loading = useLibraryStore((s) => s.loading);
  const error = useLibraryStore((s) => s.error);
  const scan = useLibraryStore((s) => s.scan);
  const addManual = useLibraryStore((s) => s.addManual);
  const removeManual = useLibraryStore((s) => s.removeManual);
  const [showAddDialog, setShowAddDialog] = useState(false);
  const processes = useProcessStore((s) => s.processes);
  const navigate = useNavigate();

  useEffect(() => { void scan(); }, [scan]);
  useEffect(() => { attachProcessEvents(); }, []);

  const catalogIndex = useCatalogStore((s) => s.index);
  const loadCatalog = useCatalogStore((s) => s.load);
  const fetchTrainer = useCatalogStore((s) => s.trainer);
  const setActiveTrainerFromCatalog = useTrainerStore((s) => s.setActiveTrainerFromCatalog);
  useEffect(() => { if (!catalogIndex) void loadCatalog(); }, [catalogIndex, loadCatalog]);

  const catalogNameIndex = useMemo(() => {
    const m = new Map<string, NonNullable<typeof catalogIndex>['games'][number]>();
    for (const g of catalogIndex?.games ?? []) {
      m.set(g.name.toLowerCase(), g);
    }
    return m;
  }, [catalogIndex]);

  function findCatalogEntry(g: DetectedGame): NonNullable<typeof catalogIndex>['games'][number] | undefined {
    if (!catalogIndex) return undefined;
    const steamId = g.boxartSteamAppId ?? (g.source === 'steam' ? Number(g.appId) : NaN);
    if (!Number.isNaN(steamId)) {
      const byId = catalogIndex.games.find(e => e.steamAppId === steamId);
      if (byId) return byId;
    }
    return catalogNameIndex.get(g.name.toLowerCase());
  }

  async function openTrainerForGame(g: DetectedGame): Promise<void> {
    const entry = findCatalogEntry(g);
    if (!entry) return;
    const trainer = await fetchTrainer(entry.trainerPath);
    if (!trainer) return;
    await setActiveTrainerFromCatalog(trainer);
    navigate('/active');
  }

  const runningSet = useMemo(() => {
    return new Set(processes.map((p) => p.name.toLowerCase().replace(/\.exe$/i, '')));
  }, [processes]);

  return (
    <div className="flex flex-col gap-4 h-full">
      <div className="flex items-baseline justify-between">
        <h1 className="text-lg font-semibold">Library</h1>
        <div className="flex items-center gap-2">
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

      {games.length > 0 && (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(140px,1fr))] gap-3 overflow-y-auto">
          {games.map((g) => {
            const dirName = (g.installDir.split(/[\\/]/).pop() ?? '').toLowerCase();
            const matched = findCatalogEntry(g);
            return (
              <GameTile
                key={`${g.source}:${g.appId}`}
                game={g}
                running={runningSet.has(dirName)}
                hasTrainer={!!matched}
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
