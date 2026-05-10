'use strict';

module.exports = function registerWindowIPC(ipcMain, deps) {
  const {
    getApp, getScreen, getMain, getChat, getDesktop,
    loadConfig, saveConfig, getDesktopPresets, createDesktopWindow, setViewId,
  } = deps;

  ipcMain.handle('get-win-bounds',  () => getMain().getBounds());
  ipcMain.handle('get-chat-bounds', () => getChat() ? getChat().getBounds() : null);
  ipcMain.handle('get-screen-size', () => {
    const { width, height } = getScreen().getPrimaryDisplay().workAreaSize;
    return { width, height };
  });
  ipcMain.handle('set-position', (_, x, y) => getMain().setPosition(Math.round(x), Math.round(y)));
  ipcMain.handle('move-combined',    (_, dx, dy) => { const w = getMain(); if (w) { const [x,y] = w.getPosition(); w.setPosition(Math.round(x+dx), Math.round(y+dy)); } });
  ipcMain.handle('resize-combined-h', (_, dy) => {
    const w = getMain();
    if (!w) return;
    const [ww, h] = w.getSize();
    w.setSize(ww, Math.max(400, h + dy));
  });
  ipcMain.handle('get-pane-split',  ()      => loadConfig()?.paneSplit || 420);
  ipcMain.handle('save-pane-split', (_, w)  => { const cfg = loadConfig() || {}; cfg.paneSplit = w; saveConfig(cfg); });
  ipcMain.handle('open-images-folder', (_, folderPath) => {
    const { shell } = require('electron');
    shell.openPath(folderPath);
  });
  ipcMain.handle('get-desktop-tile-pos',  ()        => loadConfig()?.desktopTilePos || null);
  ipcMain.handle('save-desktop-tile-pos', (_, pos)  => { const cfg = loadConfig() || {}; cfg.desktopTilePos = pos; saveConfig(cfg); });
  ipcMain.handle('get-desktop-bounds',    ()        => getDesktop()?.getBounds() || null);
  ipcMain.on('set-desktop-position', (_, x, y) => {
    const d = getDesktop();
    if (!d || d.isDestroyed()) return;
    d.setPosition(Math.round(x), Math.round(y));
  });
  ipcMain.on('desktop-drag-end', (_, x, y) => {
    const d = getDesktop();
    if (!d || d.isDestroyed()) return;
    const cfg = loadConfig() || {};
    cfg.desktopTilePos = { x: Math.round(x), y: Math.round(y) };
    saveConfig(cfg);
  });
  ipcMain.handle('get-desktop-presets', () => getDesktopPresets());
  ipcMain.on('set-desktop-preset', (_, idx) => {
    const presets = getDesktopPresets();
    const p = presets[idx % presets.length];
    const d = getDesktop();
    if (!d || d.isDestroyed()) return;
    d.setPosition(p.x, p.y);
    const cfg = loadConfig() || {};
    cfg.desktopTilePos = p;
    saveConfig(cfg);
  });
  ipcMain.handle('minimize-combined', () => getMain()?.minimize());
  ipcMain.handle('close-app',         () => getApp().quit());
  ipcMain.on('browser-view-id', (_, viewId) => {
    const m = getMain();
    if (m && viewId !== -1) setViewId(viewId, m.webContents.id);
  });
  ipcMain.handle('chat-toggle', () => {
    // Combined mode: chat is always visible — just focus the window
    getMain()?.focus();
  });
  ipcMain.handle('chat-close', () => {
    getChat().hide();
    const m = getMain();
    if (m) m.webContents.send('chat-closed');
  });
  ipcMain.handle('move-chat', (_, dx, dy) => {
    const c = getChat();
    if (!c) return;
    const [x, y] = c.getPosition();
    const nx = Math.round(x + dx), ny = Math.round(y + dy);
    c.setPosition(nx, ny);
    const [w, h] = c.getSize();
    const cfg = loadConfig() || {};
    cfg.chat = { x: nx, y: ny, width: w, height: h };
    saveConfig(cfg);
    const m = getMain();
    if (m) m.webContents.send('chat-bounds', { x: nx, y: ny, width: w, height: h });
  });
  ipcMain.on('desktop-hit-test', (_, isOverAvatar) => {
    const d = getDesktop();
    if (d && !d.isDestroyed()) d.setIgnoreMouseEvents(!isOverAvatar, { forward: true });
  });
  ipcMain.handle('toggle-desktop-mode', () => {
    const cfg = loadConfig() || {};
    cfg.desktopMode = !cfg.desktopMode;
    saveConfig(cfg);
    const d = getDesktop();
    if (cfg.desktopMode) {
      if (!d || d.isDestroyed()) createDesktopWindow();
      else d.show();
    } else {
      if (d && !d.isDestroyed()) d.hide();
    }
    return cfg.desktopMode;
  });
  ipcMain.handle('nyxia-initiate-topic', (_, topic) => {
    const c = getChat();
    if (!c) return;
    const wasVisible = c.isVisible();
    if (!wasVisible) {
      c.show();
      c.focus();
      const [x, y] = c.getPosition();
      const [w, h] = c.getSize();
      const m = getMain();
      if (m) m.webContents.send('chat-bounds', { x, y, width: w, height: h });
    }
    setTimeout(() => {
      if (!c.isDestroyed()) c.webContents.send('nyxia-topic', topic);
    }, wasVisible ? 50 : 350);
  });
  ipcMain.handle('speak-bubble-proactive', (_, text) => {
    const m = getMain();
    const d = getDesktop();
    if (m && !m.isDestroyed()) m.webContents.send('speak-bubble', text, 0);
    if (d && !d.isDestroyed()) d.webContents.send('speak-bubble', text, 0);
  });
};
