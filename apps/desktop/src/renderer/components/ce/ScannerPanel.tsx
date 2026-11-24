import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { useScannerStore, type FirstScanOp, type NextScanOp } from '../../stores/scanner-store.js';
import type { ScanValueType } from '../../../shared/ipc.js';

const VALUE_TYPES: { value: ScanValueType; label: string }[] = [
  { value: 'i32', label: 'Whole number (4 bytes)' },
  { value: 'f32', label: 'Decimal (float)' },
  { value: 'f64', label: 'Decimal (double)' },
  { value: 'i64', label: 'Whole number (8 bytes)' },
  { value: 'i16', label: 'Whole number (2 bytes)' },
  { value: 'i8',  label: 'Whole number (1 byte)' },
];

const FIRST_OPS: { value: FirstScanOp; label: string; needsValue: boolean }[] = [
  { value: 'exact',   label: 'Exact value',           needsValue: true },
  { value: 'bigger',  label: 'Bigger than',           needsValue: true },
  { value: 'smaller', label: 'Smaller than',          needsValue: true },
  { value: 'unknown', label: 'Unknown starting value', needsValue: false },
];

const NEXT_OPS: { value: NextScanOp; label: string; needsValue: boolean }[] = [
  { value: 'exact',     label: 'Exact value',  needsValue: true },
  { value: 'increased', label: 'Increased',    needsValue: false },
  { value: 'decreased', label: 'Decreased',    needsValue: false },
  { value: 'changed',   label: 'Changed',      needsValue: false },
  { value: 'unchanged', label: 'Unchanged',    needsValue: false },
  { value: 'bigger',    label: 'Bigger than',  needsValue: true },
  { value: 'smaller',   label: 'Smaller than', needsValue: true },
];

const field = 'bg-panel border border-line rounded-sm px-2 py-1 text-[11px] text-ink focus:outline-none focus:border-neon-cyan';
const primary = 'px-3 py-1 text-[11px] rounded-sm border border-neon-cyan text-neon-cyan glow-cyan hover:bg-neon-cyan/[0.08] disabled:opacity-40 disabled:hover:bg-transparent';
const quiet = 'px-3 py-1 text-[11px] rounded-sm border border-line text-muted hover:border-neon-cyan hover:text-neon-cyan disabled:opacity-40';

/**
 * Table-free cheating: find a value you can see in the game (gold, HP, ammo),
 * narrow the candidates as it changes, then edit or freeze it. Works on any
 * attached game.
 */
