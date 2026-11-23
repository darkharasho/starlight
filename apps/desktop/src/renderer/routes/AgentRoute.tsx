import { useEffect } from 'react';
import { Link } from 'react-router-dom';
import { useAgentStore } from '../stores/agent-store.js';
import { useConfigStore } from '../stores/config-store.js';
import { DEFAULT_AGENT_PREFS } from '../../shared/ipc.js';
import { QuestionCard } from '../components/agent/QuestionCard.js';
import { ActivityList } from '../components/agent/ActivityList.js';
import { useNow } from '../components/agent/useNow.js';

export function AgentRoute(): JSX.Element {
  const state = useAgentStore((s) => s.state);
  const setCanModify = useAgentStore((s) => s.setCanModify);
  const stop = useAgentStore((s) => s.stop);
  const prefs = useConfigStore((s) => s.config?.agent) ?? DEFAULT_AGENT_PREFS;
  const now = useNow();
  useEffect(() => { void useAgentStore.getState().load(); }, []);

  if (!state || state.status === 'idle') {
    return (
      <div className="mx-auto flex max-w-[760px] flex-col items-center gap-2 pt-24 text-center">
        <h1 className="text-lg font-semibold text-ink">No agent attached</h1>
        <p className="text-sm text-muted">Connect Claude Code or Codex in Settings, then ask it to find a cheat.</p>
        <Link to="/settings" className="mt-2 text-sm text-neon-cyan hover:underline">Settings</Link>
      </div>
    );
  }

  const live = state.live;
  const liveItems: string[] = [
    ...live.freezes.map((f) => `${f.where ?? f.address} = ${f.value}`),
    ...live.tests.map((t) => t.name),
    ...live.watches.map((w) => `watching ${w.address} (${w.kind}) ${Math.max(0, Math.ceil((w.endsAt - now) / 1000))}s`),
    ...(live.speed !== 1 ? [`${live.speed}×`] : []),
  ];

  return (
    <div className="mx-auto flex max-w-[760px] flex-col gap-4 pt-4">
      <header className="flex items-center gap-4 rounded-xl bg-panel px-5 py-4">
        <div className="min-w-0 flex-1">
          <div className="truncate text-base font-semibold text-ink">{state.game?.name ?? 'Waiting for approval'}</div>
          <div className="text-xs text-muted">{state.client?.label ?? 'Agent'}</div>
        </div>
        <label className="flex items-center gap-2 text-sm text-ink">
          <button
            type="button"
            role="switch"
            aria-checked={state.canModify}
            aria-label="Agent can modify the game"
            onClick={() => void setCanModify(!state.canModify)}
            className={`relative h-5 w-9 rounded-full transition-colors ${state.canModify ? 'bg-neon-cyan' : 'bg-white/15'}`}
          >
            <span className={`absolute top-0.5 size-4 rounded-full bg-white transition-all ${state.canModify ? 'left-[18px]' : 'left-0.5'}`} />
          </button>
          <span aria-hidden="true">Agent can modify the game</span>
        </label>
        <button
          type="button"
          onClick={() => void stop()}
          className="rounded-lg border border-neon-pink/50 px-3 py-1.5 text-sm text-neon-pink hover:bg-neon-pink/10"
        >Stop <span className="ml-1 text-xs opacity-70">{prefs.stop}</span></button>
      </header>

      {state.questions[0] && (
        <QuestionCard question={state.questions[0]} yesKey={prefs.confirmYes} noKey={prefs.confirmNo} />
      )}

      <section aria-label="Live" className="rounded-xl bg-panel px-5 py-3">
        <h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted">Live</h2>
        {liveItems.length === 0
          ? <p className="text-sm text-muted">Nothing active.</p>
          : <div className="flex flex-wrap gap-2">
              {liveItems.map((t, i) => (
                <span key={i} className="rounded-full border border-neon-cyan/40 bg-neon-cyan/[0.06] px-3 py-1 text-xs text-neon-cyan">{t}</span>
              ))}
            </div>}
      </section>

      <section aria-label="Activity">
        <h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted">Activity</h2>
        <ActivityList entries={state.activity} />
      </section>
    </div>
  );
}
