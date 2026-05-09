import type { CatalogGame } from '../data/catalog.js';

interface Props {
  game: CatalogGame;
  onClick?: (game: CatalogGame) => void;
}

export function GameTile({ game, onClick }: Props): JSX.Element {
  const hasTrainerBorder = game.hasTrainer ? 'border-neon-cyan/60 glow-cyan' : 'border-line';
  return (
    <button
      type="button"
      aria-label={game.name}
      onClick={() => onClick?.(game)}
      className={`relative aspect-[2/3] rounded-sm overflow-hidden border ${hasTrainerBorder} transition-transform duration-150 hover:-translate-y-0.5 hover:border-neon-cyan focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neon-cyan`}
      style={{ backgroundImage: `url(${game.coverUrl})`, backgroundSize: 'cover', backgroundPosition: 'center' }}
    >
      {game.installed && (
        <span className="absolute top-1.5 left-1.5 text-[8px] tracking-wider text-neon-pink bg-bg/70 px-1.5 py-[2px] rounded-sm">
          ● INSTALLED
        </span>
      )}
      {game.hasTrainer && (
        <span className="absolute bottom-1.5 right-1.5 text-[8px] tracking-wider text-neon-cyan bg-bg/70 px-1.5 py-[2px] rounded-sm uppercase">
          Trainer
        </span>
      )}
      <span className="sr-only">{game.name}</span>
    </button>
  );
}
