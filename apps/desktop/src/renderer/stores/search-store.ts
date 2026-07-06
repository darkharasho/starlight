import { create } from 'zustand';

/**
 * The global search query, shared between the always-visible top-bar search box
 * and the Search route's results. Lets the user search from any tab.
 */
interface SearchState {
  query: string;
  setQuery: (query: string) => void;
}

export const useSearchStore = create<SearchState>((set) => ({
  query: '',
  setQuery: (query) => set({ query }),
}));
