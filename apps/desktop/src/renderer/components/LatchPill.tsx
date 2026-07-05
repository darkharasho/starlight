import type { LatchState } from '../stores/latch-store.js';

interface Props { state: LatchState; detectedLabel?: string | undefined; onLatch?: (() => void) | undefined }

const LABELS: Record<LatchState, string> = {
  waiting:   'Waiting for game',
  detected:  'Game detected — click to Latch',
  latched:   'LATCHED',
};

export function LatchPill({ state, detectedLabel, onLatch }: Props): JSX.Element {
  const styles =
    state === 'latched'
      ? 'border-neon-green text-neon-green bg-neon-green/[0.08] glow-green'
      : state === 'detected'
      ? 'border-neon-cyan text-neon-cyan bg-neon-cyan/[0.08] glow-cyan cursor-pointer hover:bg-neon-cyan/[0.15]'
      : 'border-neon-pink text-neon-pink bg-neon-pink/[0.08] glow-pink';

  const label = state === 'detected' && detectedLabel ? detectedLabel : LABELS[state];

  return (
    <div
      className={`flex items-center gap-2 rounded px-3 py-1.5 text-xs border ${styles}`}
      role={state === 'detected' ? 'button' : 'status'}
      onClick={state === 'detected' ? onLatch : undefined}
      onKeyDown={state === 'detected' && onLatch ? (ev) => { if (ev.key === 'Enter' || ev.key === ' ') onLatch(); } : undefined}
      tabIndex={state === 'detected' ? 0 : undefined}
    >
      <span className={`block size-2 rounded-full ${state === 'latched' ? 'bg-neon-green' : state === 'detected' ? 'bg-neon-cyan' : 'bg-neon-pink animate-pulse-slow'}`} />
      <span>{label}</span>
    </div>
  );
}
