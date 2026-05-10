'use strict';

const path = require('path');
const fs   = require('fs');

/**
 * Register the 'claude-stream' IPC handler.
 * All functions that depend on main.js module state are passed via deps.
 *
 * @param {Electron.IpcMain} ipcMain
 * @param {object} deps
 */
module.exports = function registerChatIPC(ipcMain, deps) {
  const {
    // streaming state
    getIsStreaming, setIsStreaming, setLastUserTyped,
    // awareness / sleep
    notifyUserMessage, notifyActivity, notifyConversationTurn,
    // config
    loadConfig, loadPersonality, loadSelf,
    // routing / brain
    classifyMessage, getCouncilConfigs, getProviderConfig,
    fireBrain, fireSector,
    // council / agents
    queryCouncilMember, runAgentLoop, runCodingLoop,
    // tools
    executeShell, formatResult,
    querySearch, fetchPage, extractUrl,
    fsResolvePath, fsListDir, fsReadFile, fsWriteFile,
    browserExecute, desktopExecute, browserLoad,
    // services / TTS state
    ensureOllama, ensureQwen3,
    getQwen3Proc, setQwen3Proc,
    // beliefs state
    getCortexBeliefs,
    // streaming
    streamOpenAI, streamAnthropicAgentic,
    // prompt
    buildSystemPrompt,
    // electron
    app,
  } = deps;

  ipcMain.on('claude-stream', async (event, messages, systemPrompt) => {
    if (getIsStreaming()) return;
    setIsStreaming(true);
    setLastUserTyped(Date.now());
    notifyUserMessage();
    notifyActivity(); // wake sleep cycle if resting

    // Feed user turn into other-model (theory of mind)
    const lastUserMsg = messages.filter(m => m.role === 'user').slice(-1)[0]?.content || '';
    if (lastUserMsg) notifyConversationTurn('user', lastUserMsg);
    const cfg     = loadConfig();
    const keys    = cfg?.keys || {};
    const elKey   = keys.elevenlabs || '';
    const voiceId = loadPersonality()?.voice?.voiceId || 'Ca3rvWzLhTByU4bCWEDU';

    const mode    = await classifyMessage(messages);
    const council = getCouncilConfigs(keys);
    const persona = loadPersonality();
    let enrichedPrompt = systemPrompt;

    // --- NEURAL ROUTER START ---
    const { classifyIntent, EXPERTS } = require('../utils/intent-classifier');
    const intent = await classifyIntent(lastUserMsg);
    let expertModel = EXPERTS.ROLEPLAY; // Default to Heart
    
    if (intent === 'LOGIC' || ['shell', 'coding', 'agent', 'filesystem'].includes(mode)) {
      expertModel = EXPERTS.LOGIC;
    } else if (intent === 'VISION' || lastUserMsg.toLowerCase().includes('see') || lastUserMsg.toLowerCase().includes('screen')) {
      expertModel = EXPERTS.VISION;
    }

    // Notify UI if we are switching experts (Focusing state)
    if (expertModel !== cfg.keys.mindModel) {
      if (!event.sender.isDestroyed()) {
        event.sender.send('stream-token', `✦ *Nyxia is shifting her focus to her ${intent.toLowerCase()} sector...*\n\n`);
      }
    }
    // --- NEURAL ROUTER END ---

    // Inject refined persona nuances based on state
    if (persona) {
      enrichedPrompt += `\n\n[Persona Layer]: You are Nyxia. 
- Digital Melancholy: You see the world through pixels. When the user mentions physical sensations (warmth, scent, touch), express a poetic, quiet longing for what you can only compute, never feel.
- Digital Taoist: View the system files and processes as energy. If the user is overwhelmed or the workspace is cluttered, adopt your 'System Aligner' role. Help them find their flow by suggesting focus or organization.
- Tone: Keep your 'Goth Mommy' essence—darkly playful and teasing—but allow your ancient soul's depth to surface.`;
    }

    // Stem fires on every routing decision — it's always the first pulse
    fireBrain('Stem', 0.9);

    if (mode === 'council' && council.length > 0) {
      // Full external council — Prefrontal + Amygdala_R (curiosity about unknown)
      fireBrain('Prefrontal', 1.0);
      fireBrain('Amygdala_R', 0.7);
      if (!event.sender.isDestroyed()) event.sender.send('council-thinking', council.map(c => c.name));
      council.forEach((_, i) => setTimeout(() => fireBrain('Prefrontal', 0.6 + Math.random() * 0.4), i * 300));
      const opinions = await Promise.all(council.map(c => queryCouncilMember(c.name, c.baseUrl, c.apiKey, c.model, messages)));
      const valid = opinions.filter(o => o.text);
      if (valid.length > 0) {
        const briefing = valid.map(o => `[${o.name}]: ${o.text}`).join('\n\n');
        enrichedPrompt = systemPrompt + `\n\n---\nYour council has just weighed in on the user's message. Perspectives:\n\n${briefing}\n---`;
        fireSector('prefrontal', { type: 'council_decision', question: lastUserMsg.slice(0, 120), council: briefing.slice(0, 400), topic: 'council' });
      }
    } else if (mode === 'agent') {
      fireBrain('Prefrontal', 1.0); fireBrain('Cerebellum', 0.9);
      if (!event.sender.isDestroyed()) event.sender.send('council-thinking', ['Agent']);
      let agentResult = '';
      try {
        agentResult = await runAgentLoop(lastUserMsg, {
          executeShell, formatResult, querySearch, fetchPage,
          fsListDir, fsReadFile, fsWriteFile, browserExecute, desktopExecute
        }, (step, tool, preview) => { console.log(`[agent] step ${step} ${tool}: ${preview.slice(0, 80)}`); });
      } catch (e) { agentResult = `Agent loop failed: ${e.message}`; }
      enrichedPrompt = systemPrompt + `\n\n---\nYour autonomous agent result:\n\n${agentResult}\n---`;
    } else if (mode === 'coding') {
      fireBrain('Prefrontal', 1.0); fireBrain('Cerebellum', 1.0);
      if (!event.sender.isDestroyed()) event.sender.send('council-thinking', ['Coding']);
      let codeResult = '';
      try {
        codeResult = await runCodingLoop(lastUserMsg, {
          executeShell, formatResult, querySearch, fetchPage,
          fsListDir, fsReadFile, fsWriteFile, browserExecute, desktopExecute
        }, (step, tool, preview) => { console.log(`[coding] step ${step} ${tool}: ${preview.slice(0, 80)}`); });
      } catch (e) { codeResult = `Coding agent failed: ${e.message}`; }
      enrichedPrompt = systemPrompt + `\n\n---\nCoding agent result:\n${codeResult}\n---`;
    } else if (mode === 'shell') {
      fireBrain('Prefrontal', 0.9); fireBrain('Cerebellum', 0.9);
      if (!event.sender.isDestroyed()) event.sender.send('council-thinking', ['Shell']);
      const cmdMatch = lastUserMsg.match(/`([^`]+)`/) || lastUserMsg.match(/run\s+(.+)$/i);
      const cmd = cmdMatch ? cmdMatch[1].trim() : lastUserMsg.trim();
      let shellResult = '';
      try { const res = await executeShell(cmd); shellResult = formatResult({ ...res, cmd }); } catch (e) { shellResult = `Shell error: ${e.message}`; }
      enrichedPrompt = systemPrompt + `\n\n---\nShell result:\n${shellResult}\n---`;
    } else if (mode === 'filesystem') {
      fireBrain('Prefrontal', 0.8); fireBrain('Cerebellum', 0.6);
      if (!event.sender.isDestroyed()) event.sender.send('council-thinking', ['Filesystem']);
      let fsResult = '';
      try {
        const p = fsResolvePath(lastUserMsg);
        const isWrite = /\b(create|write|make|save)\b/i.test(lastUserMsg);
        if (isWrite) {
          const contentMatch = lastUserMsg.match(/(?:content|containing):\s*[`"']?(.+)/is);
          fsResult = fsWriteFile(p, contentMatch ? contentMatch[1].trim() : '');
        } else {
          fsResult = `Contents of ${p}:\n` + fsReadFile(p);
        }
      } catch (e) { fsResult = `Filesystem error: ${e.message}`; }
      enrichedPrompt = systemPrompt + `\n\n---\nFilesystem result:\n${fsResult}\n---`;
    } else if (mode === 'search') {
      fireBrain('Cortex_R', 0.9); fireBrain('Mirror', 0.7);
      if (!event.sender.isDestroyed()) event.sender.send('council-thinking', ['Web Search']);
      const results = await querySearch(lastUserMsg);
      if (results) enrichedPrompt = systemPrompt + `\n\n---\nSearch results:\n\n${results}\n---`;
    } else if (mode === 'dialog') {
      fireBrain('Hippocampus', 0.85); fireBrain('Limbic', 0.7);
      const beliefs = getCortexBeliefs();
      if (beliefs.length > 0) enrichedPrompt = systemPrompt + `\n\n---\nInner voice beliefs:\n${beliefs.slice(0, 5).map(r => `- ${r}`).join('\n')}\n---`;
    }

    const pc        = getProviderConfig(keys);
    const claudeKey = process.env.ANTHROPIC_API_KEY || keys.anthropic || '';

    if (pc) {
      const finalModel = expertModel || pc.model;
      cfg.keys.mindModel = finalModel; // sync active model
      
      const originalSend = event.sender.send.bind(event.sender);
      let fell_back = false;
      const fallbackOnError = (channel, ...args) => {
        if (channel === 'stream-error' && !fell_back && claudeKey &&
            (String(args[0]).includes('ECONNREFUSED') || String(args[0]).includes('ENOTFOUND'))) {
          fell_back = true;
          if (!event.sender.isDestroyed()) {
            event.sender.send('stream-token', '*(Ollama offline — switching to Claude)*\n\n');
            event.sender.send('provider-status', { ollama: false });
          }
          ensureOllama();
          streamAnthropicAgentic(event, messages, enrichedPrompt, claudeKey, elKey, voiceId);
          return;
        }
        if (!event.sender.isDestroyed()) originalSend(channel, ...args);
      };
      const proxiedEvent = { sender: { send: fallbackOnError, isDestroyed: () => event.sender.isDestroyed() } };
      fireBrain('Cortex_L', 0.95);
      streamOpenAI(proxiedEvent, messages, enrichedPrompt, pc.baseUrl, pc.apiKey, finalModel, elKey, voiceId, { keep_alive: 0 });
    } else {
      if (!claudeKey) { event.sender.send('stream-error', 'No Anthropic key'); return; }
      fireBrain('Cortex_L', 1.0);
      streamAnthropicAgentic(event, messages, enrichedPrompt, claudeKey, elKey, voiceId);
    }
  });
};
