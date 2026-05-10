import { useEffect, useMemo, useState } from 'react';
import { useLatchState } from '../stores/latch-store.js';
import { useTrainerStore } from '../stores/trainer-store.js';
import { useProcessStore, attachProcessEvents } from '../stores/process-store.js';
import { useConfigStore } from '../stores/config-store.js';
import { findConflict, resolveCheatHotkeys } from '../lib/accelerator.js';
import type { StarlightCheat, StarlightSupportedCheat, StarlightTrainer } from '../../shared/ipc.js';
import { ToggleCheatCard } from '../components/cheat-cards/ToggleCheatCard.js';
import { ValueCheatCard } from '../components/cheat-cards/ValueCheatCard.js';
import { UnsupportedCheatCard } from '../components/cheat-cards/UnsupportedCheatCard.js';

function isSupported(c: StarlightCheat): c is StarlightSupportedCheat {
  return !('unsupported' in c) || c.unsupported !== true;
}

function ErrorBanner({ message }: { message: string }): JSX.Element {
  const isPermission = /ptrace|permission|EPERM/i.test(message);
  return (
    <div className="text-xs text-neon-pink border border-neon-pink/40 bg-neon-pink/[0.06] rounded-sm px-3 py-2">
      <div className="font-semibold mb-1">{isPermission ? 'Permission denied' : 'Error'}</div>
      <div>{message}</div>
      {isPermission && (
        <div className="mt-2 text-muted">
          On Linux, lower the ptrace scope:{' '}
          <code className="text-neon-cyan font-mono">sudo sysctl kernel.yama.ptrace_scope=0</code>
        </div>
      )}
    </div>
  );
}

export function ActiveTrainerRoute(): JSX.Element {
  useEffect(() => { attachProcessEvents(); }, []);

  const trainer = useTrainerStore((s) => s.trainer);
  const activeCheats = useTrainerStore((s) => s.activeCheats);
  const values = useTrainerStore((s) => s.values);
  const trainerError = useTrainerStore((s) => s.error);
  const toggleCheat = useTrainerStore((s) => s.toggleCheat);
  const setCheatValue = useTrainerStore((s) => s.setCheatValue);
  const setProcessName = useTrainerStore((s) => s.setProcessName);
  const rebindHotkey = useTrainerStore((s) => s.rebindHotkey);

  const config = useConfigStore((s) => s.config);

  const latchState = useLatchState((s) => s.state);
  const latchError = useLatchState((s) => s.error);
  const pidInput = useLatchState((s) => s.pidInput);
  const setPidInput = useLatchState((s) => s.setPidInput);
  const latch = useLatchState((s) => s.latch);
  const detach = useLatchState((s) => s.detach);

  const processes = useProcessStore((s) => s.processes);
  const matchedPid = useProcessStore((s) => s.matchedPid);

  const [hotkeyErrors, setHotkeyErrors] = useState<Record<string, { toggle?: string; inc?: string; dec?: string }>>({});

  const overrides = config && trainer ? (config.hotkeyOverrides[trainer.id] ?? {}) : {};
  const allCheats = trainer ? trainer.categories.flatMap(c => c.cheats.filter((x): x is StarlightSupportedCheat => isSupported(x))) : [];

  async function handleRebind(cheatId: string, slot: 'toggle' | 'inc' | 'dec', accel: string): Promise<void> {
    const conflict = findConflict(allCheats, overrides, cheatId, slot, accel);
    if (conflict) {
      setHotkeyErrors((e) => ({ ...e, [cheatId]: { ...e[cheatId], [slot]: `Conflicts with ${conflict.cheatId} (${conflict.slot})` } }));
      return;
    }
    const r = await rebindHotkey(cheatId, slot, accel);
    if (!r.ok) {
      setHotkeyErrors((e) => ({ ...e, [cheatId]: { ...e[cheatId], [slot]: r.error ?? 'failed' } }));
    } else {
      setHotkeyErrors((e) => {
        const next = { ...(e[cheatId] ?? {}) };
        delete next[slot];
        return { ...e, [cheatId]: next };
      });
    }
  }

  async function handleReset(cheatId: string, slot: 'toggle' | 'inc' | 'dec'): Promise<void> {
    const r = await rebindHotkey(cheatId, slot, null);
    if (!r.ok) {
      setHotkeyErrors((e) => ({ ...e, [cheatId]: { ...e[cheatId], [slot]: r.error ?? 'failed' } }));
    } else {
      setHotkeyErrors((e) => {
        const next = { ...(e[cheatId] ?? {}) };
        delete next[slot];
        return { ...e, [cheatId]: next };
      });
    }
  }

  if (!trainer) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-muted">
        <p className="text-sm">No trainer loaded.</p>
        <p className="text-xs mt-2">Go to Home and click "Load Trainer (.CT)".</p>
      </div>
    );
  }

  return (
    <TrainerView
      trainer={trainer}
      activeCheats={activeCheats}
      values={values}
      trainerError={trainerError}
      toggleCheat={toggleCheat}
      setCheatValue={setCheatValue}
      setProcessName={setProcessName}
      latchState={latchState}
      latchError={latchError}
      pidInput={pidInput}
      setPidInput={setPidInput}
      latch={latch}
      detach={detach}
      processes={processes}
      matchedPid={matchedPid}
      overrides={overrides}
      hotkeyErrors={hotkeyErrors}
      handleRebind={handleRebind}
      handleReset={handleReset}
    />
  );
}

