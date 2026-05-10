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
  /** Force colors on/off. Defaults to TTY && !NO_COLOR. */
  color?: boolean;
  /** Clock injection for tests. */
  now?: () => number;
}

const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const BAR_WIDTH = 24;
const BAR_FILLED = '█';
const BAR_EMPTY = '░';

interface Style {
  reset: string;
  bold: (s: string) => string;
  dim: (s: string) => string;
  cyan: (s: string) => string;
  green: (s: string) => string;
  yellow: (s: string) => string;
  red: (s: string) => string;
  magenta: (s: string) => string;
  gray: (s: string) => string;
}

function makeStyle(enabled: boolean): Style {
  if (!enabled) {
    const id = (s: string): string => s;
    return { reset: '', bold: id, dim: id, cyan: id, green: id, yellow: id, red: id, magenta: id, gray: id };
  }
  const wrap = (code: string) => (s: string): string => `\x1b[${code}m${s}\x1b[0m`;
  return {
    reset: '\x1b[0m',
    bold: wrap('1'),
    dim: wrap('2'),
    cyan: wrap('36'),
    green: wrap('32'),
    yellow: wrap('33'),
    red: wrap('31'),
    magenta: wrap('35'),
    gray: wrap('90'),
  };
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
  private readonly style: Style;
  private lastDrawnVisibleWidth = 0;
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
    const colorOn = opts.color ?? (this.tty && !process.env.NO_COLOR);
    this.style = makeStyle(colorOn);
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
    if (this.tty) {
      // Clear the live line, then print a multi-line summary.
      this.stream.write('\r' + ' '.repeat(this.lastDrawnVisibleWidth) + '\r');
      this.stream.write(this.formatSummary(this.snapshot()) + '\n');
    }
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
      const { line, visibleWidth } = this.formatLiveLine(snap);
      const pad = Math.max(0, this.lastDrawnVisibleWidth - visibleWidth);
      this.stream.write('\r' + line + ' '.repeat(pad));
      this.lastDrawnVisibleWidth = visibleWidth;
      return;
    }
    if (!force && snap.current > 0 && snap.current % this.lineEvery !== 0) return;
    this.stream.write(`${formatPlainLine(snap)}\n`);
  }

  /** TTY live line: spinner · phase · bar · counts · timing · label. */
  private formatLiveLine(s: ProgressSnapshot): { line: string; visibleWidth: number } {
    const c = this.style;
    const parts: { vis: string; col: string }[] = [];

    const glyph = s.done
      ? (s.counters.failed > 0 ? '✗' : '✓')
      : SPINNER[Math.floor(this.nowFn() / 80) % SPINNER.length]!;
    const glyphColor = s.done
      ? (s.counters.failed > 0 ? c.red(glyph) : c.green(glyph))
      : c.cyan(glyph);
    parts.push({ vis: glyph, col: glyphColor });

    parts.push({ vis: this.phase, col: c.bold(this.phase) });

    if (s.total !== null && s.total > 0) {
      const pct = Math.min(1, s.current / s.total);
      const filled = Math.round(BAR_WIDTH * pct);
      const bar = BAR_FILLED.repeat(filled) + BAR_EMPTY.repeat(BAR_WIDTH - filled);
      const barCol = c.cyan(BAR_FILLED.repeat(filled)) + c.dim(BAR_EMPTY.repeat(BAR_WIDTH - filled));
      const pctText = ` ${(pct * 100).toFixed(0).padStart(3)}%`;
      parts.push({ vis: bar + pctText, col: barCol + c.dim(pctText) });
    }

    const ratio = s.total !== null ? `${s.current}/${s.total}` : `${s.current}`;
    parts.push({ vis: ratio, col: c.bold(ratio) });

    const counterStr = formatCounters(s.counters, c);
    if (counterStr.vis.length > 0) parts.push(counterStr);

    const elapsed = formatDuration(s.elapsedMs);
    parts.push({ vis: elapsed, col: c.dim(elapsed) });
    if (s.etaMs !== null) {
      const eta = `ETA ${formatDuration(s.etaMs)}`;
      parts.push({ vis: eta, col: c.dim(eta) });
    }

    if (s.label) {
      const truncated = s.label.length > 60 ? s.label.slice(0, 57) + '…' : s.label;
      parts.push({ vis: truncated, col: c.gray(truncated) });
    }

    const sep = '  ';
    const line = parts.map(p => p.col).join(sep);
    const visibleWidth = parts.map(p => p.vis).join(sep).length;
    return { line, visibleWidth };
  }

  /** Multi-line completion summary on TTY. */
  private formatSummary(s: ProgressSnapshot): string {
    const c = this.style;
    const ok = s.counters.failed === 0;
    const head = ok
      ? `${c.green('✓')}  ${c.bold(this.phase + ' complete')}`
      : `${c.red('✗')}  ${c.bold(this.phase + ' finished with errors')}`;

    const lines: string[] = [head];
    const total = s.total !== null ? `${s.current}/${s.total}` : `${s.current}`;
    const counterText = formatCounters(s.counters, c).col || c.dim('no items');
    lines.push(c.dim('   ') + total + '  ' + counterText);
    const timing: string[] = [`elapsed ${formatDuration(s.elapsedMs)}`];
    if (s.label) timing.push(s.label);
    lines.push(c.dim('   ') + c.dim(timing.join('  ')));
    if (s.lastError) {
      lines.push(c.dim('   ') + c.red('last error: ') + c.dim(truncate(s.lastError, 100)));
    }
    return lines.join('\n');
  }
}

function formatCounters(c: ProgressCounters, st: Style): { vis: string; col: string } {
  const items: { vis: string; col: string }[] = [];
  if (c.added)     items.push({ vis: `+${c.added} added`,         col: st.green(`+${c.added} added`) });
  if (c.updated)   items.push({ vis: `~${c.updated} updated`,     col: st.yellow(`~${c.updated} updated`) });
  if (c.unchanged) items.push({ vis: `=${c.unchanged} unchanged`, col: st.dim(`=${c.unchanged} unchanged`) });
  if (c.skipped)   items.push({ vis: `·${c.skipped} skipped`,     col: st.dim(`·${c.skipped} skipped`) });
  if (c.failed)    items.push({ vis: `!${c.failed} failed`,       col: st.red(`!${c.failed} failed`) });
  const sep = '  ';
  return { vis: items.map(i => i.vis).join(sep), col: items.map(i => i.col).join(sep) };
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

/** Plain text format used for non-TTY (CI / piped) output. */
function formatPlainLine(s: ProgressSnapshot): string {
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
