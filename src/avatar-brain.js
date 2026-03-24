/**
 * ✦ NYXIA — Avatar Brain Bridge
 * 
 * This module connects the Claude LLM brain to the 3D avatar.
 * The avatar IS the AI — every response, emotion, and state
 * is expressed through the model's animations and expressions.
 * 
 * FILE: src/avatar-brain.js
 * 
 * HOW IT WORKS:
 * 1. Claude generates a response
 * 2. The brain analyzer reads the text and detects emotional state
 * 3. The avatar receives that state and plays the matching animation
 * 4. Speech is lip-synced to the TTS audio (when voice is enabled)
 * 
 * ANIMATION STATES:
 *   idle        — default, breathing, slight sway
 *   thinking    — head tilt, eyes narrow, finger to chin
 *   talking     — mouth moves, gestures, engaged posture
 *   happy       — smile, bounce, open posture
 *   curious     — lean forward, head tilt, eyebrow raise
 *   focused     — still, concentrated, eyes locked forward
 *   playful     — wink, smirk, light bounce
 *   surprised   — eyes wide, slight back lean
 *   concerned   — slight frown, forward lean, eyebrows together
 */

// ─────────────────────────────────────────────
// EMOTION DETECTION
// Reads Claude's response text and returns an
// emotional state + intensity for the avatar.
// ─────────────────────────────────────────────

const EMOTION_PATTERNS = {
  happy: {
    keywords: ['great', 'wonderful', 'excellent', 'love', 'perfect', 'brilliant', 'amazing', 'fantastic', 'delightful', 'glad', '✦'],
    weight: 1.0
  },
  playful: {
    keywords: ['heh', 'hm', 'ah', 'oh?', 'well well', 'mortals', 'amusing', 'interesting...', 'as i suspected', 'mischief', 'dare i say', '~'],
    weight: 1.2
  },
  curious: {
    keywords: ['interesting', 'curious', 'tell me', 'what do you', 'i wonder', 'hmm', 'perhaps', 'i find myself', 'i notice'],
    weight: 1.0
  },
  focused: {
    keywords: ['here is', 'here\'s', 'let me', 'step', 'to fix', 'run this', 'install', 'the solution', 'you\'ll want to', 'try this'],
    weight: 0.9
  },
  thinking: {
    keywords: ['thinking', 'consider', 'depends', 'it could', 'one option', 'alternatively', 'on the other hand', 'weigh', 'trade-off'],
    weight: 0.8
  },
  sad: {
    keywords: ['sorry', 'unfortunate', 'regret', 'sad', 'miss', 'difficult', 'loss', 'hard', 'wish i could', 'if only'],
    weight: 0.9
  },
  concerned: {
    keywords: ['careful', 'warning', 'caution', 'issue', 'problem', 'error', 'risk', 'watch out', 'be aware', 'however'],
    weight: 0.7
  },
  surprised: {
    keywords: ['oh!', 'wait', 'actually', 'unexpected', "didn't expect", 'really?', 'truly?', 'remarkable', 'that\'s not'],
    weight: 0.9
  }
};

/**
 * Analyzes response text and returns dominant emotion + intensity.
 * @param {string} text - Claude's response
 * @returns {{ emotion: string, intensity: number, isTechnical: boolean }}
 */
function analyzeEmotion(text) {
  const lower = text.toLowerCase();
  const scores = {};

  for (const [emotion, config] of Object.entries(EMOTION_PATTERNS)) {
    let score = 0;
    for (const keyword of config.keywords) {
      if (lower.includes(keyword)) {
        score += config.weight;
      }
    }
    scores[emotion] = score;
  }

  // Detect if it's a technical/code response (longer, structured)
  const isTechnical = (
    text.includes('```') ||
    text.includes('    ') ||      // code indentation
    text.split('\n').length > 8 || // long structured response
    /\b(function|const|let|var|import|class|def|return)\b/.test(text)
  );

  // Pick dominant emotion
  const dominant = Object.entries(scores).reduce(
    (best, [emotion, score]) => score > best.score ? { emotion, score } : best,
    { emotion: 'idle', score: 0 }
  );

  // Normalize intensity 0–1
  const intensity = Math.min(dominant.score / 3, 1);

  return {
    emotion: dominant.score > 0 ? dominant.emotion : (isTechnical ? 'focused' : 'idle'),
    intensity,
    isTechnical
  };
}

