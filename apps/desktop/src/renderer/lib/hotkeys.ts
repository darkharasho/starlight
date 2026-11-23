import { acceleratorToVk } from '../../shared/vk.js';
import type { CheatItem } from '../../shared/cheat-list.js';
import type { CeSessionRecord } from '../../shared/ipc.js';

export interface EffectiveHotkey {
  /** Accelerator ("num1", "Ctrl+F1") for ours, or Cheat Engine's own text for a table hotkey. */
  accelerator: string;
  /** `table` = bound by the table author, `user` = set here, `auto` = assigned by default. */
  source: 'table' | 'user' | 'auto';
}

/** Keys handed out by default, in order: the numpad, like most trainers. */
export const AUTO_POOL = ['num1', 'num2', 'num3', 'num4', 'num5', 'num6', 'num7', 'num8', 'num9', 'num0'];

/** True when the user has set (or deliberately removed) this cheat's hotkey. "" means "use the default". */
export function isOverridden(overrides: Record<string, string | null>, name: string): boolean {
  return overrides[name] !== undefined && overrides[name] !== '';
}

/**
 * Works out the hotkey each cheat ends up with: the user's choice wins, then
 * whatever the table author bound, then a free numpad key for the first few
 * on/off cheats. `overrides` is keyed by the cheat's name so a choice survives
 * switching to another version of the table.
 */
export function effectiveHotkeys(
  items: CheatItem<CeSessionRecord>[],
  overrides: Record<string, string | null>,
): Map<number, EffectiveHotkey> {
  const out = new Map<number, EffectiveHotkey>();
  const used = new Set<string>();
  const set = (name: string): boolean => isOverridden(overrides, name);
  const scripts = items.filter((i) => !i.note && i.rec.kind === 'script');

  for (const i of scripts) {
    const o = overrides[i.rec.name];
    if (typeof o === 'string' && acceleratorToVk(o)) {
      out.set(i.rec.id, { accelerator: o, source: 'user' });
      used.add(o.toLowerCase());
    } else if (!set(i.rec.name) && i.rec.hotkey) {
      out.set(i.rec.id, { accelerator: i.rec.hotkey, source: 'table' });
    }
  }
  const pool = AUTO_POOL.filter((k) => !used.has(k));
  for (const i of scripts) {
    if (pool.length === 0) break;
    if (out.has(i.rec.id) || set(i.rec.name) || i.indent !== 0) continue;
    out.set(i.rec.id, { accelerator: pool.shift()!, source: 'auto' });
  }
  return out;
}

/** The `set_hotkeys` payload for Cheat Engine. */
export function hotkeyPayload(
  items: CheatItem<CeSessionRecord>[],
  overrides: Record<string, string | null>,
): { bindings: { id: number; keys: number[] }[]; replace: number[] } {
  const bindings: { id: number; keys: number[] }[] = [];
  for (const [id, hk] of effectiveHotkeys(items, overrides)) {
    if (hk.source === 'table') continue;          // Cheat Engine already handles these
    const keys = acceleratorToVk(hk.accelerator);
    if (keys) bindings.push({ id, keys });
  }
  // A table hotkey the user replaced or removed has to be taken off the record.
  const replace = items.filter((i) => i.rec.hotkey && isOverridden(overrides, i.rec.name)).map((i) => i.rec.id);
  return { bindings, replace };
}
