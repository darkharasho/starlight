import { describe, it, expect, beforeEach } from 'vitest';
import { useSearchStore } from '../../src/renderer/stores/search-store.js';

beforeEach(() => useSearchStore.setState({ query: '' }));

describe('search-store', () => {
  it('starts empty', () => {
    expect(useSearchStore.getState().query).toBe('');
  });

  it('setQuery updates the shared query', () => {
    useSearchStore.getState().setQuery('elden');
    expect(useSearchStore.getState().query).toBe('elden');
  });
});
