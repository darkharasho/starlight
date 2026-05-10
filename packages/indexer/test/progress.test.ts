import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Progress, formatDuration } from '../src/progress.js';

class MemoryStream {
  chunks: string[] = [];
  isTTY: boolean;
  constructor(isTTY: boolean) { this.isTTY = isTTY; }
  write(chunk: string): boolean { this.chunks.push(chunk); return true; }
  text(): string { return this.chunks.join(''); }
}

let dir: string;
let statusPath: string;

beforeEach(async () => {
  dir = join(tmpdir(), `starlight-progress-${Date.now()}-${Math.random()}`);
  await mkdir(dir, { recursive: true });
  statusPath = join(dir, 'status.json');
});
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

describe('Progress', () => {
  it('writes a status file after each tick', async () => {
    const p = new Progress({
      phase: 'discover', total: 3, statusPath,
      stream: new MemoryStream(false) as unknown as NodeJS.WritableStream & { isTTY?: boolean },
      tty: false, lineEvery: 1, now: () => 1000,
    });
    await p.tick('a');
    const s1 = JSON.parse(await readFile(statusPath, 'utf8'));
    expect(s1.phase).toBe('discover');
    expect(s1.current).toBe(1);
    expect(s1.total).toBe(3);
    expect(s1.label).toBe('a');
    expect(s1.done).toBe(false);
  });

  it('marks done=true after done() and writes the final status', async () => {
    const p = new Progress({
      phase: 'index', total: 2, statusPath,
      stream: new MemoryStream(false) as unknown as NodeJS.WritableStream & { isTTY?: boolean },
      tty: false, lineEvery: 1,
    });
    await p.tick();
    await p.tick();
    await p.done('finished');
    const s = JSON.parse(await readFile(statusPath, 'utf8'));
    expect(s.done).toBe(true);
    expect(s.label).toBe('finished');
    expect(s.current).toBe(2);
  });

  it('tracks counters', async () => {
    const p = new Progress({
      phase: 'index', statusPath,
      stream: new MemoryStream(false) as unknown as NodeJS.WritableStream & { isTTY?: boolean },
      tty: false, lineEvery: 1,
    });
    p.bump('added');
    p.bump('failed', 2);
    await p.tick();
    const s = JSON.parse(await readFile(statusPath, 'utf8'));
    expect(s.counters.added).toBe(1);
    expect(s.counters.failed).toBe(2);
  });

  it('computes etaMs from elapsed and rate', () => {
    let now = 1000;
    const p = new Progress({
      phase: 'x', total: 10,
      stream: new MemoryStream(false) as unknown as NodeJS.WritableStream & { isTTY?: boolean },
      tty: false, now: () => now,
    });
    now = 3000;       // 2000ms elapsed after we manually bump current
    (p as unknown as { current: number }).current = 2;
    const s = p.snapshot();
    // 2 items in 2000ms → 1000ms each → 8 remaining → 8000ms ETA
    expect(s.etaMs).toBe(8000);
  });

  it('emits one line per tick on a non-TTY stream when lineEvery=1', async () => {
    const stream = new MemoryStream(false);
    const p = new Progress({
      phase: 'discover', total: 2,
      stream: stream as unknown as NodeJS.WritableStream & { isTTY?: boolean },
      tty: false, lineEvery: 1,
    });
    await p.tick();
    await p.tick();
    await p.done();
    const lines = stream.text().split('\n').filter(Boolean);
    expect(lines.length).toBeGreaterThanOrEqual(2);
    expect(lines.every(l => l.includes('[discover]'))).toBe(true);
  });

  it('redraws a single line on TTY', async () => {
    const stream = new MemoryStream(true);
    const p = new Progress({
      phase: 'index', total: 2,
      stream: stream as unknown as NodeJS.WritableStream & { isTTY?: boolean },
      tty: true,
    });
    await p.tick('first');
    await p.tick('second');
    await p.done();
    const out = stream.text();
    expect(out.startsWith('\r')).toBe(true);
    expect(out.endsWith('\n')).toBe(true);
    // Multiple \r writes — proves redraw, not append
    expect(out.split('\r').length).toBeGreaterThanOrEqual(3);
  });
});

describe('formatDuration', () => {
  it.each([
    [0, '0ms'],
    [500, '500ms'],
    [1000, '1s'],
    [59000, '59s'],
    [60_000, '1m00s'],
    [125_000, '2m05s'],
    [3_600_000, '1h00m'],
    [7_265_000, '2h01m'],
  ])('formats %d as %s', (ms, expected) => {
    expect(formatDuration(ms)).toBe(expected);
  });
});
