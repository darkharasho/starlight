import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { CATALOG, type CatalogGame } from '../data/catalog.js';
import { BoxartGrid } from '../components/BoxartGrid.js';
import { PageHeader } from '../components/PageHeader.js';
import { useLatchState } from '../stores/latch-store.js';

export function SearchRoute(): JSX.Element {
  const navigate = useNavigate();
  const detect = useLatchState((s) => s.detect);
  const [query, setQuery] = useState('');

  const matches = query.trim()
    ? CATALOG.filter((g) => g.name.toLowerCase().includes(query.trim().toLowerCase()))
    : [];

  function onSelect(g: CatalogGame): void {
    if (g.hasTrainer) {
      detect({ name: g.name, coverUrl: g.coverUrl, processName: g.processName[0]! });
      navigate('/active');
    }
  }

  return (
    <>
      <PageHeader title="Search" />
      <input
        autoFocus
        type="text"
        placeholder="Type a game name…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        className="w-full max-w-[480px] h-9 rounded bg-panel border border-line px-3 text-sm text-ink placeholder:text-muted/80 focus:outline-none focus:border-neon-cyan mb-4"
      />
      {query.trim() && matches.length === 0 ? (
        <div className="text-xs text-muted">No games match. (Phase 4 will show a "request a trainer" CTA.)</div>
      ) : (
        <BoxartGrid games={matches} onSelect={onSelect} />
      )}
    </>
  );
}
