import { create } from 'zustand';
import { starlight } from '../ipc-client.js';
import type { AgentSnapshot } from '../../shared/ipc.js';

// Mirrors the main process's agent session (attach approval, questions, live
// changes, activity). Main pushes a full snapshot on every change.

interface AgentState {
  state: AgentSnapshot | null;
  load: () => Promise<void>;
  respond: (allow: boolean) => Promise<void>;
  answer: (id: string, value: number | boolean | string) => Promise<{ ok: boolean; error?: string }>;
  setCanModify: (on: boolean) => Promise<void>;
  stop: () => Promise<void>;
}

export const useAgentStore = create<AgentState>((set, get) => ({
  state: null,
  load: async () => {
    try { set({ state: await starlight().agentGetState() }); } catch { /* keep the last snapshot */ }
  },
  respond: async (allow) => {
    const id = get().state?.approval?.id;
    if (id) await starlight().agentRespondApproval({ id, allow });
  },
  answer: async (id, value) => {
    try {
      return await starlight().agentAnswer({ id, value });
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  },
  setCanModify: async (on) => { await starlight().agentSetCanModify({ on }); },
  stop: async () => { await starlight().agentStop(); },
}));

/** Follows the main process's agent session. Returns the unsubscribe. */
export function attachAgentEvents(): () => void {
  void useAgentStore.getState().load();
  return starlight().onEvent((e) => {
    if (e.type === 'agent:state') useAgentStore.setState({ state: e.state });
  });
}
