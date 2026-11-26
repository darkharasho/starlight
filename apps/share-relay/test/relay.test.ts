import { describe, it, expect, beforeAll } from 'vitest';
import { shareHash, shareSummary, shareFlags, type CommunityCheatFile } from '@starlight/ct-importer/share';
import { handle, type Env } from '../src/index.js';
import { RateLimiter } from '../src/limiter.js';

let PEM = '';
beforeAll(async () => {
  const kp = await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true, ['sign', 'verify'],
  ) as CryptoKeyPair;
  const der = new Uint8Array(await crypto.subtle.exportKey('pkcs8', kp.privateKey) as ArrayBuffer);
  const b64 = btoa(String.fromCharCode(...der)).replace(/(.{64})/g, '$1\n');
  PEM = `-----BEGIN PRIVATE KEY-----\n${b64}\n-----END PRIVATE KEY-----\n`;
});

class FakeKV {
  m = new Map<string, string>();
  async get(k: string): Promise<string | null> { return this.m.get(k) ?? null; }
  async put(k: string, v: string): Promise<void> { this.m.set(k, v); }
}

/** A Durable Object namespace with one real RateLimiter on in-memory storage. */
function fakeLimiterNamespace() {
  const store = new Map<string, unknown>();
  const storage = {
    async get(k: string) { return store.get(k); },
    async put(k: string, v: unknown) { store.set(k, structuredClone(v)); },
    async delete(k: string) { return store.delete(k); },
    async list(o: { prefix?: string } = {}) { return new Map([...store].filter(([k]) => k.startsWith(o.prefix ?? ''))); },
  };
  let chain = Promise.resolve();
  const state = {
    storage,
    // Like the runtime's input gate: one request's storage work at a time.
    blockConcurrencyWhile<T>(fn: () => Promise<T>): Promise<T> { const r = chain.then(fn); chain = r.then(() => undefined, () => undefined); return r; },
  };
  const obj = new RateLimiter(state as never);
  const stub = { fetch: (input: string, init?: RequestInit) => obj.fetch(new Request(input, init)) };
  return { idFromName: (n: string) => n, get: () => stub, store } as unknown as DurableObjectNamespace & { store: Map<string, unknown> };
}

interface Call { method: string; path: string; body: any } // eslint-disable-line @typescript-eslint/no-explicit-any

/** A fake GitHub API. `fail` makes the next call matching a "METHOD /path-prefix" key answer with that status. */
function fakeGitHub() {
  const calls: Call[] = [];
  const refs = new Set<string>();
  const pulls = new Map<number, { state: 'open' | 'closed'; merged: boolean }>();
  const fail = new Map<string, number>();
  let next = 1;
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = (init?.method ?? 'GET').toUpperCase();
    const path = url.pathname;
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ method, path, body });
    for (const [k, status] of fail) {
      const [m, p] = k.split(' ');
      if (m === method && path.startsWith(p!)) { fail.delete(k); return json(status, { message: 'boom' }); }
    }
    if (method === 'POST' && /^\/app\/installations\/\w+\/access_tokens$/.test(path)) return json(201, { token: 'inst-token' });
    if (method === 'GET' && path === '/repos/o/r/git/ref/heads/main') return json(200, { object: { sha: 'mainsha' } });
    if (method === 'POST' && path === '/repos/o/r/git/refs') {
      if (refs.has(body.ref)) return json(422, { message: 'Reference already exists' });
      refs.add(body.ref); return json(201, {});
    }
    if (method === 'PUT' && path.startsWith('/repos/o/r/contents/')) return json(201, {});
    if (method === 'POST' && path === '/repos/o/r/pulls') {
      const n = next++; pulls.set(n, { state: 'open', merged: false });
      return json(201, { number: n, html_url: `https://github.com/o/r/pull/${n}` });
    }
    if (method === 'POST' && /^\/repos\/o\/r\/issues\/\d+\/labels$/.test(path)) return json(200, []);
    const pm = /^\/repos\/o\/r\/pulls\/(\d+)$/.exec(path);
    if (method === 'GET' && pm) {
      const p = pulls.get(Number(pm[1]));
      return p ? json(200, { ...p, html_url: `https://github.com/o/r/pull/${pm[1]}` }) : json(404, {});
    }
    return json(404, { message: 'not found' });
  }) as typeof fetch;
  return { fetch, calls, pulls, fail };
}

