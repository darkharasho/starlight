// Starlight's stdout/stderr can be a pipe nobody reads any more: launched from
// a desktop launcher, an AppImage wrapper or a terminal that has since closed.
// A console.log then fails with EPIPE, which Node reports as an 'error' event
// on the stream; with no listener that is an uncaught exception, and Electron
// shows a blocking error box for it (which also freezes the main process, so
// the window's own close button stops responding). Logging must never crash
// the app, so a lost console is ignored.

import type { EventEmitter } from 'node:events';

const LOST_CONSOLE = new Set(['EPIPE', 'EIO', 'ERR_STREAM_DESTROYED']);

/** Whether a stdio stream error only means nobody can read the output any more. */
export function isLostConsoleError(e: unknown): boolean {
  const code = (e as { code?: unknown } | null)?.code;
  return typeof code === 'string' && LOST_CONSOLE.has(code);
}

/**
 * Ignores lost-console errors on the given streams (default stdout and stderr).
 * Any other stream error is still thrown, as it would have been without the guard.
 */
export function guardStdio(
  streams: EventEmitter[] = [process.stdout, process.stderr],
  rethrow: (e: unknown) => void = (e) => {
    throw e;
  },
): void {
  for (const s of streams) {
    s.on('error', (e: unknown) => {
      if (!isLostConsoleError(e)) rethrow(e);
    });
  }
}
