// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import { createActivityLog } from '../../../src/main/agent/activity.js';

describe('activity log', () => {
  it('keeps the newest 200 entries', () => {
    const onChange = vi.fn();
    const log = createActivityLog({ onChange, now: () => 1000 });
    for (let i = 0; i < 205; i++) log.note(`note ${i}`);
    const e = log.entries();
    expect(e).toHaveLength(200);
    expect(e[0]).toEqual({ id: 205, at: 1000, tool: null, summary: 'note 204', status: 'note' });
    expect(e[199]!.summary).toBe('note 5');
    expect(onChange).toHaveBeenCalledTimes(205);
    // A finish for an entry that fell off is ignored.
    log.finish(1, { status: 'ok' });
    expect(log.entries()).toHaveLength(200);
  });

  it('honours a smaller max', () => {
    const log = createActivityLog({ max: 2, onChange: () => {} });
    log.note('a'); log.note('b'); log.note('c');
    expect(log.entries().map((x) => x.summary)).toEqual(['c', 'b']);
  });

  it('finish updates status, summary and change', () => {
    const onChange = vi.fn();
    let t = 5;
    const log = createActivityLog({ onChange, now: () => t++ });
    const a = log.start('write', 'write …');
    const b = log.start('read', 'read …');
    expect(log.entries()[1]).toEqual({ id: a, at: 5, tool: 'write', summary: 'write …', status: 'running' });
    log.finish(a, { status: 'ok', summary: 'Wrote 99 to 0x10', change: { address: '0x10', old: '5', new: '99' } });
    log.finish(b, { status: 'refused', error: 'Not attached' });
    const [eb, ea] = log.entries();
    expect(ea).toEqual({ id: a, at: 5, tool: 'write', summary: 'Wrote 99 to 0x10', status: 'ok', change: { address: '0x10', old: '5', new: '99' } });
    expect(eb).toEqual({ id: b, at: 6, tool: 'read', summary: 'read …', status: 'refused', error: 'Not attached' });
    expect(onChange).toHaveBeenCalledTimes(4);
  });

  it('entries() is a copy', () => {
    const log = createActivityLog({ onChange: () => {} });
    log.note('x');
    const e = log.entries();
    e[0]!.summary = 'changed';
    e.pop();
    expect(log.entries()[0]!.summary).toBe('x');
  });
});
