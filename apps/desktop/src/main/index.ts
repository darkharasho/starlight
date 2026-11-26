import { userInfo } from 'node:os';
import { app, BrowserWindow, ipcMain, dialog, shell, protocol } from 'electron';
import { guardStdio } from './stdio-guard.js';
import { CHANNELS, type AttachRequest, type AttachResult, type LoadTrainerResult, type ToggleCheatRequest, type SetValueRequest, type IpcResult } from '../shared/ipc.js';
import { loadTrainer, setTrainerFromCatalog } from './trainer-loader.js';
import * as engineHost from './engine-host.js';
import { configureStarlightdHost, getEngineClient, engineNeedsPtraceGrant, enginePid, installedDaemonPath, restartEngine, stopEngine } from './starlightd-host.js';
import { syncCheatState, unregisterAll as unregisterHotkeys, registerForTrainer as registerHotkeysForTrainer, shutdown as shutdownHotkeys, setAgentHotkeys, setInitFailureHandler as setHotkeysInitFailureHandler } from './hotkey-host.js';
import { scanAll as scanLibrary } from './library-host.js';
import { processHost, setWindowVisible, setEngineAttached, setOnProcessList } from './process-host-singleton.js';
import { LatchDetector } from './latch-detector.js';
import { fetchCatalog, fetchTrainer, getCachedIndex, trainerForEntry } from './catalog-host.js';
import { fetchTrainerLive } from './trainer-live-fetch.js';
import type { FetchTrainerRequest, CatalogIndexEntry, UserCheatGame, ShareCheatRequest } from '../shared/ipc.js';
import { withMyGames } from '../shared/my-games.js';
import { getConfig, updateConfig, setOnCorrupt } from './user-config.js';
import { resolveBoxart, serveArt } from './boxart-host.js';
import { ART_SCHEME } from './steam-art.js';
import { createRuntimeManager, type RuntimeManifest } from './ce-runtime-manager.js';
import { grantPtraceCap, isPtraceBlocked, readPtraceScope } from './ce-native.js';
import { recordRoute } from './ct-runner.js';
import { startSession as ceStartSession, endSession as ceEndSession, setActive as ceSetActive, callSession as ceCallSession, retryTables as ceRetryTables, getActiveSession as ceGetActiveSession, ceSessionFor, releaseToStarlightd, engineOf, gameCodeBits } from './ce-session.js';
import { createUserCheatsHost } from './user-cheats-host.js';
import { createShareHost } from './share-host.js';
import { createCommunityHost, communityAppId, isCommunityKey, saveCommunityCheat, type CommunityContext } from './community-host.js';
import { listUserCheatGames, loadUserTrainer, userCheatsDir } from './user-cheats.js';
import { createGameOwner } from './game-owner.js';
import { setGameOwner } from './game-owner-singleton.js';
import { cleanCeError } from './ce-session.js';
import { launchGame } from './game-launcher.js';
import { matchGameToProcess } from './game-matcher.js';
import { killStaleCeProcesses } from './ce-process.js';
import { buildCatalogIndex, type CatalogEntry } from './game-matcher.js';
import { join } from 'node:path';
import { readFile, readlink } from 'node:fs/promises';
import { startMcpHost, type McpHost } from './agent/mcp-host.js';
import { loadOrCreateToken, rotateToken } from './agent/token.js';
import { buildConnectInfo } from './agent/connect-info.js';
import { createAgentServer } from './agent/server.js';
import type { ToolDef } from './agent/tools.js';
import { attachTool, detachTool, gameInfoTool, listGamesTool, listInstalledGamesTool } from './agent/tools-session.js';
import { createActivityLog } from './agent/activity.js';
import { createPlayerPrompts } from './agent/player-prompt.js';
import { electronNotifier } from './agent/notifier.js';
import { askPlayerTool } from './agent/tools-ask.js';
import { discoveryTools } from './agent/tools-discovery.js';
import { modifyTools } from './agent/tools-modify.js';
import { libraryTools } from './agent/tools-library.js';
import { createAgentSession } from './agent/session.js';
import { checkAttachTarget, procTargetDeps } from './agent/target-guard.js';
import { createBeforeQuit } from './quit.js';
import { listModules as engineListModules, processInfo as engineProcessInfo } from '@starlight/engine';
import { identifyGame } from './game-identity.js';
import { detectAntiCheat } from './anti-cheat.js';
import { createUpdater, type AutoUpdaterLike } from './updater.js';
import { webLink } from '../shared/web-link.js';

// Before anything logs: a closed stdout must not crash Starlight (see stdio-guard.ts).
guardStdio();

