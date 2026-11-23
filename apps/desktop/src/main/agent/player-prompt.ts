// apps/desktop/src/main/agent/player-prompt.ts
//
// What the agent asks the player. This part is attach approval: one request at
// a time, shown in the app (approval card) and as a desktop notification, and
// resolved by Allow/Deny, a timeout, or Stop.
import { randomUUID } from 'node:crypto';
import type { PendingApproval } from '../../shared/ipc.js';
import type { Notifier } from './notifier.js';

export type { PendingApproval };

export type ApprovalResult = 'allow' | 'deny' | 'timeout' | 'stopped';

export interface PlayerPrompts {
  requestApproval(a: { label: string; game: string; pid: number; closesCeTable: boolean; timeoutMs: number }): Promise<ApprovalResult>;
  /** True when `id` was the pending request (it is answered now). */
  respondApproval(id: string, allow: boolean): boolean;
  approval(): PendingApproval | null;
  /** Resolves everything pending as `stopped`. */
  cancelAll(): void;
}

export interface PlayerPromptsDeps {
  notifier: Notifier;
  focusAgentView(): void;
  onChange(): void;
  now?(): number;
}

export const approvalTitle = (label: string, game: string): string => `${label} wants to attach to ${game}`;
export const approvalBody = (closesCeTable: boolean): string =>
  `Allow it in Starlight.${closesCeTable ? ' This closes the current Cheat Engine table.' : ''}`;

interface Pending {
  info: PendingApproval;
  resolve(r: ApprovalResult): void;
}

export function createPlayerPrompts(deps: PlayerPromptsDeps): PlayerPrompts {
  const now = deps.now ?? Date.now;
  let pending: Pending | null = null;

  const settle = (p: Pending, r: ApprovalResult): void => {
    if (pending !== p) return;
    pending = null;
    p.resolve(r);
    deps.onChange();
  };

  return {
    requestApproval(a) {
      // One request at a time; the session refuses a second agent before it gets here.
      if (pending) settle(pending, 'stopped');
      return new Promise<ApprovalResult>((resolve) => {
        const info: PendingApproval = {
          id: randomUUID(), label: a.label, game: a.game, pid: a.pid, closesCeTable: a.closesCeTable,
          expiresAt: now() + a.timeoutMs,
        };
        let note: { close(): void } | null = null;
        const timer = setTimeout(() => settle(p, 'timeout'), a.timeoutMs);
        const p: Pending = {
          info,
          resolve: (r) => {
            clearTimeout(timer);
            try { note?.close(); } catch { /* gone */ }
            resolve(r);
          },
        };
        pending = p;
        try {
          note = deps.notifier.show({
            title: approvalTitle(a.label, a.game),
            body: approvalBody(a.closesCeTable),
            onClick: () => deps.focusAgentView(),
          });
        } catch { /* the in-app card still shows */ }
        deps.onChange();
      });
    },
    respondApproval(id, allow) {
      if (!pending || pending.info.id !== id) return false;
      settle(pending, allow ? 'allow' : 'deny');
      return true;
    },
    approval() {
      return pending ? { ...pending.info } : null;
    },
    cancelAll() {
      if (pending) settle(pending, 'stopped');
    },
  };
}
