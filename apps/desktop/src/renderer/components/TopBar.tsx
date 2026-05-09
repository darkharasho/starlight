import { LatchPill } from './LatchPill.js';
import type { LatchState } from '../stores/latch-store.js';

interface Props {
  latchState: LatchState;
}

export function TopBar({ latchState }: Props): JSX.Element {
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
        <LatchPill state={latchState} />
      </div>
    </header>
  );
}
