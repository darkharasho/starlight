import { useEffect, useMemo, useState } from 'react';
import { ChevronLeft, RefreshCw } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useLatchState } from '../stores/latch-store.js';
import { useTrainerStore } from '../stores/trainer-store.js';
import { useProcessStore, attachProcessEvents } from '../stores/process-store.js';
import { useConfigStore } from '../stores/config-store.js';
import { useCeSessionStore } from '../stores/ce-session-store.js';
import { ConnectStage } from '../components/ce/ConnectStage.js';
import { useCover } from '../lib/use-cover.js';
import { findConflict, resolveCheatHotkeys } from '../lib/accelerator.js';
import type { StarlightCheat, StarlightSupportedCheat, StarlightTrainer } from '../../shared/ipc.js';
import { CeSessionView, gameCandidates } from '../components/ce/CeSessionView.js';
import { openToolsOnly, findCatalogEntry, attachRequestFor, showGameScreen } from '../lib/open-game.js';

export { gameCandidates };
import { ToggleCheatCard } from '../components/cheat-cards/ToggleCheatCard.js';
import { ValueCheatCard } from '../components/cheat-cards/ValueCheatCard.js';
import { isValueCheat, isPatchCheat } from '../lib/cheat-kind.js';
import { UnsupportedCheatCard } from '../components/cheat-cards/UnsupportedCheatCard.js';

function LuaHeavyBanner({ supported, total, sourceUrl }: { supported: number; total: number; sourceUrl?: string | undefined }): JSX.Element {
  const pct = total > 0 ? Math.round((supported / total) * 100) : 0;
  return (
    <div className="text-xs text-neon-cyan border border-neon-cyan/40 bg-neon-cyan/[0.06] rounded-sm px-3 py-2">
      <div className="font-semibold mb-1">Limited cheat support</div>
      <div className="text-muted">
        {supported}/{total} entries ({pct}%) have literal addresses Starlight can read directly. The rest rely on Cheat Engine&apos;s assembler-script and Lua runtime — entries appear here for navigation but won&apos;t toggle correctly.
      </div>
      {sourceUrl && (
        <div className="mt-2">
          <a href={sourceUrl} target="_blank" rel="noreferrer"
             className="underline hover:text-neon-pink">
            Open original thread on fearlessrevolution
          </a>{' '}
          <span className="text-muted">to use the full table in Cheat Engine.</span>
        </div>
      )}
    </div>
  );
}

