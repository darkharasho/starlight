import { app, BrowserWindow, ipcMain, globalShortcut } from 'electron';
import { CHANNELS, type AttachRequest, type AttachResult, type LoadTrainerResult, type ToggleCheatRequest, type SetValueRequest, type IpcResult } from '../shared/ipc.js';
import { loadTrainer } from './trainer-loader.js';
import * as engineHost from './engine-host.js';
import { syncCheatState, unregisterAll as unregisterHotkeys } from './hotkey-host.js';
import { scanAll as scanLibrary } from './library-host.js';
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
  // TODO(phase-4.5 task 6): placeholder — replaced by process-host in task 6
  ipcMain.handle(CHANNELS.listProcesses,  async () => ({ processes: [] }));
  // TODO(phase-4.5 task 7): placeholder — replaced by process-host in task 7
  ipcMain.handle(CHANNELS.setProcessName, async () => undefined);

  ipcMain.on(CHANNELS.windowMinimize, (evt) => BrowserWindow.fromWebContents(evt.sender)?.minimize());
  ipcMain.on(CHANNELS.windowToggleMaximize, (evt) => {
    const w = BrowserWindow.fromWebContents(evt.sender);
    if (!w) return;
    if (w.isMaximized()) w.unmaximize(); else w.maximize();
  });
  ipcMain.on(CHANNELS.windowClose, (evt) => BrowserWindow.fromWebContents(evt.sender)?.close());

  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', async () => {
  unregisterHotkeys();
  await engineHost.detach();
});

app.on('will-quit', () => globalShortcut.unregisterAll());
