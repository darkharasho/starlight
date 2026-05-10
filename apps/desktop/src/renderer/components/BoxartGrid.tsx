import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Grid, type CellComponentProps } from 'react-window';
import type { CatalogGame } from '../types/catalog-game.js';
import { GameTile } from './GameTile.js';

interface Props {
  games: CatalogGame[];
  onSelect?: (game: CatalogGame) => void;
  /** Approximate tile width in px; used to pick a column count. */
  tileWidth?: number;
}

const DEFAULT_TILE_W = 160;
/** Padding around each tile inside its grid cell. */
const CELL_PADDING = 6;

interface CellProps {
  games: CatalogGame[];
  cols: number;
  cellW: number;
  onSelect?: (g: CatalogGame) => void;
}

function Cell({ rowIndex, columnIndex, style, games, cols, onSelect }: CellComponentProps<CellProps>): JSX.Element | null {
  const idx = rowIndex * cols + columnIndex;
  const game = games[idx];
  if (!game) return null;
  return (
    <div style={style} className="p-1.5">
      <GameTile game={game} {...(onSelect ? { onClick: onSelect } : {})} />
    </div>
  );
}

export function BoxartGrid({ games, onSelect, tileWidth = DEFAULT_TILE_W }: Props): JSX.Element {
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
  // Tile inside has aspect-[2/3]; account for cell padding above/below/around.
  const innerW = cellW - CELL_PADDING * 2;
  const innerH = Math.round(innerW * 1.5);
  const rowH = innerH + CELL_PADDING * 2;
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
          rowHeight={rowH}
          defaultWidth={size.width}
          defaultHeight={size.height}
          overscanCount={4}
          style={{ width: size.width, height: size.height }}
        />
      )}
    </div>
  );
}
