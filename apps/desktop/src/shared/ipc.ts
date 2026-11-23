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
  // CE session
  ceSessionStart:     'starlight:ceSession:start',
  ceSessionEnd:       'starlight:ceSession:end',
  ceSessionSetActive: 'starlight:ceSession:setActive',
  ceSessionCall:      'starlight:ceSession:call',
  ceSessionRetry:     'starlight:ceSession:retry',
  // Launching games
  launchGame:      'starlight:launchGame',
  allowMemoryAccess: 'starlight:allowMemoryAccess',
  findGameProcess: 'starlight:findGameProcess',
  // Window controls
  windowMinimize:       'starlight:window:minimize',
  windowToggleMaximize: 'starlight:window:toggleMaximize',
  windowClose:          'starlight:window:close',
  windowState:          'starlight:window:state',
  // Starlight's own updates
  updateGetVersion: 'starlight:update:getVersion',
  updateGetState:   'starlight:update:getState',
  updateCheck:      'starlight:update:check',
  updateRestart:    'starlight:update:restart',
  updateState:      'starlight:update:state',
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
  | { type: 'hotkeys:unavailable';  message: string }
  | { type: 'session:progress';     message: string }
  | { type: 'session:tables';       tables: CePickStep[] }
  /** The attached game exited; main already closed Cheat Engine. */
  | { type: 'session:game-exited';  sessionId: string }
  | { type: 'ce:hotkey';            recordId: number; ok: boolean; active: boolean; error?: string | undefined }
  /** The trainer engine's install state changed (downloads run in the background). */
  | { type: 'ceRuntime:status'; status: CeRuntimeStatus; error?: string | undefined }
  | { type: 'game:detected'; game: { id: string; name: string; steamAppId?: number | null }; pid: number; name: string; confidence: 'exact' | 'name' };

export interface WindowState { maximized: boolean }

export type CeRuntimeStatus =
  | { status: 'ready'; winCeDir: string; winCeExe: string; ceserver: string }
  /** `missing` lists what still has to be downloaded (an update can add a part). */
  | { status: 'not-installed'; missing: ('windows-ce' | 'ceserver')[] }
  | { status: 'installing'; phase: string; current?: number; total?: number };

export interface CeSessionRecord {
  id: number;
  name: string;
  isActive: boolean;
  isGroupHeader: boolean;
  /** `script` = on/off cheat, `value` = editable address, `header` = section. */
  kind?: 'script' | 'value' | 'header';
  /** Nesting level in the table (0 = top). */
  depth?: number;
  /** Current value of a value record ("??" when unreadable). Attached sessions only. */
  value?: string;
  /** Named choices for a value record, when the table defines a dropdown. */
  options?: { value: string; label: string }[];
  /** CE option flags, e.g. "[moHideChildren]". */
  opts?: string;
  /** Hotkey the table itself binds to toggling this record, e.g. "F2". */
  hotkey?: string;
}

/** How a table fared against the running game. */
export type CeTableVerdict = 'works' | 'broken' | 'unknown';

export interface CeTableAttempt { id: number; filename: string; verdict: CeTableVerdict }

/** One table queued for checking against the game, for the connecting screen. */
export interface CePickStep { id: number; filename: string; state: 'waiting' | 'checking' | CeTableVerdict }

/** The table-dependent part of a session: what's loaded and how it was prepared. */
export interface CeSessionTableState {
  records: CeSessionRecord[];
  tableId: number | null;
  tableError?: string | undefined;
  /** Prerequisite scripts switched on automatically; hidden from the cheat list. */
  hiddenIds: number[];
  /** Prerequisite scripts that refused to switch on, with the table's reason. */
  prereqErrors: Record<number, string>;
  verdict: CeTableVerdict;
  /** Every table tried, in order. */
  attempts: CeTableAttempt[];
}

/** An installed game, as the library scan identifies it. */
export interface LaunchTarget { source: DetectedGame['source']; appId: string }

/** One cheat table on offer for a game (a forum attachment or a direct .CT link). */
export interface CeTable {
  /** Forum attachment id; higher = newer upload. 0 for a direct link. */
  id: number;
  filename: string;
  url: string;
  topicUrl: string;
}

