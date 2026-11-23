import { useCallback, useEffect, useRef, useState } from 'react';
import { starlight } from '../../ipc-client.js';
import { useConfigStore } from '../../stores/config-store.js';
import { DEFAULT_AGENT_PREFS, type AgentConnectInfo } from '../../../shared/ipc.js';

type Tab = 'claude' | 'codex';

export function ConnectAgentCard(): JSX.Element {
  const config = useConfigStore((s) => s.config);
  const update = useConfigStore((s) => s.update);
  const agent = config?.agent ?? DEFAULT_AGENT_PREFS;
  const [info, setInfo] = useState<AgentConnectInfo | null>(null);
  const [tab, setTab] = useState<Tab>('claude');
  const [copied, setCopied] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [failed, setFailed] = useState(false);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refresh = useCallback(async () => {
    try {
      setInfo(await starlight().agentConnectInfo());
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, []);

  // Refetch when the switch or port changes: the server restarts and the command with it.
  useEffect(() => { void refresh(); }, [refresh, agent.enabled, agent.port]);
  useEffect(() => () => { if (copyTimer.current) clearTimeout(copyTimer.current); }, []);

  const text = info ? (tab === 'claude' ? info.claudeCommand : info.codexConfig) : '';

  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      return;
    }
    setCopied(true);
    if (copyTimer.current) clearTimeout(copyTimer.current);
    copyTimer.current = setTimeout(() => setCopied(false), 1500);
  }

  async function regenerate(): Promise<void> {
    setConfirming(false);
    try {
      setInfo(await starlight().agentRotateToken());
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }

  const tabClass = (active: boolean): string =>
    `px-3 py-1 text-xs rounded-full border ${active ? 'border-neon-cyan text-neon-cyan bg-neon-cyan/10' : 'border-line text-muted hover:text-ink'}`;
  const buttonClass = 'shrink-0 px-3 py-1.5 text-xs rounded-sm border border-line text-muted hover:border-neon-cyan hover:text-neon-cyan';

  return (
    <section className="rounded-lg bg-panel border border-line p-4 flex flex-col gap-3 animate-rise">
      <div>
        <h2 className="text-sm text-ink">Connect an agent</h2>
        <p className="text-xs text-muted mt-1">
          Let Claude Code or Codex find cheats with you. The agent can only touch a game after you allow it here in Starlight.
        </p>
      </div>

      <label className="flex items-center justify-between gap-3 text-xs">
        <span className="text-ink">Allow agents to connect</span>
        <input
          aria-label="Allow agents to connect"
          type="checkbox"
          checked={agent.enabled}
          onChange={() => void update({ agent: { enabled: !agent.enabled } })}
          className="accent-neon-cyan size-4"
        />
      </label>

      {!agent.enabled ? (
        <div className="text-xs text-muted">Agents can't connect while this is off.</div>
      ) : failed && !info ? (
        <div className="text-xs text-muted">Couldn't read the connection details.</div>
      ) : info ? (
        <>
          <div role="tablist" className="flex gap-2">
            <button type="button" role="tab" aria-selected={tab === 'claude'} className={tabClass(tab === 'claude')}
              onClick={() => setTab('claude')}>Claude Code</button>
            <button type="button" role="tab" aria-selected={tab === 'codex'} className={tabClass(tab === 'codex')}
              onClick={() => setTab('codex')}>Codex</button>
          </div>
          <pre className="font-mono text-[11px] text-ink bg-bg/60 border border-line rounded-sm p-3 whitespace-pre-wrap break-all select-all">{text}</pre>
          {info.portIsFallback && (
            <div className="text-xs text-muted">
              {`Port ${agent.port} was busy, so Starlight is using ${info.port} for now. Copy the command again if you set it up before.`}
            </div>
          )}
          <div className="flex items-center gap-2">
            <button type="button" onClick={() => void copy()} className={buttonClass}>{copied ? 'Copied' : 'Copy'}</button>
            {confirming ? (
              <>
                <span className="text-xs text-muted">Agents you've already connected will need the new command. Continue?</span>
                <button type="button" onClick={() => void regenerate()} className={buttonClass}>Continue</button>
                <button type="button" onClick={() => setConfirming(false)} className={buttonClass}>Cancel</button>
              </>
            ) : (
              <button type="button" onClick={() => setConfirming(true)} className={buttonClass}>Regenerate token</button>
            )}
          </div>
        </>
      ) : null}
    </section>
  );
}
