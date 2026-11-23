// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { checkAttachTarget, IS_STARLIGHT, NOT_YOURS, procTargetDeps, type TargetGuardDeps } from '../../../src/main/agent/target-guard.js';

interface FakeProc { uid: number | number[]; ppid: number; sid: number }

/** A fake /proc: pid → owner, parent and session. */
function fake(procs: Record<number, FakeProc>, o: { uid?: number; selfPid?: number; daemonPid?: number | null } = {}): TargetGuardDeps {
  const get = (pid: number): FakeProc => {
    const p = procs[pid];
    if (!p) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    return p;
  };
  return {
    uid: o.uid ?? 1000,
    selfPid: o.selfPid ?? 100,
    daemonPid: () => o.daemonPid ?? null,
    async readStatus(pid) {
      const p = get(pid);
      const u = Array.isArray(p.uid) ? p.uid : [p.uid, p.uid, p.uid, p.uid];
      return `Name:\tx\nPPid:\t${p.ppid}\nUid:\t${u.join('\t')}\nGid:\t1000\t1000\t1000\t1000\n`;
    },
    async readStat(pid) {
      const p = get(pid);
      return `${pid} (a (weird) name) S ${p.ppid} ${pid} ${p.sid} 0 -1 4194304`;
    },
  };
}

const BASE: Record<number, FakeProc> = {
  1: { uid: 0, ppid: 0, sid: 1 },
  50: { uid: 1000, ppid: 1, sid: 50 },     // the player's session leader
  100: { uid: 1000, ppid: 50, sid: 50 },   // Starlight's main process
  101: { uid: 1000, ppid: 100, sid: 50 },  // an Electron helper
  102: { uid: 1000, ppid: 100, sid: 50 },  // starlightd
  103: { uid: 1000, ppid: 101, sid: 50 },  // a helper's child
  200: { uid: 1000, ppid: 100, sid: 200 }, // a game Starlight launched (detached: own session)
  300: { uid: 1000, ppid: 50, sid: 50 },   // a game the player started
  400: { uid: 0, ppid: 1, sid: 400 },      // sshd
  401: { uid: [1000, 0, 0, 0], ppid: 50, sid: 50 },     // a setuid-root program
  402: { uid: [1000, 1000, 0, 1000], ppid: 50, sid: 50 }, // can regain root
  500: { uid: 1001, ppid: 1, sid: 500 },   // another user's game
};

describe('attach target guard (I5)', () => {
  it("allows the player's own game, and a game Starlight launched", async () => {
    expect(await checkAttachTarget(300, fake(BASE))).toBeNull();
    expect(await checkAttachTarget(200, fake(BASE))).toBeNull();
  });

  it('refuses a process owned by another user or root', async () => {
    expect(await checkAttachTarget(400, fake(BASE))).toBe(NOT_YOURS);
    expect(await checkAttachTarget(500, fake(BASE))).toBe(NOT_YOURS);
    expect(await checkAttachTarget(401, fake(BASE))).toBe(NOT_YOURS);
    expect(await checkAttachTarget(402, fake(BASE))).toBe(NOT_YOURS);
  });

  it("refuses Starlight's own process, the daemon and its helpers", async () => {
    expect(await checkAttachTarget(100, fake(BASE))).toBe(IS_STARLIGHT);
    expect(await checkAttachTarget(102, fake(BASE, { daemonPid: 102 }))).toBe(IS_STARLIGHT);
    expect(await checkAttachTarget(101, fake(BASE))).toBe(IS_STARLIGHT);
    expect(await checkAttachTarget(103, fake(BASE))).toBe(IS_STARLIGHT);
  });

  it("refuses a process it can't read", async () => {
    expect(await checkAttachTarget(999, fake(BASE))).toMatch(/isn't running/);
  });

  it("the real /proc reader refuses Starlight's own pid", async () => {
    // Reads only this test process's own /proc entries.
    expect(await checkAttachTarget(process.pid, procTargetDeps({ daemonPid: () => null }))).toBe(IS_STARLIGHT);
  });
});
