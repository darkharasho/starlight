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
