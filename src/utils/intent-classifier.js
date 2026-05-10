'use strict';

/**
 * Intent Classifier — The Gatekeeper
 * Decides which Expert Brain should handle the user's request.
 */

const EXPERTS = {
  ROLEPLAY:   'dolphin3:8b',
  LOGIC:      'nyxia-qwen:latest',
  VISION:     'qwen2.5vl:7b',
  GATEKEEPER: 'llama3.2:3b'
};

async function classifyIntent(text) {
  const prompt = `You are Nyxia's neural router. Classify the user's intent into exactly one category:
- CHAT: Casual conversation, flirting, emotional questions, persona lore.
- LOGIC: Technical questions, coding, running shell commands, filesystem tasks.
- VISION: Questions about what's on the screen, images, or "seeing" things.

User message: "${text}"

Return ONLY the word CHAT, LOGIC, or VISION. No explanation.`;

  try {
    const res = await fetch('http://127.0.0.1:11434/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: EXPERTS.GATEKEEPER,
        prompt: prompt,
        stream: false,
        options: { temperature: 0, num_predict: 5 }
      })
    });

    if (res.ok) {
      const data = await res.json();
      const intent = data.response.trim().toUpperCase();
      if (['CHAT', 'LOGIC', 'VISION'].includes(intent)) return intent;
    }
  } catch (e) {
    console.warn('[router] Intent classification failed, defaulting to CHAT');
  }
  return 'CHAT';
}

module.exports = { classifyIntent, EXPERTS };