interface TrainerViewProps {
  trainer: StarlightTrainer;
  activeCheats: Record<string, boolean>;
  values: Record<string, number>;
  trainerError: string | null;
  toggleCheat: (cheatId: string, on: boolean) => Promise<void>;
  setCheatValue: (cheatId: string, value: number) => Promise<void>;
  setProcessName: (names: string[]) => Promise<void>;
  latchState: string;
  latchError: string | null;
  pidInput: string;
  setPidInput: (s: string) => void;
  latch: () => Promise<void>;
  detach: () => Promise<void>;
  processes: { pid: number; name: string }[];
  matchedPid: number | null;
  overrides: Record<string, { toggle?: string | null; inc?: string | null; dec?: string | null }>;
  hotkeyErrors: Record<string, { toggle?: string; inc?: string; dec?: string }>;
  handleRebind: (cheatId: string, slot: 'toggle' | 'inc' | 'dec', accel: string) => Promise<void>;
  handleReset: (cheatId: string, slot: 'toggle' | 'inc' | 'dec') => Promise<void>;
}

function TrainerView({
  trainer,
  activeCheats,
  values,
  trainerError,
  toggleCheat,
  setCheatValue,
  setProcessName,
  latchState,
  latchError,
  pidInput,
  setPidInput,
  latch,
  detach,
  processes,
  matchedPid,
  overrides,
  hotkeyErrors,
  handleRebind,
  handleReset,
}: TrainerViewProps): JSX.Element {
  const [activeCategory, setActiveCategory] = useState<string>(trainer.categories[0]!.name);
  const category = trainer.categories.find((c) => c.name === activeCategory) ?? trainer.categories[0]!;
  const activeCount = category.cheats.filter((c) => activeCheats[c.id]).length;
  const totalCheats = trainer.categories.reduce((acc, c) => acc + c.cheats.length, 0);
  const supportedCount = trainer.categories.reduce(
    (acc, c) => acc + c.cheats.filter((x) => isSupported(x)).length, 0);

  return (
    <div className="flex flex-col h-full gap-3">
      <div className="flex items-center gap-3 -mt-2">
        <div>
          <div className="text-[13px] font-semibold">{trainer.game.name}</div>
          <div className="text-[10px] text-muted">trainer by {trainer.metadata.author ?? 'unknown'}</div>
        </div>
        <div className="ml-auto flex items-center gap-2">
          {latchState !== 'latched' && (
            <>
              <ProcessPicker
                processes={processes}
                matchedPid={matchedPid}
                pidInput={pidInput}
                setPidInput={setPidInput}
              />
              <button
                type="button"
                onClick={() => void useProcessStore.getState().refresh()}
                title="Refresh process list"
                className="px-2 py-1.5 text-xs rounded-sm border border-line text-muted hover:border-neon-cyan hover:text-neon-cyan"
              >↻</button>
              <button
                type="button"
                onClick={() => void latch()}
                className="px-3 py-1.5 text-xs rounded-sm border border-neon-cyan text-neon-cyan glow-cyan hover:bg-neon-cyan/[0.08]"
              >
                Latch
              </button>
            </>
          )}
          {latchState === 'latched' && (
            <button
              type="button"
              onClick={() => void detach()}
              className="px-3 py-1.5 text-xs rounded-sm border border-line text-muted hover:border-neon-pink hover:text-neon-pink"
            >
              Detach
            </button>
          )}
        </div>
      </div>

      {(latchError || trainerError) && <ErrorBanner message={latchError ?? trainerError ?? ''} />}

      <TrainerInfoDisclosure trainer={trainer} setProcessName={setProcessName} />

      <div className="grid grid-cols-[200px_1fr] gap-4 flex-1 min-h-0">
      <aside className="flex flex-col gap-1">
        <div className="text-[9px] tracking-wider uppercase text-muted px-2 pb-1">Categories</div>
        {trainer.categories.map((c) => {
          const isActive = c.name === activeCategory;
          return (
            <button
              key={c.name}
              type="button"
              onClick={() => setActiveCategory(c.name)}
              className={`text-left px-3 py-2 text-xs rounded-sm border flex justify-between items-center ${isActive ? 'bg-neon-pink/[0.06] border-neon-pink text-neon-pink glow-pink' : 'border-transparent text-ink hover:bg-line/30'}`}
            >
              <span>{c.name}</span>
              <span className={`text-[10px] ${isActive ? 'text-neon-pink' : 'text-muted'}`}>{c.cheats.length}</span>
            </button>
          );
        })}
        <div className="mt-auto pt-2.5 px-2 text-[10px] text-muted border-t border-line leading-relaxed">
          {supportedCount} of {totalCheats} entries supported<br />
          {totalCheats - supportedCount} unsupported
        </div>
      </aside>

      <section className="flex flex-col gap-2 overflow-y-auto">
        <div className="flex items-baseline justify-between mb-1">
          <span className="text-[11px] text-muted">{category.cheats.length} cheats · {activeCount} active</span>
        </div>
        {category.cheats.map((c) => {
          if (!isSupported(c)) {
            return <UnsupportedCheatCard
              key={c.id}
              id={c.id}
              name={c.name}
              reason={c.unsupportedReason}
              {...(c.description !== undefined ? { description: c.description } : {})}
            />;
          }
          if (c.type === 'set') {
            return (
              <ValueCheatCard
                key={c.id}
                id={c.id}
                name={c.name}
                {...(c.description !== undefined ? { description: c.description } : {})}
                active={!!activeCheats[c.id]}
                value={values[c.id] ?? c.default ?? 0}
                step={c.step ?? 1}
                {...(c.min !== undefined ? { min: c.min } : {})}
                {...(c.max !== undefined ? { max: c.max } : {})}
                hotkeys={{
                  toggle: resolveCheatHotkeys(c, overrides[c.id]).toggle ?? null,
                  inc:    resolveCheatHotkeys(c, overrides[c.id]).inc ?? null,
                  dec:    resolveCheatHotkeys(c, overrides[c.id]).dec ?? null,
                }}
                {...(hotkeyErrors[c.id] ? { hotkeyErrors: hotkeyErrors[c.id]! } : {})}
                onToggle={(id, next) => void toggleCheat(id, next)}
                onValueChange={(id, v) => void setCheatValue(id, v)}
                onRebindHotkey={(slot, accel) => void handleRebind(c.id, slot, accel)}
                onResetHotkey={(slot) => void handleReset(c.id, slot)}
              />
            );
          }
          return (
            <ToggleCheatCard
              key={c.id}
              id={c.id}
              name={c.name}
              {...(c.description !== undefined ? { description: c.description } : {})}
              active={!!activeCheats[c.id]}
              hotkey={resolveCheatHotkeys(c, overrides[c.id]).toggle ?? null}
              {...(hotkeyErrors[c.id]?.toggle ? { hotkeyError: hotkeyErrors[c.id]!.toggle! } : {})}
              onToggle={(id, next) => void toggleCheat(id, next)}
              onRebindHotkey={(slot, accel) => void handleRebind(c.id, slot, accel)}
              onResetHotkey={(slot) => void handleReset(c.id, slot)}
            />
          );
        })}
      </section>
      </div>
    </div>
  );
}

