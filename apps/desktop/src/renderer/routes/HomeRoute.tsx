import { useNavigate } from 'react-router-dom';
import { CATALOG, type CatalogGame } from '../data/catalog.js';
import { BoxartGrid } from '../components/BoxartGrid.js';
import { PageHeader } from '../components/PageHeader.js';
import { useLatchState } from '../stores/latch-store.js';
import { useTrainerStore } from '../stores/trainer-store.js';

export function HomeRoute(): JSX.Element {
  const navigate = useNavigate();
  const detect = useLatchState((s) => s.detect);
  const loadTrainer = useTrainerStore((s) => s.loadTrainer);
  const trainerLoaded = useTrainerStore((s) => s.trainer);

  const installed = CATALOG.filter((g) => g.installed);
  const featured = CATALOG.filter((g) => g.hasTrainer);
  const installedWithTrainer = CATALOG.filter((g) => g.installed && g.hasTrainer).length;

  function selectGame(g: CatalogGame): void {
    if (g.hasTrainer) {
      detect({ name: g.name, coverUrl: g.coverUrl, processName: g.processName[0]! });
      navigate('/active');
    }
  }

  return (
    <>
      <PageHeader
        title="Home"
        right={
          <span className="text-[11px] text-muted">
            <span className="inline-block size-1.5 rounded-full bg-neon-cyan glow-cyan mr-1.5 align-middle" />
            {installedWithTrainer} installed games have trainers
          </span>
        }
      />
      <div className="mb-5 flex items-center gap-3">
        <button
          type="button"
          onClick={async () => { await loadTrainer(); navigate('/active'); }}
          className="px-3 py-1.5 text-xs rounded-sm border border-neon-cyan text-neon-cyan glow-cyan hover:bg-neon-cyan/[0.08]"
        >
          Load Trainer (.CT)
        </button>
        {trainerLoaded && <span className="text-[11px] text-muted">Loaded: {trainerLoaded.game.name}</span>}
      </div>
      <Section label="Recently Played" games={installed} onSelect={selectGame} />
      <Section label="Featured Trainers" games={featured} onSelect={selectGame} />
    </>
  );
}

function Section({ label, games, onSelect }: { label: string; games: CatalogGame[]; onSelect: (g: CatalogGame) => void }): JSX.Element {
  return (
    <section className="mb-5">
      <div className="text-[10px] tracking-wider uppercase text-muted mb-2.5">{label}</div>
      <BoxartGrid games={games} onSelect={onSelect} />
    </section>
  );
}
