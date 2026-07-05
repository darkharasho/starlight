import { useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { LatchPill } from './LatchPill.js';
import type { LatchState } from '../stores/latch-store.js';
import { useDetectionStore } from '../stores/detection-store.js';
import { useCatalogStore } from '../stores/catalog-store.js';
import { useCeSessionStore } from '../stores/ce-session-store.js';

interface Props {
  latchState: LatchState;
}

export function TopBar({ latchState }: Props): JSX.Element {
  const navigate = useNavigate();
  const detected = useDetectionStore((s) => s.detected);
  const start = useCeSessionStore((s) => s.start);

  const handleLatch = useCallback(async () => {
    if (!detected) return;
    const entry = useCatalogStore.getState().index?.games.find((g) => g.id === detected.game.id);
    const source = entry?.trainerSource ?? entry?.trainerPath;
    if (!source) {
      // Catalog not loaded or no entry — clear the pill and bail gracefully
      useDetectionStore.getState().clear();
      return;
    }
    await start({
      source,
      cacheKey: detected.game.id,
      pid: detected.pid,
      processName: detected.name,
      game: detected.game,
    });
    useDetectionStore.getState().clear();
    navigate('/active');
  }, [detected, navigate, start]);

  // When a detection is pending, show the armed pill regardless of the legacy latch state.
  const effectiveState: LatchState = detected ? 'detected' : latchState;
  const detectedLabel = detected ? `${detected.name} detected — Latch` : undefined;

  return (
    <header className="h-[52px] shrink-0 border-b border-line bg-panel/60 backdrop-blur flex items-center px-4 gap-3">
      <input
        type="text"
        placeholder="⌕  Search games or trainers… (use Search tab)"
        disabled
        title="Use the Search tab in the sidebar"
        className="flex-1 max-w-[420px] h-[30px] rounded bg-panel border border-line px-2.5 text-xs text-muted placeholder:text-muted/60 focus:outline-none cursor-not-allowed opacity-70"
      />
      <div className="ml-auto">
        <LatchPill
          state={effectiveState}
          detectedLabel={detectedLabel}
          onLatch={detected ? () => { void handleLatch(); } : undefined}
        />
      </div>
    </header>
  );
}
