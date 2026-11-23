// @vitest-environment node
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm, stat, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadOrCreateToken, rotateToken } from '../../../src/main/agent/token.js';

const dirs: string[] = [];
async function tmp(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), 'sl-token-'));
  dirs.push(d);
  return d;
}
afterEach(async () => { for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true }); });

describe('agent token', () => {
  it('creates a 0600 token once and reuses it', async () => {
    const dir = await tmp();
    const a = await loadOrCreateToken(dir);
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);           // 32 bytes, base64url
    const st = await stat(join(dir, 'agent-token'));
    expect(st.mode & 0o777).toBe(0o600);
    expect((await readFile(join(dir, 'agent-token'), 'utf8')).trim()).toBe(a);
    expect(await loadOrCreateToken(dir)).toBe(a);
  });

  it('rotate writes a new token', async () => {
    const dir = await tmp();
    const a = await loadOrCreateToken(dir);
    const b = await rotateToken(dir);
    expect(b).not.toBe(a);
    expect(b).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await loadOrCreateToken(dir)).toBe(b);
    expect((await stat(join(dir, 'agent-token'))).mode & 0o777).toBe(0o600);
  });

  it('replaces a damaged token file', async () => {
    const dir = await tmp();
    const { writeFile } = await import('node:fs/promises');
    await writeFile(join(dir, 'agent-token'), 'short\n', { mode: 0o644 });
    const t = await loadOrCreateToken(dir);
    expect(t).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect((await stat(join(dir, 'agent-token'))).mode & 0o777).toBe(0o600);
  });
});
