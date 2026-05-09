import { useEffect } from 'react';
import { useLibraryStore } from '../stores/library-store.js';
import type { DetectedGame } from '../../shared/ipc.js';

function boxartUrl(g: DetectedGame): string {
  return `https://cdn.cloudflare.steamstatic.com/steam/apps/${g.appId}/library_600x900.jpg`;
}

function GameTile({ game }: { game: DetectedGame }): JSX.Element {
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
      <div className="text-[11px] font-semibold truncate">{game.name}</div>
      <div className="text-[10px] text-muted truncate">{game.installDir}</div>
    </div>
  );
}

export function LibraryRoute(): JSX.Element {
  const games = useLibraryStore((s) => s.games);
  const loading = useLibraryStore((s) => s.loading);
  const error = useLibraryStore((s) => s.error);
  const scan = useLibraryStore((s) => s.scan);

  useEffect(() => { void scan(); }, [scan]);

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
          {games.map((g) => <GameTile key={`${g.source}:${g.appId}`} game={g} />)}
        </div>
      )}
    </div>
  );
}
