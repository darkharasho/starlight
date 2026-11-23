import { useCeRuntimeStore } from '../stores/ce-runtime-store.js';

/**
 * Shows the trainer engine's background download, and a retry when it
 * failed. Nothing at all once it's installed.
 */
export function RuntimeStatusChip(): JSX.Element | null {
  const status = useCeRuntimeStore((s) => s.status);
  const error = useCeRuntimeStore((s) => s.error);
  const retry = useCeRuntimeStore((s) => s.retry);

  if (!status || status.status === 'ready') return null;

  if (status.status === 'installing') {
    const pct = status.total && status.current !== undefined
      ? Math.round((status.current / status.total) * 100)
      : null;
    return (
      <div role="status" className="flex items-center gap-2 rounded-full px-4 py-2 text-[13px] text-muted bg-panel"
           title="Starlight downloads Cheat Engine, its trainer engine, once. Cheat Engine is GPLv2 (github.com/cheat-engine/cheat-engine).">
        <span className="relative block w-14 h-1 rounded-full bg-line overflow-hidden">
          <span className={`absolute inset-y-0 left-0 bg-neon-cyan transition-[width] ${pct === null ? 'w-1/4 animate-pulse' : ''}`}
                style={pct !== null ? { width: `${pct}%` } : undefined} />
        </span>
        <span>Getting the trainer engine ready{pct !== null ? ` · ${pct}%` : ''}</span>
      </div>
    );
  }

  if (!error) return null;
  return (
    <div role="alert" className="flex items-center gap-2 rounded-full pl-4 pr-1 py-1 text-[13px] text-neon-pink bg-neon-pink/[0.1]" title={error}>
      <span>Trainer engine download failed</span>
      <button type="button" onClick={() => void retry()}
              className="rounded-full px-3 py-1 text-ink bg-panel hover:bg-line focus:outline-none focus-visible:ring-1 focus-visible:ring-neon-cyan">
        Try again
      </button>
    </div>
  );
}
