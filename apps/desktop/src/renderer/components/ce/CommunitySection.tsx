import { useEffect, useState } from 'react';
import { BookmarkPlus } from 'lucide-react';
import { useCommunityCheatsStore } from '../../stores/user-cheats-store.js';
import { starlight } from '../../ipc-client.js';
import { CheatRow } from './CheatRow.js';
import type { UserCheatView } from '../../../shared/ipc.js';

/** Approved cheats other players shared for this game. They run like the player's own, and only when turned on. */
export function CommunitySection({ steamAppId, userKey, pid, attached, exeName }: {
  steamAppId: number; userKey: string; pid: number | null; attached: boolean; exeName?: string | undefined;
}): JSX.Element | null {
  const key = `community-${steamAppId}`;
  const livePid = attached ? pid : null;
  const { items, pending, errors, confirm } = useCommunityCheatsStore();
  const [showOlder, setShowOlder] = useState(false);
  const [saved, setSaved] = useState<Record<string, string>>({});
  useEffect(() => { void useCommunityCheatsStore.getState().load(key, livePid); }, [key, livePid]);

  if (items.length === 0) return null;
  const current = items.filter((i) => !i.community?.older);
  const older = items.filter((i) => i.community?.older);

  async function save(item: UserCheatView): Promise<void> {
    const r = await starlight().communityCheatsSave({ key, id: item.cheat.id, userKey, ...(exeName ? { exeName } : {}) })
      .catch((e: unknown) => ({ ok: false as const, error: e instanceof Error ? e.message : String(e) }));
    setSaved((s) => ({ ...s, [item.cheat.id]: r.ok ? 'Saved to My cheats' : r.error }));
  }

  const row = (item: UserCheatView): JSX.Element => {
    const c = item.community;
    return (
      <div key={item.cheat.id}>
        <CheatRow item={item} attached={attached && pid !== null} store={useCommunityCheatsStore}
                  pending={pending.has(item.cheat.id)} error={errors[item.cheat.id]}
                  tag={(
                    <span className="flex shrink-0 items-center gap-1.5 text-[11px] text-muted">
                      <span>{`by ${c?.credit ?? 'Anonymous'}`}</span>
                      {c?.buildId && <span>{`made on build ${c.buildId}`}</span>}
                    </span>
                  )}
                  actions={(
                    <button type="button" aria-label={`Save ${item.cheat.name} to my cheats`} title="Save a copy to My cheats"
                            onClick={() => void save(item)}
                            className="shrink-0 rounded-md px-1.5 text-[15px] leading-none text-muted/60 hover:text-neon-cyan focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neon-cyan">
                      <BookmarkPlus aria-hidden="true" className="size-3.5" />
                    </button>
                  )} />
        {saved[item.cheat.id] && <div role="status" className="px-3.5 pb-1.5 text-xs text-muted">{saved[item.cheat.id]}</div>}
      </div>
    );
  };

  return (
    <section aria-label="Community" className="mb-3 snap-start overflow-hidden rounded-xl border border-line bg-panel animate-rise">
      <header className="flex items-center justify-between gap-3 border-b border-line/70 bg-[#2a3044] px-3.5 py-2">
        <h2 className="truncate text-[12.5px] font-medium text-soft">Community</h2>
        <span className="text-[11px] text-muted">Shared by players, approved before listing</span>
      </header>
      {confirm && (
        <div role="alertdialog" aria-label="Close the Cheat Engine table"
             className="flex items-center gap-3 border-b border-neon-amber/40 bg-neon-amber/[0.06] px-3.5 py-2 text-[13px] text-neon-amber">
          <span className="flex-1">This will close the current Cheat Engine table — continue?</span>
          <button type="button" onClick={() => void useCommunityCheatsStore.getState().confirmCloseCe()}
                  className="shrink-0 rounded-full border border-neon-amber/60 px-3 py-1 hover:bg-neon-amber/[0.1]">Continue</button>
          <button type="button" onClick={() => useCommunityCheatsStore.getState().cancelConfirm()}
                  className="shrink-0 rounded-full border border-line px-3 py-1 text-muted hover:text-ink">Cancel</button>
        </div>
      )}
      <div>{current.map(row)}</div>
      {older.length > 0 && (
        <div className="border-t border-line/60">
          <button type="button" aria-expanded={showOlder} onClick={() => setShowOlder((v) => !v)}
                  className="w-full px-3.5 py-1.5 text-left text-[12px] text-muted hover:text-ink">Older versions</button>
          {showOlder && <div>{older.map(row)}</div>}
        </div>
      )}
    </section>
  );
}
