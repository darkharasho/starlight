import { app, BrowserWindow, ipcMain } from 'electron';
import { CHANNELS, type AttachRequest, type AttachResult, type LoadTrainerResult } from '../shared/ipc.js';
import { loadTrainer } from './trainer-loader.js';
import * as engineHost from './engine-host.js';
import { join } from 'node:path';

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 600,
    backgroundColor: '#07070b',
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.once('ready-to-show', () => win.show());

  if (process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL']);
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'));
  }
}

app.whenReady().then(() => {
  ipcMain.handle(CHANNELS.loadTrainer, async (): Promise<LoadTrainerResult> =>
    loadTrainer(BrowserWindow.getFocusedWindow() ?? undefined));

  ipcMain.handle(CHANNELS.attach,
    async (_evt, req: AttachRequest): Promise<AttachResult> => engineHost.attach(req.pid));

  ipcMain.handle(CHANNELS.detach, async () => engineHost.detach());
  ipcMain.handle(CHANNELS.toggleCheat,   async () => ({ ok: false, error: 'not implemented (Phase 4 Task 4)' }));
  ipcMain.handle(CHANNELS.setCheatValue, async () => ({ ok: false, error: 'not implemented (Phase 4 Task 4)' }));

  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', async () => {
  await engineHost.detach();
});