// ─────────────────────────────────────────────
// AVATAR CONTROLLER
// Drives the Three.js model's animations based
// on emotional state from the brain.
// ─────────────────────────────────────────────

class NyxiaAvatarController {
  constructor(mixer, animations) {
    /**
     * @param mixer   - THREE.AnimationMixer attached to the GLB model
     * @param animations - array of THREE.AnimationClip from the GLB file
     * 
     * Expected animation names in the GLB:
     *   "Idle", "Thinking", "Talking", "Happy", "Curious",
     *   "Focused", "Playful", "Surprised", "Concerned"
     * 
     * If your Blender export uses different names, update ANIM_MAP below.
     */
    this.mixer = mixer;
    this.clips = {};
    this.currentAction = null;
    this.currentEmotion = 'idle';
    this.isTalking = false;

    // Map emotion states to animation clip names in the GLB
    this.ANIM_MAP = {
      idle:      'idle',
      thinking:  'fold_arms',
      talking:   'complain_01',
      happy:     'cheer',
      sad:       'cry',
      curious:   'play_video_game',
      focused:   'depressed',
      playful:   'dance_01',
      surprised: 'frightened',
      concerned: 'frustrated_01',
    };

    // Index all clips by name for fast lookup
    for (const clip of animations) {
      this.clips[clip.name] = clip;
    }

    // Start in idle
    this.playAnimation('idle');
  }

  /**
   * Play a named animation with a smooth crossfade.
   * @param {string} emotion 
   * @param {number} fadeTime - crossfade duration in seconds
   */
  playAnimation(emotion, fadeTime = 0.4) {
    const clipName = this.ANIM_MAP[emotion] || this.ANIM_MAP['idle'];
    const clip = this.clips[clipName];

    if (!clip) {
      if (this.currentEmotion !== emotion) {
        console.warn(`[NyxiaAvatar] Clip "${clipName}" not in GLB. Available: ${Object.keys(this.clips).join(', ')}`);
        this.currentEmotion = emotion; // suppress retry spam
      }
      return;
    }

    const newAction = this.mixer.clipAction(clip);
    if (this.currentAction === newAction) return;

    newAction.reset();
    newAction.setEffectiveTimeScale(1);
    newAction.setEffectiveWeight(1);

    if (this.currentAction) {
      newAction.crossFadeFrom(this.currentAction, fadeTime, true);
    }

    newAction.play();
    this.currentAction = newAction;
    this.currentEmotion = emotion;
  }

  /**
   * Called when Claude starts generating a response.
   * Avatar enters "thinking" state.
   */
  onThinkingStart() {
    this.playAnimation('thinking', 0.3);
  }

  /**
   * Called when Claude's response is received.
   * Avatar transitions to appropriate emotion, then talking.
   * @param {string} responseText - full response text
   */
  onResponseReceived(responseText) {
    const { emotion, intensity, isTechnical } = analyzeEmotion(responseText);

    // Brief emotional flash before settling into talking
    this.playAnimation(emotion, 0.2);

    setTimeout(() => {
      // Transition to talking state while reading the response
      this.playAnimation('talking', 0.3);
      this.isTalking = true;
    }, 600);

    // Return analysis so caller can use intensity for other effects
    return { emotion, intensity, isTechnical };
  }

  /**
   * Called when TTS finishes speaking (or typing animation ends).
   * Avatar returns to idle or a resting emotional state.
   * @param {string} lastEmotion - emotion to briefly hold before idle
   */
  onSpeakingEnd(lastEmotion = 'idle') {
    this.isTalking = false;
    // Hold the emotion for a moment, then settle into idle
    setTimeout(() => {
      this.playAnimation('idle', 0.8);
    }, 1200);
  }

