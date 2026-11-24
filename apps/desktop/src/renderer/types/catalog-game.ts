import type { CatalogIndexEntry } from '../../shared/ipc.js';

/**
 * UI-side game shape used by GameTile/BoxartGrid. Combines a catalog index entry
 * with view-state booleans derived by the parent route.
 */
export interface CatalogGame extends CatalogIndexEntry {
  /** Whether the user has this game installed (parent route derives from library-store). */
  installed: boolean;
}

export function steamCoverUrl(steamAppId: number | null): string | null {
  if (steamAppId == null) return null;
  // Main answers this from Steam's local cache, the store's capsule or the CDN.
  return `starlight-art://steam/${steamAppId}`;
}

/** The game's wide banner art (main answers from Steam's cache, the store or the CDN). */
export function steamHeroUrl(steamAppId: number | null | undefined): string | null {
  return steamAppId == null ? null : `starlight-art://steam-hero/${steamAppId}`;
}
