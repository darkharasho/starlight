import { useEffect, useMemo } from 'react';
import { useLibraryStore } from '../stores/library-store.js';
import { useProcessStore, attachProcessEvents } from '../stores/process-store.js';
import { useCatalogStore } from '../stores/catalog-store.js';
import type { DetectedGame } from '../../shared/ipc.js';

function boxartUrl(g: DetectedGame): string {
  return `https://cdn.cloudflare.steamstatic.com/steam/apps/${g.appId}/library_600x900.jpg`;
}

function GameTile({ game, running, hasTrainer }: { game: DetectedGame; running: boolean; hasTrainer: boolean }): JSX.Element {
  return (
    <div className="flex flex-col gap-1.5 group">
      <div className="aspect-[2/3] rounded-sm border border-line bg-panel overflow-hidden">
        <img
          src={boxartUrl(game)}
          alt={game.name}
          className="w-full h-full object-cover"
          onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }}
        />
      </div>
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
  const processes = useProcessStore((s) => s.processes);

  useEffect(() => { void scan(); }, [scan]);
  useEffect(() => { attachProcessEvents(); }, []);

  const catalogIndex = useCatalogStore((s) => s.index);
  const loadCatalog = useCatalogStore((s) => s.load);
  useEffect(() => { if (!catalogIndex) void loadCatalog(); }, [catalogIndex, loadCatalog]);

  const runningSet = useMemo(() => {
    return new Set(processes.map((p) => p.name.toLowerCase().replace(/\.exe$/i, '')));
  }, [processes]);

  const catalogSteamIds = useMemo(
    () => new Set((catalogIndex?.games ?? []).filter(g => g.steamAppId != null).map(g => g.steamAppId as number)),
    [catalogIndex],
  );

  return (
    <div className="flex flex-col gap-4 h-full">
      <div className="flex items-baseline justify-between">
        <h1 className="text-lg font-semibold">Library</h1>
        <button
          type="button"
          onClick={() => void scan()}
          className="px-3 py-1.5 text-xs rounded-sm border border-line text-muted hover:border-neon-cyan hover:text-neon-cyan"
        >
          Refresh
        </button>
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
            const dirName = (g.installDir.split('/').pop() ?? '').toLowerCase();
            return (
              <GameTile
                key={`${g.source}:${g.appId}`}
                game={g}
                running={runningSet.has(dirName)}
                hasTrainer={g.source === 'steam' && catalogSteamIds.has(Number(g.appId))}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}