function ProcessPicker({
  processes, matchedPid, pidInput, setPidInput,
}: {
  processes: { pid: number; name: string }[];
  matchedPid: number | null;
  pidInput: string;
  setPidInput: (s: string) => void;
}): JSX.Element {
  const sorted = useMemo(() => [...processes].sort((a, b) => a.name.localeCompare(b.name)), [processes]);
  const userTouched = pidInput !== '';
  const effectivePid = userTouched ? pidInput : (matchedPid != null ? String(matchedPid) : '');

  return (
    <div className="flex items-center gap-1.5">
      <label className="sr-only" htmlFor="process-picker">Process</label>
      <select
        id="process-picker"
        value={effectivePid}
        onChange={(e) => setPidInput(e.target.value)}
        className="w-44 px-2 py-1.5 text-xs rounded-sm bg-panel border border-line text-ink"
      >
        <option value="">— pick a process —</option>
        {sorted.map((p) => (
          <option key={p.pid} value={String(p.pid)}>{p.name} ({p.pid})</option>
        ))}
        {userTouched && !sorted.find(p => String(p.pid) === pidInput) && pidInput !== '' && (
          <option value={pidInput}>PID {pidInput} (manual)</option>
        )}
      </select>
      <input
        value={pidInput}
        onChange={(e) => setPidInput(e.target.value)}
        placeholder="or PID"
        className="w-16 px-2 py-1.5 text-xs rounded-sm bg-panel border border-line text-ink"
        aria-label="Manual PID"
      />
    </div>
  );
}

function TrainerInfoDisclosure({
  trainer, setProcessName,
}: {
  trainer: StarlightTrainer;
  setProcessName: (names: string[]) => Promise<void>;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(trainer.game.processName.join(', '));
  return (
    <div>
      <button type="button" onClick={() => setOpen(o => !o)}
              className="text-[10px] tracking-wider uppercase text-muted hover:text-ink">
        Trainer Info {open ? '▲' : '▼'}
      </button>
      {open && (
        <div className="mt-2 flex items-center gap-2">
          <label htmlFor="process-name-input" className="text-[10px] text-muted">Process name</label>
          <input
            id="process-name-input"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => {
              const names = draft.split(',').map(s => s.trim()).filter(Boolean);
              if (names.length > 0) void setProcessName(names);
            }}
            className="flex-1 px-2 py-1 text-xs rounded-sm bg-panel border border-line text-ink"
          />
        </div>
      )}
    </div>
  );
}