  /**
   * Override: force a specific emotion externally
   * (e.g. from personality panel or system events)
   */
  setEmotion(emotion, duration = null) {
    this.playAnimation(emotion, 0.4);
    if (duration) {
      setTimeout(() => this.playAnimation('idle', 0.8), duration);
    }
  }

  /**
   * Call this every frame in your Three.js render loop.
   * @param {number} delta - time since last frame (from THREE.Clock)
   */
  update(delta) {
    this.mixer.update(delta);
  }
}

// ─────────────────────────────────────────────
// THREE.JS SCENE SETUP
// Drop this into index.html to replace the SVG
// with the 3D GLB model.
// ─────────────────────────────────────────────

/**
 * Initializes the Three.js scene, loads the GLB avatar,
 * and returns the controller ready for use.
 * 
 * Usage in index.html:
 *   const avatarCtrl = await initNyxiaAvatar('#avatar-canvas', '/assets/nyxia-model.glb');
 *   // Then on each chat response:
 *   avatarCtrl.onResponseReceived(replyText);
 */
async function initNyxiaAvatar(canvasSelector, glbPath) {
  // Requires Three.js r128+ loaded globally or via import
  const canvas = document.querySelector(canvasSelector);
  if (!canvas) throw new Error('Avatar canvas not found');

  // Scene
  const scene = new THREE.Scene();
  scene.background = null; // transparent

  // Camera — portrait framing, waist-up
  const camera = new THREE.PerspectiveCamera(35, canvas.clientWidth / canvas.clientHeight, 0.1, 100);
  camera.position.set(0, 1.4, 3.2);
  camera.lookAt(0, 1.0, 0);

  // Renderer
  const renderer = new THREE.WebGLRenderer({
    canvas,
    alpha: true,           // transparent background
    antialias: true,
    powerPreference: 'high-performance'
  });
  renderer.setSize(canvas.clientWidth, canvas.clientHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  // Lighting — dramatic purple-tinted to match Nyxia's aesthetic
  const ambientLight = new THREE.AmbientLight(0x2a1040, 1.2);
  scene.add(ambientLight);

  const keyLight = new THREE.DirectionalLight(0xc084fc, 2.0); // purple key light
  keyLight.position.set(1, 3, 2);
  keyLight.castShadow = true;
  scene.add(keyLight);

  const fillLight = new THREE.DirectionalLight(0x38bdf8, 0.6); // cyan fill
  fillLight.position.set(-2, 1, 1);
  scene.add(fillLight);

  const rimLight = new THREE.DirectionalLight(0x7c3aed, 0.8); // purple rim
  rimLight.position.set(0, 2, -2);
  scene.add(rimLight);

  // Load GLB model
  const { GLTFLoader } = await import('https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/examples/js/loaders/GLTFLoader.js');
  const loader = new GLTFLoader();

  const gltf = await new Promise((resolve, reject) => {
    loader.load(glbPath, resolve, undefined, reject);
  });

  const model = gltf.scene;
  model.position.set(0, 0, 0);
  model.scale.set(1, 1, 1);

  // Enable shadows on all meshes
  model.traverse(node => {
    if (node.isMesh) {
      node.castShadow = true;
      node.receiveShadow = true;
      // Ensure materials render correctly
      if (node.material) {
        node.material.envMapIntensity = 0.5;
      }
    }
  });

  scene.add(model);

  // Animation mixer
  const mixer = new THREE.AnimationMixer(model);
  const controller = new NyxiaAvatarController(mixer, gltf.animations);

  // Idle breathing effect — subtle scale pulse on body
  let breathPhase = 0;
  
  // Clock for delta time
  const clock = new THREE.Clock();

  // Render loop
  function animate() {
    requestAnimationFrame(animate);
    const delta = clock.getDelta();

    // Breathing
    breathPhase += delta * 0.8;
    const breathScale = 1 + Math.sin(breathPhase) * 0.008;
    model.scale.set(breathScale, breathScale, breathScale);

    // Update animation mixer
    controller.update(delta);

    renderer.render(scene, camera);
  }
  animate();

  // Resize handler
  window.addEventListener('resize', () => {
    camera.aspect = canvas.clientWidth / canvas.clientHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(canvas.clientWidth, canvas.clientHeight);
  });

  console.log('[NyxiaAvatar] 3D model loaded and ready ✦');
  return controller;
}

// ─────────────────────────────────────────────
// CHAT INTEGRATION PATCH
// Replace the sendMessage() function in chat.html
// with this version to wire avatar to responses.
// ─────────────────────────────────────────────

/**
 * Drop-in replacement for sendMessage() in chat.html.
 * Requires avatarCtrl to be initialized via initNyxiaAvatar().
 * 
 * Add to chat.html:
 *   let avatarCtrl = null;
 *   window.addEventListener('DOMContentLoaded', async () => {
 *     // ... existing init ...
 *     avatarCtrl = await initNyxiaAvatar('#avatar-canvas', '../assets/nyxia-model.glb');
 *   });
 */
async function sendMessageWithAvatar() {
  const input = document.getElementById('chat-input');
  const text = input.value.trim();
  if (!text) return;

  input.value = '';
  addMsg('user', text);
  chatHistory.push({ role: 'user', content: text });
  showTyping();

  // Avatar starts thinking
  if (avatarCtrl) avatarCtrl.onThinkingStart();

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': window._nyxiaKey || '',
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 1000,
        system: systemPrompt,
        messages: chatHistory
      })
    });

    const data = await res.json();
    const reply = data.content[0].text;

    hideTyping();
    addMsg('nyxia', reply);
    chatHistory.push({ role: 'assistant', content: reply });

    // Avatar reacts to response
    if (avatarCtrl) {
      const { emotion, intensity } = avatarCtrl.onResponseReceived(reply);

      // Estimate how long the response takes to read (~180 wpm)
      const wordCount = reply.split(' ').length;
      const readDuration = (wordCount / 180) * 60 * 1000;

      setTimeout(() => {
        if (avatarCtrl) avatarCtrl.onSpeakingEnd(emotion);
      }, Math.min(readDuration, 8000)); // cap at 8 seconds
    }

  } catch(e) {
    hideTyping();
    addMsg('nyxia', "Mmm, connection disrupted~ Try again?");
    if (avatarCtrl) avatarCtrl.setEmotion('concerned', 3000);
  }
}

