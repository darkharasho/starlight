import { contextBridge, ipcRenderer } from 'electron';
import { CHANNELS, type StarlightApi, type StarlightEvent } from '../shared/ipc.js';

const api: StarlightApi = {
  loadTrainer:   ()    => ipcRenderer.invoke(CHANNELS.loadTrainer),
  attach:        (req) => ipcRenderer.invoke(CHANNELS.attach, req),
  detach:        ()    => ipcRenderer.invoke(CHANNELS.detach),
  toggleCheat:   (req) => ipcRenderer.invoke(CHANNELS.toggleCheat, req),
  setCheatValue: (req) => ipcRenderer.invoke(CHANNELS.setCheatValue, req),
  onEvent: (listener) => {
    const handler = (_evt: unknown, e: StarlightEvent): void => listener(e);
    ipcRenderer.on(CHANNELS.event, handler);
    return () => ipcRenderer.off(CHANNELS.event, handler);
  },
};

contextBridge.exposeInMainWorld('starlight', api);
