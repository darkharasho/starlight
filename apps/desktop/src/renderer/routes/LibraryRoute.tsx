import { useNavigate } from 'react-router-dom';
import { CATALOG, type CatalogGame } from '../data/catalog.js';
import { BoxartGrid } from '../components/BoxartGrid.js';
import { PageHeader } from '../components/PageHeader.js';
import { useLatchState } from '../stores/latch-store.js';

export function LibraryRoute(): JSX.Element {
  const navigate = useNavigate();
  const detect = useLatchState((s) => s.detect);
  const installed = CATALOG.filter((g) => g.installed);

  function onSelect(g: CatalogGame): void {
    if (g.hasTrainer) {
      detect({ name: g.name, coverUrl: g.coverUrl, processName: g.processName[0]! });
      navigate('/active');
    }
  }

  return (
    <>
      <PageHeader
        title="Library"
        subtitle={`${installed.length} games detected from Steam, Epic, Heroic, Lutris`}
      />
      <BoxartGrid games={installed} onSelect={onSelect} />
    </>
  );
}
