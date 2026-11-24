// Process tracking shared by the live-check scripts (live-m2/m3/m4).
//
// The user's games run alongside these checks, so /proc is read only for processes we started:
// a tree is built by walking /proc/<pid>/task/<tid>/children down from our own roots, never by
// scanning every process on the machine. The child-subreaper wrapper keeps daemonized
// descendants (wine, wineserver, dbus services) under our root, so the walk still finds them.
import { readdirSync, readFileSync } from 'node:fs';

/** state, ppid, start time and comm of `pid` (only ever called for our own pids). */
export function statOf(pid) {
  try {
    const s = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const rest = s.slice(s.lastIndexOf(')') + 2).split(' ');
    return { state: rest[0], ppid: Number(rest[1]), start: rest[19], comm: s.slice(s.indexOf('(') + 1, s.lastIndexOf(')')) };
  } catch { return null; }
}

/** Direct children of `pid`, from each of its threads' `children` list. */
export function childrenOf(pid) {
  const out = new Set();
  let tids = [];
  try { tids = readdirSync(`/proc/${pid}/task`); } catch { return []; }
  for (const tid of tids) {
    let text = '';
    try { text = readFileSync(`/proc/${pid}/task/${tid}/children`, 'utf8'); } catch { continue; }
    for (const c of text.trim().split(/\s+/)) if (/^\d+$/.test(c)) out.add(Number(c));
  }
  return [...out];
}

/**
 * Grows `owned` (pid -> start time) with the descendants of its live entries. An entry whose pid
 * now has another start time (or is gone) is dropped first, so a recycled pid is never a root.
 */
export function trackOwned(owned) {
  for (const [p, start] of owned) if (statOf(p)?.start !== start) owned.delete(p);
  const queue = [...owned.keys()];
  while (queue.length) {
    const parent = queue.shift();
    for (const c of childrenOf(parent)) {
      if (owned.has(c)) continue;
      // Still that parent's child (it may have exited and its pid been reused since the read).
      const st = statOf(c);
      if (!st || st.ppid !== parent) continue;
      owned.set(c, st.start);
      queue.push(c);
    }
  }
}

/** Python `descendants()` for the subreaper wrapper: the same walk, down from the wrapper itself. */
export const PY_DESCENDANTS = `
def children_of(pid):
    out = set()
    try: tids = os.listdir('/proc/%d/task' % pid)
    except Exception: return []
    for tid in tids:
        try: out.update(int(c) for c in open('/proc/%d/task/%s/children' % (pid, tid)).read().split())
        except Exception: pass
    return list(out)
def descendants():
    out, q = [], [os.getpid()]
    while q:
        for c in children_of(q.pop()):
            if c not in out:
                out.append(c); q.append(c)
    return out
`;
