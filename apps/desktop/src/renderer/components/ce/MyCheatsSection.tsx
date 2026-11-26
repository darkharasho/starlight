import { useEffect, useState } from 'react';
import { Share2, X } from 'lucide-react';
import { useUserCheatsStore } from '../../stores/user-cheats-store.js';
import { useShareStore } from '../../stores/share-store.js';
import { ShareDialog } from './ShareDialog.js';
import { userCheatsKey } from '../../../shared/game-key.js';
import type { UserCheatView } from '../../../shared/ipc.js';

/** The player's own cheats for this game, run by starlightd. */
export function MyCheatsSection({ cacheKey, pid, attached }: { cacheKey: string; pid: number | null; attached: boolean }): JSX.Element | null {
  const key = userCheatsKey(cacheKey);
  const livePid = attached ? pid : null;
  const { items, pending, errors, confirm } = useUserCheatsStore();
  useEffect(() => { void useUserCheatsStore.getState().load(key, livePid); }, [key, livePid]);

  if (items.length === 0) return null;
  const confirming = confirm ? items.find((i) => i.cheat.id === confirm.id) : undefined;
  return (
    <section aria-label="My cheats" className="mb-3 snap-start overflow-hidden rounded-xl border border-line bg-panel animate-rise">
      <header className="flex items-center justify-between gap-3 border-b border-line/70 bg-[#2a3044] px-3.5 py-2">
        <h2 className="truncate text-[12.5px] font-medium text-soft">My cheats</h2>
      </header>
      {confirm && (
        <div role="alertdialog" aria-label="Close the Cheat Engine table"
             className="flex items-center gap-3 border-b border-neon-amber/40 bg-neon-amber/[0.06] px-3.5 py-2 text-[13px] text-neon-amber">
          <span className="flex-1">
            This will close the current Cheat Engine table — continue?
            {confirming ? <span className="sr-only"> ({confirming.cheat.name})</span> : null}
          </span>
          <button type="button" onClick={() => void useUserCheatsStore.getState().confirmCloseCe()}
                  className="shrink-0 rounded-full border border-neon-amber/60 px-3 py-1 hover:bg-neon-amber/[0.1]">Continue</button>
          <button type="button" onClick={() => useUserCheatsStore.getState().cancelConfirm()}
                  className="shrink-0 rounded-full border border-line px-3 py-1 text-muted hover:text-ink">Cancel</button>
        </div>
      )}
      <div>
        {items.map((item) => (
          <CheatRow key={item.cheat.id} item={item} attached={attached && pid !== null}
                    pending={pending.has(item.cheat.id)} error={errors[item.cheat.id]}
                    onShare={() => void useShareStore.getState().open(key, item.cheat.id, livePid, item.cheat.name)} />
        ))}
      </div>
      <ShareDialog />
    </section>
  );
}

/** Only the player's own cheats can be shared; table imports are their authors'. */
function shareable(cheat: UserCheatView['cheat']): boolean {
  const kind = 'provenance' in cheat ? cheat.provenance?.kind : undefined;
  return kind === 'agent' || kind === 'manual';
}

function CheatRow({ item, attached, pending, error, onShare }: {
  item: UserCheatView; attached: boolean; pending: boolean; error: string | undefined; onShare: () => void;
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
    void useUserCheatsStore.getState().setValue(cheat.id, n);
  }
  function toggle(): void {
    const n = Number(shown);
    void useUserCheatsStore.getState().setActive(cheat.id, !item.active, isSet && shown.trim() !== '' && Number.isFinite(n) ? n : undefined);
  }

  return (
    <div className={`border-b border-line/60 px-3.5 py-1.5 animate-rise ${error ? 'bg-neon-pink/[0.05]' : item.active ? 'bg-gradient-to-r from-neon-cyan/[0.08] to-transparent to-60%' : ''}`}>
      <div className="flex min-h-[26px] items-center gap-2.5">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <span className="truncate text-[13.5px]" title={cheat.name}>{cheat.name}</span>
          <span className="shrink-0 rounded-full border border-neon-cyan/40 px-1.5 py-px text-[10.5px] text-neon-cyan">Yours</span>
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
        {shareable(cheat) && (
          <button type="button" aria-label={`Share ${cheat.name}`} title="Share this cheat with other players" onClick={onShare}
                  className="shrink-0 rounded-md px-1.5 text-[15px] leading-none text-muted/60 hover:text-neon-cyan focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neon-cyan">
            <Share2 aria-hidden="true" className="size-3.5" />
          </button>
        )}
        <button type="button" aria-label={`Remove ${cheat.name}`} title="Remove this cheat" onClick={() => setRemoving(true)}
                className="shrink-0 rounded-md px-1.5 text-[15px] leading-none text-muted/60 hover:text-neon-pink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neon-pink">
          <X aria-hidden="true" className="size-3.5" />
        </button>
      </div>
      {removing && (
        <div role="alertdialog" aria-label={`Remove ${cheat.name}`} className="mt-1.5 flex items-center gap-3 text-xs text-neon-pink">
          <span className="flex-1">{`Remove “${cheat.name}” from your cheats?`}</span>
          <button type="button" onClick={() => { setRemoving(false); void useUserCheatsStore.getState().remove(cheat.id); }}
                  className="rounded-full border border-neon-pink/60 px-2.5 py-0.5 hover:bg-neon-pink/[0.1]">Remove</button>
          <button type="button" onClick={() => setRemoving(false)} className="rounded-full border border-line px-2.5 py-0.5 text-muted hover:text-ink">Keep</button>
        </div>
      )}
      {error && <div role="alert" className="mt-1.5 whitespace-pre-line text-xs text-neon-pink">{error}</div>}
    </div>
  );
}
