import type { LatchState } from '../stores/latch-store.js';

interface Props { state: LatchState }

const LABELS: Record<LatchState, string> = {
  idle:      'Idle',
  waiting:   'Waiting for game',
  detected:  'Game detected — click to Latch',
  latched:   'LATCHED',
};

export function LatchPill({ state }: Props): JSX.Element {
  const styles =
    state === 'latched'
      ? 'border-neon-green text-neon-green bg-neon-green/[0.08] glow-green'
      : state === 'detected'
      ? 'border-neon-cyan text-neon-cyan bg-neon-cyan/[0.08] glow-cyan'
      : 'border-neon-pink text-neon-pink bg-neon-pink/[0.08] glow-pink';

  return (
    <div className={`flex items-center gap-2 rounded px-3 py-1.5 text-xs border ${styles}`} role="status">
      <span className={`block size-2 rounded-full ${state === 'latched' ? 'bg-neon-green' : state === 'detected' ? 'bg-neon-cyan' : 'bg-neon-pink animate-pulse-slow'}`} />
      <span>{LABELS[state]}</span>
    </div>
  );
}