export function ScannerPanel(): JSX.Element {
  const s = useScannerStore();
  const [firstOp, setFirstOp] = useState<FirstScanOp>('exact');
  const [nextOp, setNextOp] = useState<NextScanOp>('exact');
  const [value, setValue] = useState('');

  // Keep the shown values live while this panel is open.
  useEffect(() => {
    const t = setInterval(() => { void useScannerStore.getState().refreshValues(); }, 1000);
    return () => clearInterval(t);
  }, []);

  const ops = s.started ? NEXT_OPS : FIRST_OPS;
  const op = s.started ? nextOp : firstOp;
  const needsValue = ops.find((o) => o.value === op)?.needsValue ?? true;
  const canScan = !s.busy && (!needsValue || value.trim() !== '');

  function runScan(): void {
    if (!canScan) return;
    if (s.started) void s.nextScan(nextOp, value.trim());
    else void s.firstScan(firstOp, value.trim());
  }

  return (
    <div className="flex flex-col gap-3 min-h-0 flex-1">
      <div className="text-[11px] text-muted leading-relaxed">
        Search for a number you can see in the game, change it in the game, then search again to narrow it down.
        When only a few results are left, keep one and edit or freeze it.
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <select aria-label="Value type" value={s.valueType} disabled={s.started || s.busy}
                onChange={(e) => s.setValueType(e.target.value as ScanValueType)} className={field}>
          {VALUE_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
        </select>
        <select aria-label="Scan type" value={op} disabled={s.busy}
                onChange={(e) => (s.started ? setNextOp(e.target.value as NextScanOp) : setFirstOp(e.target.value as FirstScanOp))}
                className={field}>
          {ops.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        <input aria-label="Value to search for" value={value} disabled={!needsValue || s.busy}
               onChange={(e) => setValue(e.target.value)}
               onKeyDown={(e) => { if (e.key === 'Enter') runScan(); }}
               placeholder={needsValue ? 'Value' : '—'} inputMode="decimal"
               className={`${field} w-32 font-mono disabled:opacity-40`} />
        <button type="button" disabled={!canScan} onClick={runScan} className={primary}>
          {s.busy ? 'Scanning…' : s.started ? 'Next scan' : 'First scan'}
        </button>
        {s.started && (
          <button type="button" disabled={s.busy} onClick={() => void s.newScan()} className={quiet}>New scan</button>
        )}
        {s.started && !s.busy && (
          <span className="text-[11px] text-muted ml-auto">
            {s.count.toLocaleString()} {s.count === 1 ? 'result' : 'results'}
            {s.count > s.results.length ? ` · showing first ${s.results.length}` : ''}
          </span>
        )}
      </div>

      {s.error && (
        <div role="alert" className="px-3 py-2 rounded-sm border border-neon-pink/40 bg-neon-pink/[0.06] text-[11px] text-neon-pink">
          {s.error}
        </div>
      )}

      <div className="grid grid-cols-2 gap-3 flex-1 min-h-0">
        <section className="flex flex-col min-h-0">
          <div className="text-[9px] tracking-wider uppercase text-muted pb-1.5">Results</div>
          <div className="flex-1 min-h-0 overflow-y-auto flex flex-col gap-1">
            {s.results.length === 0 && (
              <div className="text-[11px] text-muted px-1">
                {s.busy ? 'Scanning the game’s memory…' : s.started ? 'No addresses match.' : 'Run a first scan to begin.'}
              </div>
            )}
            {s.results.map((r) => {
              const kept = s.saved.some((x) => x.address === r.address);
              return (
                <div key={r.address} className="flex items-center gap-2 px-2 py-1 rounded-sm border border-line bg-panel text-[11px]">
                  <span className="font-mono text-muted">{r.address}</span>
                  <span className="font-mono flex-1 truncate">{r.value}</span>
                  <button type="button" disabled={kept} onClick={() => s.save(r)}
                          aria-label={`Keep address ${r.address}`}
                          className="px-2 py-0.5 rounded-sm border border-line text-muted hover:border-neon-cyan hover:text-neon-cyan disabled:opacity-40">
                    {kept ? 'Kept' : 'Keep'}
                  </button>
                </div>
              );
            })}
          </div>
        </section>

        <section className="flex flex-col min-h-0">
          <div className="text-[9px] tracking-wider uppercase text-muted pb-1.5">Kept addresses</div>
          <div className="flex-1 min-h-0 overflow-y-auto flex flex-col gap-1">
            {s.saved.length === 0 && (
              <div className="text-[11px] text-muted px-1">Addresses you keep appear here to edit or freeze.</div>
            )}
            {s.saved.map((a) => <SavedRow key={a.address} address={a.address} />)}
          </div>
        </section>
      </div>
    </div>
  );
}

function SavedRow({ address }: { address: string }): JSX.Element | null {
  const entry = useScannerStore((s) => s.saved.find((x) => x.address === address));
  const [draft, setDraft] = useState<string | null>(null);
  if (!entry) return null;
  const st = useScannerStore.getState();

  function commit(): void {
    if (draft === null) return;
    const v = draft.trim();
    setDraft(null);
    if (v !== '' && v !== entry!.value) void st.write(address, v);
  }

  return (
    <div className={`flex items-center gap-2 px-2 py-1 rounded-sm border bg-panel text-[11px] ${entry.frozen ? 'border-neon-cyan/60' : 'border-line'}`}>
      <input aria-label={`Name for ${address}`} value={entry.label} placeholder={address}
             onChange={(e) => st.rename(address, e.target.value)}
             className="flex-1 min-w-0 bg-transparent text-ink placeholder:text-muted placeholder:font-mono focus:outline-none" />
      <input aria-label={`Value at ${address}`} value={draft ?? entry.value}
             onChange={(e) => setDraft(e.target.value)}
             onBlur={commit}
             onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') setDraft(null); }}
             className="w-24 bg-bg border border-line rounded-sm px-1.5 py-0.5 font-mono text-ink focus:outline-none focus:border-neon-cyan" />
      <button type="button" aria-pressed={entry.frozen} onClick={() => void st.setFrozen(address, !entry.frozen)}
              title="Hold this value so the game can't change it"
              className={`px-2 py-0.5 rounded-sm border ${entry.frozen ? 'border-neon-cyan text-neon-cyan glow-cyan' : 'border-line text-muted hover:border-neon-cyan hover:text-neon-cyan'}`}>
        {entry.frozen ? 'Frozen' : 'Freeze'}
      </button>
      <button type="button" aria-label={`Remove ${entry.label || address}`} onClick={() => void st.remove(address)}
              className="px-1.5 py-0.5 rounded-sm border border-line text-muted hover:border-neon-pink hover:text-neon-pink"><X aria-hidden="true" className="size-3" /></button>
    </div>
  );
}
