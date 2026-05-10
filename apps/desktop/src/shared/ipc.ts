import type { StarlightTrainer, ImportStats } from '@starlight/ct-importer';
import type { CatalogIndex, StarlightTrainer as CatalogTrainer } from '@starlight/catalog/schema';

export const CHANNELS = {
  loadTrainer:   'starlight:loadTrainer',
  attach:        'starlight:attach',
  detach:        'starlight:detach',
  toggleCheat:   'starlight:toggleCheat',
  setCheatValue: 'starlight:setCheatValue',
  event:         'starlight:event',
  fetchCatalog:  'starlight:fetchCatalog',
  fetchTrainer:  'starlight:fetchTrainer',
  // Phase 4.5
  scanLibrary:    'starlight:scanLibrary',
  listProcesses:  'starlight:listProcesses',
  setProcessName: 'starlight:setProcessName',
  // Phase 5.0 Task 11
  setTrainerFromCatalog: 'starlight:setTrainerFromCatalog',
  // Window controls
  windowMinimize:       'starlight:window:minimize',
  windowToggleMaximize: 'starlight:window:toggleMaximize',
  windowClose:          'starlight:window:close',
  windowState:          'starlight:window:state',
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

export type CatalogResult =
  | { ok: true; index: CatalogIndex }
  | { ok: false; error: string };

export type TrainerResult =
  | { ok: true; trainer: CatalogTrainer }
  | { ok: false; error: string };

export interface FetchTrainerRequest { trainerPath: string }

export type IpcOk<T = void> = T extends void ? { ok: true } : { ok: true; value: T };
export type IpcErr = { ok: false; error: string };
export type IpcResult<T = void> = IpcOk<T> | IpcErr;

export interface DetectedGame {
  source: 'steam';                       // future: 'epic' | 'heroic' | 'lutris'
  appId: string;
  name: string;
  installDir: string;                    // absolute path on disk
}
export interface DetectedProcess { pid: number; name: string }

export interface ScanLibraryResult { games: DetectedGame[] }
export interface ListProcessesResult { processes: DetectedProcess[] }
export interface SetProcessNameRequest { names: string[] }

export type StarlightEvent =
  | { type: 'cheat:toggled';        cheatId: string; on: boolean; cause: 'hotkey' }
  | { type: 'cheat:value-changed';  cheatId: string; value: number; cause: 'hotkey' }
  | { type: 'session:detached';     reason: 'process-exit' | 'manual' }
  | { type: 'process:list';         processes: DetectedProcess[] }
  | { type: 'process:matched';      pid: number; name: string }
  | { type: 'library:scanned';      games: DetectedGame[] }
  | { type: 'hotkey:inc';           cheatId: string }
  | { type: 'hotkey:dec';           cheatId: string };

export interface WindowState { maximized: boolean }

export interface StarlightApi {
  loadTrainer():     Promise<LoadTrainerResult>;
  attach(req: AttachRequest): Promise<AttachResult>;
  detach():          Promise<void>;
  toggleCheat(req: ToggleCheatRequest):     Promise<IpcResult>;
  setCheatValue(req: SetValueRequest):      Promise<IpcResult>;
  // Phase 4.5
  scanLibrary():     Promise<ScanLibraryResult>;
  listProcesses():   Promise<ListProcessesResult>;
  setProcessName(req: SetProcessNameRequest): Promise<void>;
  // Phase 5.0
  fetchCatalog():    Promise<CatalogResult>;
  fetchTrainer(req: FetchTrainerRequest): Promise<TrainerResult>;
  setTrainerFromCatalog(req: { trainer: import('@starlight/catalog/schema').StarlightTrainer }): Promise<IpcResult>;
  onEvent(listener: (e: StarlightEvent) => void): () => void;
  // Window controls
  windowMinimize():       void;
  windowToggleMaximize(): void;
  windowClose():          void;
  onWindowState(listener: (state: WindowState) => void): () => void;
}

declare global {
  interface Window { starlight: StarlightApi }
}

export type {
  StarlightTrainer, StarlightCheat, StarlightSupportedCheat, ImportStats,
} from '@starlight/ct-importer';

export type { CatalogIndex, CatalogIndexEntry } from '@starlight/catalog/schema';
