// Standalone VRM avatar viewer — Electron entry point.
// Opens only the 3D avatar with rotation sliders, none of Nyxia's
// backend services (mind, awareness loop, TTS, Ollama, API server, etc).
const { app, BrowserWindow } = require('electron');
const path = require('path');

if (process.platform === 'linux') {
  app.commandLine.appendSwitch('ozone-platform-hint', 'auto');
  // Without this, Electron's GPU process crashes silently → black canvas (see src/main.js)
  app.commandLine.appendSwitch('disable-gpu-sandbox');
  app.commandLine.appendSwitch('enable-webgl');
}

function createWindow() {
  const win = new BrowserWindow({
    width: 520,
    height: 760,
    backgroundColor: '#0a0414',
    title: 'Nyxia — VRM Viewer',
    webPreferences: { nodeIntegration: true, contextIsolation: false }
  });
  win.loadFile(path.join(__dirname, 'src', 'vrm-viewer.html'));
  win.webContents.on('console-message', (_e, _level, message) => console.log('[renderer]', message));
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());
