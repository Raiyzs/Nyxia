'use strict';

/**
 * Nyxia Logger — Structured, persona-aligned logging.
 * Silences 'noisy spirits' unless DEBUG mode is active.
 */

const DEBUG = process.env.NYXIA_DEBUG === 'true';

const logger = {
  info: (tag, message, ...args) => {
    if (DEBUG) console.log(`[${tag}] ${message}`, ...args);
  },
  warn: (tag, message, ...args) => {
    console.warn(`[${tag}] WARN: ${message}`, ...args);
  },
  error: (tag, message, ...args) => {
    console.error(`[${tag}] ERROR: ${message}`, ...args);
  },
  persona: (message) => {
    if (DEBUG) console.log(`✦ ${message}`);
  }
};

module.exports = logger;
