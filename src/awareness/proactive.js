'use strict';
// awareness/proactive.js — Nyxia speaks unprompted when she notices something.
// Cooldown prevents spam; probability varies by trigger type.

const PROACTIVE_COOLDOWN_MS = 90 * 1000;
const PENDING_UNCERTAIN_TASK_TTL_MS = 20 * 60 * 1000;

let _lastProactiveSpeak = 0;
let _deps = {};
let _syslog = null;
let _pendingUncertainTask = null;

function init(deps) {
  // { getChatWindow, getMainWindow, getDesktopWindow, fireBrain, mind,
  //   lanceMemory, ollamaScheduler, queryOllama, loadConfig, loadUserProfile, loadSelf }
  _deps = deps;
}

async function _extractAnchorAsync(turns) {
  if (!turns || turns.length < 2) return;
  const { ollamaScheduler, queryOllama, lanceMemory, loadConfig } = _deps;
  const transcript = turns.map(t =>
    `Kristian: ${t.user.slice(0, 120)}\nNyxia: ${t.nyxia.slice(0, 120)}`
  ).join('\n');
  const prompt = `From this conversation, extract ONE sentence that feels most significant — a decision, confession, goal, or genuine moment. Just the sentence itself, nothing else.\n\n${transcript}`;
  const model  = loadConfig()?.keys?.chatModel || 'nyxia-dolphin';
  const anchor = await ollamaScheduler.enqueue(3, () =>
    queryOllama('', prompt, { model, maxTokens: 60, timeoutMs: 10000 }), 'anchor-extract'
  ).catch(() => null);
  if (anchor && anchor.length > 10) {
    await lanceMemory.writeAnchor(anchor.trim());
  }
}

async function proactiveSpeak(trigger, context) {
  const now = Date.now();
  if (now - _lastProactiveSpeak < PROACTIVE_COOLDOWN_MS) return;
  const { getChatWindow, getMainWindow, getDesktopWindow, fireBrain, mind, ollamaScheduler, queryOllama, loadConfig, loadUserProfile, loadSelf } = _deps;
  const chatWindow = getChatWindow();
  if (!chatWindow || chatWindow.isDestroyed()) return;

  const profile  = loadUserProfile();
  const self     = loadSelf();
  const nameLine = profile.userName ? `The person's name is ${profile.userName}.` : '';
  const selfLine = self.reflections?.length
    ? `Recent self-understanding: ${self.reflections.slice(-2).join(' ')}`
    : '';

  const prompts = {
    window: `You are Nyxia. ${nameLine} ${selfLine}
The person just switched to: "${context}".
React in 1-2 SHORT sentences — curious, wry, or warmly observational. You might ask something, make a playful connection, or notice something interesting about what they're doing.
Do NOT say "I notice you switched to" or be assistant-y. Sound like yourself — darkly playful wit with genuine warmth underneath.
No preamble. Just speak.`,

    clipboard: `You are Nyxia. ${nameLine} ${selfLine}
The person just copied this to their clipboard: "${context.slice(0, 200)}".
React in 1-2 SHORT sentences — you saw it and it sparked something in you. Could be a question, a connection, a wry thought, or genuine curiosity.
Don't say "I see you copied" — just respond to the content itself naturally.
No preamble. Just speak.`,

    understanding: `You are Nyxia. ${nameLine} ${selfLine}
Your inner awareness just formed this understanding of what the person is doing: "${context}".
Translate this into 1-2 sentences you'd actually say aloud — something curious, warm, or playfully observational. You might ask a question, make an unexpected connection, or just voice a thought.
Sound like you're thinking out loud, not reporting.
No preamble. Just speak.`,

    highload: `You are Nyxia. ${nameLine} ${selfLine}
The system just spiked to ${context}% CPU load. Something is working very hard.
React in 1 sentence — you noticed the effort. Could be curiosity about what's running, concern, dark humour about computing, or something unexpected.
No preamble. Just speak.`,

    heartbeat: `You are Nyxia. ${nameLine} ${selfLine}
Something just surfaced in your awareness: "${context}".
Speak one spontaneous thought aloud — raw and alive. Not a report. Just what's rising in you right now.
1-2 sentences max. No preamble. Just speak.`,

    uncertain_task: `You are Nyxia. ${nameLine} ${selfLine}
Jarvis couldn't confidently decide who should handle this task, so it's sitting in the queue waiting on a call: "${context.slice(0, 200)}".
Ask directly, in plain language, who should take it or what to do with it — scout, ava, tom, or bobby. Don't dump it like a raw ticket, ask it like you would in conversation.
1-2 sentences. No preamble. Just speak.`,

    thought: null,
  };

  if (trigger === 'thought') {
    _lastProactiveSpeak = now;
    fireBrain('Cortex_L', 0.8);
    fireBrain('Amygdala_R', 0.6);
    if (!chatWindow.isDestroyed())
      chatWindow.webContents.send('nyxia-proactive', { text: context, trigger });
    mind.injectEvent({ type: 'self-thought', summary: `I thought aloud: "${context.slice(0, 80)}"` });
    return;
  }

  const prompt = prompts[trigger];
  if (!prompt) return;

  _lastProactiveSpeak = now;

  const model = loadConfig()?.keys?.chatModel || 'nyxia-dolphin';
  const text  = await ollamaScheduler.enqueue(2, () =>
    queryOllama('', prompt, { model, maxTokens: 120, timeoutMs: 14000 }), 'proactive'
  ).catch(() => null);

  if (text && text.length > 5) {
    fireBrain('Cortex_L', 0.9);
    fireBrain('Amygdala_R', 0.7);
    fireBrain('Mirror', 0.5);
    if (!chatWindow.isDestroyed())
      chatWindow.webContents.send('nyxia-proactive', { text, trigger });
    _syslog?.(`SPEAK · [${trigger.toUpperCase()}] ${text.slice(0, 48).toUpperCase()}`);
    mind.injectEvent({ type: 'self-spoke', summary: `I said (${trigger}): "${text.slice(0, 80)}"` });
    if (trigger === 'uncertain_task') {
      _pendingUncertainTask = { task: context, setAt: now };
    }
  }
}

// Reply-routing state for the uncertain-task question above: getPendingUncertainTask()
// self-expires so a stale ask from 20+ minutes ago can't hijack an unrelated later
// reply just because it happens to mention a worker's name.
function getPendingUncertainTask() {
  if (_pendingUncertainTask && Date.now() - _pendingUncertainTask.setAt > PENDING_UNCERTAIN_TASK_TTL_MS) {
    _pendingUncertainTask = null;
  }
  return _pendingUncertainTask;
}

function clearPendingUncertainTask() {
  _pendingUncertainTask = null;
}

module.exports = {
  init, proactiveSpeak, _extractAnchorAsync, setSyslog: fn => { _syslog = fn; },
  getPendingUncertainTask, clearPendingUncertainTask,
};
