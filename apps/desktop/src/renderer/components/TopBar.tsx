import { LatchPill, type LatchState } from './LatchPill.js';

interface Props {
  latchState: LatchState;
}

export function TopBar({ latchState }: Props): JSX.Element {
  return (
    <header className="h-[52px] shrink-0 border-b border-line bg-panel/60 backdrop-blur flex items-center px-4 gap-3">
      <input
        type="text"
        placeholder="⌕  Search games or trainers…"
        className="flex-1 max-w-[420px] h-[30px] rounded bg-panel border border-line px-2.5 text-xs text-muted placeholder:text-muted/80 focus:outline-none focus:border-neon-cyan"
      />
      <div className="ml-auto">
        <LatchPill state={latchState} />
      </div>
    </header>
  );
}
