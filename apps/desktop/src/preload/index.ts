import { contextBridge, ipcRenderer } from 'electron';
import { CHANNELS, type StarlightApi, type StarlightEvent, type WindowState } from '../shared/ipc.js';

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
