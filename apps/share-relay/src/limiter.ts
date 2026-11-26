// Daily submission limits, counted in one Durable Object so that every
// request sees every other request's count at once (KV is eventually
// consistent, so a burst could read 0 many times over). A slot is taken
// before GitHub is called and given back if the submission fails.

export interface Limit { key: string; max: number }

interface Storage {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<boolean>;
  list<T>(options: { prefix: string }): Promise<Map<string, T>>;
}
interface State { storage: Storage; blockConcurrencyWhile<T>(fn: () => Promise<T>): Promise<T> }

type Counts = Record<string, number>;

export class RateLimiter {
  constructor(private readonly state: State) {}

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const body = await req.json() as { day: string; limits: Limit[] };
    if (req.method !== 'POST' || !/^\d{4}-\d{2}-\d{2}$/.test(body.day) || !Array.isArray(body.limits)) {
      return new Response('bad request', { status: 400 });
    }
    if (url.pathname === '/take') return Response.json({ ok: await this.take(body.day, body.limits) });
    if (url.pathname === '/give-back') { await this.giveBack(body.day, body.limits); return Response.json({ ok: true }); }
    return new Response('not found', { status: 404 });
  }

  /** Counts one submission against every limit, or none if any is full. */
  take(day: string, limits: Limit[]): Promise<boolean> {
    return this.state.blockConcurrencyWhile(async () => {
      const counts = await this.counts(day);
      if (limits.some((l) => (counts[l.key] ?? 0) >= l.max)) return false;
      for (const l of limits) counts[l.key] = (counts[l.key] ?? 0) + 1;
      await this.state.storage.put(`day:${day}`, counts);
      return true;
    });
  }

  giveBack(day: string, limits: Limit[]): Promise<void> {
    return this.state.blockConcurrencyWhile(async () => {
      const counts = await this.counts(day);
      for (const l of limits) if (counts[l.key]) counts[l.key] = counts[l.key]! - 1;
      await this.state.storage.put(`day:${day}`, counts);
    });
  }

  /** Today's counts; earlier days are dropped. */
  private async counts(day: string): Promise<Counts> {
    const all = await this.state.storage.list<Counts>({ prefix: 'day:' });
    for (const k of all.keys()) if (k !== `day:${day}`) await this.state.storage.delete(k);
    return { ...(all.get(`day:${day}`) ?? {}) };
  }
}

/** The address a limit applies to: an IPv4 address, or an IPv6 address's /64. */
export function addressKey(ip: string): string {
  if (!ip.includes(':')) return ip;
  const [head = '', tail = ''] = ip.toLowerCase().split('::');
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const full = ip.includes('::') ? [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill('0'), ...right] : left;
  return `${full.slice(0, 4).map((h) => (parseInt(h || '0', 16) || 0).toString(16)).join(':')}::/64`;
}
