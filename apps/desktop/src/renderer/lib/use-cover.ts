import { useEffect, useRef, useState } from 'react';
import { starlight } from '../ipc-client.js';
import { steamCoverUrl } from '../types/catalog-game.js';

/**
 * Box art for a game: Steam's cover when the app id is known, otherwise
 * whatever the boxart resolver finds by name. `onError` moves on to the
 * fallback once, then gives up so a broken image never sticks around.
 */
export function useCover(game: { name: string; steamAppId?: number | null } | undefined): { src: string | null; onError: () => void } {
  const name = game?.name ?? '';
  const upfront = steamCoverUrl(game?.steamAppId ?? null);
  const [src, setSrc] = useState<string | null>(upfront);
  const fallbackTried = useRef(false);

  useEffect(() => { setSrc(upfront); fallbackTried.current = false; }, [upfront, name]);

  useEffect(() => {
    if (src !== null || name === '' || fallbackTried.current) return;
    let cancelled = false;
    void resolve(name, false).then((url) => { if (!cancelled && url) setSrc(url); });
    return () => { cancelled = true; };
  }, [src, name]);

  function onError(): void {
    if (fallbackTried.current || name === '') { setSrc(null); return; }
    fallbackTried.current = true;
    const failed = src;
    void resolve(name, true).then((url) => setSrc(url && url !== failed ? url : null));
  }

  return { src, onError };
}

async function resolve(name: string, forceFallback: boolean): Promise<string | null> {
  try {
    const r = await starlight().resolveBoxart(forceFallback ? { name, forceFallback } : { name });
    return r?.url ?? null;
  } catch {
    return null;
  }
}
