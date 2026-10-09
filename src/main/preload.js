'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const on = (channel, cb) => {
  const fn = (_e, ...args) => cb(...args);
  ipcRenderer.on(channel, fn);
  return () => ipcRenderer.removeListener(channel, fn);
};
const call = (ch) => (...a) => ipcRenderer.invoke(ch, ...a);
const send = (ch) => (...a) => ipcRenderer.send(ch, ...a);

contextBridge.exposeInMainWorld('api', {
  // config + model
  getConfig: call('config:get'),
  setConfig: send('config:set'),
  onConfig: (cb) => on('config:changed', cb),
  readModel: call('model:read'),
  pickModel: call('model:pick'),
  saveModel: call('model:save'),
  pickFile: call('file:pick'),
  // windows
  openStudio: send('studio:open'),
  openWindow: send('win:open'),
  onStudioTab: (cb) => on('studio:tab', cb),
  sendCommand: send('command'),
  onCommand: (cb) => on('command', cb),
  onService: (cb) => on('service', cb),
  dragStart: call('win:dragstart'),
  dragMove: send('win:dragmove'),
  setIgnoreMouse: send('win:ignore'),
  // voice + brain
  sendUtterance: send('voice:utterance'),
  interrupt: send('voice:interrupt'),
  onPipeline: (cb) => on('pipeline', cb),
  chatSend: send('chat:send'),
  chatCancel: send('chat:cancel'),
  chatHistory: call('chat:history'),
  chatClear: call('chat:clear'),
  onChatEvent: (cb) => on('chat:event', cb),
  // settings helpers
  setSecret: call('secret:set'),
  hasSecret: call('secret:has'),
  testTts: call('test:tts'),
  testLlm: call('test:llm'),
  testStt: call('test:stt'),
  // add-ons, accessories, live conversation, updates
  addonsList: call('addons:list'),
  addonsToggle: call('addons:toggle'),
  addonsRemove: call('addons:remove'),
  addonsStop: call('addons:stop'),
  addonsSaveSettings: call('addons:save-settings'),
  addonsRegistry: call('addons:registry'),
  addonsInstall: call('addons:install'),
  addonsInstallZip: call('addons:install-zip'),
  onAddonsProgress: (cb) => on('addons:progress', cb),
  onAddonsChanged: (cb) => on('addons:changed', cb),
  accessoriesList: call('accessories:list'),
  addonFile: call('addon:file'),
  rtStart: call('rt:start'),
  rtStop: call('rt:stop'),
  rtAudio: send('rt:audio'),
  rtInterrupt: send('rt:interrupt'),
  updateGet: call('update:get'),
  updateAction: send('update:action'),
  onUpdateState: (cb) => on('update:state', cb),
  metrics: call('sys:metrics'),
  prayerRefresh: call('prayer:refresh'),
  prayerToday: call('prayer:today'),
  prayerTest: send('prayer:test'),
});
