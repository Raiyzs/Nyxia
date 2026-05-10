'use strict';

/**
 * Serialises background Ollama inference calls to prevent pileup when multiple
 * setInterval timers fire LLM requests simultaneously.
 *
 * Priority levels:
 *   0 — critical  skip the queue (user-facing: classifyMessage, streaming helpers)
 *   1 — high      heartbeat interrupt, expression heartbeat (time-sensitive)
 *   2 — normal    think, other-model, self-model (background, tolerate short wait)
 *   3 — low       reflect, vision describe, memory drip, sleep phases (can drop)
 *
 * Items at the same priority are FIFO. Incoming items at priority >= 2 are dropped
 * when the queue already has maxDepth items at that tier, preventing unbounded growth.
 * Critical (0) items always run regardless of queue depth.
 *
 * Usage:
 *   const scheduler = require('./utils/ollama-scheduler');
 *   const result = await scheduler.enqueue(2, () => queryOllama(sys, user, opts), 'think');
 *   // result is null if the item was dropped
 */
class OllamaScheduler {
  constructor({ maxDepth = 3 } = {}) {
    this._queue    = [];    // { priority, fn, label, resolve, reject }[]
    this._running  = false;
    this._maxDepth = maxDepth;
  }

  /**
   * Schedule an async fn. Returns a Promise resolving to fn's result,
   * or null if the item was dropped due to queue depth.
   *
   * @param {0|1|2|3} priority
   * @param {() => Promise<any>} fn
   * @param {string} [label]  — for log output
   * @returns {Promise<any|null>}
   */
  enqueue(priority, fn, label = 'task') {
    return new Promise((resolve, reject) => {
      if (priority === 0) {
        // Critical — always runs, skip to front
        this._queue.unshift({ priority, fn, label, resolve, reject });
        this._tick();
        return;
      }

      // Drop if too many lower-or-equal-priority items already pending
      const pendingAtOrBelow = this._queue.filter(i => i.priority >= priority).length;
      if (pendingAtOrBelow >= this._maxDepth) {
        console.log(`[scheduler] drop ${label} (p=${priority} queue=${pendingAtOrBelow}/${this._maxDepth})`);
        resolve(null);
        return;
      }

      // Insert maintaining priority order (lower number = higher priority = earlier in queue)
      const insertAt = this._queue.findIndex(i => i.priority > priority);
      const item = { priority, fn, label, resolve, reject };
      if (insertAt === -1) this._queue.push(item);
      else this._queue.splice(insertAt, 0, item);

      this._tick();
    });
  }

  /** Pending count — useful for health checks. */
  get queueDepth() { return this._queue.length; }

  async _tick() {
    if (this._running || this._queue.length === 0) return;
    this._running = true;
    const { fn, label, resolve, reject } = this._queue.shift();
    try {
      resolve(await fn());
    } catch (e) {
      console.warn(`[scheduler] ${label} failed:`, e.message);
      reject(e);
    } finally {
      this._running = false;
      // setImmediate avoids stack overflow on long sequential queues
      setImmediate(() => this._tick());
    }
  }
}

// Singleton — all modules share one queue via require()
module.exports = new OllamaScheduler();
