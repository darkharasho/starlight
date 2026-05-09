import { useEffect, useState } from 'react';
import { StarlightLogo } from './StarlightLogo.js';

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
      className="h-9 shrink-0 flex items-center bg-panel border-b border-line relative select-none"
      style={DRAG}
    >
      {/* Centered title block */}
      <div className="absolute inset-0 flex items-center justify-center gap-2 pointer-events-none">
        <StarlightLogo
          className="size-4 text-neon-cyan drop-shadow-[0_0_4px_rgba(0,255,200,0.6)]"
        />
        <span
          className="text-[11px] font-bold tracking-widest text-neon-cyan"
          style={{ textShadow: '0 0 8px rgba(0,255,200,0.5)' }}
        >
          STARLIGHT
        </span>
      </div>

      {/* Window controls — pinned right, no-drag so they're clickable */}
      <div className="ml-auto flex items-stretch h-full" style={NO_DRAG}>
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
