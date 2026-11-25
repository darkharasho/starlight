import { describe, it, expect } from 'vitest';
import { isWebLink, webLink } from '../../src/shared/web-link.js';

describe('isWebLink', () => {
  it('accepts http(s) only', () => {
    expect(isWebLink('https://fearlessrevolution.com/viewtopic.php?t=1')).toBe(true);
    expect(isWebLink('http://example.com')).toBe(true);
    expect(isWebLink('file:///etc/passwd')).toBe(false);
    expect(isWebLink('cmd.exe /c calc')).toBe(false);
    expect(isWebLink('javascript:alert(1)')).toBe(false);
    expect(isWebLink('C:\\\\Windows\\\\notepad.exe')).toBe(false);
  });
});

describe('webLink', () => {
  it('returns the normalized URL that was checked, or null', () => {
    expect(webLink(' https://example.com/a b ')).toBe('https://example.com/a%20b');
    expect(webLink('https:\\\\example.com\\x')).toBe('https://example.com/x');
    expect(webLink('file:///etc/passwd')).toBeNull();
  });
});
