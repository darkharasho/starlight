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
      className="relative w-full aspect-[2/3] rounded-xl overflow-hidden ring-1 ring-white/10 shadow-card transition-[transform,box-shadow] duration-200 ease-out hover:-translate-y-1 hover:shadow-pop hover:ring-white/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neon-cyan bg-panel"
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
        <span className="absolute top-2 left-2 z-10 flex items-center gap-1 rounded-full bg-shell/80 px-2 py-[3px] text-[10px] font-medium text-ink backdrop-blur">
          <span className="size-1.5 rounded-full bg-neon-green" />Installed
        </span>
      )}
      <span className="absolute top-2 right-2 z-10 rounded-full bg-shell/80 px-2 py-[3px] text-[10px] font-medium text-neon-cyan backdrop-blur">
        Trainer
      </span>
      {/* Always-visible title so tiles are identifiable regardless of the art. */}
      <div className="absolute inset-x-0 bottom-0 z-10 px-2.5 pt-8 pb-2 bg-gradient-to-t from-shell via-shell/80 to-transparent pointer-events-none">
        <span className="block text-xs font-medium leading-tight text-white line-clamp-2 text-left">{game.name}</span>
      </div>
      <span className="sr-only">{game.name}</span>
    </button>
  );
}
