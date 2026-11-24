import { useEffect, useMemo, useRef, useState } from 'react';
import { useCeSessionStore } from '../../stores/ce-session-store.js';
import { useConfigStore } from '../../stores/config-store.js';
import { useUserCheatsStore } from '../../stores/user-cheats-store.js';
import { userCheatsKey } from '../../../shared/game-key.js';
import { MyCheatsSection } from './MyCheatsSection.js';
import type { CeSessionRecord, DetectedProcess, SessionHolder } from '../../../shared/ipc.js';
import { buildCheatList, type CheatItem } from '../../../shared/cheat-list.js';
import { acceleratorLabel, acceleratorToVk } from '../../../shared/vk.js';
import { effectiveHotkeys, type EffectiveHotkey } from '../../lib/hotkeys.js';
import { launchTargetFor } from '../../lib/installed.js';
import { useLibraryStore } from '../../stores/library-store.js';
import { keyboardEventToAccelerator } from '../../lib/accelerator.js';
import { ScannerPanel } from './ScannerPanel.js';
import { ConnectStage, TableChecks, type ConnectPhase } from './ConnectStage.js';
import { GameCover } from './GameCover.js';
import { useCover } from '../../lib/use-cover.js';

/**
 * Narrows the process list to likely game targets for the attach menu.
 * On Linux the user's games run under Proton, so they appear as `*.exe`; when
 * any exist we show just those (sorted). Otherwise we fall back to everything.
 */
export function gameCandidates(processes: DetectedProcess[]): DetectedProcess[] {
  const exes = processes.filter((p) => /\.exe$/i.test(p.name));
  const pool = exes.length > 0 ? exes : processes;
  return [...pool].sort((a, b) => a.name.localeCompare(b.name));
}

/** True when a cheat failed because the table doesn't match the installed game build. */
export function looksStale(msg: string): boolean {
  return /aob|not all results found|0 matches|no hook|failure determining what|game build|re-derive/i.test(msg);
}

const SPEEDS = [0.5, 1, 2, 4, 8];
/** How many times to look again, on its own, for a table that matches. */
const MAX_AUTO_RETRIES = 8;
const AUTO_RETRY_MS = 12_000;
/** Lists longer than this get a search box. */
const SEARCH_THRESHOLD = 12;
/** How long the connecting screen holds on a table it has just matched. */
const MATCH_HOLD_MS = 650;

type Tab = 'cheats' | 'scanner';
type Item = CheatItem<CeSessionRecord>;

