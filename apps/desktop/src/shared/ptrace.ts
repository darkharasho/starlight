/**
 * Shown when Linux's ptrace restriction keeps Starlight's memory reader
 * (ceserver or starlightd) out of a game. The UI offers a one-click Allow
 * next to it. Shared so the renderer can show the same words.
 */
export const PTRACE_MESSAGE =
  'Starlight needs your permission once to read native Linux games\' memory.';
