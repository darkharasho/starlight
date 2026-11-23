import type { CePickStep } from '../../../shared/ipc.js';
import { GameCover } from './GameCover.js';

export type ConnectPhase = 'launching' | 'waiting' | 'connecting' | 'matching' | 'matched';

interface Props {
  title: string;
  cover: { src: string | null; onError: () => void };
  phase: ConnectPhase;
  /** True when Starlight started the game itself (adds the first two steps). */
  launched: boolean;
  /** False for a session with no table: there is nothing to match. */
  hasTable: boolean;
  /** A specific line from the session, shown instead of the stock one. */
  progress?: string | null | undefined;
  steps: CePickStep[];
  onCancel?: (() => void) | undefined;
}

/**
 * The connecting sequence: the game's cover in an orbit, what is happening
 * right now, where that sits in the sequence, and — while a table is being
 * matched — each table as it is checked.
 */
export function ConnectStage({ title, cover, phase, launched, hasTable, progress, steps, onCancel }: Props): JSX.Element {
  const names = [...(launched ? ['Start game'] : []), 'Connect', ...(hasTable ? ['Match a table'] : [])];
  const at = { launching: 'Start game', waiting: 'Start game', connecting: 'Connect', matching: 'Match a table', matched: 'Match a table' }[phase];
  const current = Math.max(0, names.indexOf(at));
  const done = phase === 'matched';

  const [headline, hint] =
    phase === 'launching' ? [`Starting ${title}…`, 'Handing off to your launcher.']
    : phase === 'waiting' ? [`Waiting for ${title} to start…`, 'This can take a while if the game is updating or syncing saves.']
    : phase === 'connecting' ? [progress ?? `Connecting to ${title}…`, 'Starting Cheat Engine alongside the game.']
    : phase === 'matched' ? ['Found a matching table', 'Loading your cheats.']
    : ['Finding a table that matches your game', progress ?? 'Checking each table against the game’s code. Nothing is switched on.'];

  return (
    <div role="status" className="flex flex-col items-center text-center py-6">
      <div className="relative grid place-items-center size-[212px]">
        <span className="absolute inset-0 rounded-full border border-line" />
        <span className="absolute inset-[26px] rounded-full border border-dashed border-line/80" />
        {done ? (
          <span className="absolute inset-0 rounded-full border border-neon-cyan animate-lock" />
        ) : (
          <>
            <span className="absolute inset-0 rounded-full animate-orbit"
                  style={{
                    background: 'conic-gradient(from 0deg, transparent 0 76%, rgba(62,224,192,0.6) 99%, transparent)',
                    WebkitMask: 'radial-gradient(closest-side, transparent calc(100% - 2px), #000 calc(100% - 1px))',
                  }} />
            <span className="absolute inset-0 animate-orbit">
              <span className="absolute -top-1 left-1/2 -ml-1 size-2 rounded-full bg-neon-cyan shadow-[0_0_14px_3px_rgba(62,224,192,0.7)]" />
            </span>
          </>
        )}
        <GameCover title={title} cover={cover} size="md" />
      </div>

      <div key={headline} className="mt-6 text-[17px] font-medium text-ink animate-rise">{headline}</div>
      <div className="mt-1 max-w-[440px] text-[13px] text-muted">{hint}</div>

      {names.length > 1 && (
        <ol className="mt-7 flex w-full max-w-[520px]" aria-label="Progress">
          {names.map((n, i) => {
            const state = done || i < current ? 'done' : i === current ? 'current' : 'todo';
            return (
              <li key={n} aria-current={state === 'current' ? 'step' : undefined}
                  className={`relative flex-1 pt-5 text-xs ${state === 'done' ? 'text-soft' : state === 'current' ? 'text-ink' : 'text-muted/60'}`}>
                {i > 0 && (
                  <span className="absolute top-[7px] right-1/2 h-[1.5px] w-full bg-line overflow-hidden">
                    <span className={`block h-full bg-neon-cyan origin-left transition-transform duration-500 ${state === 'todo' ? 'scale-x-0' : 'scale-x-100'}`} />
                  </span>
                )}
                <span className={`absolute top-[3px] left-1/2 -ml-[4.5px] size-[9px] rounded-full border-[1.5px] transition-colors duration-300 ${
                  state === 'done' ? 'bg-neon-cyan border-neon-cyan'
                    : state === 'current' ? 'bg-bg border-neon-cyan shadow-[0_0_0_4px_rgba(62,224,192,0.18)]'
                    : 'bg-bg border-line'
                }`} />
                {n}
              </li>
            );
          })}
        </ol>
      )}

      {steps.length > 0 && <TableChecks steps={steps} className="mt-7" />}

      {onCancel && (
        <button type="button" onClick={onCancel}
                className="mt-6 text-[13px] text-muted underline underline-offset-4 hover:text-ink focus-visible:outline-none focus-visible:text-ink">
          Cancel
        </button>
      )}
    </div>
  );
}

const VERDICT_TEXT: Record<CePickStep['state'], string> = {
  waiting: '',
  checking: 'checking…',
  works: 'matches your game',
  broken: 'different version',
  unknown: 'couldn’t tell',
};

/** Each table in the queue: waiting, being checked (a sweep runs across it), or judged. */
export function TableChecks({ steps, className = '' }: { steps: CePickStep[]; className?: string }): JSX.Element {
  return (
    <ul aria-label="Tables being checked" className={`flex w-full max-w-[440px] flex-col gap-1.5 text-left ${className}`}>
      {steps.map((t, i) => (
        <li key={t.id} style={{ animationDelay: `${i * 70}ms` }}
            className={`relative flex items-center gap-2.5 overflow-hidden rounded-lg border px-3 py-2 text-[13px] animate-rise transition-colors duration-300 ${
              t.state === 'checking' ? 'border-neon-cyan/50 bg-panel text-ink'
                : t.state === 'works' ? 'border-neon-cyan bg-neon-cyan/[0.08] text-ink animate-lock'
                : t.state === 'waiting' ? 'border-line/60 bg-panel/50 text-muted/70'
                : 'border-line bg-panel text-muted'
            }`}>
          <span className="w-4 text-center text-xs" aria-hidden="true">
            {t.state === 'works' && <span className="inline-block text-neon-cyan animate-pop">✓</span>}
            {t.state === 'broken' && <span className="inline-block text-neon-pink/80 animate-pop">✕</span>}
            {t.state === 'unknown' && <span className="inline-block animate-pop">?</span>}
            {t.state === 'checking' && <span className="inline-block size-1.5 rounded-full bg-neon-cyan align-middle animate-pulse-slow" />}
          </span>
          <span className={`min-w-0 flex-1 truncate ${t.state === 'broken' ? 'line-through decoration-muted/50' : ''}`}>{t.filename}</span>
          <span className={`shrink-0 text-xs ${t.state === 'works' ? 'text-neon-cyan' : 'text-muted'}`}>{VERDICT_TEXT[t.state]}</span>
          {t.state === 'checking' && (
            <span aria-hidden="true" className="pointer-events-none absolute inset-0 animate-scan"
                  style={{ background: 'linear-gradient(100deg, transparent 30%, rgba(62,224,192,0.16) 50%, transparent 70%)' }} />
          )}
        </li>
      ))}
    </ul>
  );
}
