import { contextBridge, ipcRenderer } from 'electron';
import { CHANNELS, type StarlightApi, type StarlightEvent, type WindowState, type CeRuntimeProgressEvent } from '../shared/ipc.js';

const api: StarlightApi = {
  loadTrainer:   ()    => ipcRenderer.invoke(CHANNELS.loadTrainer),
  attach:        (req) => ipcRenderer.invoke(CHANNELS.attach, req),
  detach:        ()    => ipcRenderer.invoke(CHANNELS.detach),
  toggleCheat:   (req) => ipcRenderer.invoke(CHANNELS.toggleCheat, req),
  setCheatValue: (req) => ipcRenderer.invoke(CHANNELS.setCheatValue, req),
  scanLibrary:    ()    => ipcRenderer.invoke(CHANNELS.scanLibrary),
  listProcesses:  ()    => ipcRenderer.invoke(CHANNELS.listProcesses),
  setProcessName: (req) => ipcRenderer.invoke(CHANNELS.setProcessName, req),
  fetchCatalog:  ()    => ipcRenderer.invoke(CHANNELS.fetchCatalog),
  fetchTrainer:  (req) => ipcRenderer.invoke(CHANNELS.fetchTrainer, req),
  setTrainerFromCatalog: (req) => ipcRenderer.invoke(CHANNELS.setTrainerFromCatalog, req),
  getConfig:    ()    => ipcRenderer.invoke(CHANNELS.getConfig),
  updateConfig: (req) => ipcRenderer.invoke(CHANNELS.updateConfig, req),
  pickExecutable: () => ipcRenderer.invoke(CHANNELS.pickExecutable),
  rebindHotkey: (req) => ipcRenderer.invoke(CHANNELS.rebindHotkey, req),
  resolveBoxart: (req) => ipcRenderer.invoke(CHANNELS.resolveBoxart, req),
  ceRuntimeStatus:   () => ipcRenderer.invoke(CHANNELS.ceRuntimeStatus),
  ceRuntimeInstall:  () => ipcRenderer.invoke(CHANNELS.ceRuntimeInstall),
  ceSessionStart:     (req) => ipcRenderer.invoke(CHANNELS.ceSessionStart, req),
  ceSessionEnd:       (req) => ipcRenderer.invoke(CHANNELS.ceSessionEnd, req),
  ceSessionSetActive: (req) => ipcRenderer.invoke(CHANNELS.ceSessionSetActive, req),
  onCeRuntimeProgress: (cb: (e: CeRuntimeProgressEvent) => void) => {
    const handler = (_e: unknown, payload: CeRuntimeProgressEvent) => cb(payload);
    ipcRenderer.on(CHANNELS.ceRuntimeProgress, handler);
    return () => { ipcRenderer.removeListener(CHANNELS.ceRuntimeProgress, handler); };
  },
  onEvent: (listener) => {
    const handler = (_evt: unknown, e: StarlightEvent): void => listener(e);
    ipcRenderer.on(CHANNELS.event, handler);
    return () => ipcRenderer.off(CHANNELS.event, handler);
  },
  windowMinimize:       () => ipcRenderer.send(CHANNELS.windowMinimize),
  windowToggleMaximize: () => ipcRenderer.send(CHANNELS.windowToggleMaximize),
  windowClose:          () => ipcRenderer.send(CHANNELS.windowClose),
  onWindowState: (listener) => {
    const handler = (_evt: unknown, state: WindowState): void => listener(state);
    ipcRenderer.on(CHANNELS.windowState, handler);
    return () => ipcRenderer.off(CHANNELS.windowState, handler);
  },
};

contextBridge.exposeInMainWorld('starlight', api);