let lastDetectedGames: import('../shared/ipc.js').DetectedGame[] = [];
let catalogIndex = new Map<string, CatalogEntry>();
/** The catalog's own games, before the player's are added. */
let catalogGames: CatalogIndexEntry[] = [];
/** Games the player (or the agent) saved cheats for. */
let myGames: UserCheatGame[] = [];

/**
 * The meta catalog: the catalog plus every game the player has their own cheats
 * for, so a game the agent made cheats for is found, detected and opened like
 * any catalog game. Search, Browse, Library, detection and the agent all use it.
 */
function metaCatalog(): CatalogIndexEntry[] {
  return withMyGames(catalogGames, myGames);
}

async function refreshMyGames(): Promise<UserCheatGame[]> {
  myGames = await listUserCheatGames(userCheatsDir(app.getPath('userData'))).catch(() => myGames);
  catalogIndex = buildCatalogIndex(metaCatalog() as CatalogEntry[]);
  return myGames;
}

function userCheatsChanged(key: string): void {
  void refreshMyGames().finally(() => broadcast({ type: 'userCheats:changed', key }));
}

function broadcast(e: import('../shared/ipc.js').StarlightEvent): void {
  for (const win of BrowserWindow.getAllWindows()) win.webContents.send(CHANNELS.event, e);
}

function broadcastEngine(): void {
  const s = ceGetActiveSession();
  if (s && s.pid !== null) broadcast({ type: 'session:engine', sessionId: s.sessionId, engine: engineOf(s.mode), mode: s.mode, holders: gameOwner.holders(s.pid) });
}

/** One engine per game: Cheat Engine and starlightd never both hold it. */
const gameOwner = createGameOwner({
  ceSessionFor,
  releaseCe: async (id) => { await releaseToStarlightd(id); broadcastEngine(); },
  onChange: (pid) => { if (ceGetActiveSession()?.pid === pid) broadcastEngine(); },
});
setGameOwner(gameOwner);

const communityHost = createCommunityHost({ cacheDir: join(app.getPath('userData'), 'catalog-cache') });

/** The running game's platform, build and bitness, so only community cheats that fit it show. */
async function communityContext(pid: number | null): Promise<CommunityContext> {
  if (pid === null) return { platform: null, bits: null, buildId: null };
  const id = await identifyGame(pid, { catalogIndex: () => catalogIndex, detectedGames: () => lastDetectedGames }, { hash: false }).catch(() => null);
  const bits = await engineProcessInfo(await getEngineClient(), pid).then((r) => r.codeBits, () => null);
  return { platform: id ? (id.proton ? 'windows' : 'linux') : null, bits, buildId: id?.buildId ?? null };
}

const userCheatsHost = createUserCheatsHost({
  dir: userCheatsDir(app.getPath('userData')),
  getClient: getEngineClient,
  owner: gameOwner,
  onChange: userCheatsChanged,
  loadTrainer: async (key, pid) => {
    if (isCommunityKey(key)) return communityHost.trainer(communityAppId(key), await communityContext(pid));
    const trainer = await loadUserTrainer(userCheatsDir(app.getPath('userData')), key);
    return trainer ? { trainer } : null;
  },
});

const shareHost = createShareHost({
  dir: userCheatsDir(app.getPath('userData')),
  userData: app.getPath('userData'),
  appVersion: app.getVersion(),
  username: userInfo().username,
  liveBits: async (pid) => (await engineProcessInfo(await getEngineClient(), pid)).codeBits,
});

// --- The agent's MCP server (Claude Code / Codex) ---

const USER_DATA = app.getPath('userData');
let agentToken: string | null = null;
let mcpHost: McpHost | null = null;
/** The configured port `mcpHost` was started for (it may run on a fallback). */
let mcpHostConfiguredPort: number | null = null;
let mcpHostChain: Promise<void> = Promise.resolve();

async function loadAgentToken(): Promise<string> {
  agentToken ??= await loadOrCreateToken(USER_DATA);
  return agentToken;
}

// The agent session: player-approved attach, tiers, Stop and the activity log.
let agentStateQueued = false;
/** Sends the agent's state to the renderer, at most once per tick. */
function broadcastAgentState(): void {
  if (agentStateQueued) return;
  agentStateQueued = true;
  setImmediate(() => {
    agentStateQueued = false;
    broadcast({ type: 'agent:state', state: agentSession.snapshot() });
  });
}

/** Brings Starlight to the front on the agent view. */
function focusAgentView(): void {
  const win = BrowserWindow.getAllWindows()[0];
  if (win) {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  }
  broadcast({ type: 'agent:focus' });
}

