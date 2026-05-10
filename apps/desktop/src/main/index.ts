import { app, BrowserWindow, ipcMain, globalShortcut } from 'electron';
import { CHANNELS, type AttachRequest, type AttachResult, type LoadTrainerResult, type ToggleCheatRequest, type SetValueRequest, type IpcResult } from '../shared/ipc.js';
import { loadTrainer, setTrainerFromCatalog } from './trainer-loader.js';
import * as engineHost from './engine-host.js';
import { syncCheatState, unregisterAll as unregisterHotkeys } from './hotkey-host.js';
import { scanAll as scanLibrary } from './library-host.js';
import { processHost, setWindowVisible, setEngineAttached } from './process-host-singleton.js';
import { fetchCatalog, fetchTrainer } from './catalog-host.js';
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

app.whenReady().then(() => {
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
