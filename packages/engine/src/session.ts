import type { EngineClient } from './client.js';

export type DetachReason = 'process-exit' | 'manual';

export interface Session {
  readonly pid: number;
  readonly handle: number;
  readonly attached: boolean;
  readonly client: EngineClient;
  detach(): Promise<void>;
  onDetached(cb: (reason: DetachReason) => void): void;
}

export async function attach(client: EngineClient, pid: number): Promise<Session> {
  const { handle } = await client.call<{ handle: number }>('attach', { pid });

  let attached = true;
  const cbs: Array<(reason: DetachReason) => void> = [];
  const markDetached = (reason: DetachReason): void => {
    if (!attached) return;
    attached = false;
    unsubscribe();
    for (const cb of cbs) cb(reason);
  };

  const unsubscribe = client.onNotification((method, params) => {
    if (method === 'process_exited' && params?.handle === handle) markDetached('process-exit');
  });
  client.onClose(() => markDetached('process-exit'));

  return {
    pid,
    handle,
    client,
    get attached() { return attached; },
    async detach() {
      if (!attached) return;
      try {
        await client.call('detach', { handle });
      } finally {
        markDetached('manual');
      }
    },
    onDetached(cb) { cbs.push(cb); },
  };
}