/** Value types the memory scanner understands. */
export type ScanValueType = 'i8' | 'i16' | 'i32' | 'i64' | 'f32' | 'f64';

export interface CeSessionStartRequest {
  /** URL of a .CT or viewtopic page. Omit both this and `sources` for a tools-only session. */
  source?: string | undefined;
  /** Every thread/.CT URL known for this game; their tables are offered as alternatives. */
  sources?: string[] | undefined;
  /**
   * Table (attachment id) the user explicitly picked: loaded as is. Without it
   * the remembered table is tried first and, if it no longer matches the game,
   * the others are tried automatically.
   */
  tableId?: number | undefined;
  cacheKey: string;   // unique key per catalog entry id
  /** Target game process (Linux pid). Enables attach + Proton detection. */
  pid?: number | undefined;
  /** Target process name (e.g. "9Kings.exe"). Derived from the pid if omitted. */
  processName?: string | undefined;
  /** Game identity so main can auto-resolve the running process (reactive auto-attach). */
  game?: { id: string; name: string; steamAppId?: number | null } | undefined;
}

export type CeSessionStartResult =
  | ({
      ok: true; sessionId: string; proton: boolean; attached: boolean; needsPicker?: boolean;
      /** False when the game was looked for and isn't running (the session is a preview). */
      running: boolean;
      tables: CeTable[];
      process?: { pid: number; name?: string | undefined } | undefined;
    } & CeSessionTableState)
  | { ok: false; error: string; reason?: 'runtime-missing' | 'spawn-failed' | 'not-running' | 'busy' | 'ptrace' | 'unknown' };

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
  // CE session
  ceSessionStart(req: CeSessionStartRequest): Promise<CeSessionStartResult>;
  ceSessionEnd(req: { sessionId: string }): Promise<{ ok: boolean }>;
  ceSessionSetActive(req: { sessionId: string; recordId: number; active: boolean }): Promise<{ ok: boolean; error?: string }>;
  /** Value edits, game speed and the memory scanner. Always resolves; failures are `{ ok: false, error }`. */
  ceSessionCall(req: { sessionId: string; method: string; params?: unknown }): Promise<Record<string, unknown>>;
  /** Look again for a table that matches the game (e.g. once it has finished loading). */
  ceSessionRetry(req: { sessionId: string }): Promise<({ ok: true } & CeSessionTableState) | { ok: false; error: string }>;
  // Launching games
  launchGame(req: LaunchTarget): Promise<{ ok: true } | { ok: false; error: string }>;
  /** Asks (desktop password prompt) to let Starlight read native games' memory. */
  allowMemoryAccess(): Promise<{ ok: true } | { ok: false; cancelled?: boolean; error: string }>;
  findGameProcess(req: { game: { id: string; name: string; steamAppId?: number | null } }): Promise<{ pid: number; name: string } | null>;
  // Window controls
  windowMinimize():       void;
  windowToggleMaximize(): void;
  windowClose():          void;
  onWindowState(listener: (state: WindowState) => void): () => void;
  // Starlight's own updates
  /** Starlight's version (app.getVersion()). */
  updateGetVersion(): Promise<string>;
  updateGetState():   Promise<UpdateState>;
  /** A manual check; outside the AppImage it answers without checking. */
  updateCheck():      Promise<UpdateCheckResult>;
  /** Quits and installs a downloaded update; does nothing before one is downloaded. */
  updateRestart():    Promise<void>;
  onUpdateState(listener: (state: UpdateState) => void): () => void;
}

export type UpdateState =
  | { status: 'idle' }
  | { status: 'checking' }
  | { status: 'none' }
  | { status: 'downloading'; version: string; percent: number | null }
  | { status: 'downloaded'; version: string }
  | { status: 'error'; message: string };

export type UpdateCheckResult = { ok: true } | { ok: false; error: string };

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
  autoAttachOnDetect: boolean;
  /** In-game hotkeys for cheats (table-defined, user-set and auto-assigned). */
  cheatHotkeys: boolean;
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
  /** Game key → attachment id of the table that last worked (or the user chose) for it. */
  tableChoices: Record<string, number>;
  /** Game key → cheat name → hotkey accelerator (null = explicitly no hotkey). */
  cheatHotkeys: Record<string, Record<string, string | null>>;
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
