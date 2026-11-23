// apps/desktop/src/main/agent/target-guard.ts
//
// Which processes the agent may ask to attach to (I5). starlightd holds
// cap_sys_ptrace, which passes the kernel's same-user check, so an approved
// attach to a root or another user's process would hand the agent that
// process's memory. The agent also must not reach Starlight itself (its main
// process, the daemon, its helpers), where a write could defeat the approval
// and switch gates. So, before asking the player:
//   - every uid of the process (real, effective, saved, filesystem) must be ours;
//   - the process must not be Starlight's main process or the daemon, nor a
//     descendant of Starlight in Starlight's own session. Games Starlight starts
//     are spawned detached (their own session), so they stay allowed.
import { readFile } from 'node:fs/promises';

export const NOT_YOURS = "That process isn't one of your games; Starlight only attaches to programs you started.";
export const IS_STARLIGHT = "That's part of Starlight itself, not a game. Pick the game from list_games.";
export const GONE = "That process isn't running any more. Call list_games for the running games.";

export interface TargetGuardDeps {
  /** `/proc/<pid>/status`. */
  readStatus(pid: number): Promise<string>;
  /** `/proc/<pid>/stat`. */
  readStat(pid: number): Promise<string>;
  uid: number;
  selfPid: number;
  daemonPid(): number | null;
}

const MAX_DEPTH = 64;

function uids(status: string): number[] | null {
  const m = /^Uid:\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*$/m.exec(status);
  return m ? [m[1], m[2], m[3], m[4]].map(Number) : null;
}

/** `ppid` and `session` from /proc/<pid>/stat (the name may hold spaces and parentheses). */
function parentAndSession(stat: string): { ppid: number; sid: number } | null {
  const rest = stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\s+/);
  // state ppid pgrp session …
  const ppid = Number(rest[1]);
  const sid = Number(rest[3]);
  return Number.isInteger(ppid) && Number.isInteger(sid) ? { ppid, sid } : null;
}

/** A refusal message, or null when the agent may ask to attach to `pid`. */
export async function checkAttachTarget(pid: number, deps: TargetGuardDeps): Promise<string | null> {
  if (pid === deps.selfPid || pid === deps.daemonPid()) return IS_STARLIGHT;

  let status: string;
  let stat: string;
  try {
    [status, stat] = await Promise.all([deps.readStatus(pid), deps.readStat(pid)]);
  } catch {
    return GONE;
  }
  const ids = uids(status);
  if (!ids || ids.some((u) => u !== deps.uid)) return NOT_YOURS;

  const target = parentAndSession(stat);
  if (!target) return GONE;
  let self: { ppid: number; sid: number } | null;
  try { self = parentAndSession(await deps.readStat(deps.selfPid)); } catch { self = null; }
  if (!self) return null;  // can't tell; the uid check above is the security boundary
  if (target.sid !== self.sid) return null;

  // Same session as Starlight: refuse if Starlight is an ancestor.
  let ppid = target.ppid;
  for (let i = 0; i < MAX_DEPTH && ppid > 1; i++) {
    if (ppid === deps.selfPid) return IS_STARLIGHT;
    let next: { ppid: number; sid: number } | null;
    try { next = parentAndSession(await deps.readStat(ppid)); } catch { return null; }
    if (!next) return null;
    ppid = next.ppid;
  }
  return null;
}

/** The real /proc readers, for this process. */
export function procTargetDeps(o: { daemonPid(): number | null }): TargetGuardDeps {
  return {
    readStatus: (pid) => readFile(`/proc/${pid}/status`, 'utf8'),
    readStat: (pid) => readFile(`/proc/${pid}/stat`, 'utf8'),
    uid: process.getuid?.() ?? -1,
    selfPid: process.pid,
    daemonPid: o.daemonPid,
  };
}
