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
  return `https://cdn.cloudflare.steamstatic.com/steam/apps/${steamAppId}/library_600x900.jpg`;
}
