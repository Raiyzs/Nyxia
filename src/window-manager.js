'use strict';

const DESKTOP_TILE_W = 340;

function getDesktopPresets() {
  const { screen } = require('electron');
  const { width: sw, height: sh } = screen.getPrimaryDisplay().bounds;
  const th = Math.round(sh * 0.72);
  return [
    { x: sw - DESKTOP_TILE_W, y: sh - th },          // right-bottom
    { x: 0,                   y: sh - th },           // left-bottom
    { x: sw - DESKTOP_TILE_W, y: Math.round((sh - th) / 2) }, // right-center
    { x: 0,                   y: Math.round((sh - th) / 2) }, // left-center
    { x: Math.round((sw - DESKTOP_TILE_W) / 2), y: sh - th }, // center-bottom
  ];
}

/**
 * createWindowManager(deps)
 * deps: { setMain, setChat, setDesktop, loadConfig, saveConfig, __dirname }
 * Returns create* functions that set window refs via the provided setters.
 */
module.exports = function createWindowManager(deps) {
  const { setMain, setChat, setDesktop, loadConfig, saveConfig } = deps;
  const path = require('path');
  const { BrowserWindow, screen } = require('electron');
  const { setMainWindow } = require('./brain-soul');
  const dir = deps.__dirname;

  function createCompanionWindow() {
    const { width, height } = screen.getPrimaryDisplay().workAreaSize;
    const saved = loadConfig();
    const cW = saved?.companion?.width || 380;
    const cH = saved?.companion?.height || 380;
    const cX = saved?.companion?.x ?? (width - cW - 20);
    const cY = saved?.companion?.y ?? (height - cH - 20);

    const win = new BrowserWindow({
      width: cW, height: cH, x: cX, y: cY,
      transparent: true, frame: false, alwaysOnTop: true,
      skipTaskbar: true, resizable: true, hasShadow: false,
      backgroundColor: '#00000000',
      minWidth: 100, minHeight: 150, maxWidth: 500, maxHeight: 800,
      webPreferences: { nodeIntegration: true, contextIsolation: false, preload: path.join(dir, 'preload.js') }
    });
    win.loadFile(path.join(dir, 'index.html'));
    setMain(win);
    setMainWindow(win);
    win.setAlwaysOnTop(true, 'screen-saver');
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

    const persist = () => {
      if (!win) return;
      const [x, y] = win.getPosition();
      const [w, h] = win.getSize();
      const cfg = loadConfig() || {};
      cfg.companion = { x, y, width: w, height: h };
      saveConfig(cfg);
    };
    win.on('resized', persist);
    win.on('moved', persist);
    win.on('close', () => { const d = deps.getDesktop?.(); if (d && !d.isDestroyed()) d.close(); });
  }

  function createChatWindow() {
    const { width, height } = screen.getPrimaryDisplay().workAreaSize;
    const saved = loadConfig();
    const pW = saved?.chat?.width || 960;
    const pH = saved?.chat?.height || 690;
    const pX = saved?.chat?.x ?? (width - pW - 20);
    const pY = saved?.chat?.y ?? (height - pH - 80);

    const win = new BrowserWindow({
      width: pW, height: pH, x: pX, y: pY,
      transparent: true, frame: false, alwaysOnTop: true,
      skipTaskbar: true, resizable: true, hasShadow: false,
      backgroundColor: '#00000000',
      minWidth: 320, minHeight: 400, maxWidth: 1400, maxHeight: 1100,
      show: false,
      webPreferences: { nodeIntegration: true, contextIsolation: false }
    });
    win.loadFile(path.join(dir, 'chat.html'));
    win.setAlwaysOnTop(true, 'screen-saver');
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    setChat(win);

    const persist = () => {
      if (!win) return;
      const [x, y] = win.getPosition();
      const [w, h] = win.getSize();
      const cfg = loadConfig() || {};
      cfg.chat = { x, y, width: w, height: h };
      saveConfig(cfg);
      const main = deps.getMain?.();
      if (main) main.webContents.send('chat-bounds', { x, y, width: w, height: h });
    };
    win.on('resized', persist);
    win.on('moved',   persist);
  }

  function createCombinedWindow() {
    const { width, height } = screen.getPrimaryDisplay().workAreaSize;
    const saved = loadConfig();
    const cW = saved?.combined?.width  || 1060;
    const cH = saved?.combined?.height || Math.min(height, 920);
    const cX = saved?.combined?.x ?? Math.max(0, width - cW - 20);
    const cY = saved?.combined?.y ?? Math.max(0, Math.round((height - cH) / 2));

    const win = new BrowserWindow({
      width: cW, height: cH, x: cX, y: cY,
      transparent: true, frame: false, alwaysOnTop: true,
      skipTaskbar: false, resizable: true, hasShadow: false,
      backgroundColor: '#00000000',
      icon: path.join(dir, '..', 'assets', 'logo.png'),
      minWidth: 800, minHeight: 500,
      webPreferences: {
        nodeIntegration: true, contextIsolation: false,
        webviewTag: true,
        preload: path.join(dir, 'preload.js')
      }
    });
    win.loadFile(path.join(dir, 'space.html'));
    setMain(win);
    setMainWindow(win);
    win.setAlwaysOnTop(true, 'screen-saver');
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

    const persist = () => {
      if (!win) return;
      const [x, y] = win.getPosition();
      const [w, h] = win.getSize();
      const cfg = loadConfig() || {};
      cfg.combined = { x, y, width: w, height: h };
      saveConfig(cfg);
    };
    win.on('resized', persist);
    win.on('moved',   persist);
    win.on('close', () => { const d = deps.getDesktop?.(); if (d && !d.isDestroyed()) d.close(); });

    // chatWindow proxy — IPC routes through mainWindow; combined.html relay forwards to chat webview
    const chatProxy = {
      isVisible:   () => true,
      hide:        () => {},
      show:        () => win?.focus(),
      focus:       () => win?.focus(),
      getPosition: () => win?.getPosition() || [0, 0],
      getSize:     () => win?.getSize()     || [cW, cH],
      getBounds:   () => win?.getBounds()   || { x: cX, y: cY, width: cW, height: cH },
      setPosition: (x, y) => win?.setPosition(x, y),
      isDestroyed: () => !win || win.isDestroyed(),
      on:          (ev, cb) => win?.on(ev, cb),
      webContents: {
        send: (ch, ...a) => { if (win && !win.isDestroyed()) win.webContents.send(ch, ...a); },
        once: (ev, cb)   => { if (ev === 'did-finish-load') setTimeout(cb, 1000); else win?.webContents?.once(ev, cb); }
      }
    };
    setChat(chatProxy);
  }

  function createDesktopWindow() {
    const cfg = loadConfig();
    if (!cfg?.desktopMode) return;
    const { height: sh } = screen.getPrimaryDisplay().bounds;
    const th = Math.round(sh * 0.72);
    const presets = getDesktopPresets();
    const saved = cfg.desktopTilePos;
    const pos = saved || presets[0];

    const win = new BrowserWindow({
      x: pos.x, y: pos.y,
      width: DESKTOP_TILE_W, height: th,
      transparent: true, frame: false,
      skipTaskbar: true, focusable: false,
      type: 'desktop',
      alwaysOnBottom: true,
      hasShadow: false,
      backgroundColor: '#00000000',
      webPreferences: { nodeIntegration: true, contextIsolation: false }
    });
    win.setIgnoreMouseEvents(true, { forward: true });
    win.loadFile(path.join(dir, 'desktop-avatar.html'));
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    setDesktop(win);
    console.log('[desktop-presence] window created at', pos.x, pos.y);
  }

  return { createCompanionWindow, createChatWindow, createCombinedWindow, createDesktopWindow, getDesktopPresets, DESKTOP_TILE_W };
};
