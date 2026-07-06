import { useEffect, useRef, useState } from 'react';
import { type CatalogGame, steamCoverUrl } from '../types/catalog-game.js';
import { starlight } from '../ipc-client.js';

interface Props {
  game: CatalogGame;
  onClick?: (game: CatalogGame) => void;
}

export function GameTile({ game, onClick }: Props): JSX.Element {
  const upfrontCover = steamCoverUrl(game.steamAppId);
  const [shownSrc, setShownSrc] = useState<string | null>(upfrontCover);
  const fallbackTried = useRef(false);

  // Proactive resolve when there's no upfront cover. The IPC is idempotent
  // (server-side cache), so it's fine for this to run twice in React strict
  // mode — the duplicate hits the cache.
  useEffect(() => {
    if (shownSrc !== null) return;
    let cancelled = false;
    void (async () => {
      const r = await starlight().resolveBoxart({ name: game.name }).catch(() => ({ url: null }));
      if (!cancelled && r.url) setShownSrc(r.url);
    })();
    return () => { cancelled = true; };
  }, [shownSrc, game.name]);

  // When the current <img> URL fails, try a forced fallback once. If that also
  // fails (or returns the same url / null), drop the image entirely so the
  // broken-image glyph never sticks around — the name backdrop always remains.
  async function onImgError(): Promise<void> {
    if (fallbackTried.current) {
      setShownSrc(null);
      return;
    }
    fallbackTried.current = true;
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
      {/* No-art placeholder: the name centered, shown only until art loads. */}
      {shownSrc === null && (
        <span className="absolute inset-0 flex items-center justify-center text-[10px] text-muted px-2 text-center pointer-events-none">
          {game.name}
        </span>
      )}
      {shownSrc !== null && (
        <>
          {/* Blurred fill so non-2:3 art fills the tile instead of being cropped
              or leaving empty bars. */}
          <img
            src={shownSrc}
            alt=""
            aria-hidden="true"
            className="absolute inset-0 w-full h-full object-cover scale-110 blur-xl opacity-50"
          />
          {/* The actual cover, contained so it is never cut off. */}
          <img
            key={shownSrc}
            src={shownSrc}
            alt=""
            className="absolute inset-0 w-full h-full object-contain"
            onError={() => void onImgError()}
            loading="lazy"
          />
        </>
      )}
      {game.installed && (
        <span className="absolute top-1.5 left-1.5 text-[8px] tracking-wider text-neon-pink bg-bg/70 px-1.5 py-[2px] rounded-sm z-10">
          ● INSTALLED
        </span>
      )}
      <span className="absolute top-1.5 right-1.5 text-[8px] tracking-wider text-neon-cyan bg-bg/70 px-1.5 py-[2px] rounded-sm uppercase z-10">
        Trainer
      </span>
      {/* Always-visible title so tiles are identifiable regardless of the art. */}
      <div className="absolute inset-x-0 bottom-0 z-10 px-2 pt-6 pb-1.5 bg-gradient-to-t from-bg via-bg/85 to-transparent pointer-events-none">
        <span className="block text-[10px] leading-tight text-white/90 line-clamp-2">{game.name}</span>
      </div>
      <span className="sr-only">{game.name}</span>
    </button>
  );
}
