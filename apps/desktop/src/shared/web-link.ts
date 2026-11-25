/** True for an http(s) URL: the only links a table's Lua may offer the player to open. */
export function isWebLink(url: string): boolean {
  try {
    const u = new URL(url.trim());
    return u.protocol === 'https:' || u.protocol === 'http:';
  } catch {
    return false;
  }
}
