import { useEffect, useState } from 'react';
import { StarlightLogo } from './StarlightLogo.js';
import { useUpdateStore } from '../stores/update-store.js';
import { updatePill } from '../lib/update-view.js';

const DRAG = { WebkitAppRegion: 'drag' } as React.CSSProperties;
const NO_DRAG = { WebkitAppRegion: 'no-drag' } as React.CSSProperties;

export function TitleBar(): JSX.Element {
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    if (typeof window === 'undefined' || !window.starlight) return;
    return window.starlight.onWindowState((s) => setMaximized(s.maximized));
  }, []);

  return (
    <div
      className="h-9 shrink-0 flex items-center bg-shell relative select-none"
      style={DRAG}
    >
      {/* Centered title block */}
      <div className="absolute inset-0 flex items-center justify-center gap-2 pointer-events-none">
        <StarlightLogo
          className="size-4 text-neon-cyan"
        />
        <span className="text-[13px] font-semibold text-ink">Starlight</span>
      </div>

      {/* Window controls — pinned right, no-drag so they're clickable */}
      <div className="ml-auto flex items-stretch h-full" style={NO_DRAG}>
        <UpdatePill />
        <WindowButton
          aria-label="Minimize"
          onClick={() => window.starlight?.windowMinimize()}
          hoverClass="hover:bg-line"
        >
          <svg viewBox="0 0 12 12" className="size-3">
            <path d="M2 6h8" stroke="currentColor" strokeWidth="1" strokeLinecap="round" />
          </svg>
        </WindowButton>
        <WindowButton
          aria-label={maximized ? 'Restore' : 'Maximize'}
          onClick={() => window.starlight?.windowToggleMaximize()}
          hoverClass="hover:bg-line"
        >
          {maximized ? (
            <svg viewBox="0 0 12 12" className="size-3">
              <path
                d="M3.5 3.5h5v5h-5z M5 2h5v5"
                fill="none"
                stroke="currentColor"
                strokeWidth="1"
                strokeLinejoin="round"
              />
            </svg>
          ) : (
            <svg viewBox="0 0 12 12" className="size-3">
              <rect
                x="2.5"
                y="2.5"
                width="7"
                height="7"
                fill="none"
                stroke="currentColor"
                strokeWidth="1"
              />
            </svg>
          )}
        </WindowButton>
        <WindowButton
          aria-label="Close"
          onClick={() => window.starlight?.windowClose()}
          hoverClass="hover:bg-neon-pink/80 hover:text-bg"
        >
          <svg viewBox="0 0 12 12" className="size-3">
            <path
              d="M3 3l6 6M9 3l-6 6"
              stroke="currentColor"
              strokeWidth="1"
              strokeLinecap="round"
            />
          </svg>
        </WindowButton>
      </div>
    </div>
  );
}

/** Starlight's own update: progress while it downloads, then "Restart to update". */
function UpdatePill(): JSX.Element | null {
  const pill = updatePill(useUpdateStore((s) => s.state));
  const restart = useUpdateStore((s) => s.restart);
  if (!pill) return null;
  const base = 'self-center mr-2 rounded-full px-3 py-0.5 text-[11px] border';
  if (pill.kind === 'downloading') {
    return <span className={`${base} border-line text-muted`}>{pill.label}</span>;
  }
  return (
    <button
      type="button"
      onClick={() => void restart()}
      title={`Restart Starlight to install v${pill.version}`}
      className={`${base} border-neon-cyan text-neon-cyan hover:bg-neon-cyan/10 focus-visible:outline-none focus-visible:bg-neon-cyan/20`}
    >
      {pill.label}
    </button>
  );
}

interface WindowButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  hoverClass: string;
}

function WindowButton({ hoverClass, children, ...rest }: WindowButtonProps): JSX.Element {
  return (
    <button
      type="button"
      {...rest}
      className={`w-11 h-full flex items-center justify-center text-muted transition-colors ${hoverClass} hover:text-ink focus-visible:outline-none focus-visible:bg-line/60`}
    >
      {children}
    </button>
  );
}
