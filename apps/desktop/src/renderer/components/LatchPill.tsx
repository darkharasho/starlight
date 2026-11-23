import type { LatchState } from '../stores/latch-store.js';

interface Props { state: LatchState; detectedLabel?: string | undefined; onLatch?: (() => void) | undefined }

const LABELS: Record<LatchState, string> = {
  waiting:   'Waiting for game',
  detected:  'Game detected — click to Latch',
  latched:   'Connected',
};

export function LatchPill({ state, detectedLabel, onLatch }: Props): JSX.Element {
  const styles =
    state === 'latched'
      ? 'text-neon-green bg-neon-green/[0.12]'
      : state === 'detected'
      ? 'text-[#06231d] bg-neon-cyan font-semibold cursor-pointer hover:brightness-110'
      : 'text-muted bg-panel';

  const label = state === 'detected' && detectedLabel ? detectedLabel : LABELS[state];

  return (
    <div
      className={`flex items-center gap-2 rounded-full px-4 py-2 text-[13px] transition-colors ${styles}`}
      role={state === 'detected' ? 'button' : 'status'}
      onClick={state === 'detected' ? onLatch : undefined}
      onKeyDown={state === 'detected' && onLatch ? (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); onLatch(); } } : undefined}
      tabIndex={state === 'detected' ? 0 : undefined}
    >
      <span className={`block size-2 rounded-full ${state === 'latched' ? 'bg-neon-green' : state === 'detected' ? 'bg-[#06231d]' : 'bg-muted animate-pulse-slow'}`} />
      <span>{label}</span>
    </div>
  );
}
