import frida from 'frida';
import { AttachError, PermissionError } from './errors.js';

export interface Session {
  readonly pid: number;
  readonly attached: boolean;
  readonly fridaSession: frida.Session;
  detach(): Promise<void>;
}

export async function attach(pid: number): Promise<Session> {
  let fridaSession: frida.Session;
  try {
    fridaSession = await frida.attach(pid);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/permission|ptrace|EPERM/i.test(msg)) {
      throw new PermissionError(`cannot attach to pid ${pid}: ${msg}`, err);
    }
    throw new AttachError(`failed to attach to pid ${pid}: ${msg}`, err);
  }

  let attached = true;
  fridaSession.detached.connect(() => { attached = false; });

  return {
    pid,
    get attached() { return attached; },
    fridaSession,
    detach: async () => {
      if (!attached) return;
      await fridaSession.detach();
      attached = false;
    },
  };
}
