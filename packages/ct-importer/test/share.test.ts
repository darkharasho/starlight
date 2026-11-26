import { describe, it, expect } from 'vitest';
import {
  checkShareRules, shareHash, shareFlags, shareSummary, sharePlatformOf, type CommunityCheatFile,
} from '../src/share.js';
import * as index from '../src/index.js';

const game = { steamAppId: 1234, name: 'Test Game', platform: 'windows' as const, bits: 64 as const, buildId: '555' };

function valueFile(over: Record<string, unknown> = {}): CommunityCheatFile {
  return {
    schemaVersion: 1,
    cheat: {
      name: 'Infinite gold', type: 'freeze', valueType: 'int32', value: 9999,
      address: { kind: 'pointer', module: 'game.exe', baseOffset: '0x10', offsets: ['0x8', '0x10'] },
      verify: { range: { min: 0, max: 9999 } },
    },
    game,
    agent: 'claude-code 2.1',
    submittedAt: '2026-11-25',
    ...over,
  } as CommunityCheatFile;
}

function patchFile(enable?: unknown[], over: Record<string, unknown> = {}): CommunityCheatFile {
  return {
    schemaVersion: 1,
    cheat: {
      name: 'No damage', type: 'patch',
      site: { kind: 'aob', module: 'game.exe', pattern: '29 43 10 8B', offset: '0x0' },
      enable: enable ?? [
        { op: 'alloc', name: 'newmem', size: 64, near: 'site' },
        { op: 'assemble', at: 'newmem', source: 'nop // keep hp\njmp return\nreturn:' },
        { op: 'writeBytes', at: 'site', bytes: 'E9000000', original: '2943108B' },
        { op: 'registerSymbol', name: 'hpcave', at: 'newmem' },
      ],
      verify: {},
    },
    game,
    submittedAt: '2026-11-25',
    ...over,
  } as CommunityCheatFile;
}

const asm = (source: string) => patchFile([
  { op: 'alloc', name: 'newmem', size: 64, near: 'site' },
  { op: 'assemble', at: 'newmem', source },
]);
const errs = (r: ReturnType<typeof checkShareRules>) => (r.ok ? [] : r.errors);

describe('share rules', () => {
  it('is exported from the package index', () => {
    expect(index.checkShareRules).toBe(checkShareRules);
  });

  it('accepts_a_valid_value_and_patch_file', () => {
    expect(errs(checkShareRules(valueFile()))).toEqual([]);
    expect(errs(checkShareRules(patchFile()))).toEqual([]);
  });

  it('refuses_absolute_addresses', () => {
    const f = valueFile();
    (f.cheat as any).address = { kind: 'absolute', address: '0x401000' };
    expect(checkShareRules(f).ok).toBe(false);
  });

  it('refuses_module_names_with_separators', () => {
    const f = valueFile();
    (f.cheat as any).address.module = 'C:\\Games\\x.exe';
    const r = checkShareRules(f);
    expect(r.ok).toBe(false);
    expect(errs(r).some((e) => /path/.test(e))).toBe(true);
  });

  it('refuses_paths_in_assembly_but_allows_comments', () => {
    expect(checkShareRules(asm('nop // from C:\\Users\\mike\\a.txt')).ok).toBe(false);
    expect(checkShareRules(asm('mov eax,1 // set to one')).ok).toBe(true);
    expect(checkShareRules(valueFile({ credit: 'see /home/mike/x' })).ok).toBe(false);
    const f = valueFile();
    (f.cheat as any).description = 'dumped to /home/mike/x';
    expect(checkShareRules(f).ok).toBe(false);
  });

  it('refuses_oversize', () => {
    const big = 'nop\n'.repeat(4000); // 16000 chars, under the per-source limit
    const f = patchFile([
      { op: 'alloc', name: 'newmem', size: 4096, near: 'site' },
      { op: 'assemble', at: 'newmem', source: big },
      { op: 'assemble', at: 'newmem+0x400', source: big },
      { op: 'assemble', at: 'newmem+0x800', source: big },
      { op: 'assemble', at: 'newmem+0xc00', source: big },
      { op: 'assemble', at: 'newmem+0xd00', source: big },
    ]);
    const r = checkShareRules(f);
    expect(r.ok).toBe(false);
    expect(errs(r).some((e) => /64 KB/.test(e))).toBe(true);
  });

  it('credit_rules', () => {
    expect(checkShareRules(valueFile({ credit: '' })).ok).toBe(false);
    expect(checkShareRules(valueFile({ credit: 'x'.repeat(41) })).ok).toBe(false);
    expect(checkShareRules(valueFile({ credit: 'Mika' })).ok).toBe(true);
  });

  it('refuses line breaks and control characters in names', () => {
    for (const over of [{ credit: 'a\nb' }, { agent: 'a\rb' }, { game: { ...game, name: 'G\u202eame' } }]) {
      expect(errs(checkShareRules(valueFile(over))).length).toBeGreaterThan(0);
    }
    const f = valueFile();
    (f.cheat as { name: string }).name = 'Gold\n<!--';
    expect(errs(checkShareRules(f)).join()).toMatch(/cheat\.name/);
  });

  it('maps trainer platforms', () => {
    expect(sharePlatformOf('linux-proton')).toBe('windows');
    expect(sharePlatformOf('linux')).toBe('linux');
  });
});