function file(over: Partial<CommunityCheatFile> = {}): CommunityCheatFile {
  return {
    schemaVersion: 1,
    cheat: {
      name: 'Infinite gold', type: 'freeze', valueType: 'int32', value: 9999,
      address: { kind: 'pointer', module: 'game.exe', baseOffset: '0x10', offsets: ['0x8'] },
      verify: { range: { min: 0, max: 9999 } },
    },
    game: { steamAppId: 1234, name: 'Test Game', platform: 'windows', bits: 64, buildId: '555' },
    submittedAt: '2026-11-25',
    ...over,
  } as CommunityCheatFile;
}

function setup() {
  const kv = new FakeKV();
  const gh = fakeGitHub();
  const env = {
    SHARE_KV: kv as unknown as KVNamespace, LIMITER: fakeLimiterNamespace(), GITHUB_APP_ID: '42', GITHUB_INSTALLATION_ID: '99', GITHUB_APP_KEY: PEM,
    GITHUB_OWNER: 'o', GITHUB_REPO: 'r',
  } as Env;
  let installId = 'install-1';
  let ip = '203.0.113.1';
  const submit = async (f: unknown = file(), raw?: string) => {
    const res = await handle(new Request('https://relay.test/submit', {
      method: 'POST', headers: { 'content-type': 'application/json', 'CF-Connecting-IP': ip },
      body: raw ?? JSON.stringify({ file: f, installId, appVersion: '0.5.11' }),
    }), env, { fetch: gh.fetch, now: () => new Date('2026-11-25T08:00:00Z') });
    return { status: res.status, body: await res.json() as any }; // eslint-disable-line @typescript-eslint/no-explicit-any
  };
  return { kv, gh, env, submit, setInstall: (s: string) => { installId = s; }, setIp: (s: string) => { ip = s; } };
}

const allPuts: string[] = [];

