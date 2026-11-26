import { useCallback } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { LatchPill } from './LatchPill.js';
import { RuntimeStatusChip } from './RuntimeStatusChip.js';
import type { LatchState } from '../stores/latch-store.js';
import { useDetectionStore } from '../stores/detection-store.js';
import { useCeSessionStore } from '../stores/ce-session-store.js';
import { useSearchStore } from '../stores/search-store.js';
import { attachRequestFor, findCatalogEntry, showGameScreen, openCatalogGame } from '../lib/open-game.js';
import { isMyGameEntry } from '../../shared/my-games.js';

interface Props {
  latchState: LatchState;
}

export function TopBar({ latchState }: Props): JSX.Element {
  const navigate = useNavigate();
  const location = useLocation();
  const detected = useDetectionStore((s) => s.detected);
  const start = useCeSessionStore((s) => s.start);
  const ceAttached = useCeSessionStore((s) => s.attached);
  const ceSessionId = useCeSessionStore((s) => s.sessionId);
  const query = useSearchStore((s) => s.query);
  const setQuery = useSearchStore((s) => s.setQuery);

  const onSearchChange = useCallback((value: string) => {
    setQuery(value);
    // Jump to the results view as soon as the user starts searching.
    if (value && location.pathname !== '/search') navigate('/search');
  }, [setQuery, location.pathname, navigate]);

  const handleLatch = useCallback(async () => {
    if (!detected) return;
    const entry = findCatalogEntry(detected.game);
    if (entry && isMyGameEntry(entry)) {
      // A game only the player's own cheats cover: its page has them.
      useDetectionStore.getState().clear();
      await openCatalogGame(entry, navigate);
      return;
    }
    const req = entry ? attachRequestFor(entry, { pid: detected.pid, processName: detected.name }) : null;
    if (!req) {
      // Catalog not loaded or no entry — clear the pill and bail gracefully
      useDetectionStore.getState().clear();
      return;
    }
    await start(req);
    useDetectionStore.getState().clear();
    showGameScreen(navigate);
  }, [detected, navigate, start]);

  // Pill priority: an attached Cheat Engine session wins (it's the strongest
  // "we're live" signal), then a pending detection (armed), then the legacy
  // latch state. Without the session check the pill sat on "Waiting for game"
  // even while a session was attached and running.
  const effectiveState: LatchState =
    ceAttached && ceSessionId ? 'latched' : detected ? 'detected' : latchState;
  const detectedLabel = detected ? `${detected.game.name} detected — Latch` : undefined;

  return (
    <header className="h-[60px] shrink-0 flex items-center px-6 gap-3">
      <input
        type="text"
        placeholder="Search games or trainers…"
        aria-label="Search games or trainers"
        value={query}
        onChange={(e) => onSearchChange(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter' && query.trim() && location.pathname !== '/search') navigate('/search'); }}
        className="flex-1 max-w-[440px] h-[38px] rounded-full bg-panel border border-transparent px-4 text-sm text-ink placeholder:text-muted transition-colors hover:border-line focus:outline-none focus:border-neon-cyan/70"
      />
      <div className="ml-auto flex items-center gap-2">
        <RuntimeStatusChip />
        <LatchPill
          state={effectiveState}
          detectedLabel={detectedLabel}
          onLatch={detected ? () => { void handleLatch(); } : undefined}
        />
      </div>
    </header>
  );
}
