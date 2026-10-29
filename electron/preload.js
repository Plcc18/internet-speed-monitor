'use strict';
/**
 * Ponte segura entre o renderer e o processo principal.
 * contextIsolation fica ligado e o renderer nao tem acesso a Node.
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // Teste
  startTest: () => ipcRenderer.invoke('speedtest:start'),
  abortTest: () => ipcRenderer.invoke('speedtest:abort'),
  onTestEvent: (cb) => {
    const listener = (_e, ev) => cb(ev);
    ipcRenderer.on('speedtest:event', listener);
    return () => ipcRenderer.removeListener('speedtest:event', listener);
  },

  // Historico
  getHistory: () => ipcRenderer.invoke('history:get'),
  clearHistory: () => ipcRenderer.invoke('history:clear'),
  deleteResult: (id) => ipcRenderer.invoke('history:delete', id),
  exportHistory: () => ipcRenderer.invoke('history:export'),

  // Preferencias
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),

  // Aplicativo
  getAppInfo: () => ipcRenderer.invoke('app:info'),
  openDataFolder: () => ipcRenderer.send('app:open-data-folder'),

  // Janela
  minimize: () => ipcRenderer.send('window:minimize'),
  toggleMaximize: () => ipcRenderer.send('window:toggle-maximize'),
  close: () => ipcRenderer.send('window:close'),
  onWindowState: (cb) => {
    const listener = (_e, st) => cb(st);
    ipcRenderer.on('window:state', listener);
    return () => ipcRenderer.removeListener('window:state', listener);
  },
});
