import { useEffect, useState } from 'react';
import { keyboardEventToAccelerator } from '../lib/accelerator.js';

interface Props {
  value: string | null;
  onCapture: (accelerator: string) => void;
  onReset: () => void;
  /** Optional: error message rendered below the row (e.g. "Conflict with F4"). */
  error?: string | null;
}

export function HotkeyCapture({ value, onCapture, onReset, error = null }: Props): JSX.Element {
  const [capturing, setCapturing] = useState(false);

  useEffect(() => {
    if (!capturing) return;
    function handler(e: KeyboardEvent): void {
      e.preventDefault();
      e.stopPropagation();
      if (e.code === 'Escape' || e.key === 'Escape') {
        setCapturing(false);
        return;
      }
      const accel = keyboardEventToAccelerator(e);
      if (accel) {
        setCapturing(false);
        onCapture(accel);
      }
    }
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [capturing, onCapture]);

  return (
    <div className="flex items-center gap-1">
      <span className={`text-[10px] tracking-wider px-2 py-1 rounded-sm border font-mono ${capturing ? 'border-neon-pink text-neon-pink animate-pulse' : 'border-line text-muted'}`}>
        {capturing ? 'press a key…' : (value ?? '(none)')}
      </span>
      <button
        type="button"
        aria-label="Edit hotkey"
        onClick={() => setCapturing((c) => !c)}
        className="px-1.5 py-0.5 text-[10px] rounded-sm border border-line text-muted hover:border-neon-cyan hover:text-neon-cyan"
      >
        &#9998;
      </button>
      <button
        type="button"
        aria-label="Reset hotkey"
        onClick={() => onReset()}
        className="px-1.5 py-0.5 text-[10px] rounded-sm border border-line text-muted hover:border-neon-pink hover:text-neon-pink"
      >
        &#8634;
      </button>
      {error && <span className="text-[10px] text-neon-pink ml-1">{error}</span>}
    </div>
  );
}
