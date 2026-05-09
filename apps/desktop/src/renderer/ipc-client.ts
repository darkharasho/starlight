import type { StarlightApi } from '../shared/ipc.js';

/* In production, the contextBridge installed `window.starlight`.
 * In tests we inject a fake by calling setStarlightApi(). */

let _injected: StarlightApi | null = null;

export function setStarlightApi(injected: StarlightApi): void { _injected = injected; }
export function clearStarlightApi(): void { _injected = null; }

export function starlight(): StarlightApi {
  if (_injected) return _injected;
  if (typeof window !== 'undefined' && window.starlight) return window.starlight;
  throw new Error('Starlight IPC API not available — preload script may not have loaded.');
}

/** Typed accessor for new stores. Throws if the API is unavailable. */
export function api(): StarlightApi {
  if (_injected) return _injected;
  if (typeof window !== 'undefined' && window.starlight) return window.starlight;
  throw new Error('window.starlight is not available — preload missing or test setup incomplete');
}
