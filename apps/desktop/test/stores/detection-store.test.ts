import { describe, it, expect, beforeEach } from 'vitest';
import { useDetectionStore } from '../../src/renderer/stores/detection-store.js';

beforeEach(() => useDetectionStore.setState({ detected: null }));

describe('detection-store', () => {
  it('stores the latest detection', () => {
    useDetectionStore.getState().setDetected({ game: { id: 'g', name: 'G', steamAppId: null }, pid: 5, name: 'G.exe', confidence: 'exact' });
    expect(useDetectionStore.getState().detected?.pid).toBe(5);
  });

  it('clears the detection', () => {
    useDetectionStore.getState().setDetected({ game: { id: 'g', name: 'G', steamAppId: null }, pid: 5, name: 'G.exe', confidence: 'exact' });
    useDetectionStore.getState().clear();
    expect(useDetectionStore.getState().detected).toBeNull();
  });
});
