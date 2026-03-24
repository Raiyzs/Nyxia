const { ipcRenderer, contextBridge } = require('electron');

// Expose safe API to renderer
window.nyxia = {
  getClipboard: () => ipcRenderer.invoke('get-clipboard'),
  setPosition: (x, y) => ipcRenderer.invoke('set-position', x, y),
  getScreenSize: () => ipcRenderer.invoke('get-screen-size'),
  sendToBackend: (msg) => ipcRenderer.invoke('send-to-backend', msg),
  toggleClickThrough: (enabled) => ipcRenderer.invoke('toggle-click-through', enabled),
  onBackendEvent: (cb) => ipcRenderer.on('backend-event', (_, data) => cb(data)),
};