export function CeSessionView({ processes }: { processes: DetectedProcess[] }): JSX.Element {
  const s = useCeSessionStore();
  const config = useConfigStore((c) => c.config);
  const [tab, setTab] = useState<Tab>('cheats');
  const [query, setQuery] = useState('');
  const cover = useCover(s.lastReq?.game ?? (s.title ? { name: s.title } : undefined));

  const hasTable = s.tableId !== null || s.records.length > 0;
  const paused = s.engine === 'starlightd';
  const cacheKey = s.lastReq?.cacheKey ?? null;
  const myKey = cacheKey === null ? null : userCheatsKey(cacheKey);
  const myPid = s.attached ? s.attachedTo?.pid ?? null : null;
  const hasUserCheats = useUserCheatsStore((u) => myKey !== null && u.key === myKey && u.items.length > 0);
  useEffect(() => { if (myKey !== null) void useUserCheatsStore.getState().load(myKey, myPid); }, [myKey, myPid]);
  const [confirmTable, setConfirmTable] = useState(false);
  useEffect(() => { if (!paused) setConfirmTable(false); }, [paused]);
  // The Cheats tab has something to show when there is a table, the player's own cheats, or the paused notice.
  const hasCheatsTab = hasTable || hasUserCheats || paused;
  const activeTab: Tab = hasCheatsTab ? tab : 'scanner';
  const hotkeysOn = config?.preferences.cheatHotkeys !== false;
  const title = s.title ?? 'Cheat Engine session';

  const hidden = useMemo(() => new Set(s.hiddenIds), [s.hiddenIds]);
  // Until the game is attached nothing can be switched on, so show every option.
  const list = useMemo(
    () => buildCheatList(s.records, { transparentIds: hidden, revealAll: !s.attached }),
    [s.records, hidden, s.attached],
  );
  const hotkeys = useMemo(() => {
    if (!s.attached || !hotkeysOn) return new Map<number, EffectiveHotkey>();
    const all = buildCheatList(s.records, { transparentIds: hidden, revealAll: true }).sections.flatMap((x) => x.items);
    return effectiveHotkeys(all, config?.cheatHotkeys?.[s.lastReq?.cacheKey ?? ''] ?? {});
  }, [s.records, hidden, s.attached, hotkeysOn, config, s.lastReq]);

  // Keep "on" states and values current while the cheat list is showing.
  useEffect(() => {
    if (!s.attached || activeTab !== 'cheats' || paused) return;
    const t = setInterval(() => { void useCeSessionStore.getState().refresh(); }, 2000);
    return () => clearInterval(t);
  }, [s.attached, activeTab, s.sessionId, paused]);

  // A table judged right after launch can fail only because the game hadn't
  // finished loading. Keep looking for a while — unless the user has already
  // got something switched on, which a reload would undo.
  const userHasCheatsOn = s.records.some((r) => r.isActive && !hidden.has(r.id));
  const autoRetrying = !paused && s.attached && hasTable && s.verdict === 'broken' && s.retries < MAX_AUTO_RETRIES && !userHasCheatsOn;
  useEffect(() => {
    if (!autoRetrying || s.retrying || s.starting) return;
    const t = setTimeout(() => { void useCeSessionStore.getState().retry({ auto: true }); }, AUTO_RETRY_MS);
    return () => clearTimeout(t);
  }, [autoRetrying, s.retrying, s.starting, s.retries, s.sessionId]);

  // The connecting sequence. When a table has just been matched, hold on the
  // result for a beat so the match is seen before the list takes over.
  const busy = !!s.launch || s.starting;
  const everLaunched = useRef(false);
  if (s.launch) everLaunched.current = true;
  const wasBusy = useRef(busy);
  const [matched, setMatched] = useState(false);
  useEffect(() => {
    const finished = wasBusy.current && !busy;
    wasBusy.current = busy;
    if (busy) { setMatched(false); return; }
    if (!finished) { everLaunched.current = false; return; }
    if (!s.attached || !s.pickSteps.some((t) => t.state === 'works')) { everLaunched.current = false; return; }
    setMatched(true);
    const t = setTimeout(() => { setMatched(false); everLaunched.current = false; }, MATCH_HOLD_MS);
    return () => clearTimeout(t);
  }, [busy, s.attached, s.pickSteps]);
  const connecting = busy || matched;
  const phase: ConnectPhase = matched ? 'matched'
    : s.starting ? (s.pickSteps.length > 0 ? 'matching' : 'connecting')
    : s.launch?.phase ?? 'connecting';

  const staleCount = useMemo(
    () => Object.values(s.recordErrors).filter(looksStale).length,
    [s.recordErrors],
  );
  const currentTable = s.tables.find((t) => t.id === s.tableId);
  const skipped = s.attempts.filter((a) => a.verdict !== 'works' && a.id !== s.tableId).length;
  const verdictOf = (id: number): string => {
    const a = s.attempts.find((x) => x.id === id);
    return a?.verdict === 'works' ? ' ✓' : a?.verdict === 'broken' ? ' ✗' : '';
  };

  const q = query.trim().toLowerCase();
  const sections = q === ''
    ? list.sections
    : list.sections
        .map((sec) => ({ ...sec, items: sec.items.filter((i) => !i.note && (i.label.toLowerCase().includes(q) || i.rec.name.toLowerCase().includes(q))) }))
        .filter((sec) => sec.items.length > 0);
  const onCount = s.records.filter((r) => r.isActive && !hidden.has(r.id) && r.kind !== 'header').length;

  const notices = (
    <div className="mb-3 flex flex-col gap-2 empty:hidden">
      {(s.startError || s.speedError || s.tableError) && (
        <Notice tone="pink" role="alert">
          {s.startError ?? s.speedError ?? `This table didn't load cleanly: ${s.tableError}`}
        </Notice>
      )}

      {!paused && s.attached && hasTable && s.verdict === 'broken' && (
        <Notice tone="amber">
          <div className="flex items-center gap-3">
            <span className="flex-1">
              {s.attempts.length > 1 ? `None of the ${s.attempts.length} tables tried match` : 'This table doesn’t match'} the game as it is right now.{' '}
              {s.retrying
                ? (s.progress ?? 'Looking again…')
                : autoRetrying
                  ? 'If the game is still loading that’s expected — Starlight keeps trying.'
                  : 'Game speed and the Memory scanner still work, or pick a table yourself.'}
            </span>
            <button type="button" disabled={s.retrying} onClick={() => void s.retry()}
                    className={`shrink-0 rounded-full border border-neon-amber/60 px-3 py-1 hover:bg-neon-amber/[0.1] ${s.retrying ? 'opacity-50' : ''}`}>
              {s.retrying ? 'Trying…' : 'Try again'}
            </button>
          </div>
          {s.retrying && s.pickSteps.length > 0 && <TableChecks steps={s.pickSteps} className="mx-auto mt-3" />}
        </Notice>
      )}

      {activeTab === 'cheats' && !paused && staleCount > 0 && s.verdict !== 'broken' && (
        <Notice tone="amber">
          {staleCount === 1 ? 'A cheat' : `${staleCount} cheats`} couldn&apos;t find the code {staleCount === 1 ? 'it patches' : 'they patch'} —
          this table was made for a different version of the game.
          {s.tables.length > 1
            ? ' Try another table from the list on the left, or find the value yourself with the Memory scanner.'
            : ' You can still find the value yourself with the Memory scanner.'}
        </Notice>
      )}
    </div>
  );

  if (connecting) {
    return (
      <div className="relative h-full overflow-y-auto">
        <CoverWash src={cover.src} />
        <div className="relative mx-auto flex min-h-full w-full max-w-[700px] flex-col justify-center px-2 pb-[6vh]">
          <ConnectStage title={title} cover={cover} phase={phase} launched={everLaunched.current} hasTable={hasTable}
                        progress={s.progress} steps={s.pickSteps}
                        onCancel={s.launch ? () => s.cancelPlay() : undefined} />
        </div>
      </div>
    );
  }

  return (
    <div className="relative flex h-full min-h-0 gap-6">
      {/* The game and everything that applies to the whole session. Stays put while the list scrolls. */}
      <aside className="relative flex w-[248px] shrink-0 flex-col items-center gap-3 overflow-y-auto pb-1 pt-11 text-center">
        <div className="relative shrink-0">
          {/* The game's own colours, as a glow behind its cover. */}
          {cover.src && (
            <img src={cover.src} alt="" aria-hidden="true"
                 className="pointer-events-none absolute left-1/2 top-1/2 h-[125%] w-[230%] max-w-none -translate-x-1/2 -translate-y-1/2 rounded-full object-cover opacity-40 blur-xl saturate-150" />
          )}
          <GameCover title={title} cover={cover} size={s.attached ? 'md' : 'lg'} />
        </div>
        <div className="relative w-full">
          <h1 className="line-clamp-2 text-[20px] font-semibold leading-tight tracking-tight">{title}</h1>
          <div className="mt-1.5 flex flex-col items-center gap-0.5 text-[12.5px] leading-snug text-muted">
            {s.attached && (
              <span className="inline-flex max-w-full items-center gap-1.5 text-soft"
                    title={s.attachedTo ? `pid ${s.attachedTo.pid}${s.proton ? ' · running under Proton' : ''}` : undefined}>
                <span className="size-2 shrink-0 rounded-full bg-neon-green shadow-[0_0_10px_rgba(74,222,128,0.8)]" />
                <span className="truncate">Connected to {s.attachedTo?.name ?? 'the game'}</span>
              </span>
            )}
            {hasTable ? (
              <span>
                <span>{`${list.total} ${list.total === 1 ? 'cheat' : 'cheats'}`}</span>
                {s.attached && onCount > 0 && <span className="text-neon-cyan">{`, ${onCount} on`}</span>}
              </span>
            ) : (
              <span>No table for this game — game speed and the memory scanner still work</span>
            )}
          </div>
        </div>

        {s.attached ? (
          <RailCard className="animate-rise">
            <div className="pb-1.5 text-xs text-muted">Game speed</div>
            <div role="group" aria-label="Game speed" className="flex rounded-full bg-bg p-[3px] text-[12.5px]">
              {SPEEDS.map((x) => (
                <button key={x} type="button" aria-pressed={s.speed === x} onClick={() => void s.setSpeed(x)}
                        className={`flex-1 rounded-full py-1 tabular-nums transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neon-cyan ${
                          s.speed === x ? 'bg-neon-cyan font-semibold text-[#06231d]' : 'text-muted hover:text-ink'
                        }`}>
                  {x}×
                </button>
              ))}
            </div>
          </RailCard>
        ) : (
          <PlayBar processes={processes} />
        )}

        {(s.attached || s.tables.length > 0) && (
          <RailCard className="flex flex-col gap-2.5">
            {s.attached && (
              <button type="button" aria-pressed={hotkeysOn}
                      title="In-game hotkeys switch cheats on and off while you play"
                      onClick={() => { void useConfigStore.getState().update({ preferences: { cheatHotkeys: !hotkeysOn } }).then(() => useCeSessionStore.getState().syncHotkeys()); }}
                      className="group flex w-full items-center justify-between rounded-md text-[12.5px] text-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neon-cyan">
                <span>Hotkeys {hotkeysOn ? 'on' : 'off'}</span>
                <span aria-hidden="true" className={`relative h-[18px] w-[32px] rounded-full transition-colors ${hotkeysOn ? 'bg-neon-cyan/30' : 'bg-white/[0.08] group-hover:bg-white/[0.13]'}`}>
                  <span className={`absolute left-[3px] top-[3px] size-3 rounded-full transition-[transform,background-color] duration-200 ${hotkeysOn ? 'translate-x-[14px] bg-neon-cyan' : 'bg-muted'}`} />
                </span>
              </button>
            )}
            {s.tables.length > 0 && (
              <label className="flex flex-col gap-1.5 text-xs text-muted">
                <span>Table</span>
                <select value={s.tableId ?? ''} disabled={s.starting || s.retrying}
                        onChange={(e) => { const id = Number(e.target.value); if (id !== s.tableId) void s.switchTable(id); }}
                        className="w-full min-w-0 rounded-lg border border-line bg-bg px-2.5 py-1.5 text-[12.5px] text-ink focus:border-neon-cyan focus:outline-none">
                  {s.tableId !== null && !currentTable && <option value={s.tableId}>Current table</option>}
                  {s.tables.map((t, i) => (
                    <option key={t.url} value={t.id}>{t.filename}{i === 0 ? ' (newest)' : ''}{verdictOf(t.id)}</option>
                  ))}
                </select>
              </label>
            )}
            {s.attached && s.verdict === 'works' && skipped > 0 && currentTable && (
              <p className="text-[11.5px] leading-relaxed text-muted">
                Using <span className="break-all text-soft">{currentTable.filename}</span> — the first table Starlight could confirm works with your
                version of the game ({skipped} {skipped === 1 ? 'other was' : 'others were'} passed over).
              </p>
            )}
          </RailCard>
        )}
      </aside>

      <div className="relative flex min-w-0 flex-1 flex-col">
        {hasCheatsTab ? (
          <div className="flex shrink-0 items-center gap-2 pb-3">
            <div role="tablist" className="flex items-center gap-1">
              <TabButton active={activeTab === 'cheats'} onClick={() => setTab('cheats')}>Cheats</TabButton>
              <TabButton active={activeTab === 'scanner'} onClick={() => setTab('scanner')}>Memory scanner</TabButton>
            </div>
            {activeTab === 'cheats' && !paused && list.total > SEARCH_THRESHOLD && (
              <input type="search" aria-label="Filter cheats" placeholder="Filter cheats…" value={query} onChange={(e) => setQuery(e.target.value)}
                     className="ml-auto w-52 rounded-full border border-line bg-panel px-3.5 py-1.5 text-[13px] text-ink placeholder:text-muted/60 transition-colors focus:border-neon-cyan focus:outline-none" />
            )}
          </div>
        ) : (
          <h2 className="shrink-0 pb-3 pt-1 text-[15px] font-semibold">Memory scanner</h2>
        )}

        {notices}

        {activeTab === 'scanner' ? (
          <div className="flex min-h-0 flex-1 flex-col">
            {s.attached
              ? <ScannerPanel />
              : <div className="py-8 text-center text-[13px] text-muted">Start the game to use the memory scanner.</div>}
          </div>
        ) : (
          <div className="-mr-2 min-h-0 flex-1 overflow-y-auto pb-2 pr-2">
            {cacheKey !== null && <MyCheatsSection cacheKey={cacheKey} pid={myPid} attached={s.attached} />}
            {paused && (
              <PausedNotice holders={s.holders} confirming={confirmTable} setConfirming={setConfirmTable} />
            )}
            {!paused && hasTable && list.total === 0 && (
              <div className="py-8 text-center text-[13px] text-muted">This table has no entries.</div>
            )}
            {!paused && list.total > 0 && sections.length === 0 && (
              <div className="py-8 text-center text-[13px] text-muted">No cheats match “{query.trim()}”.</div>
            )}
            {!paused && sections.map((sec, i) => {
              const on = s.attached ? sec.items.filter((x) => !x.note && x.rec.isActive).length : 0;
              return (
                <section key={`${sec.title ?? ''}:${i}`} className="mb-3 overflow-hidden rounded-xl border border-line bg-panel animate-rise"
                         style={{ animationDelay: `${Math.min(i, 8) * 45}ms` }}>
                  {sec.title && (
                    <header className="flex items-center justify-between gap-3 border-b border-line/60 px-3.5 py-2">
                      <h2 className="truncate text-[12.5px] font-medium text-soft">{sec.title}</h2>
                      {on > 0 && <span className="shrink-0 text-xs text-neon-cyan">{on} on</span>}
                    </header>
                  )}
                  {/* Rows run down one column, then the next, so the list uses the width instead of the scrollbar. */}
                  <div className={`-mb-px ${sec.items.length > 1 ? ROW_COLUMNS : ''}`}>
                    {sec.items.map((item) => (
                      <RecordRow key={item.rec.id} item={item} attached={s.attached} pending={s.pending.has(item.rec.id)}
                                 error={s.recordErrors[item.rec.id]} hotkey={hotkeys.get(item.rec.id)} hotkeysOn={hotkeysOn && s.attached} />
                    ))}
                  </div>
                </section>
              );
            })}
            {!paused && list.notes.length > 0 && q === '' && (
              <details className="mt-1 px-1 text-xs text-muted">
                <summary className="cursor-pointer hover:text-ink">About this table</summary>
                <ul className="mt-2 flex flex-col gap-1 pl-3">
                  {list.notes.map((n, i) => <li key={i}>{n}</li>)}
                </ul>
              </details>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/** The Cheat Engine table is off while starlightd runs the game's cheats. */
function PausedNotice({ holders, confirming, setConfirming }: {
  holders: SessionHolder[]; confirming: boolean; setConfirming: (b: boolean) => void;
}): JSX.Element {
  const loadTable = useCeSessionStore((x) => x.loadTable);
  const useTableInstead = useCeSessionStore((x) => x.useTableInstead);
  const agent = holders.includes('agent');
  const btn = 'shrink-0 rounded-full border border-neon-amber/60 px-3 py-1 hover:bg-neon-amber/[0.1]';
  if (holders.length === 0) {
    return (
      <Notice tone="amber">
        <div className="flex items-center gap-3">
          <span className="flex-1">The Cheat Engine table is closed.</span>
          <button type="button" onClick={() => void loadTable()} className={btn}>Load the table</button>
        </div>
      </Notice>
    );
  }
  return (
    <Notice tone="amber">
      <div className="flex items-center gap-3">
        <span className="flex-1">{`The Cheat Engine table is paused while ${agent ? 'the agent session' : 'your cheats'} run${agent ? 's' : ''}.`}</span>
        {!confirming && <button type="button" onClick={() => setConfirming(true)} className={btn}>Use the table instead</button>}
      </div>
      {confirming && (
        <div role="alertdialog" aria-label="Use the table instead" className="mt-2 flex items-center gap-3">
          <span className="flex-1">{`This turns off your cheats${agent ? ' and ends the agent session' : ''} — continue?`}</span>
          <button type="button" onClick={() => { setConfirming(false); void useTableInstead(); }} className={btn}>Continue</button>
          <button type="button" onClick={() => setConfirming(false)} className="shrink-0 rounded-full border border-line px-3 py-1 text-muted hover:text-ink">Cancel</button>
        </div>
      )}
    </Notice>
  );
}

/** Two columns of rows once the window is wide enough, three on a very wide one. */
const ROW_COLUMNS = 'gap-0 min-[1180px]:columns-2 min-[1800px]:columns-3 [column-rule:1px_solid_rgba(54,61,82,0.6)]';

/** The game's own colours, washed across the top of the connecting screen. */
function CoverWash({ src }: { src: string | null }): JSX.Element {
  return (
    <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 top-0 h-[360px] overflow-hidden"
         style={{ WebkitMaskImage: 'radial-gradient(70% 100% at 50% 0%, #000 0%, transparent 100%)' }}>
      {src
        ? <img src={src} alt="" className="absolute left-1/2 top-[-120px] w-[900px] max-w-none -translate-x-1/2 opacity-30 blur-3xl saturate-150" />
        : <div className="absolute inset-0 bg-[radial-gradient(60%_100%_at_50%_0%,rgba(62,224,192,0.14),transparent_70%)]" />}
    </div>
  );
}

function RailCard({ className = '', children }: { className?: string; children: React.ReactNode }): JSX.Element {
  return <div className={`w-full shrink-0 rounded-xl border border-line bg-panel px-3 py-2.5 text-left ${className}`}>{children}</div>;
}

const NOTICE_TONES = {
  pink: 'border-neon-pink/40 bg-neon-pink/[0.06] text-neon-pink',
  amber: 'border-neon-amber/40 bg-neon-amber/[0.06] text-neon-amber',
};

function Notice({ tone, role, className = '', children }: {
  tone: keyof typeof NOTICE_TONES; role?: 'alert'; className?: string; children: React.ReactNode;
}): JSX.Element {
  return (
    <div role={role} className={`whitespace-pre-line rounded-xl border px-4 py-2.5 text-[13px] leading-relaxed animate-rise ${NOTICE_TONES[tone]} ${className}`}>
      {children}
    </div>
  );
}

/**
 * The not-attached action: Play starts the game and attaches when it's up; the
 * arrow next to it attaches to something already running instead.
 */
function PlayBar({ processes }: { processes: DetectedProcess[] }): JSX.Element {
  const s = useCeSessionStore();
  const [menuOpen, setMenuOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  // Re-evaluated when the library scan lands, in case it finished after this game was opened.
  useLibraryStore((l) => l.games);
  const canLaunch = !!(s.lastReq?.launch ?? (s.lastReq?.game ? launchTargetFor(s.lastReq.game) : undefined));
  const candidates = gameCandidates(processes);

  useEffect(() => {
    if (!menuOpen) return;
    const close = (e: MouseEvent): void => { if (!wrap.current?.contains(e.target as Node)) setMenuOpen(false); };
    const esc = (e: KeyboardEvent): void => { if (e.key === 'Escape') setMenuOpen(false); };
    window.addEventListener('mousedown', close);
    window.addEventListener('keydown', esc);
    return () => { window.removeEventListener('mousedown', close); window.removeEventListener('keydown', esc); };
  }, [menuOpen]);

  const primary = 'bg-neon-cyan text-[#06231d] font-bold transition-[filter,transform] hover:brightness-110 active:scale-[0.97] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/80';
  return (
    <div className="flex w-full shrink-0 flex-col items-center gap-2">
      <div ref={wrap} className="relative flex w-full rounded-full shadow-[0_0_28px_rgba(62,224,192,0.3)]">
        {canLaunch ? (
          <>
            <button type="button" onClick={() => void s.play()} className={`${primary} flex-1 rounded-l-full py-2.5 pl-7 pr-4 text-[15px]`}>▶ Play</button>
            <button type="button" aria-label="Other ways to connect" aria-haspopup="menu" aria-expanded={menuOpen}
                    onClick={() => setMenuOpen((o) => !o)}
                    className={`${primary} ml-px rounded-r-full pl-3 pr-4 text-xs`}>
              <span className={`inline-block transition-transform duration-200 ${menuOpen ? 'rotate-180' : ''}`}>▾</span>
            </button>
          </>
        ) : (
          <button type="button" aria-haspopup="menu" aria-expanded={menuOpen} onClick={() => setMenuOpen((o) => !o)}
                  className={`${primary} flex-1 rounded-full px-4 py-2.5 text-sm`}>Attach to running game ▾</button>
        )}
        {menuOpen && (
          <div role="menu" aria-label="Attach to a running game"
               className="absolute inset-x-0 top-full z-20 mt-2 max-h-64 overflow-y-auto rounded-xl border border-line bg-raised py-1.5 text-left shadow-[0_18px_50px_rgba(0,0,0,0.7)] animate-rise">
            <div className="px-3.5 py-1.5 text-xs text-muted">Attach to a running game</div>
            {candidates.length === 0 && (
              <div className="px-3.5 py-2 text-[13px] text-muted">Nothing running yet. Start the game and it shows up here.</div>
            )}
            {candidates.map((p) => (
              <button key={p.pid} type="button" role="menuitem"
                      onClick={() => { setMenuOpen(false); void s.attach(p.pid, p.name); }}
                      className="flex w-full items-center justify-between gap-3 px-3.5 py-2 text-left text-[13px] text-ink hover:bg-neon-cyan/[0.08] hover:text-neon-cyan focus-visible:bg-neon-cyan/[0.08] focus-visible:outline-none">
                <span className="truncate">{p.name}</span>
                <span className="shrink-0 text-xs text-muted">pid {p.pid}</span>
              </button>
            ))}
          </div>
        )}
      </div>
      <span className="text-xs leading-snug text-muted">
        {canLaunch
          ? 'Starts the game and attaches when it’s running.'
          : 'This game isn’t in your library — start it yourself, then attach.'}
      </span>
    </div>
  );
}

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }): JSX.Element {
  return (
    <button type="button" role="tab" aria-selected={active} onClick={onClick}
            className={`rounded-full px-3.5 py-1.5 text-[13px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neon-cyan ${
              active ? 'bg-raised text-ink' : 'text-muted hover:text-ink'
            }`}>
      {children}
    </button>
  );
}

function RecordRow({ item, attached, pending, error, hotkey, hotkeysOn }: {
  item: Item; attached: boolean; pending: boolean; error: string | undefined;
  hotkey: EffectiveHotkey | undefined; hotkeysOn: boolean;
}): JSX.Element {
  const setActive = useCeSessionStore((s) => s.setActive);
  const r = item.rec;
  const child = item.indent === 1;

  if (item.note) {
    return <div className={`break-inside-avoid border-b border-line/60 px-3.5 py-2 text-xs italic text-muted ${child ? 'break-before-avoid pl-8' : ''}`}>{item.label}</div>;
  }

  const isValue = r.kind === 'value';
  const disabled = pending || !attached;
  const label = `${item.label}: ${isValue ? (r.isActive ? 'Frozen' : 'Freeze') : (r.isActive ? 'On' : 'Off')}`;
  const hint = !attached ? 'Start the game first' : isValue ? 'Hold this value so the game can’t change it' : undefined;
  return (
    <div className={`relative break-inside-avoid border-b border-line/60 px-3.5 py-1.5 transition-colors duration-300 ${child ? 'break-before-avoid bg-bg/40 pl-8' : ''} ${
      error ? 'bg-neon-pink/[0.05]' : r.isActive ? 'bg-gradient-to-r from-neon-cyan/[0.08] to-transparent to-60%' : ''
    }`}>
      <span aria-hidden="true"
            className={`absolute bottom-1.5 left-0 top-1.5 w-[2.5px] origin-center rounded-full bg-neon-cyan shadow-[0_0_10px_#3ee0c0] transition-transform duration-300 ${r.isActive && !error ? 'scale-y-100' : 'scale-y-0'}`} />
      <div className="flex min-h-[26px] items-center gap-2.5">
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13.5px]" title={r.name}>{item.label}</div>
          {item.hiddenChildren > 0 && (
            <div className="mt-0.5 text-xs text-muted">
              {item.hiddenChildren} {item.hiddenChildren === 1 ? 'option appears' : 'options appear'} when on
            </div>
          )}
        </div>
        {isValue && attached && <ValueField record={r} label={item.label} />}
        {!isValue && hotkeysOn && <HotkeyChip name={r.name} label={item.label} hotkey={hotkey} />}
        {isValue ? (
          <button type="button" disabled={disabled} aria-pressed={r.isActive} aria-label={label} title={hint}
                  onClick={() => void setActive(r.id, !r.isActive)}
                  className={`min-w-[62px] shrink-0 rounded-full border px-2.5 py-[3px] text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neon-cyan ${
                    r.isActive ? 'border-neon-cyan bg-neon-cyan/[0.12] text-neon-cyan' : 'border-line text-muted hover:border-neon-cyan hover:text-neon-cyan'
                  } ${disabled ? 'opacity-40' : ''}`}>
            {pending ? '…' : r.isActive ? 'Frozen' : 'Freeze'}
          </button>
        ) : (
          <button type="button" disabled={disabled} aria-pressed={r.isActive} aria-label={label} title={hint}
                  onClick={() => void setActive(r.id, !r.isActive)}
                  className={`relative h-[22px] w-[38px] shrink-0 rounded-full transition-[background-color,box-shadow] duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neon-cyan focus-visible:ring-offset-2 focus-visible:ring-offset-panel ${
                    r.isActive ? 'bg-neon-cyan/30 shadow-[0_0_14px_rgba(62,224,192,0.3)]' : 'bg-white/[0.08] hover:bg-white/[0.13]'
                  } ${disabled && !pending ? 'opacity-40' : ''}`}>
            <span className={`absolute left-[3px] top-[3px] size-4 rounded-full transition-[transform,background-color] duration-200 ease-out ${
              r.isActive ? 'translate-x-[16px] bg-neon-cyan' : 'bg-muted'
            } ${pending ? 'animate-pulse-slow' : ''}`} />
          </button>
        )}
      </div>
      {error && <div role="alert" className="mt-1.5 whitespace-pre-line text-xs text-neon-pink">{error}</div>}
    </div>
  );
}

/** A cheat's in-game hotkey. Click to change it; Backspace while capturing removes it. */
function HotkeyChip({ name, label, hotkey }: { name: string; label: string; hotkey: EffectiveHotkey | undefined }): JSX.Element {
  const [capturing, setCapturing] = useState(false);
  const [invalid, setInvalid] = useState(false);

  useEffect(() => {
    if (!capturing) return;
    function onKey(e: KeyboardEvent): void {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Escape') { setCapturing(false); return; }
      if ((e.key === 'Backspace' || e.key === 'Delete') && !e.ctrlKey && !e.altKey && !e.shiftKey) {
        setCapturing(false);
        void useCeSessionStore.getState().setHotkey(name, null);
        return;
      }
      const accel = keyboardEventToAccelerator(e);
      if (!accel) return;                       // a lone modifier: keep waiting
      if (!acceleratorToVk(accel)) { setInvalid(true); return; }
      setCapturing(false);
      void useCeSessionStore.getState().setHotkey(name, accel);
    }
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [capturing, name]);

  const text = capturing
    ? (invalid ? 'try another key' : 'press a key…')
    : hotkey ? (hotkey.source === 'table' ? hotkey.accelerator : acceleratorLabel(hotkey.accelerator)) : '+ key';
  return (
    <button type="button" aria-label={`Hotkey for ${label}: ${hotkey ? text : 'none'}`}
            title={capturing ? 'Esc cancels · Backspace removes the hotkey' : 'In-game hotkey — click to change'}
            onClick={() => { setInvalid(false); setCapturing((c) => !c); }}
            onBlur={() => setCapturing(false)}
            className={`shrink-0 rounded-md border px-2 py-0.5 text-[11.5px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neon-cyan ${
              capturing ? 'border-neon-pink text-neon-pink animate-pulse-slow'
                : hotkey ? 'border-white/10 border-b-2 bg-raised text-soft hover:border-neon-cyan/60 hover:text-neon-cyan'
                : 'border-transparent text-muted/50 hover:border-line hover:text-muted'
            }`}>
      {text}
    </button>
  );
}

/** Shows a value record's current value and lets the user overwrite it. */
function ValueField({ record: r, label }: { record: CeSessionRecord; label: string }): JSX.Element {
  const setValue = useCeSessionStore((s) => s.setValue);
  const [draft, setDraft] = useState<string | null>(null);
  const unreadable = r.value === undefined || r.value === '??' || r.value === '';

  function commit(next: string | null): void {
    setDraft(null);
    const v = (next ?? '').trim();
    if (v !== '' && v !== r.value) void setValue(r.id, v);
  }

  if (r.options && r.options.length > 0) {
    return (
      <select aria-label={`Value of ${label}`} value={r.value ?? ''} onChange={(e) => commit(e.target.value)}
              className="max-w-[150px] shrink-0 rounded-lg border border-line bg-bg px-2 py-0.5 text-[13px] text-ink focus:border-neon-cyan focus:outline-none">
        {!r.options.some((o) => o.value === r.value) && <option value={r.value ?? ''}>{unreadable ? '—' : r.value}</option>}
        {r.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    );
  }

  return (
    <input aria-label={`Value of ${label}`}
           value={draft ?? (unreadable ? '' : r.value ?? '')}
           placeholder={unreadable ? 'not readable yet' : ''}
           title={unreadable ? 'Not readable yet — get into the game first' : undefined}
           onChange={(e) => setDraft(e.target.value)}
           onBlur={() => { if (draft !== null) commit(draft); }}
           onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') setDraft(null); }}
           className="w-24 shrink-0 rounded-lg border border-line bg-bg px-2.5 py-0.5 text-right text-[13px] tabular-nums text-ink placeholder:text-left placeholder:text-xs placeholder:text-muted/60 transition-colors focus:border-neon-cyan focus:outline-none" />
  );
}
