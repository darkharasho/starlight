import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Grid, type CellComponentProps } from 'react-window';
import type { CatalogGame } from '../types/catalog-game.js';
import { GameTile } from './GameTile.js';

interface Props {
  games: CatalogGame[];
  onSelect?: (game: CatalogGame) => void;
  /** Approximate tile width in px; used to pick a column count. */
  tileWidth?: number;
  /** Tile aspect 2:3 plus name+badges → ~1.5:1 inner ratio. */
  tileHeight?: number;
}

const DEFAULT_TILE_W = 160;
const DEFAULT_TILE_H = 270;

interface CellProps {
  games: CatalogGame[];
  cols: number;
  cellW: number;
  onSelect?: (g: CatalogGame) => void;
}

function Cell({ rowIndex, columnIndex, style, games, cols, cellW, onSelect }: CellComponentProps<CellProps>): JSX.Element | null {
  const idx = rowIndex * cols + columnIndex;
  const game = games[idx];
  if (!game) return null;
  const padded: React.CSSProperties = { ...style, padding: 6, width: cellW };
  return (
    <div style={padded}>
      <GameTile game={game} {...(onSelect ? { onClick: onSelect } : {})} />
    </div>
  );
}

export function BoxartGrid({ games, onSelect, tileWidth = DEFAULT_TILE_W, tileHeight = DEFAULT_TILE_H }: Props): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 1200, height: 800 });

  useLayoutEffect(() => {
    if (!containerRef.current) return;
    const measure = (): void => {
      const r = containerRef.current!.getBoundingClientRect();
      setSize({ width: Math.max(1, Math.floor(r.width)), height: Math.max(1, Math.floor(r.height)) });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(containerRef.current);
    return () => ro.disconnect();
  }, []);

  const cols = Math.max(1, Math.floor(size.width / tileWidth));
  const cellW = Math.floor(size.width / cols);
  const rowCount = Math.ceil(games.length / cols);

  // Stable cellProps reference — Grid re-renders cells when this object changes.
  const cellProps: CellProps = { games, cols, cellW, ...(onSelect ? { onSelect } : {}) };

  return (
    <div ref={containerRef} className="flex-1 min-h-0 h-full w-full">
      {size.height > 0 && (
        <Grid
          cellComponent={Cell}
          cellProps={cellProps}
          columnCount={cols}
          columnWidth={cellW}
          rowCount={rowCount}
          rowHeight={tileHeight}
          defaultWidth={size.width}
          defaultHeight={size.height}
          overscanCount={4}
          style={{ width: size.width, height: size.height }}
        />
      )}
    </div>
  );
}
