'use strict';

const pty = require('node-pty');
const os  = require('os');

const ptyProcs = new Map(); // windowId → pty process

module.exports = function registerTerminalIPC(ipcMain, app) {
  ipcMain.on('pty-start', (event, { cols, rows }) => {
    const wid = event.sender.id;
    if (ptyProcs.has(wid)) { ptyProcs.get(wid).kill(); ptyProcs.delete(wid); }
    const shell = process.env.SHELL || '/bin/bash';
    const proc = pty.spawn(shell, [], {
      name: 'xterm-256color',
      cols: cols || 80, rows: rows || 24,
      cwd: process.env.HOME || os.homedir(),
      env: { ...process.env, TERM: 'xterm-256color' }
    });
    ptyProcs.set(wid, proc);
    proc.onData(data => { if (!event.sender.isDestroyed()) event.sender.send('pty-data', data); });
    proc.onExit(() => { ptyProcs.delete(wid); if (!event.sender.isDestroyed()) event.sender.send('pty-exit'); });
  });

  ipcMain.on('pty-input', (event, data) => {
    const proc = ptyProcs.get(event.sender.id);
    if (proc) proc.write(data);
  });

  ipcMain.on('pty-resize', (event, { cols, rows }) => {
    const proc = ptyProcs.get(event.sender.id);
    if (proc) proc.resize(cols, rows);
  });

  ipcMain.on('pty-kill', (event) => {
    const proc = ptyProcs.get(event.sender.id);
    if (proc) { proc.kill(); ptyProcs.delete(event.sender.id); }
  });

  // Kill all PTYs on exit
  app.on('will-quit', () => { for (const [, p] of ptyProcs) try { p.kill(); } catch(_) {} });
};
