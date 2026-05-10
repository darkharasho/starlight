import type { CatalogGame } from '../types/catalog-game.js';
import { GameTile } from './GameTile.js';

interface Props {
  games: CatalogGame[];
  onSelect?: (game: CatalogGame) => void;
  /** Tailwind grid-cols class (default: 8). */
  cols?: string;
}

export function BoxartGrid({ games, onSelect, cols = 'grid-cols-8' }: Props): JSX.Element {
  return (
    <div className={`grid ${cols} gap-3`}>
      {games.map((g) => (
        <GameTile key={g.id} game={g} {...(onSelect ? { onClick: onSelect } : {})} />
      ))}
    </div>
  );
}