describe('shareHash', () => {
  it('hash_is_stable_across_key_order', async () => {
    const a = valueFile();
    const c = a.cheat as any;
    const reversed = {
      ...a,
      cheat: {
        verify: { range: { max: 9999, min: 0 } },
        address: { offsets: ['0x8', '0x10'], baseOffset: '0x10', module: 'game.exe', kind: 'pointer' },
        value: c.value, valueType: c.valueType, type: c.type, name: c.name,
      },
    } as CommunityCheatFile;
    const h = await shareHash(a);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(await shareHash(reversed)).toBe(h);
    expect(await shareHash({ ...a, game: { ...a.game, bits: 32 } })).not.toBe(h);
    // credit and dates aren't part of what the cheat does
    expect(await shareHash({ ...a, credit: 'Mika', submittedAt: '2027-01-01' })).toBe(h);
  });
});

describe('shareFlags', () => {
  const has = (f: string[], s: string) => f.some((x) => x.includes(s));

  it('flags long assembly and big writes', () => {
    const lines = Array.from({ length: 51 }, () => 'nop').join('\n');
    expect(has(shareFlags(asm(lines)), '51 lines')).toBe(true);
    const f = patchFile([{ op: 'writeBytes', at: 'site', bytes: '90'.repeat(65), original: '00'.repeat(65) }]);
    expect(has(shareFlags(f), '65 bytes')).toBe(true);
  });

  it('flags allocations without near', () => {
    const f = patchFile([{ op: 'alloc', name: 'newmem', size: 64 }]);
    expect(has(shareFlags(f), 'near')).toBe(true);
    expect(has(shareFlags(patchFile()), 'near')).toBe(false);
  });

  it('flags jumps and calls outside the cheat', () => {
    expect(has(shareFlags(asm('call game.exe+1234')), 'jumps or calls outside')).toBe(true);
    expect(has(shareFlags(asm('jmp 0x401000')), 'jumps or calls outside')).toBe(true);
    expect(has(shareFlags(asm('jmp return\nreturn:')), 'jumps or calls outside')).toBe(false);
    expect(has(shareFlags(asm('jmp site+5')), 'jumps or calls outside')).toBe(false);
    expect(has(shareFlags(asm('jmp newmem // loop')), 'jumps or calls outside')).toBe(false);
    expect(has(shareFlags(patchFile()), 'jumps or calls outside')).toBe(false);
  });

  it('flags system calls', () => {
    for (const s of ['syscall', 'int 0x80', 'sysenter']) {
      expect(has(shareFlags(asm(s)), 'system call')).toBe(true);
    }
    expect(has(shareFlags(asm('nop')), 'system call')).toBe(false);
  });
});

