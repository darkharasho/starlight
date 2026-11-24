import { useState, useEffect } from 'react';
import { PageHeader } from '../components/PageHeader.js';
import { useConfigStore } from '../stores/config-store.js';
import { useUpdateStore } from '../stores/update-store.js';
import { updateStatusText } from '../lib/update-view.js';
import { ConnectAgentCard } from '../components/settings/ConnectAgentCard.js';
import { HotkeyCapture } from '../components/HotkeyCapture.js';
import { DEFAULT_AGENT_PREFS } from '../../shared/ipc.js';

export function SettingsRoute(): JSX.Element {
  const config = useConfigStore((s) => s.config);
  const update = useConfigStore((s) => s.update);
  const [pollDraft, setPollDraft] = useState<string>(String(config?.preferences.pollIntervalMs ?? 2000));

  const askTimeout = config?.agent?.askTimeoutSec ?? DEFAULT_AGENT_PREFS.askTimeoutSec;
  const [askDraft, setAskDraft] = useState<string>(String(askTimeout));
  useEffect(() => { setAskDraft(String(askTimeout)); }, [askTimeout]);

  useEffect(() => {
    if (config) setPollDraft(String(config.preferences.pollIntervalMs));
  }, [config?.preferences.pollIntervalMs]);

  if (!config) {
    return (
      <>
        <PageHeader title="Settings" />
        <div className="text-xs text-muted">Loading…</div>
      </>
    );
  }

  async function commitPoll(): Promise<void> {
    const n = Number(pollDraft);
    if (!Number.isFinite(n) || n < 500 || n > 30000) {
      setPollDraft(String(config!.preferences.pollIntervalMs));
      return;
    }
    if (n === config!.preferences.pollIntervalMs) return;
    await update({ preferences: { pollIntervalMs: n } });
  }

  async function commitAsk(): Promise<void> {
    const n = Number(askDraft);
    if (!Number.isInteger(n) || n < 10 || n > 3600) {
      setAskDraft(String(askTimeout));
      return;
    }
    if (n === askTimeout) return;
    await update({ agent: { askTimeoutSec: n } });
  }

  async function toggleRefresh(): Promise<void> {
    await update({ preferences: { catalogRefreshOnLaunch: !config!.preferences.catalogRefreshOnLaunch } });
  }

  async function toggleAutoAttach(): Promise<void> {
    await update({ preferences: { autoAttachOnDetect: !config!.preferences.autoAttachOnDetect } });
  }

  return (
    <>
      <PageHeader title="Settings" />
      <div className="flex flex-col gap-4 max-w-[480px]">
        <label className="flex items-center justify-between gap-3 text-xs">
          <span>
            <div className="text-ink">Process poll interval</div>
            <div className="text-[10px] text-muted">How often Starlight scans for running games (500–30000 ms)</div>
          </span>
          <input
            aria-label="Poll interval (ms)"
            type="number"
            min={500}
            max={30000}
            step={100}
            value={pollDraft}
            onChange={(e) => setPollDraft(e.target.value)}
            onBlur={() => void commitPoll()}
            className="w-24 px-2 py-1.5 text-xs rounded-sm bg-panel border border-line text-ink"
          />
        </label>
        <label className="flex items-center justify-between gap-3 text-xs">
          <span>
            <div className="text-ink">Refresh catalog on launch</div>
            <div className="text-[10px] text-muted">If off, Starlight uses the cached catalog and only refreshes when you click Refresh in Browse</div>
          </span>
          <input
            aria-label="Refresh catalog on launch"
            type="checkbox"
            checked={config.preferences.catalogRefreshOnLaunch}
            onChange={() => void toggleRefresh()}
            className="accent-neon-cyan size-4"
          />
        </label>
        <label className="flex items-center justify-between gap-3 text-xs">
          <span>
            <div className="text-ink">Auto-attach on game detect</div>
            <div className="text-[10px] text-muted">Auto-attach when a game is detected (skips the "Latch" click)</div>
          </span>
          <input
            aria-label="Auto-attach when a game is detected"
            type="checkbox"
            checked={config.preferences.autoAttachOnDetect}
            onChange={() => void toggleAutoAttach()}
            className="accent-neon-cyan size-4"
          />
        </label>
        <label className="flex items-center justify-between gap-3 text-xs">
          <span>
            <div className="text-ink">Run tables on Starlight's engine when possible</div>
            <div className="text-[10px] text-muted">Off sends every table to Cheat Engine.</div>
          </span>
          <input
            aria-label="Run tables on Starlight's engine when possible"
            type="checkbox"
            checked={config.preferences.nativeTables !== false}
            onChange={() => void update({ preferences: { nativeTables: config.preferences.nativeTables === false } })}
            className="accent-neon-cyan size-4"
          />
        </label>
        <label className="flex items-center justify-between gap-3 text-xs">
          <span>
            <div className="text-ink">In-game cheat hotkeys</div>
            <div className="text-[10px] text-muted">Switch cheats on and off from inside the game. The first cheats get numpad keys; change any of them on the cheat itself</div>
          </span>
          <input
            aria-label="In-game cheat hotkeys"
            type="checkbox"
            checked={config.preferences.cheatHotkeys !== false}
            onChange={() => void update({ preferences: { cheatHotkeys: config.preferences.cheatHotkeys === false } })}
            className="accent-neon-cyan size-4"
          />
        </label>
      </div>

      <div className="mt-8 pt-6 border-t border-line max-w-[480px] flex flex-col gap-4">
        <ConnectAgentCard />
        {([
          ['Answer yes', 'confirmYes'],
          ['Answer no', 'confirmNo'],
          ['Stop the agent', 'stop'],
        ] as const).map(([label, key]) => (
          <div key={key} className="flex items-center justify-between gap-3 text-xs">
            <span className="text-ink">{label}</span>
            <HotkeyCapture
              value={(config.agent ?? DEFAULT_AGENT_PREFS)[key]}
              onCapture={(accel) => void update({ agent: { [key]: accel } })}
              onReset={() => void update({ agent: { [key]: DEFAULT_AGENT_PREFS[key] } })}
            />
          </div>
        ))}
        <label className="flex items-center justify-between gap-3 text-xs">
          <span>
            <div className="text-ink">Question timeout</div>
            <div className="text-[10px] text-muted">How long the agent waits for your answer (10–3600 seconds)</div>
          </span>
          <input
            aria-label="Question timeout (seconds)"
            type="number"
            min={10}
            max={3600}
            step={10}
            value={askDraft}
            onChange={(e) => setAskDraft(e.target.value)}
            onBlur={() => void commitAsk()}
            className="w-24 px-2 py-1.5 text-xs rounded-sm bg-panel border border-line text-ink"
          />
        </label>
      </div>

      <UpdatesSection />

      <div className="mt-8 pt-6 border-t border-line max-w-[480px]">
        <h2 className="text-[10px] tracking-wider uppercase text-muted mb-2">Attributions</h2>
        <div className="text-xs text-muted leading-relaxed">
          Starlight uses{' '}
          <a href="https://github.com/cheat-engine/cheat-engine" target="_blank" rel="noreferrer"
             className="text-neon-cyan hover:underline">Cheat Engine</a>{' '}
          as its trainer engine. Cheat Engine is licensed under the{' '}
          <a href="https://www.gnu.org/licenses/gpl-2.0.html" target="_blank" rel="noreferrer"
             className="text-neon-cyan hover:underline">GNU General Public License v2</a>.
          The Windows build Starlight downloads is unmodified from upstream. For native Linux games it
          also uses ceserver, built from the Cheat Engine source with a small patch (the patch and build
          script are in the runtimes repository below). Sources are available at
          <a href="https://github.com/cheat-engine/cheat-engine" target="_blank" rel="noreferrer"
             className="text-neon-cyan hover:underline"> github.com/cheat-engine/cheat-engine</a>.
        </div>
        <div className="text-[10px] text-muted/80 mt-3">
          Runtime tarballs hosted at{' '}
          <a href="https://github.com/darkharasho/starlight-runtimes" target="_blank" rel="noreferrer"
             className="hover:text-neon-cyan">github.com/darkharasho/starlight-runtimes</a>.
        </div>
      </div>
    </>
  );
}

