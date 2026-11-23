// apps/desktop/src/main/agent/player-prompt.ts
//
// What the agent asks the player: attach approval and ask_player questions.
// One of each at a time, shown in the app and as a desktop notification, and
// resolved by the player, a timeout, Stop, or (questions) the agent's request
// being aborted. The yes/no hotkeys are bound only while a confirm question waits.
import { randomUUID } from 'node:crypto';
import type { AgentPreferences, PendingApproval, PendingQuestion } from '../../shared/ipc.js';
import type { AgentHotkeysPort } from '../hotkey-host.js';
import type { Notifier } from './notifier.js';
import { QUESTION_WAITING, ToolError } from './tools.js';

export type { PendingApproval, PendingQuestion };

export type ApprovalResult = 'allow' | 'deny' | 'timeout' | 'stopped';

export type AskResult =
  | { answered: true; answer: number | boolean | string }
  | { answered: false; reason: 'timeout' | 'stopped' };

export interface AskRequest {
  question: string;
  answer: 'number' | 'confirm' | 'choice';
  choices?: string[];
  timeoutMs: number;
  label: string;
  /** Aborted when the agent's request is cancelled: the question is dropped as `stopped`. */
  signal?: AbortSignal;
}

export interface PlayerPrompts {
  ask(q: AskRequest): Promise<AskResult>;
  answer(id: string, value: unknown): { ok: true } | { ok: false; error: string };
  pending(): PendingQuestion[];
  /** `signal`: the agent's request; aborting it (cancel, disconnect) drops the card as `stopped`. */
  requestApproval(a: { label: string; game: string; pid: number; closesCeTable: boolean; timeoutMs: number; signal?: AbortSignal }): Promise<ApprovalResult>;
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
  hotkeys: AgentHotkeysPort;
  prefs(): Promise<AgentPreferences>;
  now?(): number;
}

export const approvalTitle = (label: string, game: string, pid: number): string => `${label} wants to attach to ${game} (process ${pid})`;
export const approvalBody = (closesCeTable: boolean): string =>
  `Allow it in Starlight.${closesCeTable ? ' This closes the current Cheat Engine table.' : ''}`;

interface Pending {
  info: PendingApproval;
  resolve(r: ApprovalResult): void;
}

interface PendingAsk {
  info: PendingQuestion;
  resolve(r: AskResult): void;
}

export function createPlayerPrompts(deps: PlayerPromptsDeps): PlayerPrompts {
  const now = deps.now ?? Date.now;
  let pending: Pending | null = null;
  let question: PendingAsk | null = null;

  const settleQuestion = (q: PendingAsk, r: AskResult): void => {
    if (question !== q) return;
    question = null;
    q.resolve(r);
    deps.onChange();
  };

  const settle = (p: Pending, r: ApprovalResult): void => {
    if (pending !== p) return;
    pending = null;
    p.resolve(r);
    deps.onChange();
  };

  return {
    async ask(a) {
      if (question) throw new ToolError(QUESTION_WAITING);
      if (a.signal?.aborted) return { answered: false, reason: 'stopped' };
      return new Promise<AskResult>((resolve) => {
        const t = now();
        const info: PendingQuestion = {
          id: randomUUID(), question: a.question, answer: a.answer, askedAt: t, expiresAt: t + a.timeoutMs, label: a.label,
          ...(a.choices ? { choices: [...a.choices] } : {}),
        };
        let note: { close(): void } | null = null;
        let closed = false;
        const onAbort = (): void => settleQuestion(q, { answered: false, reason: 'stopped' });
        const timer = setTimeout(() => settleQuestion(q, { answered: false, reason: 'timeout' }), a.timeoutMs);
        const q: PendingAsk = {
          info,
          resolve: (r) => {
            closed = true;
            clearTimeout(timer);
            a.signal?.removeEventListener('abort', onAbort);
            try { note?.close(); } catch { /* gone */ }
            if (a.answer === 'confirm') {
              try { deps.hotkeys.set({ yes: null, no: null }); } catch { /* best-effort */ }
            }
            resolve(r);
          },
        };
        question = q;
        a.signal?.addEventListener('abort', onAbort, { once: true });
        deps.onChange();
        void (async () => {
          let prefs: AgentPreferences | null = null;
          try { prefs = await deps.prefs(); } catch { /* default copy below */ }
          if (closed) return;
          let body = a.question;
          if (a.answer === 'confirm') {
            const yes = prefs?.confirmYes ?? 'Ctrl+Shift+Y';
            const no = prefs?.confirmNo ?? 'Ctrl+Shift+N';
            body += `\nPress ${yes} for yes or ${no} for no.`;
            try {
              deps.hotkeys.set({ yes, no }, {
                yes: () => settleQuestion(q, { answered: true, answer: true }),
                no: () => settleQuestion(q, { answered: true, answer: false }),
              });
            } catch { /* the in-app buttons still work */ }
          } else if (a.answer === 'number') {
            body += '\nSwitch to Starlight to type the number.';
          } else {
            body += `\nSwitch to Starlight to pick: ${(a.choices ?? []).join(' / ')}.`;
          }
          try {
            note = deps.notifier.show({ title: `${a.label} asks`, body, onClick: () => deps.focusAgentView() });
          } catch { /* the in-app card still shows */ }
        })();
      });
    },
    answer(id, value) {
      const q = question;
      if (!q || q.info.id !== id) return { ok: false, error: 'That question was already answered' };
      switch (q.info.answer) {
        case 'number':
          if (typeof value !== 'number' || !Number.isFinite(value)) return { ok: false, error: 'Type a number' };
          break;
        case 'confirm':
          if (typeof value !== 'boolean') return { ok: false, error: 'Answer yes or no' };
          break;
        case 'choice':
          if (typeof value !== 'string' || !(q.info.choices ?? []).includes(value)) return { ok: false, error: 'Pick one of the choices' };
          break;
      }
      settleQuestion(q, { answered: true, answer: value as number | boolean | string });
      return { ok: true };
    },
    pending() {
      return question ? [{ ...question.info, ...(question.info.choices ? { choices: [...question.info.choices] } : {}) }] : [];
    },
    requestApproval(a) {
      // One request at a time; the session refuses a second agent before it gets here.
      if (pending) settle(pending, 'stopped');
      if (a.signal?.aborted) return Promise.resolve('stopped');
      return new Promise<ApprovalResult>((resolve) => {
        const info: PendingApproval = {
          id: randomUUID(), label: a.label, game: a.game, pid: a.pid, closesCeTable: a.closesCeTable,
          expiresAt: now() + a.timeoutMs,
        };
        let note: { close(): void } | null = null;
        const timer = setTimeout(() => settle(p, 'timeout'), a.timeoutMs);
        const onAbort = (): void => settle(p, 'stopped');
        const p: Pending = {
          info,
          resolve: (r) => {
            clearTimeout(timer);
            a.signal?.removeEventListener('abort', onAbort);
            try { note?.close(); } catch { /* gone */ }
            resolve(r);
          },
        };
        pending = p;
        a.signal?.addEventListener('abort', onAbort, { once: true });
        try {
          note = deps.notifier.show({
            title: approvalTitle(a.label, a.game, a.pid),
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
      if (question) settleQuestion(question, { answered: false, reason: 'stopped' });
      if (pending) settle(pending, 'stopped');
    },
  };
}