describe('share relay', () => {
  it('opens_a_pull_request', async () => {
    const s = setup();
    const r = await s.submit();
    expect(r).toEqual({ status: 200, body: { url: 'https://github.com/o/r/pull/1', state: 'open', duplicate: false } });
    const hash = await shareHash(file());
    const put = s.gh.calls.find((c) => c.method === 'PUT')!;
    allPuts.push(put.path);
    expect(put.path).toBe(`/repos/o/r/contents/packages/catalog/community/1234/${hash.slice(0, 12)}.json`);
    expect(put.body.branch).toBe(`community/1234-${hash.slice(0, 8)}`);
    expect(JSON.parse(atob(put.body.content))).toEqual(file());
    const ref = s.gh.calls.find((c) => c.path === '/repos/o/r/git/refs')!;
    expect(ref.body).toEqual({ ref: `refs/heads/community/1234-${hash.slice(0, 8)}`, sha: 'mainsha' });
    const pr = s.gh.calls.find((c) => c.method === 'POST' && c.path === '/repos/o/r/pulls')!;
    expect(pr.body.title).toBe('Community cheat: Test Game — Infinite gold');
    expect(pr.body.base).toBe('main');
    expect(pr.body.body).toBe(`<!-- starlight-summary -->\n${shareSummary(file(), shareFlags(file()))}\n<!-- /starlight-summary -->`);
    const label = s.gh.calls.find((c) => c.path === '/repos/o/r/issues/1/labels')!;
    expect(label.body).toEqual({ labels: ['community-cheat'] });
    const tok = s.gh.calls.find((c) => c.path === '/app/installations/99/access_tokens')!;
    expect(tok.method).toBe('POST');
  });

  it('rejects_invalid', async () => {
    const s = setup();
    const f = file();
    (f.cheat as any).address = { kind: 'absolute', address: '0x1' }; // eslint-disable-line @typescript-eslint/no-explicit-any
    const r = await s.submit(f);
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/absolute/);
    expect(s.gh.calls).toHaveLength(0);
  });

  it('rejects_oversize_body', async () => {
    const s = setup();
    const r = await s.submit(undefined, JSON.stringify({ file: file(), installId: 'x', pad: 'x'.repeat(70000) }));
    expect(r.status).toBe(413);
    expect(s.gh.calls).toHaveLength(0);
  });

  it('rejects a body that is not a submission', async () => {
    const s = setup();
    expect((await s.submit(undefined, 'not json')).status).toBe(400);
    expect((await s.submit(undefined, JSON.stringify({ file: file() }))).status).toBe(400);
  });

  it('rate_limits', async () => {
    const s = setup();
    for (let i = 0; i < 5; i++) {
      const r = await s.submit(file({ cheat: { ...file().cheat, name: `Gold ${i}` } as never }));
      expect(r.status).toBe(200);
    }
    const sixth = await s.submit(file({ cheat: { ...file().cheat, name: 'Gold 6' } as never }));
    expect(sixth).toEqual({ status: 429, body: { error: 'Too many submissions today.' } });
    s.setInstall('install-2');
    expect((await s.submit(file({ cheat: { ...file().cheat, name: 'Gold 7' } as never }))).status).toBe(200);
    // 6 accepted from this IP so far; 14 more from fresh installs, then the IP is full
    for (let i = 0; i < 14; i++) {
      s.setInstall(`ip-fill-${i}`);
      expect((await s.submit(file({ cheat: { ...file().cheat, name: `Ip ${i}` } as never }))).status).toBe(200);
    }
    s.setInstall('install-fresh');
    expect((await s.submit(file({ cheat: { ...file().cheat, name: 'One more' } as never }))).status).toBe(429);
    s.setIp('203.0.113.2');
    expect((await s.submit(file({ cheat: { ...file().cheat, name: 'Other ip' } as never }))).status).toBe(200);
  });

  it('a burst of submissions cannot get past the limit', async () => {
    const s = setup();
    const all = await Promise.all(Array.from({ length: 30 }, (_, i) => s.submit(file({ cheat: { ...file().cheat, name: `Burst ${i}` } as never }))));
    expect(all.filter((r) => r.status === 200)).toHaveLength(5);
    expect(all.filter((r) => r.status === 429)).toHaveLength(25);
    expect(s.gh.calls.filter((c) => c.method === 'POST' && c.path === '/repos/o/r/pulls')).toHaveLength(5);
  });

  it('IPv6 addresses in one /64 share a limit', async () => {
    const s = setup();
    for (let i = 1; i <= 20; i++) {
      s.setInstall(`v6-install-${i}`); s.setIp(`2001:db8:1:2::${i.toString(16)}`);
      expect((await s.submit(file({ cheat: { ...file().cheat, name: `V6 ${i}` } as never }))).status).toBe(200);
    }
    s.setInstall('v6-install-next'); s.setIp('2001:0db8:0001:0002:ffff::9');
    expect((await s.submit(file({ cheat: { ...file().cheat, name: 'V6 next' } as never }))).status).toBe(429);
    s.setIp('2001:db8:1:3::1');
    expect((await s.submit(file({ cheat: { ...file().cheat, name: 'Other /64' } as never }))).status).toBe(200);
  });

  it('there is a daily cap across everyone', async () => {
    const s = setup();
    for (let i = 0; i < 100; i++) {
      s.setInstall(`everyone-${i}`); s.setIp(`198.51.100.${i}`);
      expect((await s.submit(file({ cheat: { ...file().cheat, name: `All ${i}` } as never }))).status).toBe(200);
    }
    s.setInstall('one-more-install'); s.setIp('192.0.2.1');
    expect((await s.submit(file({ cheat: { ...file().cheat, name: 'All 100' } as never }))).status).toBe(429);
  });

  it('duplicate_returns_existing', async () => {
    const s = setup();
    await s.submit();
    const again = await s.submit();
    expect(again).toEqual({ status: 200, body: { url: 'https://github.com/o/r/pull/1', state: 'open', duplicate: true } });
    expect(s.gh.calls.filter((c) => c.method === 'POST' && c.path === '/repos/o/r/pulls')).toHaveLength(1);
    s.gh.pulls.set(1, { state: 'closed', merged: false });
    expect((await s.submit()).body.state).toBe('declined');
    s.gh.pulls.set(1, { state: 'closed', merged: true });
    expect((await s.submit()).body.state).toBe('merged');
    // a re-credited copy is the same cheat
    expect((await s.submit(file({ credit: 'Mika' }))).body.duplicate).toBe(true);
  });

  it('duplicates do not count against the rate limit', async () => {
    const s = setup();
    for (let i = 0; i < 10; i++) expect((await s.submit()).status).toBe(200);
  });

  it('retry_after_github_failure_reuses_branch', async () => {
    const s = setup();
    s.gh.fail.set('POST /repos/o/r/pulls', 500);
    const first = await s.submit();
    expect(first).toEqual({ status: 502, body: { error: "GitHub didn't accept the submission. Try again later." } });
    expect([...s.kv.m.keys()].some((k) => k.startsWith('h:'))).toBe(false);
    const second = await s.submit();
    expect(second.status).toBe(200);
    expect(second.body.duplicate).toBe(false);
    const refCalls = s.gh.calls.filter((c) => c.path === '/repos/o/r/git/refs');
    expect(refCalls).toHaveLength(2);
  });

  it('a failed submission does not use up the rate limit', async () => {
    const s = setup();
    for (let i = 0; i < 5; i++) {
      s.gh.fail.set('POST /repos/o/r/pulls', 500);
      expect((await s.submit(file({ cheat: { ...file().cheat, name: `G${i}` } as never }))).status).toBe(502);
    }
    expect((await s.submit()).status).toBe(200);
  });

  it('answers 404 to anything else', async () => {
    const s = setup();
    const get = await handle(new Request('https://relay.test/submit'), s.env, { fetch: s.gh.fetch });
    expect(get.status).toBe(404);
    const other = await handle(new Request('https://relay.test/merge', { method: 'POST', body: '{}' }), s.env, { fetch: s.gh.fetch });
    expect(other.status).toBe(404);
  });

  it('uses GITHUB_API when set (local end-to-end runs)', async () => {
    const s = setup();
    const seen: string[] = [];
    const spy = (async (input: string | URL | Request, init?: RequestInit) => { seen.push(new URL(String(input)).origin); return s.gh.fetch(input, init); }) as typeof fetch;
    const env = { ...s.env, GITHUB_API: 'http://127.0.0.1:9' } as Env;
    const res = await handle(new Request('https://relay.test/submit', { method: 'POST', body: JSON.stringify({ file: file(), installId: 'install-api', appVersion: 'x' }) }), env, { fetch: spy });
    expect(res.status).toBe(200);
    expect(new Set(seen)).toEqual(new Set(['http://127.0.0.1:9']));
  });

  it('calls fetch unbound, as the Workers runtime requires', async () => {
    const s = setup();
    const strict = function (this: unknown, input: string | URL | Request, init?: RequestInit) {
      if (this !== undefined && this !== globalThis) throw new TypeError('Illegal invocation');
      return s.gh.fetch(input, init);
    } as typeof fetch;
    const res = await handle(new Request('https://relay.test/submit', { method: 'POST', body: JSON.stringify({ file: file(), installId: 'install-unbound', appVersion: 'x' }) }), s.env, { fetch: strict });
    expect(res.status).toBe(200);
  });

  it('only_writes_community_path', () => {
    expect(allPuts.length).toBeGreaterThan(0);
    for (const p of allPuts) expect(p.startsWith('/repos/o/r/contents/packages/catalog/community/')).toBe(true);
  });
});