const agentActivity = createActivityLog({ onChange: broadcastAgentState });
const agentPrompts = createPlayerPrompts({
  notifier: electronNotifier(), focusAgentView, onChange: broadcastAgentState,
  hotkeys: { set: setAgentHotkeys }, prefs: async () => (await getConfig()).agent,
});
const attachTargetDeps = procTargetDeps({ daemonPid: enginePid });
const agentSession = createAgentSession({
  getClient: getEngineClient,
  checkTarget: (pid) => checkAttachTarget(pid, attachTargetDeps),
  identify: (pid) => identifyGame(pid, { catalogIndex: () => catalogIndex, detectedGames: () => lastDetectedGames }),
  owner: gameOwner,
  prompts: agentPrompts,
  hotkeys: { set: setAgentHotkeys },
  activity: agentActivity,
  prefs: async () => (await getConfig()).agent,
  onChange: broadcastAgentState,
  focusAgentView,
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const agentTools: ToolDef<any>[] = [
  listGamesTool({
    listProcesses: () => processHost.listOnce(),
    manualExePaths: async () => (await getConfig()).manualGames.map((g) => g.exePath),
    installDirs: () => lastDetectedGames.map((g) => g.installDir).filter(Boolean),
    exePath: (pid) => readlink(`/proc/${pid}/exe`).catch(() => null),
    identify: (pid) => identifyGame(pid, { catalogIndex: () => catalogIndex, detectedGames: () => lastDetectedGames }, { hash: false }),
    detectAntiCheatFn: (pid) => detectAntiCheat(pid),
    attachedPid: () => agentSession.attachedPid(),
  }),
  listInstalledGamesTool({
    // A fresh scan (it takes well under a second), so games installed since launch show up.
    installedGames: async () => (lastDetectedGames = await scanLibrary()),
    catalog: async () => {
      if (!getCachedIndex()) catalogGames = (await fetchCatalog()).games;
      await refreshMyGames();
      return metaCatalog();
    },
  }),
  attachTool(agentSession),
  detachTool(agentSession),
  askPlayerTool(agentPrompts, async () => (await getConfig()).agent),
  gameInfoTool({ listModules: engineListModules, readMaps: (pid) => readFile(`/proc/${pid}/maps`, 'utf8') }),
  ...discoveryTools(),
  ...modifyTools(),
  ...libraryTools({
    dir: userCheatsDir(USER_DATA),
    onSaved: userCheatsChanged,
    catalogTrainerFor: async (game) => {
      const entry = game.catalogId ? (getCachedIndex()?.games ?? []).find((g) => g.id === game.catalogId) : undefined;
      if (!entry) return null;
      return await trainerForEntry(entry, { fetchTrainer, fetchTrainerLive: (src, game) => fetchTrainerLive(src, game) });
    },
  }),
];

/** Starts, restarts or stops the MCP server to match the agent preferences. Serialized. */
function applyAgentHost(prefs: { enabled: boolean; port: number }): Promise<void> {
  mcpHostChain = mcpHostChain.then(async () => {
    if (prefs.enabled && mcpHost && mcpHostConfiguredPort === prefs.port) return;
    if (mcpHost) {
      const old = mcpHost;
      mcpHost = null;
      mcpHostConfiguredPort = null;
      await old.close().catch(() => {});
    }
    if (!prefs.enabled) return;
    await loadAgentToken();
    mcpHost = await startMcpHost({
      port: prefs.port,
      token: () => agentToken ?? '',
      createServer: (mcpSessionId) => createAgentServer(mcpSessionId, {
        version: app.getVersion(),
        tools: agentTools,
        access: agentSession,
        activity: agentActivity,
        onClientInfo: () => {},
      }),
      onSessionClosed: (mcpSessionId) => { void agentSession.onMcpSessionClosed(mcpSessionId).catch(() => {}); },
    });
    mcpHostConfiguredPort = prefs.port;
  }).catch((err) => {
    console.error('[agent] the MCP server failed to start:', err instanceof Error ? err.message : err);
  });
  return mcpHostChain;
}

async function agentConnectInfo(): Promise<import('../shared/ipc.js').AgentConnectInfo> {
  await mcpHostChain;
  const cfg = await getConfig();
  return buildConnectInfo({
    enabled: cfg.agent.enabled,
    port: mcpHost?.port ?? cfg.agent.port,
    portIsFallback: mcpHost?.portIsFallback ?? false,
    token: await loadAgentToken(),
  });
}

/** Remembers the table that worked for a game so the next launch starts with it. */
async function rememberTable(cacheKey: string, tableId: number | null): Promise<void> {
  if (tableId === null || tableId === 0) return;
  const cfg = await getConfig();
  if (cfg.tableChoices[cacheKey] === tableId) return;
  await updateConfig({ tableChoices: { [cacheKey]: tableId } });
}

let sessionCacheKey: string | null = null;

const latchDetector = new LatchDetector({
  catalogIndex: () => catalogIndex,
  detectedGames: () => lastDetectedGames,
  isSessionActive: () => ceGetActiveSession() !== null,
});

setOnProcessList((processes) => {
  latchDetector.prune(new Set(processes.map((p) => p.pid)));
  void latchDetector.detect(processes).then((d) => {
    if (!d) return;
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send(CHANNELS.event, {
        type: 'game:detected',
        game: { id: d.game.id, name: d.game.name, steamAppId: d.game.steamAppId },
        pid: d.pid, name: d.name, confidence: d.confidence,
      });
    }
  }).catch(() => {});
});

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 600,
    backgroundColor: '#07070b',
    show: false,
    frame: false,
    autoHideMenuBar: true,
    icon: join(app.getAppPath(), 'build', 'icon.png'),
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.once('ready-to-show', () => win.show());

  win.on('hide',     () => setWindowVisible(false));
  win.on('minimize', () => setWindowVisible(false));
  win.on('show',     () => setWindowVisible(true));
  win.on('restore',  () => setWindowVisible(true));

  const sendState = (): void => {
    win.webContents.send(CHANNELS.windowState, { maximized: win.isMaximized() });
  };
  win.on('maximize',   sendState);
  win.on('unmaximize', sendState);

  if (process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL']);
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'));
  }
}

