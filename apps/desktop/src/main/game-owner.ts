/**
 * One engine per game. Cheat Engine and starlightd must never both hold a
 * game, so every starlightd user (the agent, the user's cheats, a table running
 * natively) registers a hold here, and claiming a game that Cheat Engine has
 * releases CE first.
 */
export type Holder = 'agent' | 'user-cheats' | 'table';

export type Owner =
  | { engine: 'ce'; sessionId: string }
  | { engine: 'starlightd'; holders: Holder[] };

export interface GameOwner {
  /** CE is reported only when no starlightd holder exists, because a claim always releases CE first. */
  ownerOf(pid: number): Owner | null;
  holders(pid: number): Holder[];
  /** Registers a holder with no CE handover. Returns an idempotent release. */
  hold(pid: number, holder: Holder): () => void;
  /** Like `hold`, but ends a Cheat Engine session on the game first. */
  claim(pid: number, holder: Holder): Promise<() => void>;
}

export interface GameOwnerDeps {
  ceSessionFor(pid: number): { sessionId: string } | null;
  releaseCe(sessionId: string): Promise<void>;
  onChange?(pid: number): void;
}

export function createGameOwner(deps: GameOwnerDeps): GameOwner {
  const held = new Map<number, Map<Holder, number>>();

  const holders = (pid: number): Holder[] => [...(held.get(pid)?.keys() ?? [])];

  function hold(pid: number, holder: Holder): () => void {
    let byHolder = held.get(pid);
    if (!byHolder) { byHolder = new Map(); held.set(pid, byHolder); }
    byHolder.set(holder, (byHolder.get(holder) ?? 0) + 1);
    deps.onChange?.(pid);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const m = held.get(pid);
      if (!m) return;
      const n = (m.get(holder) ?? 0) - 1;
      if (n > 0) m.set(holder, n); else m.delete(holder);
      if (m.size === 0) held.delete(pid);
      deps.onChange?.(pid);
    };
  }

  return {
    ownerOf(pid) {
      const h = holders(pid);
      if (h.length > 0) return { engine: 'starlightd', holders: h };
      const ce = deps.ceSessionFor(pid);
      return ce ? { engine: 'ce', sessionId: ce.sessionId } : null;
    },
    holders,
    hold,
    async claim(pid, holder) {
      const ce = deps.ceSessionFor(pid);
      if (ce) await deps.releaseCe(ce.sessionId);
      return hold(pid, holder);
    },
  };
}
