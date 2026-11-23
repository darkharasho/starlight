import { useNavigate } from 'react-router-dom';
import { useAgentStore } from '../../stores/agent-store.js';
import { useNow, countdown } from './useNow.js';

export function ApprovalCard(): JSX.Element | null {
  const approval = useAgentStore((s) => s.state?.approval ?? null);
  const respond = useAgentStore((s) => s.respond);
  const navigate = useNavigate();
  const now = useNow();
  if (!approval) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div role="alertdialog" aria-label="Agent attach request" className="w-[440px] max-w-[90vw] rounded-2xl border border-neon-cyan/40 bg-panel p-6 shadow-2xl animate-rise">
        <h2 className="text-base font-semibold text-ink">{`${approval.label} wants to attach to ${approval.game} — Allow?`}</h2>
        {approval.closesCeTable && (
          <p className="mt-2 text-[13px] text-neon-amber">This closes the current Cheat Engine table.</p>
        )}
        <p className="mt-2 text-xs text-muted">Asking again in {countdown(approval.expiresAt - now)}</p>
        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={() => void respond(false)}
            className="rounded-lg px-4 py-2 text-sm text-muted hover:bg-white/[0.06] hover:text-ink"
          >Deny</button>
          <button
            type="button"
            onClick={() => { void respond(true); navigate('/agent'); }}
            className="rounded-lg bg-neon-cyan px-4 py-2 text-sm font-semibold text-bg hover:brightness-110"
          >Allow</button>
        </div>
      </div>
    </div>
  );
}
