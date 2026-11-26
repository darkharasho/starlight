// The few GitHub API calls the relay makes, as a GitHub App installation.
// The App is installed on one repository; its token can't merge anything here
// because the relay never calls a merge endpoint.

export interface GitHubConfig {
  appId: string;
  installationId: string;
  /** The App's private key, PKCS#8 PEM. */
  privateKey: string;
  owner: string;
  repo: string;
  fetch: typeof fetch;
  now(): Date;
}

export class GitHubError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

const API = 'https://api.github.com';

function b64url(bytes: Uint8Array | string): string {
  const bin = typeof bytes === 'string' ? bytes : String.fromCharCode(...bytes);
  return btoa(bin).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}

export function base64Utf8(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

async function appJwt(cfg: GitHubConfig): Promise<string> {
  const pem = cfg.privateKey.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  const der = Uint8Array.from(atob(pem), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey('pkcs8', der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const now = Math.floor(cfg.now().getTime() / 1000);
  const head = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const body = b64url(JSON.stringify({ iat: now - 60, exp: now + 540, iss: cfg.appId }));
  const sig = new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(`${head}.${body}`)));
  return `${head}.${body}.${b64url(sig)}`;
}

export class GitHub {
  private token: string | null = null;
  constructor(private readonly cfg: GitHubConfig) {}

  private async call<T>(method: string, path: string, body?: unknown, auth?: string): Promise<{ status: number; data: T }> {
    const res = await this.cfg.fetch(`${API}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${auth ?? await this.installationToken()}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        'user-agent': 'starlight-share-relay',
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const data = await res.json().catch(() => ({})) as T;
    return { status: res.status, data };
  }

  private async must<T>(method: string, path: string, body?: unknown): Promise<T> {
    const r = await this.call<T & { message?: string }>(method, path, body);
    if (r.status >= 300) throw new GitHubError(r.status, `${method} ${path}: ${r.status} ${r.data.message ?? ''}`.trim());
    return r.data;
  }

  private async installationToken(): Promise<string> {
    if (this.token) return this.token;
    const jwt = await appJwt(this.cfg);
    const r = await this.call<{ token?: string; message?: string }>('POST', `/app/installations/${this.cfg.installationId}/access_tokens`, undefined, jwt);
    if (r.status >= 300 || !r.data.token) throw new GitHubError(r.status, `installation token: ${r.status}`);
    this.token = r.data.token;
    return this.token;
  }

  private get repoPath(): string { return `/repos/${this.cfg.owner}/${this.cfg.repo}`; }

  /** The pull request's state: open, merged, or closed without merging. */
  async pullState(n: number): Promise<{ url: string; state: 'open' | 'merged' | 'declined' }> {
    const p = await this.must<{ state: string; merged: boolean; html_url: string }>('GET', `${this.repoPath}/pulls/${n}`);
    return { url: p.html_url, state: p.state === 'open' ? 'open' : p.merged ? 'merged' : 'declined' };
  }

  /** Branch off main (reusing the branch if a failed try left it), add one file, open the pull request. */
  async openPull(o: { branch: string; path: string; content: string; title: string; body: string; label: string }): Promise<{ number: number; url: string }> {
    const main = await this.must<{ object: { sha: string } }>('GET', `${this.repoPath}/git/ref/heads/main`);
    const ref = await this.call<{ message?: string }>('POST', `${this.repoPath}/git/refs`, { ref: `refs/heads/${o.branch}`, sha: main.object.sha });
    if (ref.status >= 300 && ref.status !== 422) throw new GitHubError(ref.status, `create branch: ${ref.status}`);

    const put = { message: o.title, content: base64Utf8(o.content), branch: o.branch };
    const first = await this.call<{ message?: string }>('PUT', `${this.repoPath}/contents/${o.path}`, put);
    if (first.status === 422) {
      // The file is already on the branch from a failed try: replace it in place.
      const existing = await this.must<{ sha: string }>('GET', `${this.repoPath}/contents/${o.path}?ref=${encodeURIComponent(o.branch)}`);
      await this.must('PUT', `${this.repoPath}/contents/${o.path}`, { ...put, sha: existing.sha });
    } else if (first.status >= 300) {
      throw new GitHubError(first.status, `add file: ${first.status}`);
    }

    const pr = await this.must<{ number: number; html_url: string }>('POST', `${this.repoPath}/pulls`, {
      title: o.title, head: o.branch, base: 'main', body: o.body, maintainer_can_modify: true,
    });
    await this.must('POST', `${this.repoPath}/issues/${pr.number}/labels`, { labels: [o.label] }).catch(() => undefined);
    return { number: pr.number, url: pr.html_url };
  }
}
