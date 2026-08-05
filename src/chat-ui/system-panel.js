'use strict';

// System panel — stats, growth, quests, desktop/VRAM controls
// Deps: { ipcRenderer, showView }
// Exposes window globals called by HTML onclick + DOMContentLoaded

module.exports = function initSystemPanel(deps) {
  const { ipcRenderer, showView } = deps;

  function calcLevelData(profile) {
    const sc   = profile.sessionCount || 0;
    const msgs = profile.counters?.totalMessages || 0;
    const vox  = profile.counters?.voiceMessages || 0;
    const xp   = sc * 50 + msgs * 10 + vox * 20;
    const lvl  = Math.max(1, Math.floor(Math.sqrt(xp / 100)) + 1);
    const xpFor = n => n * n * 100;
    const xpProg = xp - xpFor(lvl - 1);
    const xpNeed = xpFor(lvl) - xpFor(lvl - 1);
    return { level: lvl, xpProgress: xpProg, xpNeeded: xpNeed, xpTotal: xp };
  }

  function getTitle(level) {
    if (level >= 30) return 'Shadow Monarch';
    if (level >= 20) return 'National-Level Hunter';
    if (level >= 15) return 'S-Rank Hunter';
    if (level >= 10) return 'A-Rank Hunter';
    if (level >= 7)  return 'B-Rank Hunter';
    if (level >= 5)  return 'C-Rank Hunter';
    if (level >= 3)  return 'D-Rank Hunter';
    if (level >= 2)  return 'E-Rank Hunter';
    return 'Newcomer';
  }

  function calcStats(profile) {
    const sc    = profile.sessionCount || 0;
    const msgs  = profile.counters?.totalMessages || 0;
    const vox   = profile.counters?.voiceMessages || 0;
    const streak = profile.counters?.streak || 0;
    const facts = (profile.facts || []).length + (profile.interests || []).length;
    const cap99 = v => Math.min(Math.round(v), 99);
    return [
      { name: 'STR', desc: 'Rapport',   val: cap99(sc * 3),       color: '#ff7eb3' },
      { name: 'INT', desc: 'Insight',   val: cap99(facts * 4),    color: '#a78bfa' },
      { name: 'AGI', desc: 'Voice',     val: cap99(vox * 8),      color: '#00d4ff' },
      { name: 'VIT', desc: 'Streak',    val: cap99(streak * 12),  color: '#4ade80' },
      { name: 'SNS', desc: 'Awareness', val: cap99(msgs / 3),     color: '#fbbf24' },
    ];
  }

  function updateGrowthBars(profile, self) {
    const facts       = (profile.facts || []).length + (profile.interests || []).length;
    const sessions    = profile.sessionCount || 0;
    const msgs        = profile.counters?.totalMessages || 0;
    const reflections = (self.reflections || []).length;
    const beliefs     = (self.beliefs || []).length;

    // Learning: grows with knowledge of Kristian (facts, sessions, messages)
    const learnPct = Math.min(100, Math.round(facts * 6 + sessions * 5 + Math.min(msgs * 0.5, 30)));
    const learnLabels = ['Stranger', 'Familiar', 'Bonded', 'Attuned', 'Beloved'];
    const learnStage  = learnLabels[Math.min(4, Math.floor(learnPct / 20))];

    // Independence: grows with self-reflection (max 25 reflections) + beliefs
    const indiePct = Math.min(100, Math.round(reflections / 25 * 75 + Math.min(beliefs * 5, 25)));
    const indieLabels = ['Dormant', 'Stirring', 'Aware', 'Forming', 'Sovereign'];
    const indieStage  = indieLabels[Math.min(4, Math.floor(indiePct / 20))];

    document.getElementById('growth-learn-fill').style.width  = learnPct + '%';
    document.getElementById('growth-learn-stage').textContent = learnStage;
    document.getElementById('growth-learn-hint').textContent  = `${learnPct}% · ${facts} known facts · ${sessions} sessions`;

    document.getElementById('growth-indie-fill').style.width  = indiePct + '%';
    document.getElementById('growth-indie-stage').textContent = indieStage;
    document.getElementById('growth-indie-hint').textContent  = `${indiePct}% · ${reflections} reflections · ${beliefs} beliefs`;
  }

  async function loadSystemPanel() {
    const profile = await ipcRenderer.invoke('load-user-profile');
    const { level, xpProgress, xpNeeded } = calcLevelData(profile);
    const prevLevel = profile._prevLevel || 0;

    // Status
    document.getElementById('sys-player').textContent = profile.userName || 'Unknown';
    document.getElementById('sys-title-val').textContent = getTitle(level);
    document.getElementById('sys-level').textContent = level;
    document.getElementById('sys-xp-fill').style.width = (xpNeeded > 0 ? xpProgress / xpNeeded * 100 : 0) + '%';
    document.getElementById('sys-xp-hint').textContent = `${xpProgress} / ${xpNeeded} XP`;

    // Level-up notification
    if (prevLevel && level > prevLevel) {
      const n = document.getElementById('sys-notify');
      n.textContent = `LEVEL UP! You are now LV.${level}`;
      n.classList.add('show');
      setTimeout(() => n.classList.remove('show'), 4000);
    }
    profile._prevLevel = level;
    ipcRenderer.invoke('save-user-profile', profile);

    // Stats
    const statsEl = document.getElementById('sys-stats');
    statsEl.innerHTML = '';
    calcStats(profile).forEach(s => {
      const pct = Math.min(s.val, 99);
      statsEl.innerHTML += `
        <div class="sys-stat-row">
          <span class="sys-stat-name" title="${s.desc}">${s.name}</span>
          <div class="sys-bar" style="flex:1"><div class="sys-bar-fill" style="width:${pct}%;background:${s.color};box-shadow:0 0 5px ${s.color}55"></div></div>
          <span class="sys-stat-val">${s.val}</span>
        </div>`;
    });

    // Growth bars
    const self = await ipcRenderer.invoke('load-self-data').catch(() => ({ beliefs: [], reflections: [] }));
    updateGrowthBars(profile, self);

    // Quests
    renderQuests(profile.quests);

    // ✦ RIGHT NOW — self-model
    try {
      const sm = await ipcRenderer.invoke('get-self-model');
      const smEl = document.getElementById('sys-selfmodel-content');
      if (sm && (sm.what_im_doing || sm.how_im_feeling)) {
        smEl.innerHTML = '';
        const rows = [
          ['doing',   sm.what_im_doing],
          ['feeling', sm.how_im_feeling],
          ['wanting', sm.what_i_want_right_now],
          ['concern', sm.pending_concern],
        ];
        for (const [label, val] of rows) {
          if (!val) continue;
          const d = document.createElement('div');
          const lbl = document.createElement('span');
          lbl.style.cssText = 'color:rgba(120,100,180,0.7)';
          lbl.textContent = label;
          d.appendChild(lbl);
          d.appendChild(document.createTextNode('  ' + val));
          smEl.appendChild(d);
        }
        if (sm.inner_tension !== undefined) {
          const d = document.createElement('div');
          d.style.marginTop = '4px';
          const lbl = document.createElement('span');
          lbl.style.cssText = 'color:rgba(120,100,180,0.7)';
          lbl.textContent = 'tension';
          const val = document.createElement('span');
          val.style.color = sm.inner_tension > 0.6 ? '#ef4444' : sm.inner_tension > 0.3 ? '#f59e0b' : '#4ade80';
          val.textContent = '  ' + (sm.inner_tension * 100).toFixed(0) + '%';
          d.appendChild(lbl); d.appendChild(val); smEl.appendChild(d);
        }
      } else {
        smEl.innerHTML = '<span style="color:rgba(120,100,180,0.4);font-style:italic">not yet updated — check back in 2min</span>';
      }
    } catch(_) {}

    // ✦ INNER THOUGHTS — thought bank
    try {
      const thoughts = await ipcRenderer.invoke('get-thought-bank');
      const tEl = document.getElementById('sys-thoughts-list');
      if (thoughts && thoughts.length > 0) {
        tEl.innerHTML = '';
        for (const t of thoughts.slice(-5).reverse()) {
          const ago = Math.round((Date.now() - t.timestamp) / 60000);
          const wrap = document.createElement('div');
          wrap.style.cssText = 'margin-bottom:5px;padding:4px 0;border-bottom:1px solid rgba(120,100,180,0.1)';
          const dot = document.createElement('span');
          dot.style.cssText = t.spoken ? 'color:#4ade80;margin-right:5px' : 'color:rgba(180,160,220,0.4);margin-right:5px';
          dot.textContent = '●';
          const meta = document.createElement('span');
          meta.style.cssText = 'color:rgba(120,100,180,0.5);font-size:9px';
          meta.textContent = `${ago}m ago · ${t.source}`;
          const body = document.createElement('div');
          body.style.cssText = 'color:rgba(200,180,240,0.85);margin-top:2px';
          const txt = String(t.text || '');
          body.textContent = txt.slice(0, 80) + (txt.length > 80 ? '…' : '');
          wrap.appendChild(dot); wrap.appendChild(meta); wrap.appendChild(body);
          tEl.appendChild(wrap);
        }
      } else {
        tEl.innerHTML = '<span style="color:rgba(120,100,180,0.4);font-style:italic">no thoughts yet — starts 3min after launch</span>';
      }
    } catch(_) {}

    // ◈ BODY STATE — interoception
    try {
      const bs = await ipcRenderer.invoke('get-body-state');
      const el = document.getElementById('sys-body-state');
      const bar = (v, color) =>
        `<div class="sys-bar" style="flex:1"><div class="sys-bar-fill" style="width:${Math.round(v*100)}%;background:${color}"></div></div>`;
      el.innerHTML = [
        ['strain',      bs.strain,      '#ef4444'],
        ['energy',      bs.energy,      '#4ade80'],
        ['fatigue',     bs.fatigue,     '#f59e0b'],
        ['discomfort',  bs.discomfort,  '#f97316'],
        ['frustration', bs.frustration, '#a855f7'],
      ].map(([name, val, color]) =>
        `<div class="sys-stat-row"><span class="sys-stat-name">${name}</span>${bar(val, color)}<span class="sys-stat-val">${Math.round(val*100)}%</span></div>`
      ).join('');
    } catch(_) {}

    // ◈ READING KRISTIAN — other-model
    try {
      const k = await ipcRenderer.invoke('get-kristian-state');
      const el = document.getElementById('sys-kristian-content');
      el.innerHTML = '';
      const energyColor = k.energy > 0.6 ? '#4ade80' : k.energy < 0.3 ? '#ef4444' : '#f59e0b';
      const kRows = [
        ['mood',   k.mood],
        ['focus',  k.focus],
        ['wants',  k.wants],
      ];
      for (const [label, val] of kRows) {
        if (!val) continue;
        const d = document.createElement('div');
        const lbl = document.createElement('span');
        lbl.style.cssText = 'color:rgba(120,100,180,0.7)';
        lbl.textContent = label;
        d.appendChild(lbl);
        d.appendChild(document.createTextNode('  ' + val));
        el.appendChild(d);
      }
      const eDiv = document.createElement('div');
      const eLbl = document.createElement('span');
      eLbl.style.cssText = 'color:rgba(120,100,180,0.7)';
      eLbl.textContent = 'energy';
      const eVal = document.createElement('span');
      eVal.style.color = energyColor;
      eVal.textContent = '  ' + Math.round(k.energy * 100) + '%';
      eDiv.appendChild(eLbl); eDiv.appendChild(eVal); el.appendChild(eDiv);
      if (k.tension > 0.2) {
        const tDiv = document.createElement('div');
        const tLbl = document.createElement('span');
        tLbl.style.cssText = 'color:rgba(120,100,180,0.7)';
        tLbl.textContent = 'tension';
        const tVal = document.createElement('span');
        tVal.style.color = '#ef4444';
        tVal.textContent = '  ' + Math.round(k.tension * 100) + '%';
        tDiv.appendChild(tLbl); tDiv.appendChild(tVal); el.appendChild(tDiv);
      }
      if (k.persistent?.tendencies?.length) {
        const tdDiv = document.createElement('div');
        tdDiv.style.cssText = 'margin-top:4px;color:rgba(120,100,180,0.5)';
        tdDiv.textContent = 'tends to: ' + k.persistent.tendencies.slice(0, 2).join(', ');
        el.appendChild(tdDiv);
      }
    } catch(_) {}

    // ✦ CURIOSITY GAPS — open gaps
    try {
      const gaps = await ipcRenderer.invoke('get-gaps');
      const el = document.getElementById('sys-gaps-list');
      if (gaps && gaps.length > 0) {
        el.innerHTML = '';
        for (const g of gaps.slice(0, 8)) {
          const age = Math.round((Date.now() - g.created) / 3600000);
          const ageStr = age < 1 ? 'just now' : age < 24 ? `${age}h ago` : `${Math.round(age / 24)}d ago`;
          const urgColor = g.urgency > 0.6 ? '#ef4444' : g.urgency > 0.4 ? '#f59e0b' : 'rgba(180,160,220,0.4)';

          const wrap = document.createElement('div');
          wrap.style.cssText = 'margin-bottom:6px;padding:4px 0;border-bottom:1px solid rgba(120,100,180,0.1);display:flex;align-items:flex-start;gap:6px';

          const dot = document.createElement('span');
          dot.style.cssText = `color:${urgColor};font-size:8px;margin-top:2px`;
          dot.textContent = '●';

          const inner = document.createElement('div');
          inner.style.flex = '1';
          const textDiv = document.createElement('div');
          textDiv.style.color = 'rgba(200,180,240,0.85)';
          const txt = String(g.text || '');
          textDiv.textContent = txt.slice(0, 70) + (txt.length > 70 ? '…' : '');
          const metaDiv = document.createElement('div');
          metaDiv.style.cssText = 'color:rgba(120,100,180,0.5);font-size:9px';
          metaDiv.textContent = `${g.type} · ${ageStr}`;
          inner.appendChild(textDiv); inner.appendChild(metaDiv);

          const btn = document.createElement('button');
          btn.style.cssText = 'background:none;border:1px solid rgba(120,100,180,0.3);border-radius:3px;color:rgba(120,100,180,0.6);font-size:8px;padding:1px 4px;cursor:pointer;flex-shrink:0';
          btn.textContent = '✓';
          btn.addEventListener('click', () => resolveGap(g.id));

          wrap.appendChild(dot); wrap.appendChild(inner); wrap.appendChild(btn);
          el.appendChild(wrap);
        }
      } else {
        el.innerHTML = '<span style="color:rgba(120,100,180,0.4);font-style:italic">no open gaps</span>';
      }
    } catch(_) {}

    // ✦ NARRATIVE ARC — sleep consolidation output
    try {
      const arc = await ipcRenderer.invoke('get-narrative-arc');
      document.getElementById('sys-arc-content').innerHTML = arc
        ? arc.replace(/\n/g, '<br>')
        : '<span style="color:rgba(120,100,180,0.4)">no arc yet — forms after first 2h rest</span>';
    } catch(_) {}
  }

  async function resolveGap(id) {
    await ipcRenderer.invoke('resolve-gap', id);
    loadSystemPanel();
  }

  function getTodayStr() { return new Date().toISOString().split('T')[0]; }

  function renderQuests(quests) {
    const today = getTodayStr();
    // Reset list if it's a new day
    if (!quests || quests.date !== today) quests = { date: today, items: [] };

    const list = document.getElementById('sys-quest-list');
    list.innerHTML = '';
    quests.items.forEach(q => {
      const row = document.createElement('div');
      row.className = 'sys-quest-item';
      row.innerHTML = `
        <div class="sys-quest-check ${q.done ? 'done' : ''}" onclick="toggleQuest('${q.id}')">${q.done ? '✓' : ''}</div>
        <span class="sys-quest-txt ${q.done ? 'done' : ''}">${q.text}</span>
        <span class="sys-quest-del" onclick="deleteQuest('${q.id}')">✕</span>`;
      list.appendChild(row);
    });

    const done = quests.items.filter(q => q.done).length;
    const total = quests.items.length;
    document.getElementById('sys-quest-count').textContent = `${done}/${total}`;

    const penalty = document.getElementById('sys-penalty');
    const overdue = quests.items.some(q => !q.done);
    penalty.style.display = total > 0 && overdue ? 'block' : 'none';
  }

  async function getQuests() {
    const profile = await ipcRenderer.invoke('load-user-profile');
    const today = getTodayStr();
    if (!profile.quests || profile.quests.date !== today) profile.quests = { date: today, items: [] };
    return profile;
  }

  async function addQuest() {
    const inp = document.getElementById('sys-quest-input');
    const text = inp.value.trim();
    if (!text) return;
    inp.value = '';
    const profile = await getQuests();
    profile.quests.items.push({ id: Date.now().toString(), text, done: false });
    await ipcRenderer.invoke('save-user-profile', profile);
    renderQuests(profile.quests);
  }

  async function toggleQuest(id) {
    const profile = await getQuests();
    const q = profile.quests.items.find(q => q.id === id);
    if (q) q.done = !q.done;
    await ipcRenderer.invoke('save-user-profile', profile);
    renderQuests(profile.quests);
  }

  async function deleteQuest(id) {
    const profile = await getQuests();
    profile.quests.items = profile.quests.items.filter(q => q.id !== id);
    await ipcRenderer.invoke('save-user-profile', profile);
    renderQuests(profile.quests);
  }

  function useAbility(prompt) {
    showView('chat');
    document.getElementById('chat-input').value = prompt;
    document.getElementById('chat-input').focus();
  }

  async function toggleDesktopMode() {
    const enabled = await ipcRenderer.invoke('toggle-desktop-mode');
    document.getElementById('desktop-mode-status').textContent = enabled ? 'ON' : 'OFF';
    document.getElementById('btn-desktop-mode').textContent = enabled ? 'Disable Desktop Avatar' : 'Enable Desktop Avatar';
  }

  async function checkVram() {
    const el = document.getElementById('vram-status');
    el.textContent = 'Checking...';
    const { apps, free } = await ipcRenderer.invoke('vram-status');
    const lines = apps ? apps.split('\n').filter(Boolean).map(l => {
      const [pid, mb, name] = l.split(',').map(s => s.trim());
      const short = (name || '').split('/').pop();
      return `  ${short} — ${mb}`;
    }) : ['  (nothing)'];
    el.textContent = `Free: ${free}\n${lines.join('\n')}`;
  }

  async function freeVram() {
    const el = document.getElementById('vram-status');
    el.textContent = 'Freeing...';
    const result = await ipcRenderer.invoke('free-vram');
    el.textContent = result;
  }

  // Expose as window globals for HTML onclick + toggleSystem in chat.html
  window.loadSystemPanel  = loadSystemPanel;
  window.resolveGap       = resolveGap;
  window.addQuest         = addQuest;
  window.toggleQuest      = toggleQuest;
  window.deleteQuest      = deleteQuest;
  window.useAbility       = useAbility;
  window.toggleDesktopMode = toggleDesktopMode;
  window.checkVram        = checkVram;
  window.freeVram         = freeVram;
};
