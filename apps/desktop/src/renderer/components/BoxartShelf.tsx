import type { CatalogGame } from '../types/catalog-game.js';
import { GameTile } from './GameTile.js';

interface Props {
  games: CatalogGame[];
  onSelect?: (game: CatalogGame) => void;
  /** Cap the number of tiles rendered. Default 30 — Home shelves shouldn't try to show 7,746. */
  limit?: number;
  /** Tailwind-tracked min tile width. */
  minTileWidth?: string;
}

/**
 * Non-virtualized grid for shelves embedded inside a scrolling page (Home,
 * Search results). Flows naturally with the parent's scroll context — no
 * inner scrollbar. Use BoxartGrid for full-screen virtualized lists.
 */
export function BoxartShelf({ games, onSelect, limit = 30, minTileWidth = '140px' }: Props): JSX.Element {
  const slice = games.slice(0, limit);
  return (
    <div
      className="grid gap-3"
      style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${minTileWidth}, 1fr))` }}
    >
      {slice.map((g) => (
        <GameTile key={g.id} game={g} {...(onSelect ? { onClick: onSelect } : {})} />
      ))}
    </div>
  );
}
