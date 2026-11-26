// The share relay. POST /submit takes a shared cheat from the Starlight app,
// checks it with the same rules the app and CI use, rate-limits it, and opens
// a pull request that adds one file under packages/catalog/community/. It
// never merges and never writes anywhere else.
import { checkShareRules, shareFlags, shareHash, shareSummary } from '@starlight/ct-importer/share';
import { GitHub } from './github.js';
import { addressKey, type Limit } from './limiter.js';

export { RateLimiter } from './limiter.js';

export interface Env {
  /** Content hash → pull request number. */
  SHARE_KV: KVNamespace;
  /** The RateLimiter Durable Object; one instance counts every submission. */
  LIMITER: DurableObjectNamespace;
  GITHUB_APP_ID: string;
  GITHUB_INSTALLATION_ID: string;
  GITHUB_APP_KEY: string;
  GITHUB_OWNER: string;
  GITHUB_REPO: string;
  /** Local end-to-end runs point this at a fake GitHub; unset in production. */
  GITHUB_API?: string;
}

/** The cheat file may be 64 KB; the envelope (install id, app version) gets a little more. */
const MAX_BODY = 65536 + 2048;
const PER_INSTALL = 5;
const PER_IP = 20;
/** Across everyone: a ceiling on how many pull requests one day can bring. */
const PER_DAY = 100;
const COMMUNITY = 'packages/catalog/community';

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const error = (status: number, message: string) => json(status, { error: message });

export async function handle(req: Request, env: Env, deps: { fetch?: typeof fetch; now?(): Date } = {}): Promise<Response> {
  const url = new URL(req.url);
  if (req.method !== 'POST' || url.pathname !== '/submit') return error(404, 'Not found.');
  const now = deps.now ?? (() => new Date());

  const text = await req.text();
  if (new TextEncoder().encode(text).length > MAX_BODY) return error(413, 'That cheat is too big to share (the limit is 64 KB).');
  let body: { file?: unknown; installId?: unknown; appVersion?: unknown };
  try { body = JSON.parse(text) as typeof body; } catch { return error(400, "That isn't a cheat submission."); }
  if (!body || typeof body.installId !== 'string' || body.installId.length < 8 || body.installId.length > 64 || body.file === undefined) {
    return error(400, "That isn't a cheat submission.");
  }

  const checked = checkShareRules(body.file);
  if (!checked.ok) return error(400, `This cheat can't be shared: ${checked.errors.join('; ')}`);
  const file = checked.file;
  const hash = await shareHash(file);

  const gh = new GitHub({
    appId: env.GITHUB_APP_ID, installationId: env.GITHUB_INSTALLATION_ID, privateKey: env.GITHUB_APP_KEY,
    owner: env.GITHUB_OWNER, repo: env.GITHUB_REPO, api: env.GITHUB_API || undefined, fetch: deps.fetch ?? fetch, now,
  });

  const known = await env.SHARE_KV.get(`h:${hash}`);
  if (known) {
    try {
      const p = await gh.pullState(Number(known));
      return json(200, { url: p.url, state: p.state, duplicate: true });
    } catch {
      return error(502, "GitHub didn't answer. Try again later.");
    }
  }

  const day = now().toISOString().slice(0, 10);
  const limits: Limit[] = [
    { key: `i:${body.installId}`, max: PER_INSTALL },
    { key: `ip:${addressKey(req.headers.get('CF-Connecting-IP') ?? 'unknown')}`, max: PER_IP },
    { key: 'all', max: PER_DAY },
  ];
  const limiter = env.LIMITER.get(env.LIMITER.idFromName('submissions'));
  const ask = (path: string) => limiter.fetch(`https://limiter${path}`, { method: 'POST', body: JSON.stringify({ day, limits }) });
  const taken = await ask('/take').then((r) => r.json() as Promise<{ ok?: boolean }>);
  if (!taken.ok) return error(429, 'Too many submissions today.');

  const hash12 = hash.slice(0, 12);
  let pr: { number: number; url: string };
  try {
    pr = await gh.openPull({
      branch: `community/${file.game.steamAppId}-${hash.slice(0, 8)}`,
      path: `${COMMUNITY}/${file.game.steamAppId}/${hash12}.json`,
      content: `${JSON.stringify(file, null, 2)}\n`,
      title: `Community cheat: ${file.game.name} — ${file.cheat.name}`,
      body: `<!-- starlight-summary -->\n${shareSummary(file, shareFlags(file))}\n<!-- /starlight-summary -->`,
      label: 'community-cheat',
    });
  } catch (err) {
    console.error('share relay: opening the pull request failed:', err instanceof Error ? err.message : String(err));
    await ask('/give-back').catch(() => undefined);
    return error(502, "GitHub didn't accept the submission. Try again later.");
  }

  await env.SHARE_KV.put(`h:${hash}`, String(pr.number));
  return json(200, { url: pr.url, state: 'open', duplicate: false });
}

export default {
  fetch(req: Request, env: Env): Promise<Response> { return handle(req, env); },
};
