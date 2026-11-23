// @vitest-environment node
import { describe, it, expect, beforeEach } from 'vitest';
import { parseAttachments, recentPageStarts, listTables, isOtherStoreBuild, clearTableCache } from '../../src/main/ct-tables.js';

const TOPIC = 'https://fearlessrevolution.com/viewtopic.php?f=4&t=100';
const att = (id: number, name: string): string =>
  `<a class="postlink" href="./download/file.php?id=${id}&amp;sid=abc">${name}</a>`;
const pager = (starts: number[], t = 100): string =>
  starts.map((s) => `<a href="./viewtopic.php?f=4&amp;t=${t}&amp;start=${s}">p</a>`).join('');

beforeEach(() => clearTableCache());

describe('parseAttachments', () => {
  it('extracts .CT and .zip attachments with direct download URLs', () => {
    const html = att(11, 'Game_v1.CT') + '<a href="./download/file.php?id=12">shot.png</a>' + att(13, 'bundle.zip');
    expect(parseAttachments(html, TOPIC)).toEqual([
      { id: 11, filename: 'Game_v1.CT', url: 'https://fearlessrevolution.com/download/file.php?id=11', topicUrl: TOPIC },
      { id: 13, filename: 'bundle.zip', url: 'https://fearlessrevolution.com/download/file.php?id=13', topicUrl: TOPIC },
    ]);
  });
  it('decodes entities in filenames', () => {
    expect(parseAttachments(att(5, 'Tom &amp; Jerry.ct'), TOPIC)[0]!.filename).toBe('Tom & Jerry.ct');
  });
});

describe('recentPageStarts', () => {
  it('is empty for a single-page thread', () => {
    expect(recentPageStarts('<p>no pagination</p>', TOPIC)).toEqual([]);
  });
  it('derives the newest pages even though the pager elides the middle', () => {
    // phpBB shows "1 2 3 4 5 … 29": offsets 15..60 and 420.
    expect(recentPageStarts(pager([15, 30, 45, 60, 420]), TOPIC)).toEqual([420, 405]);
  });
  it('ignores pagination links that belong to other threads', () => {
    expect(recentPageStarts(pager([15]) + pager([900], 555), TOPIC)).toEqual([15]);
  });
});

describe('listTables', () => {
  it('collects tables from the first and newest pages, newest upload first', async () => {
    const pages: Record<string, string> = {
      [TOPIC]: att(10, 'old.CT') + pager([15, 30]),
      [`${TOPIC}&start=30`]: att(40, 'newest.CT'),
      [`${TOPIC}&start=15`]: att(20, 'mid.CT'),
    };
    const fetched: string[] = [];
    const tables = await listTables([TOPIC], { fetchText: async (u) => { fetched.push(u); return pages[u] ?? null; } });
    expect(tables.map((t) => t.filename)).toEqual(['newest.CT', 'mid.CT', 'old.CT']);
    expect(fetched).toHaveLength(3);
  });

  it('merges several threads for one game and de-duplicates', async () => {
    const other = 'https://fearlessrevolution.com/viewtopic.php?f=4&t=200';
    const tables = await listTables([TOPIC, other, TOPIC], {
      fetchText: async (u) => (u === TOPIC ? att(10, 'a.CT') : att(30, 'b.CT')),
    });
    expect(tables.map((t) => t.id)).toEqual([30, 10]);
  });

  it('puts Game Pass builds after Steam builds regardless of age', async () => {
    const tables = await listTables([TOPIC], {
      fetchText: async () => att(50, 'Game-WinGDK-Shipping.CT') + att(49, 'Game-Win64-Shipping.CT'),
    });
    expect(tables.map((t) => t.id)).toEqual([49, 50]);
    expect(isOtherStoreBuild('Palworld (gamepass).CT')).toBe(true);
    expect(isOtherStoreBuild('Palworld_0.3.CT')).toBe(false);
  });

  it('only offers zips when a game has no bare .CT', async () => {
    const withCt = await listTables([TOPIC], { fetchText: async () => att(1, 'a.zip') + att(2, 'b.CT') });
    expect(withCt.map((t) => t.filename)).toEqual(['b.CT']);
    clearTableCache();
    const zipOnly = await listTables([TOPIC], { fetchText: async () => att(1, 'a.zip') });
    expect(zipOnly.map((t) => t.filename)).toEqual(['a.zip']);
  });

  it('treats a direct .CT link as a single table and never fetches it as a page', async () => {
    const tables = await listTables(['https://example.com/files/My%20Game.CT'], { fetchText: async () => { throw new Error('should not fetch'); } });
    expect(tables).toEqual([{ id: 0, filename: 'My Game.CT', url: 'https://example.com/files/My%20Game.CT', topicUrl: 'https://example.com/files/My%20Game.CT' }]);
  });

  it('returns nothing (rather than throwing) when a thread is unreachable', async () => {
    expect(await listTables([TOPIC], { fetchText: async () => null })).toEqual([]);
  });

  it('caches a thread listing', async () => {
    let n = 0;
    const fetchText = async (): Promise<string> => { n++; return att(1, 'a.CT'); };
    await listTables([TOPIC], { fetchText, now: 1000 });
    await listTables([TOPIC], { fetchText, now: 2000 });
    expect(n).toBe(1);
  });
});
