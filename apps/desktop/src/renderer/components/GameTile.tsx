import { useEffect, useState } from 'react';
import { type CatalogGame, steamCoverUrl } from '../types/catalog-game.js';
import { starlight } from '../ipc-client.js';

interface Props {
  game: CatalogGame;
  onClick?: (game: CatalogGame) => void;
}

export function GameTile({ game, onClick }: Props): JSX.Element {
  const upfrontCover = steamCoverUrl(game.steamAppId);
  // Single source-of-truth for what URL the <img> should attempt.
  // null = nothing to show → render the name backdrop alone.
  const [shownSrc, setShownSrc] = useState<string | null>(upfrontCover);
  const [resolverRan, setResolverRan] = useState(false);
  const [fallbackTried, setFallbackTried] = useState(false);

  // Reset state when the game (and thus upfront URL) changes.
  useEffect(() => {
    setShownSrc(upfrontCover);
    setResolverRan(false);
    setFallbackTried(false);
  }, [upfrontCover, game.id]);

  // Proactive resolve when there's no upfront cover.
  useEffect(() => {
    if (shownSrc !== null || resolverRan) return;
    setResolverRan(true);
    let cancelled = false;
    void (async () => {
      const r = await starlight().resolveBoxart({ name: game.name }).catch(() => ({ url: null }));
      if (!cancelled && r.url) setShownSrc(r.url);
    })();
    return () => { cancelled = true; };
  }, [shownSrc, resolverRan, game.name]);

  // When the current <img> URL fails, try a forced fallback once. If that also
  // fails (or returns null), drop the image entirely so the broken-image glyph
  // never sticks around — the name backdrop always remains.
  async function onImgError(): Promise<void> {
    if (fallbackTried) {
      setShownSrc(null);
      return;
    }
    setFallbackTried(true);
    const r = await starlight().resolveBoxart({ name: game.name, forceFallback: true }).catch(() => ({ url: null }));
    setShownSrc(r.url && r.url !== shownSrc ? r.url : null);
  }

  return (
    <button
      type="button"
      aria-label={game.name}
      onClick={() => onClick?.(game)}
      className="relative w-full aspect-[2/3] rounded-sm overflow-hidden border border-neon-cyan/60 glow-cyan transition-transform duration-150 hover:-translate-y-0.5 hover:border-neon-cyan focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neon-cyan bg-[#1a1a22]"
    >
      <span className="absolute inset-0 flex items-center justify-center text-[10px] text-muted px-2 text-center pointer-events-none">
        {game.name}
      </span>
      {shownSrc !== null && (
        <img
          key={shownSrc}
          src={shownSrc}
          alt=""
          className="absolute inset-0 w-full h-full object-cover"
          onError={() => void onImgError()}
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
