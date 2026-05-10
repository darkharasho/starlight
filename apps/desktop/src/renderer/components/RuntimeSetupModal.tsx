import { useEffect } from 'react';
import { useCeRuntimeStore } from '../stores/ce-runtime-store.js';

export function RuntimeSetupModal(): JSX.Element | null {
  const status = useCeRuntimeStore((s) => s.status);
  const installing = useCeRuntimeStore((s) => s.installing);
  const error = useCeRuntimeStore((s) => s.installError);
  const refresh = useCeRuntimeStore((s) => s.refresh);
  const install = useCeRuntimeStore((s) => s.install);

  useEffect(() => { void refresh(); }, [refresh]);

  if (!status || status.status === 'ready') return null;

  if (status.status === 'installing' || installing) {
    const phase = status.status === 'installing' ? status.phase : 'preparing';
    const pct = status.status === 'installing' && status.total && status.current
      ? Math.round((status.current / status.total) * 100)
      : null;
    return (
      <Backdrop>
        <h2 className="text-base font-semibold">Installing trainer engine…</h2>
        <div className="text-xs text-muted mt-2 capitalize">{phase}{pct !== null ? ` · ${pct}%` : ''}</div>
        <div className="w-[280px] h-1.5 bg-line rounded-sm mt-3 overflow-hidden">
          <div className="h-full bg-neon-cyan glow-cyan transition-all" style={{ width: pct !== null ? `${pct}%` : '8%' }} />
        </div>
      </Backdrop>
    );
  }

  // status: 'not-installed'
  return (
    <Backdrop>
      <h2 className="text-base font-semibold">Set up the trainer engine</h2>
      <p className="text-xs text-muted mt-2 max-w-[420px]">
        Starlight uses Cheat Engine as its trainer engine. We&apos;ll download a one-time ~24 MB
        runtime to your user data directory. It runs invisibly in the background.
      </p>
      <p className="text-[10px] text-muted/80 mt-2 max-w-[420px]">
        Cheat Engine is licensed under GPLv2. Sources at{' '}
        <a href="https://github.com/cheat-engine/cheat-engine" target="_blank" rel="noreferrer"
           className="underline hover:text-neon-cyan">github.com/cheat-engine/cheat-engine</a>.
      </p>
      {error && (
        <p className="text-xs text-neon-pink mt-3 max-w-[420px]">{error}</p>
      )}
      <div className="mt-3 flex gap-2">
        <button type="button" onClick={() => void install()}
                className="px-3 py-1.5 text-xs rounded-sm border border-neon-cyan text-neon-cyan glow-cyan hover:bg-neon-cyan/[0.08]">
          Set up
        </button>
        <button type="button" onClick={() => void refresh()}
                className="px-3 py-1.5 text-xs rounded-sm border border-line text-muted hover:border-neon-cyan hover:text-neon-cyan">
          Refresh status
        </button>
      </div>
    </Backdrop>
  );
}

function Backdrop({ children }: { children: React.ReactNode }): JSX.Element {
  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-bg/70 backdrop-blur-sm">
      <div className="px-6 py-5 rounded-md border border-neon-cyan/40 bg-panel/95 glow-cyan max-w-md flex flex-col items-start">
        {children}
      </div>
    </div>
  );
}
