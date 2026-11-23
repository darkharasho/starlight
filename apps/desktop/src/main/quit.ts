// apps/desktop/src/main/quit.ts
//
// The quit sequence (R21). Electron doesn't wait for an async `before-quit`
// handler, so the first `before-quit` holds the quit (`preventDefault`), runs
// the steps in order under an overall time cap, then exits. A `before-quit`
// while the steps run is held too (nothing runs twice); after they finish a
// quit passes straight through.

export interface QuitStep {
  name: string;
  run(): unknown;
}

/** How long the quit sequence may take before Starlight exits anyway. */
export const QUIT_CAP_MS = 3000;

/** Runs each step in order, each best-effort; resolves 'timeout' if they take longer than `capMs`. */
export async function runQuitSteps(
  steps: QuitStep[],
  o: { capMs: number; log?(message: string): void },
): Promise<'done' | 'timeout'> {
  let timedOut = false;
  const all = (async () => {
    for (const step of steps) {
      if (timedOut) return;
      try {
        await step.run();
      } catch (err) {
        o.log?.(`[quit] ${step.name} failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  })();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cap = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => { timedOut = true; resolve('timeout'); }, o.capMs);
  });
  try {
    return await Promise.race([all.then(() => 'done' as const), cap]);
  } finally {
    clearTimeout(timer);
  }
}

export function createBeforeQuit(o: {
  steps(): QuitStep[];
  exit(): void;
  capMs?: number;
  log?(message: string): void;
}): (e: { preventDefault(): void }) => void {
  let state: 'idle' | 'running' | 'done' = 'idle';
  return (e) => {
    if (state === 'done') return;
    e.preventDefault();
    if (state === 'running') return;
    state = 'running';
    void runQuitSteps(o.steps(), { capMs: o.capMs ?? QUIT_CAP_MS, ...(o.log ? { log: o.log } : {}) })
      .then((r) => { if (r === 'timeout') o.log?.('[quit] cleanup took too long; exiting anyway'); })
      .finally(() => {
        state = 'done';
        o.exit();
      });
  };
}
