import type { StarlightTrainer, ImportStats } from '@starlight/ct-importer';

export const CHANNELS = {
  loadTrainer:   'starlight:loadTrainer',
  attach:        'starlight:attach',
  detach:        'starlight:detach',
  toggleCheat:   'starlight:toggleCheat',
  setCheatValue: 'starlight:setCheatValue',
  event:         'starlight:event',
} as const;

export interface AttachRequest { pid: number }
export type AttachResult =
  | { ok: true }
  | { ok: false; code: 'permission' | 'not-found' | 'unknown'; message: string };

export interface ToggleCheatRequest { cheatId: string; on: boolean }
export interface SetValueRequest    { cheatId: string; value: number }

export type LoadTrainerResult =
  | { ok: true; trainer: StarlightTrainer; stats: ImportStats }
  | { ok: false; error: string };

export type IpcOk<T = void> = T extends void ? { ok: true } : { ok: true; value: T };
export type IpcErr = { ok: false; error: string };
export type IpcResult<T = void> = IpcOk<T> | IpcErr;

export type StarlightEvent =
  | { type: 'cheat:toggled';        cheatId: string; on: boolean; cause: 'hotkey' }
  | { type: 'cheat:value-changed';  cheatId: string; value: number; cause: 'hotkey' }
  | { type: 'session:detached';     reason: 'process-exit' | 'manual' };

export interface StarlightApi {
  loadTrainer():     Promise<LoadTrainerResult>;
  attach(req: AttachRequest): Promise<AttachResult>;
  detach():          Promise<void>;
  toggleCheat(req: ToggleCheatRequest):     Promise<IpcResult>;
  setCheatValue(req: SetValueRequest):      Promise<IpcResult>;
  onEvent(listener: (e: StarlightEvent) => void): () => void;
}

declare global {
  interface Window { starlight: StarlightApi }
}

export type { StarlightTrainer, StarlightCheat, StarlightSupportedCheat, ImportStats } from '@starlight/ct-importer';
