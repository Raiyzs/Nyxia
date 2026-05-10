'use strict';

// Settings panel — personality, keys, gaming mode
// Deps: { ipcRenderer, setSystemPrompt, refreshTTSEngine }
// Exposes window globals called by HTML onclick/onchange + DOMContentLoaded

module.exports = function initSettings(deps) {
  const { ipcRenderer, setSystemPrompt, refreshTTSEngine } = deps;

  let saveTimer;
  function debouncedSave() { clearTimeout(saveTimer); saveTimer = setTimeout(savePersonality, 700); }

  let keySaveTimer;
  function debouncedSaveKeys() { clearTimeout(keySaveTimer); keySaveTimer = setTimeout(saveKeys, 700); }

  function onThemePreset(theme, color) {
    document.getElementById('s-accent-color').value = color;
    // Highlight active preset button
    document.querySelectorAll('.theme-preset-btn').forEach(b => {
      const isActive = b.id === `tp-${theme}`;
      b.style.boxShadow = isActive ? `0 0 10px ${b.dataset.color}55` : 'none';
      b.style.fontWeight = isActive ? '700' : '400';
    });
    savePersonality();
  }

  function setupLiveSettings() {
    ['s-name','s-age','s-tone','s-catchphrases','s-voice-id'].forEach(id =>
      document.getElementById(id).addEventListener('input', debouncedSave));
    ['s-backstory','s-traits','s-interests','s-extra'].forEach(id =>
      document.getElementById(id).addEventListener('input', debouncedSave));
    ['s-hair-color','s-eye-color'].forEach(id =>
      document.getElementById(id).addEventListener('input', savePersonality));
    ['s-outfit','s-voice-enabled','s-tts-engine'].forEach(id =>
      document.getElementById(id).addEventListener('change', savePersonality));
    ['s-key-anthropic','s-key-elevenlabs',
     's-openai-base','s-chat-model','s-mind-model','s-openai-key','s-think-models'].forEach(id =>
      document.getElementById(id).addEventListener('input', debouncedSaveKeys));
    // s-provider onchange handled by onProviderChange() — it also calls saveKeys()
  }

  const PROVIDER_DEFAULTS = {
    gemini:   { label: 'Gemini API Key',             chatModel: 'gemini-2.0-flash',         mindModel: 'gemini-2.0-flash-lite' },
    groq:     { label: 'Groq API Key',               chatModel: 'llama-3.3-70b-versatile',  mindModel: 'llama-3.3-70b-versatile' },
    deepseek: { label: 'DeepSeek API Key',           chatModel: 'deepseek-chat',            mindModel: 'deepseek-chat' },
    mistral:  { label: 'Mistral API Key',            chatModel: 'mistral-small-latest',     mindModel: 'mistral-small-latest' },
    kimi:     { label: 'Kimi API Key (Moonshot)',    chatModel: 'moonshot-v1-32k',          mindModel: 'moonshot-v1-8k' },
    grok:     { label: 'Grok API Key (x.ai)',        chatModel: 'grok-3-mini',              mindModel: 'grok-3-mini' },
    openai:   { label: 'API Key (blank for Ollama)', chatModel: 'llama3.2',                 mindModel: 'llama3.2' },
  };

  async function populateOllamaModels(currentModel) {
    const sel = document.getElementById('s-chat-model-select');
    try {
      const res = await fetch('http://127.0.0.1:11434/api/tags');
      const data = await res.json();
      const models = (data.models || []).map(m => m.name).sort();
      sel.innerHTML = models.map(m => `<option value="${m}">${m}</option>`).join('');
      if (currentModel && models.includes(currentModel)) sel.value = currentModel;
      else if (models.length) document.getElementById('s-chat-model').value = sel.value;
    } catch(_) {
      sel.innerHTML = `<option value="${currentModel || ''}">${currentModel || 'Ollama not running'}</option>`;
    }
  }

  // Called from select onchange (user switching) or loadKeysForm (loading saved state)
  async function onProviderChange(val, fromLoad = false) {
    document.getElementById('s-provider-fields').style.display = val === 'anthropic' ? 'none' : 'block';
    document.getElementById('s-custom-url-row').style.display  = val === 'openai' ? 'block' : 'none';
    const isOllama = val === 'openai';
    document.getElementById('s-chat-model-select').style.display = isOllama ? 'block' : 'none';
    document.getElementById('s-chat-model').style.display        = isOllama ? 'none'  : 'block';
    if (isOllama) await populateOllamaModels(document.getElementById('s-chat-model').value.trim());
    const def = PROVIDER_DEFAULTS[val];
    if (def) {
      document.getElementById('s-apikey-label').textContent = def.label;
      if (!fromLoad) {
        // Prefill models if blank, load stored key for new provider
        if (!document.getElementById('s-chat-model').value.trim())
          document.getElementById('s-chat-model').value = def.chatModel;
        if (!document.getElementById('s-mind-model').value.trim())
          document.getElementById('s-mind-model').value = def.mindModel;
        const k = await ipcRenderer.invoke('load-keys');
        document.getElementById('s-openai-key').value =
          val === 'gemini' ? (k.geminiKey || '') :
          val === 'grok'   ? (k.grokKey   || '') :
                             (k.openaiKey || '');
        await saveKeys();
      }
    }
  }

  async function loadKeysForm() {
    const k = await ipcRenderer.invoke('load-keys');
    document.getElementById('s-key-anthropic').value  = k.anthropic  || '';
    document.getElementById('s-key-elevenlabs').value = k.elevenlabs || '';
    const provider = k.provider || 'anthropic';
    document.getElementById('s-provider').value    = provider;
    document.getElementById('s-openai-base').value = k.openaiBase || 'http://127.0.0.1:11434/v1';
    document.getElementById('s-chat-model').value  = k.chatModel  || '';
    document.getElementById('s-mind-model').value  = k.mindModel  || '';
    if (provider === 'openai') await populateOllamaModels(k.chatModel || '');
    // Load the right API key for the active provider
    const keyVal = provider === 'gemini'   ? (k.geminiKey   || '')
                 : provider === 'groq'     ? (k.groqKey     || '')
                 : provider === 'deepseek' ? (k.deepseekKey || '')
                 : provider === 'mistral'  ? (k.mistralKey  || '')
                 : provider === 'kimi'     ? (k.kimiKey     || '')
                 : provider === 'grok'     ? (k.grokKey     || '')
                 : (k.openaiKey || '');
    document.getElementById('s-openai-key').value = keyVal;
    const tm = (k.thinkModels || []).map(m => `${m.baseUrl || ''}|${m.model || ''}|${m.apiKey || ''}`).join('\n');
    document.getElementById('s-think-models').value = tm;
    onProviderChange(provider, true); // fromLoad — skip prefill/save
    document.querySelectorAll('.s-single').forEach(el => {
      el.style.height = 'auto';
      el.style.height = el.scrollHeight + 'px';
    });
  }

  async function saveKeys() {
    const provider = document.getElementById('s-provider').value;
    const keyVal   = document.getElementById('s-openai-key').value.trim();
    // Load existing so we don't wipe keys for other providers
    const existing = await ipcRenderer.invoke('load-keys');
    const keys = {
      ...existing,
      anthropic:  document.getElementById('s-key-anthropic').value.trim(),
      elevenlabs: document.getElementById('s-key-elevenlabs').value.trim(),
      provider,
      openaiBase: document.getElementById('s-openai-base').value.trim() || 'http://127.0.0.1:11434/v1',
      chatModel:  document.getElementById('s-chat-model').value.trim(),
      mindModel:  document.getElementById('s-mind-model').value.trim(),
      // Store key under provider-specific slot
      ...(provider === 'gemini'   ? { geminiKey:   keyVal } : {}),
      ...(provider === 'groq'     ? { groqKey:     keyVal } : {}),
      ...(provider === 'deepseek' ? { deepseekKey: keyVal } : {}),
      ...(provider === 'mistral'  ? { mistralKey:  keyVal } : {}),
      ...(provider === 'kimi'     ? { kimiKey:     keyVal } : {}),
      ...(provider === 'grok'     ? { grokKey:     keyVal } : {}),
      ...(provider === 'openai'   ? { openaiKey:   keyVal } : {}),
      thinkModels: document.getElementById('s-think-models').value.trim()
        .split('\n').filter(l => l.trim())
        .map(l => { const [baseUrl, model, apiKey] = l.split('|'); return { provider: 'openai', baseUrl: baseUrl?.trim(), model: model?.trim(), apiKey: apiKey?.trim() || '' }; })
        .filter(m => m.baseUrl && m.model),
    };
    await ipcRenderer.invoke('save-keys', keys);
  }

  async function loadPersonalityForm() {
    const p = await ipcRenderer.invoke('get-personality');
    document.getElementById('s-name').value = p.name || '';
    document.getElementById('s-age').value = p.age || '';
    document.getElementById('s-backstory').value = p.backstory || '';
    document.getElementById('s-tone').value = p.tone || '';
    document.getElementById('s-traits').value = (p.traits || []).join('\n');
    document.getElementById('s-interests').value = (p.interests || []).join('\n');
    document.getElementById('s-catchphrases').value = (p.catchphrases || []).join(', ');
    document.getElementById('s-extra').value = p.extra || '';
    const ap = p.appearance || {};
    document.getElementById('s-hair-color').value = ap.hairColor || '#4a1060';
    document.getElementById('s-eye-color').value = ap.eyeColor || '#c084fc';
    document.getElementById('s-outfit').value = ap.outfit || 'default';
    const accent = ap.accentColor || '#c084fc';
    const accentEl = document.getElementById('s-accent-color');
    if (accentEl) accentEl.value = accent;
    // Highlight matching preset if any
    document.querySelectorAll('.theme-preset-btn').forEach(b => {
      const isActive = b.dataset.color === accent;
      b.style.boxShadow = isActive ? `0 0 10px ${b.dataset.color}55` : 'none';
      b.style.fontWeight = isActive ? '700' : '400';
    });
    const v = p.voice || {};
    document.getElementById('s-voice-enabled').checked = v.enabled || false;
    document.getElementById('s-voice-id').value = v.voiceId || 'Ca3rvWzLhTByU4bCWEDU';
    document.getElementById('s-tts-engine').value = v.ttsEngine || 'browser';
    const rot = await ipcRenderer.invoke('get-model-rotation');
    document.getElementById('s-model-rotation').value = rot;
    document.getElementById('s-rotation-val').textContent = rot + '°';
    // Auto-fit single-line textareas to their content
    document.querySelectorAll('.s-single').forEach(el => {
      el.style.height = 'auto';
      el.style.height = el.scrollHeight + 'px';
    });
  }

  function onRotationChange(val) {
    document.getElementById('s-rotation-val').textContent = Math.round(val) + '°';
    ipcRenderer.invoke('set-model-rotation', parseFloat(val));
  }

  // ── Gaming mode ───────────────────────────────────────────────────────────────
  async function initGamingMode() {
    const on = await ipcRenderer.invoke('get-gaming-mode');
    updateGamingBtn(on);
  }

  async function toggleGamingMode() {
    const btn = document.getElementById('gaming-mode-btn');
    const currentlyOn = btn.dataset.on === 'true';
    const next = !currentlyOn;
    await ipcRenderer.invoke('set-gaming-mode', next);
    updateGamingBtn(next);
  }

  function updateGamingBtn(on) {
    const btn = document.getElementById('gaming-mode-btn');
    if (!btn) return;
    btn.dataset.on = String(on);
    btn.textContent = on ? 'On' : 'Off';
    btn.style.background = on ? 'rgba(74,222,128,0.15)' : 'rgba(168,85,247,0.08)';
    btn.style.borderColor = on ? 'rgba(74,222,128,0.5)' : 'rgba(168,85,247,0.4)';
    btn.style.color = on ? '#4ade80' : '#c084fc';
  }

  async function savePersonality() {
    const p = {
      name: document.getElementById('s-name').value.trim() || 'Nyxia',
      age: document.getElementById('s-age').value.trim(),
      backstory: document.getElementById('s-backstory').value.trim(),
      tone: document.getElementById('s-tone').value.trim(),
      traits: document.getElementById('s-traits').value.split('\n').map(s=>s.trim()).filter(Boolean),
      interests: document.getElementById('s-interests').value.split('\n').map(s=>s.trim()).filter(Boolean),
      catchphrases: document.getElementById('s-catchphrases').value.split(',').map(s=>s.trim()).filter(Boolean),
      extra: document.getElementById('s-extra').value.trim(),
      appearance: {
        hairColor: document.getElementById('s-hair-color').value,
        eyeColor: document.getElementById('s-eye-color').value,
        outfit: document.getElementById('s-outfit').value,
        accentColor: document.getElementById('s-accent-color')?.value || '#c084fc'
      },
      voice: {
        enabled: document.getElementById('s-voice-enabled').checked,
        voiceId: document.getElementById('s-voice-id').value.trim(),
        ttsEngine: document.getElementById('s-tts-engine').value
      }
    };
    await ipcRenderer.invoke('save-personality', p);
    refreshTTSEngine();
    setSystemPrompt(await ipcRenderer.invoke('get-system-prompt'));
    const conf = document.getElementById('save-confirm');
    conf.classList.add('show');
    setTimeout(() => conf.classList.remove('show'), 2500);
  }

  ipcRenderer.on('gaming-mode-changed', (_, on) => updateGamingBtn(on));

  // Expose as window globals for HTML onclick/onchange handlers and DOMContentLoaded
  window.onThemePreset        = onThemePreset;
  window.loadPersonalityForm  = loadPersonalityForm;
  window.savePersonality      = savePersonality;
  window.loadKeysForm         = loadKeysForm;
  window.saveKeys             = saveKeys;
  window.onProviderChange     = onProviderChange;
  window.onRotationChange     = onRotationChange;
  window.initGamingMode       = initGamingMode;
  window.toggleGamingMode     = toggleGamingMode;
  window.setupLiveSettings    = setupLiveSettings;
  window.debouncedSaveKeys    = debouncedSaveKeys;
};