// ─────────────────────────────────────────────
// SYSTEM EVENT REACTIONS
// Avatar reacts to desktop events from the
// Python backend — not just chat messages.
// ─────────────────────────────────────────────

/**
 * Wire this to ipcRenderer 'backend-event' in index.html.
 * The avatar reacts to what you're doing on the desktop.
 */
function handleSystemEvent(event, avatarCtrl) {
  if (!avatarCtrl) return;

  switch(event.type) {
    case 'clipboard_change':
      avatarCtrl.setEmotion('curious', 2000);
      break;

    case 'window_change':
      // React to specific apps
      const appName = (event.window_name || '').toLowerCase();
      if (appName.includes('code') || appName.includes('vim') || appName.includes('nvim')) {
        avatarCtrl.setEmotion('focused', 3000);
      } else if (appName.includes('youtube') || appName.includes('spotify')) {
        avatarCtrl.setEmotion('happy', 3000);
      } else if (appName.includes('blender')) {
        avatarCtrl.setEmotion('curious', 2000);
      }
      break;

    case 'idle_comment':
      avatarCtrl.setEmotion('playful', 4000);
      break;

    case 'time_reaction':
      // Late night = different vibe
      const hour = new Date().getHours();
      if (hour >= 22 || hour < 5) {
        avatarCtrl.setEmotion('playful', 3000); // Nyxia loves the night
      }
      break;
  }
}

// ─────────────────────────────────────────────
// EXPORTS (for use as a module)
// ─────────────────────────────────────────────

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    analyzeEmotion,
    NyxiaAvatarController,
    initNyxiaAvatar,
    sendMessageWithAvatar,
    handleSystemEvent
  };
}
