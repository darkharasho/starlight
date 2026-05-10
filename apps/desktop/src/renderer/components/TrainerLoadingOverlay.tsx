import { useCatalogStore } from '../stores/catalog-store.js';

/**
 * Full-screen overlay shown while a trainer JSON is being fetched.
 *
 * Live-fetched trainers (the `trainerSource` path) hit fearlessrevolution
 * over the network and can take a few seconds. Without feedback the click
 * appears to do nothing.
 */
export function TrainerLoadingOverlay(): JSX.Element | null {
  const fetchingId = useCatalogStore((s) => s.fetchingTrainerId);
  const trainerError = useCatalogStore((s) => s.trainerError);
  const index = useCatalogStore((s) => s.index);

  if (!fetchingId && !trainerError) return null;

  const entry = fetchingId ? index?.games.find((g) => g.id === fetchingId) ?? null : null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-bg/70 backdrop-blur-sm pointer-events-none"
      aria-live="polite"
    >
      <div className="flex flex-col items-center gap-3 px-6 py-5 rounded-md border border-neon-cyan/40 bg-panel/95 glow-cyan pointer-events-auto">
        {fetchingId && (
          <>
            <Spinner />
            <div className="text-xs text-muted">
              Fetching trainer…
            </div>
            {entry && (
              <div className="text-sm font-semibold text-neon-cyan max-w-[280px] text-center truncate">
                {entry.name}
              </div>
            )}
            <div className="text-[10px] text-muted">
              First load pulls the table from fearlessrevolution
            </div>
          </>
        )}
        {!fetchingId && trainerError && (
          <div className="flex flex-col items-center gap-1 max-w-[320px]">
            <div className="text-sm font-semibold text-neon-pink">Trainer fetch failed</div>
            <div className="text-[11px] text-muted text-center">{trainerError}</div>
            <button
              type="button"
              onClick={() => useCatalogStore.setState({ trainerError: null })}
              className="mt-2 px-3 py-1 text-[11px] rounded-sm border border-line text-muted hover:border-neon-cyan hover:text-neon-cyan"
            >
              Dismiss
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function Spinner(): JSX.Element {
  return (
    <span
      className="inline-block w-7 h-7 rounded-full border-2 border-neon-cyan/30 border-t-neon-cyan animate-spin"
      aria-label="Loading"
    />
  );
}
