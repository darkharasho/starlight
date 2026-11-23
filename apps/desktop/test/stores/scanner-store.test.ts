import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockCall = vi.fn();
vi.mock('../../src/renderer/ipc-client.js', () => ({
  starlight: () => ({ ceSessionCall: mockCall }),
}));
import { useScannerStore } from '../../src/renderer/stores/scanner-store.js';
import { useCeSessionStore } from '../../src/renderer/stores/ce-session-store.js';

/** Routes bridge calls by method so a test reads like the conversation with Cheat Engine. */
function script(handlers: Record<string, (params: unknown) => unknown>): void {
  mockCall.mockImplementation(async (req: { method: string; params?: unknown }) => {
    const h = handlers[req.method];
    if (!h) throw new Error(`unexpected call: ${req.method}`);
    return h(req.params);
  });
}
const methods = (): string[] => mockCall.mock.calls.map((c) => (c[0] as { method: string }).method);

beforeEach(() => {
  mockCall.mockReset();
  useCeSessionStore.setState({ sessionId: 's1', attached: true });
  useScannerStore.getState().clear();
  useScannerStore.setState({ valueType: 'i32' });
});

describe('scanner-store', () => {
  it('first scan waits for Cheat Engine to finish, then loads results', async () => {
    let polls = 0;
    script({
      scan_first: () => ({ ok: true }),
      scan_status: () => ({ busy: ++polls < 3, count: 2 }),
      scan_results: () => ({ count: 2, items: [{ address: '00A0', value: '100' }, { address: '00B0', value: '100' }] }),
    });
    await useScannerStore.getState().firstScan('exact', '100');
    const s = useScannerStore.getState();
    expect(polls).toBe(3);
    expect(s).toMatchObject({ busy: false, started: true, count: 2 });
    expect(s.results.map((r) => r.address)).toEqual(['00A0', '00B0']);
    expect(mockCall.mock.calls[0]![0]).toMatchObject({ method: 'scan_first', params: { valueType: 'i32', op: 'exact', value: '100' } });
  });

  it('surfaces a scan that could not start and stays usable', async () => {
    script({ scan_first: () => ({ ok: false, error: 'not attached to a game process' }) });
    await useScannerStore.getState().firstScan('exact', '1');
    expect(useScannerStore.getState()).toMatchObject({ busy: false, started: false, error: 'not attached to a game process' });
  });

  it('next scan is refused until there is a first scan', async () => {
    await useScannerStore.getState().nextScan('decreased', '');
    expect(mockCall).not.toHaveBeenCalled();
  });

  it('keeping, editing and freezing an address', async () => {
    script({ mem_write: () => ({ ok: true }), freeze_set: () => ({ ok: true }), freeze_clear: () => ({ ok: true }) });
    const st = useScannerStore.getState();
    st.save({ address: '00A0', value: '100' });
    st.save({ address: '00A0', value: '100' });           // no duplicates
    expect(useScannerStore.getState().saved).toHaveLength(1);

    await st.write('00A0', '9999');
    expect(useScannerStore.getState().saved[0]!.value).toBe('9999');
    await st.setFrozen('00A0', true);
    expect(mockCall).toHaveBeenLastCalledWith({ sessionId: 's1', method: 'freeze_set', params: { address: '00A0', valueType: 'i32', value: '9999' } });
    expect(useScannerStore.getState().saved[0]!.frozen).toBe(true);

    await st.remove('00A0');                               // removing a frozen address releases it
    expect(methods()).toEqual(['mem_write', 'freeze_set', 'freeze_clear']);
    expect(useScannerStore.getState().saved).toEqual([]);
  });

  it('a refused write is reported and the shown value is left alone', async () => {
    script({ mem_write: () => ({ ok: false, error: 'could not write that address' }) });
    useScannerStore.getState().save({ address: '00A0', value: '100' });
    await useScannerStore.getState().write('00A0', '5');
    expect(useScannerStore.getState()).toMatchObject({ error: 'could not write that address', saved: [{ value: '100' }] });
  });

  it('refreshValues updates live values but not ones the user froze', async () => {
    useScannerStore.setState({
      started: true,
      results: [{ address: '00A0', value: '1' }],
      saved: [
        { address: '00B0', valueType: 'f32', label: '', value: '2', frozen: false },
        { address: '00C0', valueType: 'i32', label: '', value: '3', frozen: true },
      ],
    });
    script({ mem_read: () => ({ values: ['11', '22', '33'] }) });
    await useScannerStore.getState().refreshValues();
    const s = useScannerStore.getState();
    expect(s.results[0]!.value).toBe('11');
    expect(s.saved.map((x) => x.value)).toEqual(['22', '3']);
    expect(mockCall.mock.calls[0]![0].params.items).toEqual([
      { address: '00A0', valueType: 'i32' }, { address: '00B0', valueType: 'f32' }, { address: '00C0', valueType: 'i32' },
    ]);
  });

  it('forgets everything when the session changes', () => {
    useScannerStore.getState().save({ address: '00A0', value: '1' });
    useCeSessionStore.setState({ sessionId: 's2' });
    expect(useScannerStore.getState().saved).toEqual([]);
  });
});
