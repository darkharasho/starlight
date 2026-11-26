import { useState, type ReactNode } from 'react';
import { X } from 'lucide-react';
import type { UserCheatsStore } from '../../stores/user-cheats-store.js';
import type { UserCheatView } from '../../../shared/ipc.js';

/** Only the player's own cheats can be shared; table imports are their authors'. */
export function shareable(cheat: UserCheatView['cheat']): boolean {
  const kind = 'provenance' in cheat ? cheat.provenance?.kind : undefined;
  return kind === 'agent' || kind === 'manual';
}

/** One cheat run by starlightd: on/off, a value for "set" cheats, and the row's own tag and actions. */
export function CheatRow({ item, attached, pending, error, store, tag, actions, onRemove }: {
  item: UserCheatView; attached: boolean; pending: boolean; error: string | undefined;
  store: UserCheatsStore;
  /** Shown after the name, e.g. "Yours" or the community credit. */
  tag: ReactNode;
  /** Extra buttons before Remove. */
  actions?: ReactNode;
  /** Absent: the row has no Remove button. */
  onRemove?: () => void;
}): JSX.Element {
  const { cheat } = item;
  const [removing, setRemoving] = useState(false);
  const unsupported = 'unsupported' in cheat && cheat.unsupported === true;
  const isSet = !unsupported && cheat.type === 'set';
  const fallback = isSet ? (item.value ?? ('default' in cheat ? cheat.default : undefined)) : undefined;
  const [draft, setDraft] = useState<string | null>(null);
  const shown = draft ?? (fallback !== undefined ? String(fallback) : '');
  const disabled = pending || !attached || unsupported;
  const hint = unsupported ? 'This cheat can’t run' : !attached ? 'Start the game first' : undefined;
  const reasons = item.verify?.status === 'needs-update' ? item.verify.reasons : null;

  function commit(): void {
    const text = (draft ?? '').trim();
    const n = Number(text);
    // An inactive cheat keeps what was typed; the toggle sends it.
    if (!item.active) { if (text === '' || !Number.isFinite(n)) setDraft(null); return; }
    setDraft(null);
    if (text === '' || !Number.isFinite(n) || n === item.value) return;
    void store.getState().setValue(cheat.id, n);
  }
  function toggle(): void {
    const n = Number(shown);
    void store.getState().setActive(cheat.id, !item.active, isSet && shown.trim() !== '' && Number.isFinite(n) ? n : undefined);
  }

  return (
    <div className={`border-b border-line/60 px-3.5 py-1.5 animate-rise ${error ? 'bg-neon-pink/[0.05]' : item.active ? 'bg-gradient-to-r from-neon-cyan/[0.08] to-transparent to-60%' : ''}`}>
      <div className="flex min-h-[26px] items-center gap-2.5">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <span className="truncate text-[13.5px]" title={cheat.name}>{cheat.name}</span>
          {tag}
          {reasons && (
            <span tabIndex={0} title={reasons.join('\n')} aria-label={`Needs updating: ${reasons.join('; ')}`}
                  className="shrink-0 cursor-help rounded-full border border-neon-amber/50 bg-neon-amber/[0.08] px-1.5 py-px text-[10.5px] text-neon-amber focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neon-amber">
              Needs updating
            </span>
          )}
        </div>
        {isSet && (
          <input aria-label={`Value of ${cheat.name}`} value={shown} inputMode="decimal"
                 onChange={(e) => setDraft(e.target.value)} onBlur={() => { if (draft !== null) commit(); }}
                 onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') setDraft(null); }}
                 className="w-24 shrink-0 rounded-lg border border-line bg-bg px-2.5 py-0.5 text-right text-[13px] tabular-nums text-ink focus:border-neon-cyan focus:outline-none" />
        )}
        <button type="button" disabled={disabled} aria-pressed={item.active} aria-label={`${cheat.name}: ${item.active ? 'On' : 'Off'}`} title={hint}
                onClick={toggle}
                className={`relative h-[22px] w-[38px] shrink-0 rounded-full transition-[background-color,box-shadow] duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neon-cyan ${
                  item.active ? 'bg-neon-cyan/30 shadow-[0_0_14px_rgb(var(--accent)/0.3)]' : 'bg-white/[0.08] hover:bg-white/[0.13]'
                } ${disabled && !pending ? 'opacity-40' : ''}`}>
          <span className={`absolute left-[3px] top-[3px] size-4 rounded-full transition-[transform,background-color] duration-200 ease-out ${
            item.active ? 'translate-x-[16px] bg-neon-cyan' : 'bg-muted'
          } ${pending ? 'animate-pulse-slow' : ''}`} />
        </button>
        {actions}
        {onRemove && (
          <button type="button" aria-label={`Remove ${cheat.name}`} title="Remove this cheat" onClick={() => setRemoving(true)}
                  className="shrink-0 rounded-md px-1.5 text-[15px] leading-none text-muted/60 hover:text-neon-pink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neon-pink">
            <X aria-hidden="true" className="size-3.5" />
          </button>
        )}
      </div>
      {removing && onRemove && (
        <div role="alertdialog" aria-label={`Remove ${cheat.name}`} className="mt-1.5 flex items-center gap-3 text-xs text-neon-pink">
          <span className="flex-1">{`Remove “${cheat.name}” from your cheats?`}</span>
          <button type="button" onClick={() => { setRemoving(false); onRemove?.(); }}
                  className="rounded-full border border-neon-pink/60 px-2.5 py-0.5 hover:bg-neon-pink/[0.1]">Remove</button>
          <button type="button" onClick={() => setRemoving(false)} className="rounded-full border border-line px-2.5 py-0.5 text-muted hover:text-ink">Keep</button>
        </div>
      )}
      {error && <div role="alert" className="mt-1.5 whitespace-pre-line text-xs text-neon-pink">{error}</div>}
    </div>
  );
}
