import type { Session } from './session.js';
import type { WatchReport } from './types.js';

export interface Watch {
  id: number;
  /** Hits so far; the watch keeps running. */
  poll(): Promise<WatchReport>;
  /** Ends the watch and returns its final report. */
  stop(): Promise<WatchReport>;
  /**
   * Called once when the watch ends by itself (timeout, max_hits, process_exited, detached).
   * Not called after `stop()`. Fires immediately if the watch already ended.
   */
  onEnded(cb: (reason: string) => void): void;
}

/** Starts a hardware watchpoint (debug registers on every thread). Time-boxed by the daemon. */
export async function watchStart(
  s: Session,
  o: { address: string; size: 1 | 2 | 4 | 8; kind: 'write' | 'access'; durationMs?: number; maxHits?: number },
): Promise<Watch> {
  // `watch_ended` can arrive in the same chunk as the `watch_start` reply, before this function
  // resumes, so listen first and match the id afterwards.
  const ended = new Map<number, string>();
  let id: number | undefined;
  const cbs: Array<(reason: string) => void> = [];
  const unsubscribe = s.client.onNotification((method, params) => {
    if (method !== 'watch_ended' || typeof params?.id !== 'number') return;
    if (id === undefined) { ended.set(params.id, String(params.reason)); return; }
    if (params.id === id) finish(String(params.reason));
  });
  let endedReason: string | undefined;
  const finish = (reason: string): void => {
    if (endedReason !== undefined) return;
    endedReason = reason;
    unsubscribe();
    for (const cb of cbs.splice(0)) cb(reason);
  };

  try {
    const r = await s.client.call<{ id: number }>('watch_start', {
      handle: s.handle,
      address: o.address,
      size: o.size,
      kind: o.kind,
      ...(o.durationMs !== undefined ? { duration_ms: o.durationMs } : {}),
      ...(o.maxHits !== undefined ? { max_hits: o.maxHits } : {}),
    });
    id = r.id;
  } catch (err) {
    unsubscribe();
    throw err;
  }
  const early = ended.get(id);
  if (early !== undefined) finish(early);

  const watchId = id;
  return {
    id: watchId,
    poll: () => s.client.call<WatchReport>('watch_poll', { id: watchId }),
    async stop() {
      try {
        return await s.client.call<WatchReport>('watch_stop', { id: watchId });
      } finally {
        unsubscribe();
        cbs.length = 0;
      }
    },
    onEnded(cb) {
      if (endedReason !== undefined) cb(endedReason); else cbs.push(cb);
    },
  };
}
