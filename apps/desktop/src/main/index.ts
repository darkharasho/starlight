import { app, BrowserWindow, ipcMain, globalShortcut, dialog } from 'electron';
import { CHANNELS, type AttachRequest, type AttachResult, type LoadTrainerResult, type ToggleCheatRequest, type SetValueRequest, type IpcResult } from '../shared/ipc.js';
import { loadTrainer, setTrainerFromCatalog } from './trainer-loader.js';
import * as engineHost from './engine-host.js';
import { syncCheatState, unregisterAll as unregisterHotkeys, registerForTrainer as registerHotkeysForTrainer } from './hotkey-host.js';
import { scanAll as scanLibrary } from './library-host.js';
import { processHost, setWindowVisible, setEngineAttached } from './process-host-singleton.js';
import { fetchCatalog, fetchTrainer } from './catalog-host.js';
import { getConfig, updateConfig, setOnCorrupt } from './user-config.js';
import { resolveBoxart } from './boxart-host.js';
import { join } from 'node:path';

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

engineHost.onDetached((reason) => {
  unregisterHotkeys();
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(CHANNELS.event, { type: 'session:detached', reason });
  }
});

engineHost.onAttachStateChange((attached) => setEngineAttached(attached));

app.whenReady().then(async () => {
  setOnCorrupt((backupPath) => {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send(CHANNELS.event, { type: 'config:corrupted', backupPath });
    }
  });

  const initialConfig = await getConfig();
  processHost.setIntervalMs(initialConfig.preferences.pollIntervalMs);

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
      return { ok: true as const, index };
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle(CHANNELS.setTrainerFromCatalog, async (_evt, req: { trainer: import('@starlight/ct-importer').StarlightTrainer }) =>
    setTrainerFromCatalog(req.trainer));

  ipcMain.handle(CHANNELS.fetchTrainer, async (_evt, req: { trainerPath: string }) => {
    try {
      const trainer = await fetchTrainer(req.trainerPath);
      return { ok: true as const, trainer };
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle(CHANNELS.getConfig, async () => getConfig());
  ipcMain.handle(CHANNELS.updateConfig, async (_evt, req: { patch: import('../shared/ipc.js').DeepPartial<import('../shared/ipc.js').UserConfig> }) => {
    const next = await updateConfig(req.patch);
    processHost.setIntervalMs(next.preferences.pollIntervalMs);
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

  ipcMain.on(CHANNELS.windowMinimize, (evt) => BrowserWindow.fromWebContents(evt.sender)?.minimize());
  ipcMain.on(CHANNELS.windowToggleMaximize, (evt) => {
    const w = BrowserWindow.fromWebContents(evt.sender);
    if (!w) return;
    if (w.isMaximized()) w.unmaximize(); else w.maximize();
  });
  ipcMain.on(CHANNELS.windowClose, (evt) => BrowserWindow.fromWebContents(evt.sender)?.close());

  processHost.start();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', async () => {
  processHost.pause();
  unregisterHotkeys();
  await engineHost.detach();
});

app.on('will-quit', () => globalShortcut.unregisterAll());
