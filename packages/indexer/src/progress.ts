import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export interface ProgressCounters {
  added: number;
  updated: number;
  unchanged: number;
  failed: number;
  skipped: number;
}

export interface ProgressSnapshot {
  phase: string;
  current: number;
  total: number | null;
  label: string | null;
  counters: ProgressCounters;
  startedAt: string;
  updatedAt: string;
  elapsedMs: number;
  etaMs: number | null;
  lastError: string | null;
  done: boolean;
}

export interface ProgressOpts {
  phase: string;
  total?: number | null;
  statusPath?: string | null;
  /** Force-output mode. Defaults to detecting `process.stderr.isTTY`. */
  tty?: boolean;
  /** When non-TTY, print a line every N ticks. Default 10. */
  lineEvery?: number;
  /** Stream to write user-visible progress to. Default `process.stderr`. */
  stream?: NodeJS.WritableStream & { isTTY?: boolean };
  /** Clock injection for tests. */
  now?: () => number;
}

export class Progress {
  private readonly phase: string;
  private total: number | null;
  private current = 0;
  private label: string | null = null;
  private readonly counters: ProgressCounters = {
    added: 0, updated: 0, unchanged: 0, failed: 0, skipped: 0,
  };
  private readonly startMs: number;
  private lastError: string | null = null;
  private readonly statusPath: string | null;
  private readonly stream: NodeJS.WritableStream & { isTTY?: boolean };
  private readonly tty: boolean;
  private readonly lineEvery: number;
  private readonly nowFn: () => number;
  private lastDrawnLength = 0;
  private finished = false;

  constructor(opts: ProgressOpts) {
    this.phase = opts.phase;
    this.total = opts.total ?? null;
    this.statusPath = opts.statusPath ?? null;
    this.stream = opts.stream ?? process.stderr;
    this.tty = opts.tty ?? Boolean(this.stream.isTTY);
    this.lineEvery = opts.lineEvery ?? 10;
    this.nowFn = opts.now ?? Date.now;
    this.startMs = this.nowFn();
  }

  setTotal(total: number | null): void {
    this.total = total;
  }

  bump(kind: keyof ProgressCounters, n = 1): void {
    this.counters[kind] += n;
  }

  noteError(message: string): void {
    this.lastError = message;
  }

  async tick(label?: string): Promise<void> {
    this.current += 1;
    if (label !== undefined) this.label = label;
    await this.flush();
  }

  async update(label?: string): Promise<void> {
    if (label !== undefined) this.label = label;
    await this.flush();
  }

  async done(label?: string): Promise<void> {
    this.finished = true;
    if (label !== undefined) this.label = label;
    await this.flush(true);
    if (this.tty) this.stream.write('\n');
  }

  snapshot(): ProgressSnapshot {
    const now = this.nowFn();
    const elapsedMs = now - this.startMs;
    let etaMs: number | null = null;
    if (this.total !== null && this.current > 0 && this.current < this.total) {
      const perItem = elapsedMs / this.current;
      etaMs = Math.round(perItem * (this.total - this.current));
    }
    return {
      phase: this.phase,
      current: this.current,
      total: this.total,
      label: this.label,
      counters: { ...this.counters },
      startedAt: new Date(this.startMs).toISOString(),
      updatedAt: new Date(now).toISOString(),
      elapsedMs,
      etaMs,
      lastError: this.lastError,
      done: this.finished,
    };
  }

  private async flush(force = false): Promise<void> {
    const snap = this.snapshot();
    this.render(snap, force);
    if (this.statusPath !== null) await writeStatus(this.statusPath, snap);
  }

  private render(snap: ProgressSnapshot, force: boolean): void {
    if (this.tty) {
      const line = formatLine(snap);
      const padded = line.padEnd(this.lastDrawnLength, ' ');
      this.stream.write(`\r${padded}`);
      this.lastDrawnLength = line.length;
      return;
    }
    if (!force && snap.current > 0 && snap.current % this.lineEvery !== 0) return;
    this.stream.write(`${formatLine(snap)}\n`);
  }
}

function formatLine(s: ProgressSnapshot): string {
  const parts: string[] = [];
  parts.push(`[${s.phase}]`);
  parts.push(s.total !== null ? `${s.current}/${s.total}` : `${s.current}`);
  const c = s.counters;
  const cBits: string[] = [];
  if (c.added) cBits.push(`+${c.added}`);
  if (c.updated) cBits.push(`~${c.updated}`);
  if (c.unchanged) cBits.push(`=${c.unchanged}`);
  if (c.skipped) cBits.push(`·${c.skipped}`);
  if (c.failed) cBits.push(`!${c.failed}`);
  if (cBits.length > 0) parts.push(cBits.join(' '));
  parts.push(formatDuration(s.elapsedMs));
  if (s.etaMs !== null) parts.push(`ETA ${formatDuration(s.etaMs)}`);
  if (s.label) parts.push(`· ${s.label}`);
  return parts.join(' ');
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const secs = Math.round(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  const rem = secs % 60;
  if (mins < 60) return `${mins}m${rem.toString().padStart(2, '0')}s`;
  const hrs = Math.floor(mins / 60);
  return `${hrs}h${(mins % 60).toString().padStart(2, '0')}m`;
}

async function writeStatus(path: string, snap: ProgressSnapshot): Promise<void> {
  await mkdir(dirname(path), { recursive: true }).catch(() => {});
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  try {
    await writeFile(tmp, JSON.stringify(snap, null, 2) + '\n', 'utf8');
    await rename(tmp, path);
  } catch {
    /* status file is best-effort; never fail the run for it */
  }
}
