'use strict';
const { ipcRenderer, contextBridge } = require('electron');

contextBridge.exposeInMainWorld('brainPanel', {
  onBrainFire: (cb) => ipcRenderer.on('brain-fire', (_, payload) => cb(payload)),
});
