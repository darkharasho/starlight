import type { ActivityEntry } from '../../../shared/ipc.js';
import { useNow } from './useNow.js';

const DOT: Record<ActivityEntry['status'], string> = {
  running: 'bg-neon-cyan animate-pulse',
  ok: 'bg-neon-cyan',
  error: 'bg-neon-pink',
  refused: 'bg-neon-amber',
  note: 'bg-muted',
};

export function relativeTime(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}

export function ActivityList({ entries }: { entries: ActivityEntry[] }): JSX.Element {
  const now = useNow();
  if (entries.length === 0) return <p className="text-sm text-muted">Nothing yet.</p>;
  return (
    <ul className="flex flex-col gap-1.5">
      {entries.map((e) => (
        <li key={e.id} className="rounded-lg bg-panel px-4 py-2.5 animate-rise">
          <div className="flex items-center gap-3">
            <span aria-hidden="true" className={`size-2 shrink-0 rounded-full ${DOT[e.status]}`} />
            <span className="min-w-0 flex-1 truncate text-sm text-ink">{e.summary}</span>
            <span className="shrink-0 text-xs text-muted">{relativeTime(now - e.at)}</span>
          </div>
          {e.change && (
            <div className="ml-5 mt-1 font-mono text-xs text-muted">{e.change.address}: {e.change.old} → {e.change.new}</div>
          )}
          {e.error && <div className="ml-5 mt-1 text-xs text-neon-pink">{e.error}</div>}
        </li>
      ))}
    </ul>
  );
}
