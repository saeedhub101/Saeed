'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const on = (channel, cb) => {
  const fn = (_e, ...args) => cb(...args);
  ipcRenderer.on(channel, fn);
  return () => ipcRenderer.removeListener(channel, fn);
};

contextBridge.exposeInMainWorld('api', {
  getConfig: () => ipcRenderer.invoke('config:get'),
  setConfig: (patch) => ipcRenderer.send('config:set', patch),
  onConfig: (cb) => on('config:changed', cb),
  readModel: () => ipcRenderer.invoke('model:read'),
  pickModel: () => ipcRenderer.invoke('model:pick'),
  saveModel: (buffer, name) => ipcRenderer.invoke('model:save', buffer, name),
  openStudio: (tab) => ipcRenderer.send('studio:open', tab),
  onStudioTab: (cb) => on('studio:tab', cb),
  sendCommand: (cmd, args) => ipcRenderer.send('command', cmd, args),
  onCommand: (cb) => on('command', cb),
  onService: (cb) => on('service', cb),
  dragStart: () => ipcRenderer.invoke('win:dragstart'),
  dragMove: (x, y) => ipcRenderer.send('win:dragmove', x, y),
  setIgnoreMouse: (v) => ipcRenderer.send('win:ignore', v),
});
