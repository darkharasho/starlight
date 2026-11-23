// apps/desktop/src/main/agent/token.ts
//
// The per-install bearer token for the MCP server. It lives in its own file
// (mode 0600) and never in config.json, which goes into backups and bug
// reports and which the renderer reads wholesale.
import { randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const TOKEN_FILE = 'agent-token';
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;  // 32 bytes, base64url, no padding

function newToken(): string {
  return randomBytes(32).toString('base64url');
}

async function writeToken(dir: string, token: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  const path = join(dir, TOKEN_FILE);
  const tmp = `${path}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
  // `wx` + 0600: the token is never readable by anyone else, not even briefly.
  await writeFile(tmp, `${token}\n`, { mode: 0o600, flag: 'wx' });
  await chmod(tmp, 0o600);  // in case the umask was odd
  await rename(tmp, path);
}

/** Reads the token, or creates it (32 random bytes, base64url) on first use. */
export async function loadOrCreateToken(dir: string): Promise<string> {
  const path = join(dir, TOKEN_FILE);
  let existing: string | null = null;
  try {
    existing = (await readFile(path, 'utf8')).trim();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  if (existing !== null && TOKEN_RE.test(existing)) {
    // Tighten a file someone loosened by hand.
    const st = await stat(path);
    if ((st.mode & 0o777) !== 0o600) await chmod(path, 0o600);
    return existing;
  }
  const token = newToken();
  await writeToken(dir, token);
  return token;
}

/** Replaces the token. The caller closes the MCP sessions that used the old one. */
export async function rotateToken(dir: string): Promise<string> {
  const token = newToken();
  await writeToken(dir, token);
  return token;
}
