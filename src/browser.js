// browser.js — webContents-based browser (replaces Playwright)
// Controls the integrated browser webview in combined.html.
// Main process gets the webview's webContentsId via IPC on startup,
// then drives it directly — no external browser process needed.

let _viewId     = null;  // webContentsId of the browser-view webview
let _combinedId = null;  // webContentsId of combined.html (for tab switching)

function setViewId(viewId, combinedId) {
  _viewId     = viewId;
  _combinedId = combinedId;
  console.log('[browser] view ready, wcId:', viewId);
}

function getWC() {
  if (!_viewId) throw new Error('Browser view not ready — combined window not open');
  const { webContents } = require('electron');
  const wc = webContents.fromId(_viewId);
  if (!wc || wc.isDestroyed()) throw new Error('Browser view destroyed');
  return wc;
}

function showBrowserTab() {
  if (!_combinedId) return;
  const { webContents } = require('electron');
  const wc = webContents.fromId(_combinedId);
  if (wc && !wc.isDestroyed()) wc.send('browser-show');
}

function waitForLoad(wc, timeout = 20000) {
  return new Promise(resolve => {
    if (!wc.isLoading()) { resolve(); return; }
    const timer = setTimeout(() => { wc.removeListener('did-stop-loading', onStop); resolve(); }, timeout);
    function onStop() { clearTimeout(timer); resolve(); }
    wc.once('did-stop-loading', onStop);
  });
}

async function getPageContent(wc) {
  const title = await wc.executeJavaScript('document.title').catch(() => '');
  const text  = await wc.executeJavaScript(
    '(document.body?.innerText||"").replace(/\\s+/g," ").trim().slice(0,2000)'
  ).catch(() => '');
  return { title, url: wc.getURL(), text };
}

// Navigate to URL, return title + text excerpt
async function browserNavigate(url) {
  const wc = getWC();
  showBrowserTab();
  await wc.loadURL(url);
  await waitForLoad(wc);
  return getPageContent(wc);
}

// Click element by text label or CSS selector
async function browserClick(target) {
  const wc = getWC();
  await wc.executeJavaScript(`
    (function() {
      const t = ${JSON.stringify(target.toLowerCase())};
      const all = [...document.querySelectorAll('a,button,input[type=submit],[role=button]')];
      const el  = all.find(e => e.textContent.trim().toLowerCase().includes(t))
                || document.querySelector(${JSON.stringify(target)});
      if (el) el.click();
    })()
  `).catch(() => {});
  await waitForLoad(wc, 6000);
  return getPageContent(wc);
}

// Type into focused/first input, optionally submit
async function browserType(text, submit = true) {
  const wc = getWC();
  await wc.executeJavaScript(`
    (function() {
      const el = (document.activeElement && document.activeElement.tagName !== 'BODY')
        ? document.activeElement
        : document.querySelector('input[type=text],input[type=search],textarea,[contenteditable]');
      if (!el) return;
      el.focus();
      el.value = ${JSON.stringify(text)};
      el.dispatchEvent(new Event('input',  { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      ${submit ? 'el.form?.submit(); el.dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",code:"Enter",bubbles:true}));' : ''}
    })()
  `).catch(() => {});
  await waitForLoad(wc, 8000);
  return getPageContent(wc);
}

// Return current page content without navigating
async function browserGetContent() {
  return getPageContent(getWC());
}

// no-op — webview lifecycle managed by Electron window
async function closeBrowser() {}

// Parse natural language instruction → action → result string
async function browserExecute(instruction) {
  const text = instruction.trim();

  const explicitUrl = text.match(/https?:\/\/[^\s]+/)?.[0];
  const bareUrl     = text.match(/(?:open|go to|navigate to|visit|browse to)\s+((?:https?:\/\/)?[\w-]+\.[a-z]{2,}[^\s]*)/i)?.[1];
  const targetUrl   = explicitUrl || (bareUrl ? (bareUrl.startsWith('http') ? bareUrl : 'https://' + bareUrl) : null);

  if (targetUrl) {
    const r = await browserNavigate(targetUrl);
    return `Opened ${r.url} — "${r.title}"\n\n${r.text.slice(0, 800)}`;
  }

  const searchMatch = text.match(/search (?:for |on (?:google|youtube|bing|duckduckgo) for )?["']?(.+?)["']?(?:\s+on\s+(google|youtube|bing|duckduckgo))?$/i);
  if (searchMatch) {
    const query   = searchMatch[1].trim();
    const engine  = (searchMatch[2] || 'duckduckgo').toLowerCase();
    const engines = {
      duckduckgo: `https://duckduckgo.com/?q=${encodeURIComponent(query)}`,
      google:     `https://www.google.com/search?q=${encodeURIComponent(query)}`,
      youtube:    `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`,
      bing:       `https://www.bing.com/search?q=${encodeURIComponent(query)}`,
    };
    const r = await browserNavigate(engines[engine] || engines.duckduckgo);
    return `Searched for "${query}" on ${engine}. Results: "${r.title}"\n\n${r.text.slice(0, 800)}`;
  }

  const clickMatch = text.match(/click (?:on )?["']?(.+?)["']?$/i);
  if (clickMatch) {
    const r = await browserClick(clickMatch[1].trim());
    return `Clicked "${clickMatch[1]}". Now on: "${r.title}" (${r.url})\n\n${r.text.slice(0, 600)}`;
  }

  const typeMatch = text.match(/type ["']?(.+?)["']?$/i);
  if (typeMatch) {
    const r = await browserType(typeMatch[1].trim());
    return `Typed "${typeMatch[1]}" and submitted. Now on: "${r.title}"\n\n${r.text.slice(0, 600)}`;
  }

  if (/what'?s? on (the )?(screen|page|browser)|current page|what (are you|is nyxia) (looking at|seeing)/i.test(text)) {
    const r = await browserGetContent();
    return `Current page: "${r.title}" (${r.url})\n\n${r.text.slice(0, 800)}`;
  }

  return 'I need a clearer target — a URL, a search query, or something to click.';
}

// Navigate silently in background — no tab switch (used by 'search' mode to keep browser in sync)
function browserLoad(url) {
  try {
    const wc = getWC();
    wc.loadURL(url).catch(() => {});
  } catch (_) {}
}

module.exports = { browserExecute, browserNavigate, browserClick, browserGetContent, closeBrowser, setViewId, browserLoad };
