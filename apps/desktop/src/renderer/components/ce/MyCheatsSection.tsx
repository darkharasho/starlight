import { useEffect } from 'react';
import { Share2 } from 'lucide-react';
import { useUserCheatsStore } from '../../stores/user-cheats-store.js';
import { useShareStore } from '../../stores/share-store.js';
import { ShareDialog } from './ShareDialog.js';
import { CheatRow, shareable } from './CheatRow.js';
import { userCheatsKey } from '../../../shared/game-key.js';

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
                    pending={pending.has(item.cheat.id)} error={errors[item.cheat.id]} store={useUserCheatsStore}
                    tag={<span className="shrink-0 rounded-full border border-neon-cyan/40 px-1.5 py-px text-[10.5px] text-neon-cyan">Yours</span>}
                    onRemove={() => void useUserCheatsStore.getState().remove(item.cheat.id)}
                    actions={shareable(item.cheat) && (
                      <button type="button" aria-label={`Share ${item.cheat.name}`} title="Share this cheat with other players"
                              onClick={() => void useShareStore.getState().open(key, item.cheat.id, livePid, item.cheat.name)}
                              className="shrink-0 rounded-md px-1.5 text-[15px] leading-none text-muted/60 hover:text-neon-cyan focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neon-cyan">
                        <Share2 aria-hidden="true" className="size-3.5" />
                      </button>
                    )} />
        ))}
      </div>
      <ShareDialog />
    </section>
  );
}
