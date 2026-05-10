import { useEffect, useState } from 'react';
import { type CatalogGame, steamCoverUrl } from '../types/catalog-game.js';
import { starlight } from '../ipc-client.js';

interface Props {
  game: CatalogGame;
  onClick?: (game: CatalogGame) => void;
}

export function GameTile({ game, onClick }: Props): JSX.Element {
  const upfrontCover = steamCoverUrl(game.steamAppId);
  const [resolvedCover, setResolvedCover] = useState<string | null>(null);
  const [errored, setErrored] = useState(false);

  // Lazily resolve boxart for entries without an upfront Steam ID. Hits the
  // main-process resolver, which uses Steam Store search (free) → SteamGridDB.
  useEffect(() => {
    if (upfrontCover !== null || resolvedCover !== null) return;
    let cancelled = false;
    void (async () => {
      const r = await starlight().resolveBoxart({ name: game.name }).catch(() => ({ url: null }));
      if (!cancelled && r.url) setResolvedCover(r.url);
    })();
    return () => { cancelled = true; };
  }, [upfrontCover, resolvedCover, game.name]);

  // If the upfront URL 404s (game removed from Steam etc.) try the resolver as a fallback.
  async function handleImgError(): Promise<void> {
    if (errored) return;
    setErrored(true);
    const r = await starlight().resolveBoxart({ name: game.name, forceFallback: true }).catch(() => ({ url: null }));
    if (r.url && r.url !== upfrontCover) setResolvedCover(r.url);
  }

  const cover = resolvedCover ?? (errored ? null : upfrontCover);

  return (
    <button
      type="button"
      aria-label={game.name}
      onClick={() => onClick?.(game)}
      className="relative w-full aspect-[2/3] rounded-sm overflow-hidden border border-neon-cyan/60 glow-cyan transition-transform duration-150 hover:-translate-y-0.5 hover:border-neon-cyan focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neon-cyan bg-[#1a1a22]"
    >
      {/* Name backdrop — always present so broken/loading covers still show context. */}
      <span className="absolute inset-0 flex items-center justify-center text-[10px] text-muted px-2 text-center pointer-events-none">
        {game.name}
      </span>
      {cover && (
        <img
          src={cover}
          alt=""
          className="absolute inset-0 w-full h-full object-cover"
          onError={() => void handleImgError()}
          loading="lazy"
        />
      )}
      {game.installed && (
        <span className="absolute top-1.5 left-1.5 text-[8px] tracking-wider text-neon-pink bg-bg/70 px-1.5 py-[2px] rounded-sm z-10">
          ● INSTALLED
        </span>
      )}
      <span className="absolute bottom-1.5 right-1.5 text-[8px] tracking-wider text-neon-cyan bg-bg/70 px-1.5 py-[2px] rounded-sm uppercase z-10">
        Trainer
      </span>
      <span className="sr-only">{game.name}</span>
    </button>
  );
}
