import { useState, useEffect } from 'react';
import { PageHeader } from '../components/PageHeader.js';
import { useConfigStore } from '../stores/config-store.js';

export function SettingsRoute(): JSX.Element {
  const config = useConfigStore((s) => s.config);
  const update = useConfigStore((s) => s.update);
  const [pollDraft, setPollDraft] = useState<string>(String(config?.preferences.pollIntervalMs ?? 2000));

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

  async function toggleRefresh(): Promise<void> {
    await update({ preferences: { catalogRefreshOnLaunch: !config!.preferences.catalogRefreshOnLaunch } });
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
      </div>

      <div className="mt-8 pt-6 border-t border-line max-w-[480px]">
        <h2 className="text-[10px] tracking-wider uppercase text-muted mb-2">Attributions</h2>
        <div className="text-xs text-muted leading-relaxed">
          Starlight uses{' '}
          <a href="https://github.com/cheat-engine/cheat-engine" target="_blank" rel="noreferrer"
             className="text-neon-cyan hover:underline">Cheat Engine</a>{' '}
          as its trainer engine. Cheat Engine is licensed under the{' '}
          <a href="https://www.gnu.org/licenses/gpl-2.0.html" target="_blank" rel="noreferrer"
             className="text-neon-cyan hover:underline">GNU General Public License v2</a>.
          The Linux build downloaded by Starlight is unmodified from upstream; sources are available at
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
