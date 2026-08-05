'use strict';
// memory/facts.js — Mem0-style learned facts extracted from conversations.
// Persisted to nyxia-facts.json, capped at 50 entries.

const fs   = require('fs');
const path = require('path');

let _learnedFacts = [];
let _getDataPath  = () => '';
let _loadConfig   = () => ({});

function init({ getDataPath, loadConfig }) {
  _getDataPath = getDataPath;
  _loadConfig  = loadConfig;
  load();
}

function _factsPath() {
  return path.join(_getDataPath(), 'nyxia-facts.json');
}

function load() {
  try { _learnedFacts = JSON.parse(fs.readFileSync(_factsPath(), 'utf8')); }
  catch (_) { _learnedFacts = []; }
}

function save() {
  try { fs.writeFileSync(_factsPath(), JSON.stringify(_learnedFacts, null, 2)); }
  catch (_) {}
}

async function extractFactsAsync(userMsg, assistantMsg) {
  if (!userMsg || userMsg.length < 20 || !assistantMsg || assistantMsg.length < 10) return;
  try {
    const cfg = _loadConfig();
    const res = await fetch('http://127.0.0.1:11434/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: cfg.mindModel || 'nyxia-ft',
        messages: [{
          role: 'system',
          content:
            'Extract 1-3 short factual statements about the USER from this conversation exchange. ' +
            'Only extract concrete, reusable facts: preferences, projects, skills, life details, opinions. ' +
            'Skip small talk and questions. If nothing factual is present, output an empty array. ' +
            'Output JSON array of strings only. Example: ["User is learning Rust", "User prefers dark themes"]',
        }, {
          role: 'user',
          content: `User: ${userMsg.slice(0, 400)}\nAssistant: ${assistantMsg.slice(0, 400)}`,
        }],
        stream: false,
        format: { type: 'array', items: { type: 'string' } },
        options: { temperature: 0, num_predict: 80 },
      }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return;
    const data = await res.json();
    let facts = [];
    try { facts = JSON.parse(data.message?.content || '[]'); } catch (_) { return; }
    if (!Array.isArray(facts) || facts.length === 0) return;

    const newFacts = facts.filter(f =>
      typeof f === 'string' && f.length > 5 &&
      !_learnedFacts.some(e => e.toLowerCase().includes(f.toLowerCase().slice(0, 20)))
    );
    if (newFacts.length === 0) return;

    _learnedFacts = [..._learnedFacts, ...newFacts].slice(-50);
    save();
    console.log('[facts] learned:', newFacts);
  } catch (_) {}
}

module.exports = {
  init,
  extractFactsAsync,
  getLearnedFacts: () => _learnedFacts,
};
