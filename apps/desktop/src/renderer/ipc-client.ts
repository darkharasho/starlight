import type { StarlightApi } from '../shared/ipc.js';

/* In production, the contextBridge installed `window.starlight`.
 * In tests we inject a fake by calling setStarlightApi(). */

let api: StarlightApi | null = null;

export function setStarlightApi(injected: StarlightApi): void { api = injected; }
export function clearStarlightApi(): void { api = null; }

export function starlight(): StarlightApi {
  if (api) return api;
  if (typeof window !== 'undefined' && window.starlight) return window.starlight;
  throw new Error('Starlight IPC API not available — preload script may not have loaded.');
}
