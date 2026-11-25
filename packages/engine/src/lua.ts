import type { Session } from './session.js';
import type { SymbolRegistry } from './types.js';

/** What a Lua run asked the app to change, in order. */
export type LuaEffect =
  | { op: 'registerSymbol'; name: string; address: string }
  | { op: 'unregisterSymbol'; name: string };

/** Something a Lua run wanted to show the player (showMessage, print, messageDialog, shellExecute). */
export interface LuaNotice { kind: 'message' | 'link'; text: string }

/** A Lua error is a result, not a rejection: its effects up to the error still apply. */
export type LuaRunResult =
  | { ok: true; returned: string | null; effects: LuaEffect[]; notices: LuaNotice[] }
  | { ok: false; error: string; line: number | null; effects: LuaEffect[]; notices: LuaNotice[] };

export interface LuaRunOptions {
  /** Shown in error messages (CE's chunk name). */
  name: string;
  syntaxcheck?: boolean;
  /** The table's symbols (lowercase name → address). */
  symbols: SymbolRegistry;
  /** CE's `memrec` for a record's own script. */
  memrec?: { id: number; description: string; value: string };
}

export interface LuaState {
  readonly id: number;
  run(chunk: string, o: LuaRunOptions): Promise<LuaRunResult>;
  close(): Promise<void>;
}

/**
 * Opens a Lua state on starlightd for an attached session. One state per table: functions the
 * table script defines are visible to its records' scripts, as in Cheat Engine. `process` is the
 * game's executable name for CE's `process` and `openProcess` (default: the process's comm).
 */
export async function luaOpen(s: Session, o: { process?: string } = {}): Promise<LuaState> {
  const { id } = await s.client.call<{ id: number }>('lua_open', {
    handle: s.handle,
    ...(o.process ? { process: o.process } : {}),
  });
  return {
    id,
    async run(chunk, r) {
      return s.client.call<LuaRunResult>('lua_run', {
        id,
        chunk,
        name: r.name,
        syntaxcheck: r.syntaxcheck ?? false,
        symbols: Object.fromEntries(r.symbols),
        ...(r.memrec ? { memrec: r.memrec } : {}),
      });
    },
    async close() {
      await s.client.call('lua_close', { id });
    },
  };
}
