import { dialog, BrowserWindow } from 'electron';
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { importCt } from '@starlight/ct-importer';
import type { StarlightTrainer } from '@starlight/ct-importer';
import type { LoadTrainerResult } from '../shared/ipc.js';
import { setActiveTrainer, cancelAllFreezes } from './engine-host.js';
import { registerForTrainer } from './hotkey-host.js';
import { processHost } from './process-host-singleton.js';

export async function loadTrainer(parentWindow?: BrowserWindow): Promise<LoadTrainerResult> {
  const parent = parentWindow ?? BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
  const result = parent
    ? await dialog.showOpenDialog(parent, {
        title: 'Open Cheat Engine table',
        filters: [{ name: 'Cheat Engine table', extensions: ['CT', 'ct'] }, { name: 'All files', extensions: ['*'] }],
        properties: ['openFile'],
      })
    : await dialog.showOpenDialog({
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
    const base = basename(path).replace(/\.(ct|CT)$/, '');
    const out = importCt(xml, {
      gameName: base,
      processName: [base, `${base}.exe`],
      platform: ['linux'],
    });
    await cancelAllFreezes();
    setActiveTrainer(out.trainer);
    registerForTrainer(out.trainer);
    processHost.setTrainerProcessNames(out.trainer.game.processName);
    return { ok: true, trainer: out.trainer, stats: out.stats };
  } catch (err) {
    return { ok: false, error: `failed to import ${path}: ${err instanceof Error ? err.message : String(err)}` };
  }
}

export async function setTrainerFromCatalog(trainer: StarlightTrainer): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    await cancelAllFreezes();
    setActiveTrainer(trainer);
    registerForTrainer(trainer);
    processHost.setTrainerProcessNames(trainer.game.processName);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