/** The engine may not read the game yet: one click asks for the permission. */
function AllowAccessBanner({ message, allowing, onAllow }: { message: string; allowing: boolean; onAllow: () => Promise<void> }): JSX.Element {
  return (
    <div role="alert" className="text-xs text-ink border border-neon-cyan/40 bg-neon-cyan/[0.06] rounded-sm px-3 py-2">
      <div className="font-semibold mb-1">{message}</div>
      <div className="text-soft">
        Linux keeps programs from reading each other&apos;s memory. Allowing it once gives that permission to
        Starlight&apos;s memory reader only, and it stays allowed after a restart.
      </div>
      <button type="button" disabled={allowing} onClick={() => void onAllow()}
              className="mt-2 rounded-full px-3 py-1 text-xs font-semibold text-[#06231d] bg-neon-cyan hover:brightness-110 disabled:opacity-60 focus:outline-none focus-visible:ring-2 focus-visible:ring-neon-cyan/50">
        {allowing ? 'Waiting for your password…' : 'Allow'}
      </button>
    </div>
  );
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
  const navigate = useNavigate();

  const ceSessionId = useCeSessionStore((s) => s.sessionId);
  const ceStarting = useCeSessionStore((s) => s.starting);
  const ceStartError = useCeSessionStore((s) => s.startError);
  const ceStartReason = useCeSessionStore((s) => s.startReason);
  const ceAllowing = useCeSessionStore((s) => s.allowingAccess);
  const ceAllowAccess = useCeSessionStore((s) => s.allowMemoryAccess);
  const ceNotRunning = useCeSessionStore((s) => s.notRunning);
  const ceLastReq = useCeSessionStore((s) => s.lastReq);
  const ceStart = useCeSessionStore((s) => s.start);
  const ceTitle = useCeSessionStore((s) => s.title);
  const ceProgress = useCeSessionStore((s) => s.progress);

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
  const latchNeedsPermission = useLatchState((s) => s.needsPermission);
  const latchAllowing = useLatchState((s) => s.allowing);
  const latchAllowAccess = useLatchState((s) => s.allowAccess);
  const pidInput = useLatchState((s) => s.pidInput);
  const setPidInput = useLatchState((s) => s.setPidInput);
  const latch = useLatchState((s) => s.latch);
  const detach = useLatchState((s) => s.detach);

  const processes = useProcessStore((s) => s.processes);
  const matchedPid = useProcessStore((s) => s.matchedPid);

  const [hotkeyErrors, setHotkeyErrors] = useState<Record<string, { toggle?: string; inc?: string; dec?: string }>>({});

  const overrides = config && trainer ? (config.hotkeyOverrides[trainer.id] ?? {}) : {};
  const allCheats = trainer ? trainer.categories.flatMap(c => c.cheats.filter((x): x is StarlightSupportedCheat => isValueCheat(x))) : [];

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

  const running = gameCandidates(processes);

  /** Attach to a running process: with its tables if the catalog knows the game, else tools only. */
  async function attachRunning(p: { pid: number; name: string }): Promise<void> {
    const name = p.name.replace(/\.exe$/i, '');
    const target = { pid: p.pid, processName: p.name };
    const entry = findCatalogEntry({ id: '', name });
    const req = entry ? attachRequestFor(entry, target) : null;
    if (req) {
      await ceStart(req);
      showGameScreen(navigate);
      return;
    }
    await openToolsOnly({ name }, navigate, target);
  }
  const content: JSX.Element = ceSessionId ? (
    <CeSessionView processes={processes} />
  ) : ceStarting ? (
    <StartingStage title={ceTitle ?? 'the game'} game={ceLastReq?.game} progress={ceProgress} hasTable={!!(ceLastReq?.source || ceLastReq?.sources?.length)} />
  ) : !trainer ? (
    <div className="mx-auto flex h-full w-full max-w-[560px] flex-col items-center gap-5 pt-14 text-center">
      {ceNotRunning ? (
        <div className="w-full rounded-xl border border-neon-pink/40 bg-neon-pink/[0.06] px-4 py-2.5 text-[13px] text-neon-pink animate-rise">
          {ceTitle ?? 'That game'} isn&apos;t running. Start it, then{' '}
          {ceLastReq
            ? <button type="button" className="underline hover:text-ink" onClick={() => void ceStart(ceLastReq)}>try again</button>
            : 'open it again'}
          {' '}— Starlight attaches automatically.
        </div>
      ) : ceStartError && ceStartReason === 'ptrace' ? (
        <div role="alert" className="w-full rounded-xl border border-neon-cyan/40 bg-neon-cyan/[0.06] px-4 py-3 text-[13px] text-ink animate-rise">
          <div className="font-semibold mb-1">Allow Starlight to cheat native Linux games</div>
          <div className="text-soft">
            Linux keeps programs from reading each other&apos;s memory. Allowing it once gives that permission to
            Starlight&apos;s memory reader only, and it stays allowed after a restart.
          </div>
          <button type="button" disabled={ceAllowing} onClick={() => void ceAllowAccess()}
                  className="mt-3 rounded-full px-4 py-1.5 text-[13px] font-semibold text-[#06231d] bg-neon-cyan hover:brightness-110 disabled:opacity-60 focus:outline-none focus-visible:ring-2 focus-visible:ring-neon-cyan/50">
            {ceAllowing ? 'Waiting for your password…' : 'Allow'}
          </button>
        </div>
      ) : ceStartError ? (
        <div role="alert" className="w-full rounded-xl border border-neon-pink/40 bg-neon-pink/[0.06] px-4 py-2.5 text-[13px] text-neon-pink animate-rise">
          <div className="font-semibold mb-1">Couldn&apos;t start{ceTitle ? ` ${ceTitle}` : ' the session'}</div>
          <div className="whitespace-pre-line">{ceStartError}</div>
          {ceLastReq && (
            <button type="button" className="mt-2 underline hover:text-ink" onClick={() => void ceStart(ceLastReq)}>Try again</button>
          )}
        </div>
      ) : null}
      <div>
        <h1 className="text-[24px] font-semibold tracking-tight">No game attached</h1>
        <p className="mt-2 text-[13px] leading-relaxed text-muted">
          Pick a game from Home or Library to load its cheats, or attach to anything that&apos;s running
          to change its speed and search its memory.
        </p>
      </div>
      <section className="w-full text-left">
        <h2 className="px-1 pb-2 text-[13px] font-medium text-soft">Running now</h2>
        {running.length === 0 ? (
          <div className="rounded-xl border border-dashed border-line px-4 py-6 text-center text-[13px] text-muted">
            No running games found. Start a game and it shows up here.
          </div>
        ) : (
          <div className="overflow-hidden rounded-xl border border-line bg-panel">
            {running.map((p) => (
              <button key={p.pid} type="button"
                      onClick={() => void attachRunning(p)}
                      className="group flex w-full items-center justify-between border-t border-line/60 px-4 py-3 text-left text-sm transition-colors first:border-t-0 hover:bg-neon-cyan/[0.06] focus-visible:bg-neon-cyan/[0.06] focus-visible:outline-none">
                <span>{p.name}</span>
                <span className="text-xs text-muted transition-colors group-hover:text-neon-cyan">pid {p.pid} · attach</span>
              </button>
            ))}
          </div>
        )}
      </section>
    </div>
  ) : (
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
      latchNeedsPermission={latchNeedsPermission}
      latchAllowing={latchAllowing}
      latchAllowAccess={latchAllowAccess}
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

  // The game screens are centred and draw their own top edge, so Back floats
  // over them; the older trainer view keeps it in the flow above its header.
  const floating = !!ceSessionId || ceStarting || !trainer;
  return (
    <div className="relative flex flex-col h-full min-h-0">
      <button
        type="button"
        onClick={() => {
          // Nothing to go back to (e.g. the app opened straight onto a game) → Home.
          const idx = (window.history.state as { idx?: number } | null)?.idx ?? 0;
          if (idx > 0) navigate(-1); else navigate('/');
        }}
        className={`group flex h-8 items-center gap-1 rounded-full pl-1.5 pr-3 text-[13px] text-soft transition-colors hover:bg-white/[0.07] hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neon-cyan ${
          floating ? 'absolute left-0 top-0 z-20' : 'shrink-0 self-start mb-3'
        }`}
      >
        <ChevronLeft aria-hidden="true" className="size-4 transition-transform group-hover:-translate-x-0.5" /> Back
      </button>
      <div className="flex-1 min-h-0">{content}</div>
    </div>
  );
}

/** Shown while a session is being set up and there is no cheat list to show yet. */
function StartingStage({ title, game, progress, hasTable }: {
  title: string; game: { name: string; steamAppId?: number | null } | undefined; progress: string | null; hasTable: boolean;
}): JSX.Element {
  const cover = useCover(game ?? { name: title });
  const steps = useCeSessionStore((s) => s.pickSteps);
  return (
    <div className="mx-auto flex min-h-full w-full max-w-[700px] flex-col justify-center pb-[6vh]">
      <ConnectStage title={title} cover={cover} phase={steps.length > 0 ? 'matching' : 'connecting'} launched={false} hasTable={hasTable}
                    progress={progress} steps={steps} />
    </div>
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
  latchNeedsPermission: boolean;
  latchAllowing: boolean;
  latchAllowAccess: () => Promise<void>;
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
  latchNeedsPermission,
  latchAllowing,
  latchAllowAccess,
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
    (acc, c) => acc + c.cheats.filter((x) => isValueCheat(x)).length, 0);

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
                aria-label="Refresh list"
              ><RefreshCw aria-hidden="true" className="size-3.5" /></button>
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

      {latchNeedsPermission && latchError ? (
        <AllowAccessBanner message={latchError} allowing={latchAllowing} onAllow={latchAllowAccess} />
      ) : (latchError || trainerError) && <ErrorBanner message={latchError ?? trainerError ?? ''} />}

      {totalCheats > 0 && supportedCount / totalCheats < 0.3 && (
        <LuaHeavyBanner
          supported={supportedCount}
          total={totalCheats}
          sourceUrl={trainer.metadata.source.url}
        />
      )}

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
          if (!isValueCheat(c)) {
            return <UnsupportedCheatCard
              key={c.id}
              id={c.id}
              name={c.name}
              reason={isPatchCheat(c) ? "Code cheat: open the game's page to use it" : c.unsupportedReason}
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
