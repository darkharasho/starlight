/**
 * The normalized http(s) URL for `url`, or null: the only links a table's Lua may offer the
 * player to open. Open the returned string, not the original, so what was checked is what opens.
 */
export function webLink(url: string): string | null {
  try {
    const u = new URL(url.trim());
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : null;
  } catch {
    return null;
  }
}

export function isWebLink(url: string): boolean {
  return webLink(url) !== null;
}
