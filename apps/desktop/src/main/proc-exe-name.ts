// apps/desktop/src/main/proc-exe-name.ts
//
// Linux truncates a process's `comm` (what ps-list reports as `name`) to
// TASK_COMM_LEN-1 = 15 chars, so "RSDragonwilds.exe" arrives as
// "RSDragonwilds.e". That truncated name breaks exe-name matching and, worse,
// gets handed to Windows CE's openProcess() which then can't find the process.
//
// The full, untruncated exe name is available in /proc/<pid>/cmdline. This
// module recovers it. Proton game processes carry a Windows-style argv[0] such
// as `S:\common\RSDragonwilds\RSDragonwilds.exe`, so we split on both `/` and
// `\` to get the basename.
import { readFile } from 'node:fs/promises';

const COMM_MAX = 15; // TASK_COMM_LEN - 1

function basename(p: string): string {
  const parts = p.split(/[/\\]/);
  return parts[parts.length - 1] ?? p;
}

/**
 * Recover the full exe name from a raw /proc/<pid>/cmdline string (NUL-separated
 * argv). Returns the basename of the `.exe` token that corresponds to this
 * process, or null if none is present.
 *
 * When `comm` (the possibly-truncated process name) is given, we prefer the
 * `.exe` token whose 15-char-truncated basename equals it — that pins the exact
 * argument belonging to this process even when argv contains several exes (e.g.
 * a launcher exe followed by the game exe). Otherwise we fall back to the last
 * `.exe` token, which for a game process is normally argv[0].
 */
export function exeNameFromCmdline(cmdline: string, comm?: string): string | null {
  const tokens = cmdline.split('\0').filter(Boolean);
  const exes = tokens.map(basename).filter((b) => /\.exe$/i.test(b));
  if (exes.length === 0) return null;
  if (comm) {
    const c = comm.toLowerCase();
    const match = exes.find((b) => b.slice(0, COMM_MAX).toLowerCase() === c);
    if (match) return match;
  }
  return exes[exes.length - 1]!;
}

/**
 * Read the full exe name for a running pid from /proc/<pid>/cmdline. Falls back
 * to `comm` (the caller's possibly-truncated name) when cmdline yields no `.exe`
 * token, and to null only when both are unavailable.
 */
export async function readExeName(pid: number, comm?: string): Promise<string | undefined> {
  try {
    const cmdline = await readFile(`/proc/${pid}/cmdline`, 'utf8');
    const name = exeNameFromCmdline(cmdline, comm);
    if (name) return name;
  } catch {
    // fall through to comm
  }
  return comm;
}
