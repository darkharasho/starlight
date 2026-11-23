import { readFile } from 'node:fs/promises';
import defaultSignatures from './anti-cheat-signatures.json';

export interface AntiCheatSignature {
  name: string;
  /** Regex sources, matched case-insensitively against the mapped file's basename. */
  patterns: string[];
}

export interface AntiCheatHit { name: string; module: string }

/** Path of a /proc/<pid>/maps line: everything after address, perms, offset, dev, inode. */
function mapsPath(line: string): string | null {
  const m = /^\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+(.*)$/.exec(line);
  const path = m?.[1]?.replace(/ \(deleted\)$/, '').trim();
  return path ? path : null;
}

export function findAntiCheat(
  mapsText: string,
  sigs: AntiCheatSignature[] = defaultSignatures,
): AntiCheatHit | null {
  const compiled = sigs.map((s) => ({ name: s.name, res: s.patterns.map((p) => new RegExp(p, 'i')) }));
  for (const line of mapsText.split('\n')) {
    const path = mapsPath(line);
    if (!path) continue;
    const base = path.slice(path.lastIndexOf('/') + 1);
    for (const sig of compiled) {
      if (sig.res.some((re) => re.test(base))) return { name: sig.name, module: base };
    }
  }
  return null;
}

export async function detectAntiCheat(
  pid: number,
  readMaps: (pid: number) => Promise<string> = (p) => readFile(`/proc/${p}/maps`, 'utf8'),
): Promise<AntiCheatHit | null> {
  let text: string;
  try { text = await readMaps(pid); } catch { return null; }
  return findAntiCheat(text);
}

export function antiCheatMessage(hit: AntiCheatHit): string {
  return `${hit.name} is running in this game, so Starlight won't attach. Starlight only works with single-player games that don't have anti-cheat running.`;
}
