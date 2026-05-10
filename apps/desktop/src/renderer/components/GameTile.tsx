import { type CatalogGame, steamCoverUrl } from '../types/catalog-game.js';

interface Props {
  game: CatalogGame;
  onClick?: (game: CatalogGame) => void;
}

export function GameTile({ game, onClick }: Props): JSX.Element {
  const cover = steamCoverUrl(game.steamAppId);
  return (
    <button
      type="button"
      aria-label={game.name}
      onClick={() => onClick?.(game)}
      className="relative aspect-[2/3] rounded-sm overflow-hidden border border-neon-cyan/60 glow-cyan transition-transform duration-150 hover:-translate-y-0.5 hover:border-neon-cyan focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neon-cyan"
      style={cover ? { backgroundImage: `url(${cover})`, backgroundSize: 'cover', backgroundPosition: 'center' } : { backgroundColor: '#1a1a22' }}
    >
      {!cover && (
        <span className="absolute inset-0 flex items-center justify-center text-[10px] text-muted px-2 text-center">
          {game.name}
        </span>
      )}
      {game.installed && (
        <span className="absolute top-1.5 left-1.5 text-[8px] tracking-wider text-neon-pink bg-bg/70 px-1.5 py-[2px] rounded-sm">
          ● INSTALLED
        </span>
      )}
      <span className="absolute bottom-1.5 right-1.5 text-[8px] tracking-wider text-neon-cyan bg-bg/70 px-1.5 py-[2px] rounded-sm uppercase">
        Trainer
      </span>
      <span className="sr-only">{game.name}</span>
    </button>
  );
}
