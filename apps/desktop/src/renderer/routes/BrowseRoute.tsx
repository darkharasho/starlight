import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { CATALOG, type CatalogGame } from '../data/catalog.js';
import { BoxartGrid } from '../components/BoxartGrid.js';
import { PageHeader } from '../components/PageHeader.js';
import { useLatchState } from '../stores/latch-store.js';

export function BrowseRoute(): JSX.Element {
  const navigate = useNavigate();
  const detect = useLatchState((s) => s.detect);
  const [hasTrainerOnly, setHasTrainerOnly] = useState(true);

  const games = CATALOG.filter((g) => !hasTrainerOnly || g.hasTrainer);

  function onSelect(g: CatalogGame): void {
    if (g.hasTrainer) {
      detect({ name: g.name, coverUrl: g.coverUrl, processName: g.processName[0]! });
      navigate('/active');
    }
  }

  return (
    <>
      <PageHeader
        title="Browse"
        subtitle={`${games.length} games in the catalog`}
        right={
          <label className="flex items-center gap-2 text-[11px] text-muted cursor-pointer">
            <input
              type="checkbox"
              checked={hasTrainerOnly}
              onChange={(e) => setHasTrainerOnly(e.target.checked)}
              className="accent-neon-cyan"
            />
            Has trainer only
          </label>
        }
      />
      <BoxartGrid games={games} onSelect={onSelect} />
    </>
  );
}
