'use strict';

const fs   = require('fs');
const path = require('path');

const SEARXNG_URL = 'http://127.0.0.1:8888';
const FS_ROOT     = '/var/home/kvoldnes';

// ── Web search (SearXNG) ──────────────────────────────────────────────────────
async function querySearch(query) {
  try {
    const url = `${SEARXNG_URL}/search?q=${encodeURIComponent(query)}&format=json&categories=general`;
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const data = await res.json();
    if (!data.results?.length) return null;
    return data.results.slice(0, 3)
      .map(r => `**${r.title}**\n${r.content || ''}\n${r.url}`)
      .join('\n\n');
  } catch (e) {
    console.warn('[searxng] query failed:', e.message);
    return null;
  }
}

function extractUrl(text) {
  const m = text.match(/(https?:\/\/[^\s]+|(?:[a-zA-Z0-9-]+\.)+(?:com|org|net|io|co|uk|de|fr|jp|tv|info|gov|edu|au|ca|me|app|dev|ai)[^\s]*)/i);
  if (!m) return null;
  return m[0].startsWith('http') ? m[0] : 'https://' + m[0];
}

async function fetchPage(url) {
  try {
    const parsedUrl = new URL(url);
    const mod = parsedUrl.protocol === 'https:' ? require('https') : require('http');
    const text = await new Promise((resolve, reject) => {
      const req = mod.get(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36' },
        timeout: 10000,
      }, res => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          fetchPage(res.headers.location).then(resolve).catch(reject);
          return;
        }
        let body = '';
        res.on('data', d => { body += d; if (body.length > 500000) req.destroy(); });
        res.on('end', () => resolve(body));
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    });
    const clean = text
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').replace(/&#\d+;/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 3000);
    return clean || null;
  } catch (e) {
    console.warn('[fetch] failed:', url, e.message);
    return null;
  }
}

// ── Filesystem tools — Phase 4.2 ──────────────────────────────────────────────
function fsResolvePath(text) {
  const m = text.match(/(~\/[^\s'"`,]+|\/var\/home\/kvoldnes\/[^\s'"`,]+|\/home\/kvoldnes\/[^\s'"`,]+)/);
  if (!m) return null;
  return m[0].replace(/^~/, FS_ROOT).replace(/^\/home\/kvoldnes/, FS_ROOT);
}

function fsSanitize(p) {
  const resolved = path.resolve(p);
  if (!resolved.startsWith(FS_ROOT)) throw new Error(`Path outside allowed root: ${resolved}`);
  return resolved;
}

function fsListDir(dirPath) {
  const safe = fsSanitize(dirPath);
  const entries = fs.readdirSync(safe, { withFileTypes: true });
  return entries.map(e => `${e.isDirectory() ? 'd' : 'f'}  ${e.name}`).join('\n') || '(empty)';
}

function fsReadFile(filePath) {
  const safe = fsSanitize(filePath);
  const content = fs.readFileSync(safe, 'utf8');
  return content.slice(0, 3000) + (content.length > 3000 ? '\n...(truncated)' : '');
}

function fsWriteFile(filePath, content) {
  const safe = fsSanitize(filePath);
  fs.mkdirSync(path.dirname(safe), { recursive: true });
  fs.writeFileSync(safe, content, 'utf8');
  return `Written: ${safe}`;
}

module.exports = { SEARXNG_URL, querySearch, extractUrl, fetchPage, fsResolvePath, fsSanitize, fsListDir, fsReadFile, fsWriteFile };
