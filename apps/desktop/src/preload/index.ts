import { contextBridge, ipcRenderer } from 'electron';
import { CHANNELS, type StarlightApi, type StarlightEvent, type WindowState, type UpdateState } from '../shared/ipc.js';

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
  ceSessionCall:      (req) => ipcRenderer.invoke(CHANNELS.ceSessionCall, req),
  ceSessionRetry:     (req) => ipcRenderer.invoke(CHANNELS.ceSessionRetry, req),
  launchGame:         (req) => ipcRenderer.invoke(CHANNELS.launchGame, req),
  allowMemoryAccess:  () => ipcRenderer.invoke(CHANNELS.allowMemoryAccess),
  findGameProcess:    (req) => ipcRenderer.invoke(CHANNELS.findGameProcess, req),
  userCheatsList:       (req) => ipcRenderer.invoke(CHANNELS.userCheatsList, req),
  userCheatsSetActive:  (req) => ipcRenderer.invoke(CHANNELS.userCheatsSetActive, req),
  userCheatsSetValue:   (req) => ipcRenderer.invoke(CHANNELS.userCheatsSetValue, req),
  userCheatsRemove:     (req) => ipcRenderer.invoke(CHANNELS.userCheatsRemove, req),
  userCheatsDisableAll: (req) => ipcRenderer.invoke(CHANNELS.userCheatsDisableAll, req),
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
  updateGetVersion: () => ipcRenderer.invoke(CHANNELS.updateGetVersion),
  updateGetState:   () => ipcRenderer.invoke(CHANNELS.updateGetState),
  updateCheck:      () => ipcRenderer.invoke(CHANNELS.updateCheck),
  updateRestart:    () => ipcRenderer.invoke(CHANNELS.updateRestart),
  onUpdateState: (listener) => {
    const handler = (_evt: unknown, state: UpdateState): void => listener(state);
    ipcRenderer.on(CHANNELS.updateState, handler);
    return () => ipcRenderer.off(CHANNELS.updateState, handler);
  },
};

contextBridge.exposeInMainWorld('starlight', api);