const CE_RUNTIME_ROOT = join(app.getPath('userData'), 'runtime');
const CT_CACHE_DIR = join(app.getPath('userData'), 'ct-cache');
/** Local counts of where tables were routed (D20). */
const CT_ROUTING_FILE = join(app.getPath('userData'), 'ct-routing.json');
const CE_MANIFEST_URL = 'https://raw.githubusercontent.com/darkharasho/starlight-runtimes/main/manifest.json';

// The trainer engine downloads itself in the background; nobody is asked.
configureStarlightdHost({
  runtimeRoot: CE_RUNTIME_ROOT,
  isPackaged: app.isPackaged,
  resourcesPath: process.resourcesPath,
  appPath: app.getAppPath(),
});
const runtimeManager = createRuntimeManager({
  runtimeRoot: CE_RUNTIME_ROOT,
  fetchManifest: async () => {
    const res = await fetch(CE_MANIFEST_URL);
    if (!res.ok) throw new Error(`runtime list HTTP ${res.status}`);
    return await res.json() as RuntimeManifest;
  },
  onStatus: (status, error) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.webContents.isDestroyed()) win.webContents.send(CHANNELS.event, { type: 'ceRuntime:status', status, error });
    }
  },
});

engineHost.onDetached((reason) => {
  unregisterHotkeys();
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(CHANNELS.event, { type: 'session:detached', reason });
  }
});

engineHost.onAttachStateChange((attached) => setEngineAttached(attached));

// Steam cover art reaches the renderer through starlight-art://steam/<appid>,
// which main answers from Steam's local cache or the store. Must be
// registered before ready.
protocol.registerSchemesAsPrivileged([
  // corsEnabled + supportFetchAPI: the renderer reads cover pixels for the game's accent colour.
  { scheme: ART_SCHEME, privileges: { standard: true, secure: true, corsEnabled: true, supportFetchAPI: true } },
]);

