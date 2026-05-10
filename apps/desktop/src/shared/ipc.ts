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
  // Phase 5.1
  getConfig:    'starlight:getConfig',
  updateConfig: 'starlight:updateConfig',
  // Phase 5.2
  pickExecutable: 'starlight:pickExecutable',
  // Phase 5.3
  rebindHotkey: 'starlight:rebindHotkey',
  // Phase 5.5
  resolveBoxart: 'starlight:resolveBoxart',
  // CE runtime
  ceRuntimeStatus:   'starlight:ceRuntime:status',
  ceRuntimeInstall:  'starlight:ceRuntime:install',
  ceRuntimeProgress: 'starlight:ceRuntime:progress',
  // CE session
  ceSessionStart:     'starlight:ceSession:start',
  ceSessionEnd:       'starlight:ceSession:end',
  ceSessionSetActive: 'starlight:ceSession:setActive',
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

export type PickExecutableResult =
  | { ok: true; path: string }
  | { ok: false; error: 'cancelled' | 'unknown'; message?: string };

export type HotkeySlot = 'toggle' | 'inc' | 'dec';

export interface RebindHotkeyRequest {
  trainerId: string;
  cheatId: string;
  slot: HotkeySlot;
  /** Electron accelerator string, or `null` to explicitly clear the hotkey (no binding). */
  accelerator: string | null;
}

export type RebindHotkeyResult =
  | { ok: true }
  | { ok: false; error: 'no-active-trainer' | 'conflict' | 'invalid' | 'unknown'; message?: string };

export interface ResolveBoxartRequest {
  name: string;
  steamAppId?: number;
  /** When true, skip Steam CDN even if steamAppId is set — used after a confirmed CDN miss. */
  forceFallback?: boolean;
}

export interface ResolveBoxartResult {
  url: string | null;
}

export type CatalogResult =
  | { ok: true; index: CatalogIndex }
  | { ok: false; error: string };

export type TrainerResult =
  | { ok: true; trainer: CatalogTrainer }
  | { ok: false; error: string };

/**
 * Fetch a trainer JSON. The renderer passes the matched catalog entry; the
 * main process picks the right path:
 *   - `trainerPath` → static fetch from the catalog CDN (legacy curated entries)
 *   - `trainerSource` → live fetch from a fearlessrevolution viewtopic URL
 *     (parses .CT via ct-importer, caches result per-user)
 *
 * The hint fields (`name`, `processName`, `platform`) are required for live
 * fetches because the importer needs them to construct the StarlightTrainer.
 */
export interface FetchTrainerRequest {
  trainerPath?: string;
  trainerSource?: string;
  id: string;
  name: string;
  processName: string[];
  platform: ('windows' | 'linux' | 'macos')[];
  refresh?: boolean;
}

export type IpcOk<T = void> = T extends void ? { ok: true } : { ok: true; value: T };
export type IpcErr = { ok: false; error: string };
export type IpcResult<T = void> = IpcOk<T> | IpcErr;

export interface DetectedGame {
  source: 'steam' | 'manual' | 'epic' | 'heroic' | 'lutris';
  appId: string;
  name: string;
  installDir: string;                    // absolute path on disk
  /** Optional: Steam app id (number) to use for the Library tile's boxart.
   *  Steam-source scanners leave this undefined (boxart is computed from appId).
   *  Manual-source scanner sets this when it matches the entry to a catalog game. */
  boxartSteamAppId?: number;
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
  | { type: 'hotkey:dec';           cheatId: string }
  | { type: 'config:changed';       config: UserConfig }
  | { type: 'config:corrupted';     backupPath: string }
  | { type: 'hotkeys:unavailable';  message: string };

export interface WindowState { maximized: boolean }

export type CeRuntimeStatus =
  | { status: 'ready'; installDir: string; binary: string }
  | { status: 'not-installed' }
  | { status: 'installing'; phase: string; current?: number; total?: number };

export interface CeRuntimeProgressEvent {
  phase: 'downloading' | 'verifying' | 'extracting' | 'done';
  current?: number;
  total?: number;
}

export interface CeSessionRecord {
  id: number;
  name: string;
  isActive: boolean;
  isGroupHeader: boolean;
}

export type CeSessionStartResult =
  | { ok: true; sessionId: string; records: CeSessionRecord[] }
  | { ok: false; error: string; reason?: 'runtime-missing' | 'spawn-failed' | 'unknown' };

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
  // Phase 5.1
  getConfig():    Promise<UserConfig>;
  updateConfig(req: UpdateConfigRequest): Promise<UserConfig>;
  // Phase 5.2
  pickExecutable(): Promise<PickExecutableResult>;
  // Phase 5.3
  rebindHotkey(req: RebindHotkeyRequest): Promise<RebindHotkeyResult>;
  // Phase 5.5
  resolveBoxart(req: ResolveBoxartRequest): Promise<ResolveBoxartResult>;
  // CE runtime
  ceRuntimeStatus(): Promise<CeRuntimeStatus>;
  ceRuntimeInstall(): Promise<{ ok: true } | { ok: false; error: string }>;
  onCeRuntimeProgress(cb: (e: CeRuntimeProgressEvent) => void): () => void;
  // CE session
  ceSessionStart(req: { ctPath: string }): Promise<CeSessionStartResult>;
  ceSessionEnd(req: { sessionId: string }): Promise<{ ok: boolean }>;
  ceSessionSetActive(req: { sessionId: string; recordId: number; active: boolean }): Promise<{ ok: boolean; error?: string }>;
  // Window controls
  windowMinimize():       void;
  windowToggleMaximize(): void;
  windowClose():          void;
  onWindowState(listener: (state: WindowState) => void): () => void;
}

// Phase 5.1 — User config types (canonical Zod schema in main/user-config.ts)
export interface RecentTrainer {
  id: string;
  name: string;
  openedAt: string;                    // ISO timestamp
  source: 'catalog' | 'file';
}

export interface AppPreferences {
  theme: 'dark';
  pollIntervalMs: number;              // 500–30000; ProcessHost interval
  catalogRefreshOnLaunch: boolean;
}

export interface ManualGame {
  id: string;
  name: string;
  exePath: string;
  addedAt: string;
}

export interface CheatHotkeyOverride {
  toggle?: string | null;
  inc?: string | null;
  dec?: string | null;
}

export interface UserConfig {
  schemaVersion: 1;
  processNameOverrides: Record<string, string[]>;
  recents: RecentTrainer[];
  preferences: AppPreferences;
  manualGames: ManualGame[];
  hotkeyOverrides: Record<string, Record<string, CheatHotkeyOverride>>;
}

// DeepPartial type used by updateConfig patches.
export type DeepPartial<T> = T extends object
  ? { [K in keyof T]?: DeepPartial<T[K]> }
  : T;

export interface UpdateConfigRequest { patch: DeepPartial<UserConfig> }

declare global {
  interface Window { starlight: StarlightApi }
}

export type {
  StarlightTrainer, StarlightCheat, StarlightSupportedCheat, ImportStats,
} from '@starlight/ct-importer';

export type { CatalogIndex, CatalogIndexEntry } from '@starlight/catalog/schema';
