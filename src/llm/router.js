'use strict';
// llm/router.js — message intent classifier.
// Routes user input to: casual, dialog, council, agent, shell, browser, desktop, filesystem, search, fetch, image.

let _deps = {};

function init(deps) {
  // { loadConfig, loadUserProfile, loadSelf, extractUrl, ollamaScheduler, queryOllama }
  _deps = deps;
}

function _conversationMode(text) {
  const selfDomain = /\b(you feel|you think|your opinion|do you like|are you|you believe|your favorite|you prefer|you miss|you want|you wish|you remember|you enjoy|you hate|you love|makes you|you scared|you happy|you sad)\b/i;
  if (selfDomain.test(text)) return 'dialog';
  const profile     = _deps.loadUserProfile();
  const self        = _deps.loadSelf();
  const sessions    = profile?.sessionCount || 0;
  const reflections = self?.reflections?.length || 0;
  const confidence  = Math.min(1.0, (sessions / 30) * 0.6 + (reflections / 15) * 0.4);
  const isQuestion  = text.includes('?') || /\b(what|why|how|when|where|who|which|explain|tell me|do you know|can you|could you|is it|are there|does|did|will|would|should|define|describe)\b/i.test(text);
  if (!isQuestion) return 'dialog';
  if (confidence > 0.6) return 'dialog';
  return 'council';
}

async function classifyMessage(messages) {
  const { loadConfig, extractUrl, ollamaScheduler, queryOllama } = _deps;
  const last = messages.filter(m => m.role === 'user').slice(-1)[0]?.content || '';
  const text = last.trim();

  if (text.length < 25) return 'casual';
  const greetings = /^(hi|hey|hello|yo|sup|howdy|good (morning|evening|night|afternoon)|what's up|how are you|how r u)\b/i;
  if (greetings.test(text)) return 'casual';
  if (/\bagent:/i.test(text)) return 'agent';
  if (/\b(generate|draw|create|make|paint|render)\b.{0,40}\b(image|picture|photo|illustration|art|drawing)\b/i.test(text)) return 'image';
  if (/\b(image|picture|photo|illustration)\b.{0,20}\b(of|showing|with|depicting)\b/i.test(text)) return 'image';
  const shellDirect = /^(ls\b|cat\b|pwd\b|echo\b|find\b|grep\b|ps\b|df\b|du\b|which\b|whoami\b|uname\b|env\b|python|node\b|npm\b|git\b)/;
  if (shellDirect.test(text.trim())) return 'shell';
  if (extractUrl(text)) return 'fetch';

  // Latency fast-path: no action-ish vocabulary → it's conversation.
  // Skips a full Ollama round trip (and a VRAM hot-swap with keep_alive:0)
  // on most chat turns. Anything matching falls through to the LLM classifier.
  const ACTIONISH = /\b(open|launch|run|execute|install|search|find|look up|google|browse|navigate|click|press|type|scroll|download|upload|file|files|folder|directory|save|delete|remove|move|copy|rename|create|write|read|edit|screenshot|terminal|command|shell|website|browser|app|weather|news|price|stock|latest|update|fetch|check|visit|go to|show|generate|draw|render|make|play)\b/i;
  if (!ACTIONISH.test(text)) return _conversationMode(text);

  try {
    const cfg = loadConfig();
    const mindModel = cfg.mindModel || 'nyxia-ft';
    const body = JSON.stringify({
      model: mindModel,
      messages: [
        {
          role: 'system',
          content:
            'Classify the user request into exactly one mode.\n' +
            'agent — needs multiple tools in sequence (e.g. search then save to file, find info then install, research then write report)\n' +
            'shell — run a single terminal/shell command\n' +
            'browser — navigate or interact with a website in a browser\n' +
            'desktop — open an app, click a UI element, control a window\n' +
            'filesystem — read or write a local file only (no search needed)\n' +
            'search — look up current information (news, weather, prices, software releases)\n' +
            'conversation — chat, question, opinion, explanation, anything else',
        },
        { role: 'user', content: text },
      ],
      format: {
        type: 'object',
        properties: {
          mode: { type: 'string', enum: ['agent', 'shell', 'browser', 'desktop', 'filesystem', 'search', 'image', 'conversation'] },
        },
        required: ['mode'],
      },
      stream: false,
      options: { temperature: 0, num_predict: 20 },
    });

    const res = await fetch('http://127.0.0.1:11434/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      signal: AbortSignal.timeout(8000),
    });
    if (res.ok) {
      const data   = await res.json();
      const parsed = JSON.parse(data.message?.content || '{}');
      const mode   = parsed.mode;
      if (mode && mode !== 'conversation') {
        console.log('[classify]', mode, '—', text.slice(0, 60));
        return mode;
      }
      if (mode === 'conversation') return _conversationMode(text);
    }
  } catch (e) {
    console.warn('[classify] LLM unavailable, using fallback:', e.message);
  }

  return _conversationMode(text);
}

module.exports = { init, classifyMessage, _conversationMode };