describe('shareSummary', () => {
  it('summary_lists_every_step', () => {
    const f = patchFile();
    const flags = ['an example flag'];
    const s = shareSummary(f, flags);
    for (const want of ['Test Game', 'Steam app 1234', 'Windows (Proton)', '64-bit', 'build `555`', 'No damage', 'Anonymous']) {
      expect(s).toContain(want);
    }
    const ops = ['alloc', 'assemble', 'writeBytes', 'registerSymbol'].map((op) => s.indexOf(op));
    expect(ops.every((i) => i >= 0)).toBe(true);
    expect([...ops].sort((a, b) => a - b)).toEqual(ops);
    expect(s).toContain('`2943108B` → `E9000000`');
    expect(s).toContain('```asm\nnop // keep hp\njmp return\nreturn:\n```');
    expect(s).toMatch(/### Look closely[\s\S]*an example flag/);
    expect(s.split('\n').every((l) => l === l.trimEnd())).toBe(true);
  });

  it('summarises value cheats and credit', () => {
    const s = shareSummary(valueFile({ credit: 'Mika' }), []);
    expect(s).toContain('`game.exe+0x10 → 0x8 → 0x10`');
    expect(s).toContain('int32');
    expect(s).toContain('9999');
    expect(s).toContain('range 0–9999');
    expect(s).toContain('Mika');
    expect(s).not.toContain('### Look closely');
  });

  it('mentions what a repair is based on', () => {
    const s = shareSummary(valueFile({ derivedFrom: 'abcdef012345' }), []);
    expect(s).toMatch(/Based on.*abcdef012345/);
  });

  it('a crafted name cannot hide the steps from the description', () => {
    const f = patchFile(undefined, { agent: 'x <!-- y', credit: '@octocat' });
    (f.cheat as { name: string }).name = 'Gold <!-- [click](https://evil.test)';
    const s = shareSummary(f, ['syscall flag']);
    for (const line of s.split('\n')) {
      if (/<!--|\]\(|@octocat/.test(line)) expect(line).toMatch(/`[^`]*(<!--|\]\(|@octocat)[^`]*`/);
    }
    expect(s).toContain('### Look closely');
  });

  it('an assembly fence cannot be closed early', () => {
    const s = shareSummary(asm('nop\n```\n<!--\nnop'), []);
    const fence = /^(`{4,})asm$/m.exec(s)?.[1];
    expect(fence).toBeDefined();
    expect(s).toContain(`${fence}asm\nnop\n\`\`\`\n<!--\nnop\n${fence}`);
  });

  it('keeps the original credit of a repaired cheat', () => {
    const s = shareSummary(valueFile({ derivedFrom: 'abcdef012345', derivedCredit: 'Alice', credit: 'Bob' }), []);
    expect(s).toMatch(/Based on.*abcdef012345.*Alice/);
    expect(s).toContain('https://github.com/darkharasho/starlight/blob/main/packages/catalog/community/1234/abcdef012345.json');
    expect(errs(checkShareRules(valueFile({ derivedFrom: 'abcdef012345', derivedCredit: 'Alice' })))).toEqual([]);
    expect(errs(checkShareRules(valueFile({ derivedCredit: 'Alice' }))).join()).toMatch(/derivedCredit/);
  });

  it('says unknown build and native Linux', () => {
    const f = valueFile({ game: { steamAppId: 1, name: 'N', platform: 'linux', bits: 32 } });
    const s = shareSummary(f, []);
    expect(s).toContain('unknown build');
    expect(s).toContain('Linux (native)');
    expect(s).toContain('32-bit');
  });
});