function UpdatesSection(): JSX.Element {
  const { state, version, asked, result, check, restart } = useUpdateStore();
  const status = updateStatusText(state, asked, result);
  const checking = asked && (result === null || state.status === 'checking');
  return (
    <div className="mt-8 pt-6 border-t border-line max-w-[480px]">
      <h2 className="text-[10px] tracking-wider uppercase text-muted mb-2">Updates</h2>
      <div className="flex items-center justify-between gap-3 text-xs">
        <span>
          <div className="text-ink">Starlight {version ? `v${version}` : ''}</div>
          <div className="text-[10px] text-muted" role="status">
            {status ?? 'Starlight checks for updates on launch and installs them when you quit.'}
          </div>
        </span>
        {state.status === 'downloaded' ? (
          <button type="button" onClick={() => void restart()}
            className="shrink-0 px-3 py-1.5 text-xs rounded-sm border border-neon-cyan text-neon-cyan hover:bg-neon-cyan/10">
            Restart to update
          </button>
        ) : (
          <button type="button" onClick={() => void check()} disabled={checking || state.status === 'downloading'}
            className="shrink-0 px-3 py-1.5 text-xs rounded-sm border border-line text-muted hover:border-neon-cyan hover:text-neon-cyan disabled:opacity-50 disabled:pointer-events-none">
            Check for updates
          </button>
        )}
      </div>
    </div>
  );
}
