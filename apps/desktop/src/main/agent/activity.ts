// apps/desktop/src/main/agent/activity.ts
//
// The agent's activity log: one entry per tool call (No silent actions), plus
// notes for attach, Stop and the "Agent can modify the game" switch. Kept in
// memory, newest 200.
import type { ActivityEntry } from '../../shared/ipc.js';
import type { ActivitySink } from './tools.js';

export type { ActivityEntry };

export interface ActivityLog extends ActivitySink {
  note(summary: string): void;
  /** Newest first; a copy. */
  entries(): ActivityEntry[];
}

export function createActivityLog(o: { max?: number; onChange(): void; now?(): number }): ActivityLog {
  const max = o.max ?? 200;
  const now = o.now ?? Date.now;
  /** Oldest first. */
  const list: ActivityEntry[] = [];
  let nextId = 1;

  const push = (e: Omit<ActivityEntry, 'id' | 'at'>): number => {
    const id = nextId++;
    list.push({ id, at: now(), ...e });
    if (list.length > max) list.splice(0, list.length - max);
    o.onChange();
    return id;
  };

  return {
    start(tool, summary) {
      return push({ tool, summary, status: 'running' });
    },
    finish(id, r) {
      const e = list.find((x) => x.id === id);
      if (!e) return;
      e.status = r.status;
      if (r.summary !== undefined) e.summary = r.summary;
      if (r.error !== undefined) e.error = r.error;
      if (r.change !== undefined) e.change = { ...r.change };
      o.onChange();
    },
    note(summary) {
      push({ tool: null, summary, status: 'note' });
    },
    entries() {
      return list.map((e) => ({ ...e, ...(e.change ? { change: { ...e.change } } : {}) })).reverse();
    },
  };
}
