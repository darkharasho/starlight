import { describe, it, expect } from 'vitest';
import { isWebLink } from '../../src/shared/web-link.js';

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
