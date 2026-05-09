import { attach as engineAttach, type Session, AttachError, PermissionError } from '@starlight/engine';
import type { AttachResult } from '../shared/ipc.js';

let session: Session | null = null;

export function currentSession(): Session | null { return session; }

export async function attach(pid: number): Promise<AttachResult> {
  if (session) await detach();
  try {
    session = await engineAttach(pid);
    return { ok: true };
  } catch (err) {
    if (err instanceof PermissionError) {
      return { ok: false, code: 'permission', message: err.message };
    }
    if (err instanceof AttachError) {
      return { ok: false, code: 'not-found', message: err.message };
    }
    return { ok: false, code: 'unknown', message: err instanceof Error ? err.message : String(err) };
  }
}

export async function detach(): Promise<void> {
  if (!session) return;
  try { await session.detach(); }
  catch { /* swallow — frida already detached */ }
  session = null;
}

/** Returns true if a session is alive. */
export function isAttached(): boolean {
  return session !== null && session.attached;
}
