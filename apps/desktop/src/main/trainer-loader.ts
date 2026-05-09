import { dialog, BrowserWindow } from 'electron';
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { importCt } from '@starlight/ct-importer';
import type { LoadTrainerResult } from '../shared/ipc.js';
import { setActiveTrainer } from './engine-host.js';
import { registerForTrainer } from './hotkey-host.js';

export async function loadTrainer(parentWindow?: BrowserWindow): Promise<LoadTrainerResult> {
  const result = await dialog.showOpenDialog(parentWindow ?? BrowserWindow.getFocusedWindow() ?? new BrowserWindow({ show: false }), {
    title: 'Open Cheat Engine table',
    filters: [{ name: 'Cheat Engine table', extensions: ['CT', 'ct'] }, { name: 'All files', extensions: ['*'] }],
    properties: ['openFile'],
  });
  if (result.canceled || result.filePaths.length === 0) {
    return { ok: false, error: 'cancelled' };
  }
  const path = result.filePaths[0]!;
  let xml: string;
  try {
    xml = await readFile(path, 'utf8');
  } catch (err) {
    return { ok: false, error: `failed to read ${path}: ${err instanceof Error ? err.message : String(err)}` };
  }
  try {
    const out = importCt(xml, {
      gameName: basename(path).replace(/\.(ct|CT)$/, ''),
      processName: ['unknown'],   // user supplies real process name later
      platform: ['linux'],
    });
    setActiveTrainer(out.trainer);
    registerForTrainer(out.trainer);
    return { ok: true, trainer: out.trainer, stats: out.stats };
  } catch (err) {
    return { ok: false, error: `failed to import ${path}: ${err instanceof Error ? err.message : String(err)}` };
  }
}