app.whenReady().then(async () => {
  protocol.handle(ART_SCHEME, (request) => serveArt(request.url));

  setOnCorrupt((backupPath) => {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send(CHANNELS.event, { type: 'config:corrupted', backupPath });
    }
  });

  setHotkeysInitFailureHandler((message) => {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send(CHANNELS.event, { type: 'hotkeys:unavailable', message });
    }
  });

  const initialConfig = await getConfig();
  processHost.setIntervalMs(initialConfig.preferences.pollIntervalMs);
  void applyAgentHost(initialConfig.agent);

  // Reap Cheat Engine processes orphaned by a previous crash (which bypasses the
  // before-quit cleanup). Leftover CE holds the game open and makes the next
  // attach time out ("spawned but timed out waiting for ping").
  void killStaleCeProcesses(CE_RUNTIME_ROOT)
    .then((n) => { if (n > 0) console.log(`[startup] reaped ${n} orphaned Cheat Engine process(es)`); })
    .catch(() => {});

  // Populate the installed-game list up front. The latch detector bridges a
  // running process's Proton compatdata appid to a catalog entry *through* this
  // list, so without it a game already running at launch (before the user opens
  // the Library tab) can't be identified. Fire-and-forget: each poll re-evaluates
  // unmatched processes, so detection catches up once the scan resolves.
  void scanLibrary()
    .then((games) => {
      lastDetectedGames = games;
      for (const win of BrowserWindow.getAllWindows()) {
        win.webContents.send(CHANNELS.event, { type: 'library:scanned', games });
      }
    })
    .catch(() => {});

  ipcMain.handle(CHANNELS.loadTrainer, async (): Promise<LoadTrainerResult> =>
    loadTrainer(BrowserWindow.getFocusedWindow() ?? undefined));

  ipcMain.handle(CHANNELS.attach,
    async (_evt, req: AttachRequest): Promise<AttachResult> => engineHost.attach(req.pid));

  ipcMain.handle(CHANNELS.detach, async () => engineHost.detach());
  ipcMain.handle(CHANNELS.toggleCheat,
    async (_evt, req: ToggleCheatRequest): Promise<IpcResult> => {
      const r = await engineHost.toggleCheat(req.cheatId, req.on);
      if (r.ok) syncCheatState(req.cheatId, req.on);
      return r;
    });

  ipcMain.handle(CHANNELS.setCheatValue,
    async (_evt, req: SetValueRequest): Promise<IpcResult> => engineHost.setCheatValue(req.cheatId, req.value));

  ipcMain.handle(CHANNELS.scanLibrary, async () => {
    const games = await scanLibrary();
    lastDetectedGames = games;
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send(CHANNELS.event, { type: 'library:scanned', games });
    }
    return { games };
  });
  ipcMain.handle(CHANNELS.listProcesses, async () => {
    const processes = await processHost.listOnce();
    return { processes };
  });

  ipcMain.handle(CHANNELS.setProcessName, async (_evt, req: { names: string[] }) => {
    processHost.setTrainerProcessNames(req.names);
    if (engineHost.getActiveTrainer()) engineHost.updateProcessName(req.names);
  });

  ipcMain.handle(CHANNELS.fetchCatalog, async () => {
    try {
      const index = await fetchCatalog();
      // A game running before the catalog loads is re-evaluated each poll (LatchDetector.reported
      // only records matched pids), so it will be detected once the index populates — don't
      // "optimize" the re-evaluation away.
      catalogGames = index?.games ?? [];
      await refreshMyGames();
      return { ok: true as const, index: { ...index, games: metaCatalog() } };
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle(CHANNELS.setTrainerFromCatalog, async (_evt, req: { trainer: import('@starlight/ct-importer').StarlightTrainer }) =>
    setTrainerFromCatalog(req.trainer));

  ipcMain.handle(CHANNELS.fetchTrainer, async (_evt, req: FetchTrainerRequest) => {
    try {
      let trainer;
      if (req.trainerPath) {
        trainer = await fetchTrainer(req.trainerPath);
      } else if (req.trainerSource) {
        const liveOpts: Parameters<typeof fetchTrainerLive>[1] = {
          id: req.id,
          name: req.name,
          processName: req.processName,
          platform: req.platform,
        };
        if (req.refresh !== undefined) liveOpts.refresh = req.refresh;
        trainer = await fetchTrainerLive(req.trainerSource, liveOpts);
      } else {
        return { ok: false as const, error: 'fetchTrainer: neither trainerPath nor trainerSource provided' };
      }
      return { ok: true as const, trainer };
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle(CHANNELS.getConfig, async () => getConfig());
  ipcMain.handle(CHANNELS.updateConfig, async (_evt, req: { patch: import('../shared/ipc.js').DeepPartial<import('../shared/ipc.js').UserConfig> }) => {
    const next = await updateConfig(req.patch);
    processHost.setIntervalMs(next.preferences.pollIntervalMs);
    void applyAgentHost(next.agent);  // restarts only when enabled or port changed
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send(CHANNELS.event, { type: 'config:changed', config: next });
    }
    return next;
  });

  ipcMain.handle(CHANNELS.pickExecutable, async () => {
    const focused = BrowserWindow.getFocusedWindow();
    const opts = {
      title: 'Pick a game executable',
      properties: ['openFile' as const],
      filters: [
        { name: 'Executables', extensions: ['exe', 'app', 'sh', '*'] },
        { name: 'All files',   extensions: ['*'] },
      ],
    };
    const result = focused
      ? await dialog.showOpenDialog(focused, opts)
      : await dialog.showOpenDialog(opts);
    if (result.canceled || result.filePaths.length === 0) {
      return { ok: false, error: 'cancelled' as const };
    }
    return { ok: true as const, path: result.filePaths[0]! };
  });

  ipcMain.handle(CHANNELS.rebindHotkey, async (_evt, req: import('../shared/ipc.js').RebindHotkeyRequest):
    Promise<import('../shared/ipc.js').RebindHotkeyResult> => {
    const trainer = engineHost.getActiveTrainer();
    if (!trainer || trainer.id !== req.trainerId) {
      return { ok: false, error: 'no-active-trainer' };
    }
    // Build the new override patch.
    const cfg = await getConfig();
    const trainerOverrides = { ...(cfg.hotkeyOverrides[req.trainerId] ?? {}) };
    const cheatOverride = { ...(trainerOverrides[req.cheatId] ?? {}) };
    cheatOverride[req.slot] = req.accelerator;        // null clears, string overrides
    trainerOverrides[req.cheatId] = cheatOverride;
    const next = await updateConfig({
      hotkeyOverrides: { ...cfg.hotkeyOverrides, [req.trainerId]: trainerOverrides },
    });
    // Re-register live with the merged overrides.
    registerHotkeysForTrainer(trainer, next.hotkeyOverrides[req.trainerId] ?? {});
    // Broadcast config:changed so the renderer's config-store updates.
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send(CHANNELS.event, { type: 'config:changed', config: next });
    }
    return { ok: true };
  });

  ipcMain.handle(CHANNELS.resolveBoxart, async (_evt, req: import('../shared/ipc.js').ResolveBoxartRequest):
    Promise<import('../shared/ipc.js').ResolveBoxartResult> => resolveBoxart(req));

  ipcMain.handle(CHANNELS.ceRuntimeStatus, async () => runtimeManager.status());
  ipcMain.handle(CHANNELS.allowMemoryAccess, async () => {
    if (await readPtraceScope() === 0) return { ok: true as const };
    // Grant whichever of Starlight's memory readers exist: a missing one (no
    // release build of starlightd in dev, a failed Cheat Engine download)
    // doesn't block the other.
    const bins: string[] = [];
    let daemonError: string | null = null;
    try { bins.push(await installedDaemonPath()); }
    catch (err) { daemonError = err instanceof Error ? err.message : String(err); }
    const r = await runtimeManager.ensure();
    if (r.ok) bins.push(r.status.ceserver);
    if (bins.length === 0) {
      return { ok: false as const, error: `Couldn't set up the trainer engine: ${daemonError ?? (r.ok ? 'unknown error' : r.error)}` };
    }
    const g = await grantPtraceCap({ bins });
    if (g.ok) await restartEngine();
    return g;
  });
  ipcMain.handle(CHANNELS.ceRuntimeInstall, async () => {
    const r = await runtimeManager.ensure();
    return r.ok ? { ok: true as const } : r;
  });

  ipcMain.handle(CHANNELS.ceSessionStart, async (_evt, req: import('../shared/ipc.js').CeSessionStartRequest): Promise<import('../shared/ipc.js').CeSessionStartResult> => {
    try {
      const processes = await processHost.listOnce();
      // An explicit table is the user's pick and is loaded as is. Otherwise
      // start from the table that worked last time and let the session move on
      // to the game's other tables if that one no longer matches.
      const cfg = await getConfig();
      const explicit = req.tableId !== undefined;
      const r = await ceStartSession({
        source: req.source,
        sources: req.sources,
        tableId: req.tableId ?? cfg.tableChoices[req.cacheKey],
        autoPick: !explicit,
        cacheKey: req.cacheKey,
        runtimeRoot: CE_RUNTIME_ROOT,
        ctCacheDir: CT_CACHE_DIR,
        ensureRuntime: () => runtimeManager.ensure(),
        pid: req.pid,
        processName: req.processName,
        game: req.game,
        processes,
        detectedGames: lastDetectedGames,
        engineNeedsPtraceGrantFn: () => engineNeedsPtraceGrant(),
        starlightdHolders: (pid) => gameOwner.holders(pid),
        holdTable: (pid) => gameOwner.hold(pid, 'table'),
        nativeTables: cfg.preferences.nativeTables !== false,
        recordRouteFn: (d) => { void recordRoute(CT_ROUTING_FILE, d).catch(() => {}); },
        onProgress: (message) => broadcast({ type: 'session:progress', message }),
        onSteps: (tables) => broadcast({ type: 'session:tables', tables }),
        onGameExit: (sessionId) => broadcast({ type: 'session:game-exited', sessionId }),
        onEvent: (e) => {
          if (e['type'] === 'lua-notice' && typeof e['text'] === 'string' && (e['kind'] === 'message' || e['kind'] === 'link')) {
            broadcast({ type: 'session:notice', kind: e['kind'], text: e['text'] });
          }
          if (e['type'] === 'hotkey' && typeof e['id'] === 'number') {
            broadcast({
              type: 'ce:hotkey', recordId: e['id'], ok: e['ok'] === true, active: e['active'] === true,
              error: typeof e['error'] === 'string' ? cleanCeError(e['error']) : undefined,
            });
          }
        },
      });
      sessionCacheKey = req.cacheKey;
      if (r.attached && (explicit || r.verdict === 'works')) void rememberTable(req.cacheKey, r.tableId).catch(() => {});
      // Game speed is off for 32-bit games (starlightd's speed hooks are 64-bit).
      const codeBits = r.attached && r.process ? await gameCodeBits(r.process.pid, r.process.name) : null;
      return {
        ok: true as const, sessionId: r.sessionId, records: r.records, proton: r.proton,
        attached: r.attached, needsPicker: r.needsPicker, running: r.running,
        tables: r.tables, tableId: r.tableId, tableError: r.tableError, process: r.process,
        hiddenIds: r.hiddenIds, prereqErrors: r.prereqErrors, verdict: r.verdict, attempts: r.attempts,
        engine: r.engine, mode: r.mode, route: r.route, holders: r.holders, codeBits,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const reason = /anti-cheat|won't attach/i.test(msg) ? 'anti-cheat' as const :
                     isPtraceBlocked(msg) ? 'ptrace' as const :
                     /still connected/i.test(msg) ? 'busy' as const :
                     /isn't installed|download the trainer engine/i.test(msg) ? 'runtime-missing' as const :
                     /not running/i.test(msg) ? 'not-running' as const :
                     /spawn|timed out/i.test(msg) ? 'spawn-failed' as const :
                     'unknown' as const;
      return { ok: false as const, error: msg, reason };
    }
  });

  ipcMain.handle(CHANNELS.ceSessionEnd, async (_evt, req: { sessionId: string }) => ceEndSession(req));
  ipcMain.handle(CHANNELS.ceSessionSetActive, async (_evt, req: { sessionId: string; recordId: number; active: boolean }) =>
    ceSetActive(req));
  ipcMain.handle(CHANNELS.ceSessionCall, async (_evt, req: { sessionId: string; method: string; params?: unknown }) =>
    ceCallSession(req));
  ipcMain.handle(CHANNELS.ceSessionRetry, async (_evt, req: { sessionId: string }) => {
    const r = await ceRetryTables(req);
    if (r.ok && r.verdict === 'works' && sessionCacheKey) void rememberTable(sessionCacheKey, r.tableId).catch(() => {});
    return r;
  });

  ipcMain.handle(CHANNELS.openLink, async (_evt, url: unknown) => {
    const link = typeof url === 'string' ? webLink(url) : null;
    if (!link) return { ok: false };
    await shell.openExternal(link);
    return { ok: true };
  });

  ipcMain.handle(CHANNELS.launchGame, async (_evt, req: import('../shared/ipc.js').LaunchTarget) => {
    // Only ever launch something the library scan itself found.
    const game = lastDetectedGames.find((g) => g.source === req.source && g.appId === req.appId);
    if (!game) return { ok: false as const, error: 'That game is no longer in your library.' };
    return launchGame(game, {
      openExternal: (url) => shell.openExternal(url),
      manualExePath: async (appId) => (await getConfig()).manualGames.find((g) => g.id === appId)?.exePath ?? null,
    });
  });

  ipcMain.handle(CHANNELS.findGameProcess, async (_evt, req: { game: { id: string; name: string; steamAppId?: number | null } }) => {
    const processes = await processHost.listOnce();
    const m = await matchGameToProcess(req.game, { processes, detectedGames: lastDetectedGames }).catch(() => null);
    return m && m !== 'ambiguous' ? m : null;
  });

  ipcMain.handle(CHANNELS.userCheatsList, (_evt, req: { key: string; pid: number | null }) => userCheatsHost.list(req.key, req.pid));
  ipcMain.handle(CHANNELS.userCheatsSetActive, (_evt, req: Parameters<typeof userCheatsHost.setActive>[0]) => userCheatsHost.setActive(req));
  ipcMain.handle(CHANNELS.userCheatsSetValue, (_evt, req: Parameters<typeof userCheatsHost.setValue>[0]) => userCheatsHost.setValue(req));
  ipcMain.handle(CHANNELS.userCheatsRemove, (_evt, req: { key: string; id: string }) => userCheatsHost.remove(req.key, req.id));
  ipcMain.handle(CHANNELS.userCheatsDisableAll, (_evt, req: { pid: number }) => userCheatsHost.disableAll(req.pid));
  ipcMain.handle(CHANNELS.userCheatsGames, () => refreshMyGames());
  ipcMain.handle(CHANNELS.shareCheatPreview, (_evt, req: ShareCheatRequest) => shareHost.preview(req));
  ipcMain.handle(CHANNELS.shareCheatSend, (_evt, req: ShareCheatRequest) => shareHost.send(req));
  ipcMain.handle(CHANNELS.communityCheatsSave, async (_evt, req: { key: string; id: string; userKey: string; exeName?: string }) => {
    const r = await saveCommunityCheat({ dir: userCheatsDir(app.getPath('userData')), community: communityHost }, req);
    if (r.ok) userCheatsChanged(req.userKey);
    return r;
  });

  ipcMain.handle(CHANNELS.agentConnectInfo, () => agentConnectInfo());
  ipcMain.handle(CHANNELS.agentRotateToken, async () => {
    await mcpHostChain;
    agentToken = await rotateToken(USER_DATA);
    await mcpHost?.closeSessions();
    return agentConnectInfo();
  });
  ipcMain.handle(CHANNELS.agentGetState, () => agentSession.snapshot());
  ipcMain.handle(CHANNELS.agentRespondApproval, (_evt, req: { id: string; allow: boolean }) => {
    agentPrompts.respondApproval(String(req?.id ?? ''), req?.allow === true);
  });
  ipcMain.handle(CHANNELS.agentAnswer, (_evt, req: { id: string; value: unknown }) =>
    agentPrompts.answer(String(req?.id ?? ''), req?.value));
  ipcMain.handle(CHANNELS.agentSetCanModify, (_evt, req: { on: boolean }) => agentSession.setCanModify(req?.on === true));
  ipcMain.handle(CHANNELS.agentStop, () => agentSession.stop('player'));

  ipcMain.on(CHANNELS.windowMinimize, (evt) => BrowserWindow.fromWebContents(evt.sender)?.minimize());
  ipcMain.on(CHANNELS.windowToggleMaximize, (evt) => {
    const w = BrowserWindow.fromWebContents(evt.sender);
    if (!w) return;
    if (w.isMaximized()) w.unmaximize(); else w.maximize();
  });
  ipcMain.on(CHANNELS.windowClose, (evt) => BrowserWindow.fromWebContents(evt.sender)?.close());

  const updater = createUpdater({
    isPackaged: app.isPackaged,
    version: app.getVersion(),
    // Imported here, not at the top: electron-updater reads Electron state when it loads.
    load: async () => {
      const m = await import('electron-updater');
      // CommonJS: depending on the bundler's interop the exports may sit under default.
      const mod = m.default ?? m;
      return mod.autoUpdater as unknown as AutoUpdaterLike;
    },
    onState: (state) => {
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.webContents.isDestroyed()) win.webContents.send(CHANNELS.updateState, state);
      }
    },
  });
  ipcMain.handle(CHANNELS.updateGetVersion, () => updater.getVersion());
  ipcMain.handle(CHANNELS.updateGetState, () => updater.getState());
  ipcMain.handle(CHANNELS.updateCheck, () => updater.check());
  ipcMain.handle(CHANNELS.updateRestart, () => updater.restart());

  processHost.start();
  createWindow();
  runtimeManager.ensureInBackground();
  void updater.start();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// R21 quit order, awaited: Electron doesn't wait for an async before-quit, so the
// first one holds the quit, runs these under a 3 s cap, then exits (I6).
app.on('before-quit', createBeforeQuit({
  exit: () => app.exit(0),
  log: (m) => console.error(m),
  steps: () => [
    { name: 'pause process watch', run: () => processHost.pause() },
    { name: 'hotkeys', run: () => { shutdownHotkeys(); unregisterHotkeys(); } },
    { name: 'agent stop', run: () => agentSession.stop('app-quit') },
    { name: 'my cheats', run: () => userCheatsHost.end() },
    { name: 'MCP server', run: async () => { await mcpHostChain; await mcpHost?.close(); } },
    { name: 'engine detach', run: () => engineHost.detach() },
    { name: 'engine stop', run: () => stopEngine() },
    {
      name: 'Cheat Engine',
      run: async () => {
        const s = ceGetActiveSession();
        if (s) await ceEndSession({ sessionId: s.sessionId });
      },
    },
  ],
}));
