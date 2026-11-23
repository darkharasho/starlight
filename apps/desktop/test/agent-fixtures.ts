import type { AgentSnapshot } from '../src/shared/ipc.js';

export function snap(over: Partial<AgentSnapshot> = {}): AgentSnapshot {
  return {
    status: 'attached',
    client: { label: 'Claude', name: 'claude-code' },
    approval: null,
    game: { pid: 1, name: 'Hades', key: 'hades', proton: true, steamAppId: 1145360, buildId: null },
    canModify: true,
    questions: [],
    live: { freezes: [], tests: [], watches: [], speed: 1 },
    activity: [],
    ...over,
  };
}
