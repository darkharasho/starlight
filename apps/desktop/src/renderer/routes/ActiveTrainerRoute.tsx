import { useState } from 'react';
import { useLatchState } from '../stores/latch-store.js';
import { ELDEN_RING_TRAINER, type MockCheat, type MockSupportedCheat } from '../data/elden-ring-trainer.js';
import { ToggleCheatCard } from '../components/cheat-cards/ToggleCheatCard.js';
import { ValueCheatCard } from '../components/cheat-cards/ValueCheatCard.js';
import { UnsupportedCheatCard } from '../components/cheat-cards/UnsupportedCheatCard.js';

function isSupported(c: MockCheat): c is MockSupportedCheat {
  return !('unsupported' in c) || c.unsupported !== true;
}

function isValueCheat(c: MockSupportedCheat): boolean {
  return c.type === 'set';
}

export function ActiveTrainerRoute(): JSX.Element {
  const { state, detectedGame, latch, detach } = useLatchState();

  if (!detectedGame) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-muted">
        <p className="text-sm">No game latched.</p>
        <p className="text-xs mt-2">Open a game and click its tile from Home or Library.</p>
      </div>
    );
  }

  return <TrainerView state={state} game={detectedGame} onLatch={latch} onDetach={detach} />;
}

interface TrainerViewProps {
  state: ReturnType<typeof useLatchState.getState>['state'];
  game: NonNullable<ReturnType<typeof useLatchState.getState>['detectedGame']>;
  onLatch: () => void;
  onDetach: () => void;
}

function TrainerView({ state, game, onLatch, onDetach }: TrainerViewProps): JSX.Element {
  const trainer = ELDEN_RING_TRAINER;
  const [activeCategory, setActiveCategory] = useState<string>(trainer.categories[0]!.name);

  // Per-cheat state: active + current value (for value cheats)
  const [active, setActive] = useState<Record<string, boolean>>({});
  const [values, setValues] = useState<Record<string, number>>(() => {
    const init: Record<string, number> = {};
    for (const cat of trainer.categories) {
      for (const c of cat.cheats) {
        if (isSupported(c) && isValueCheat(c) && c.default !== undefined) init[c.id] = c.default;
      }
    }
    return init;
  });

  const category = trainer.categories.find((c) => c.name === activeCategory)!;
  const activeCount = category.cheats.filter((c) => active[c.id]).length;
  const totalCheats = trainer.categories.reduce((acc, c) => acc + c.cheats.length, 0);
  const supportedCount = trainer.categories.reduce(
    (acc, c) => acc + c.cheats.filter((x) => isSupported(x)).length, 0,
  );

  return (
    <div className="grid grid-cols-[200px_1fr] gap-4 h-full">
      {/* Header band spans both columns */}
      <div className="col-span-2 flex items-center gap-3 -mt-2 mb-2">
        <div
          className="w-7 h-[42px] bg-cover bg-center rounded-sm border border-line"
          style={{ backgroundImage: `url(${game.coverUrl})` }}
        />
        <div>
          <div className="text-[13px] font-semibold">{game.name}</div>
          <div className="text-[10px] text-muted">PID 24081 · trainer by {trainer.metadata.author ?? 'unknown'}</div>
        </div>
        <div className="ml-auto flex items-center gap-2">
          {state === 'detected' && (
            <button
              type="button"
              onClick={onLatch}
              className="px-3 py-1.5 text-xs rounded-sm border border-neon-cyan text-neon-cyan glow-cyan hover:bg-neon-cyan/[0.08]"
            >
              Latch
            </button>
          )}
          {state === 'latched' && (
            <button
              type="button"
              onClick={onDetach}
              className="px-3 py-1.5 text-xs rounded-sm border border-line text-muted hover:border-neon-pink hover:text-neon-pink"
            >
              Detach
            </button>
          )}
        </div>
      </div>

      {/* Categories sidebar */}
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
          {totalCheats - supportedCount} unsupported (Lua scripts)
        </div>
      </aside>

      {/* Cheats list */}
      <section className="flex flex-col gap-2 overflow-y-auto">
        <div className="flex items-baseline justify-between mb-1">
          <span className="text-[11px] text-muted">{category.cheats.length} cheats · {activeCount} active</span>
        </div>
        {category.cheats.map((c) => {
          if (!isSupported(c)) {
            return (
              <UnsupportedCheatCard
                key={c.id}
                id={c.id}
                name={c.name}
                reason={c.unsupportedReason}
                {...(c.description !== undefined ? { description: c.description } : {})}
              />
            );
          }
          if (isValueCheat(c)) {
            return (
              <ValueCheatCard
                key={c.id}
                id={c.id}
                name={c.name}
                {...(c.description !== undefined ? { description: c.description } : {})}
                active={!!active[c.id]}
                value={values[c.id] ?? c.default ?? 0}
                step={c.step ?? 1}
                {...(c.min !== undefined ? { min: c.min } : {})}
                {...(c.max !== undefined ? { max: c.max } : {})}
                {...(c.hotkeys ? { hotkeys: c.hotkeys } : {})}
                onToggle={(id, next) => setActive((p) => ({ ...p, [id]: next }))}
                onValueChange={(id, v) => setValues((p) => ({ ...p, [id]: v }))}
              />
            );
          }
          return (
            <ToggleCheatCard
              key={c.id}
              id={c.id}
              name={c.name}
              {...(c.description !== undefined ? { description: c.description } : {})}
              active={!!active[c.id]}
              {...(c.hotkeys?.toggle ? { hotkey: c.hotkeys.toggle } : {})}
              onToggle={(id, next) => setActive((p) => ({ ...p, [id]: next }))}
            />
          );
        })}
      </section>
    </div>
  );
}
