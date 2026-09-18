// ═══════════════════════════════════════════════════════
// BASE ALGORITHM — Abstract base for all 34 RL algorithms
// ═══════════════════════════════════════════════════════

import { clamp } from '../utils/math.js';

/**
 * Every algorithm extends this base class.
 * Must implement: update(features, reward, done) and predict(features)
 */
export class BaseAlgorithm {
  constructor(id, config = {}) {
    this.id = id;
    this.config = config;
    this.signal = 0;       // [-1, 1] trading signal
    this.confidence = 0.5; // [0, 1] confidence
    this.metrics = {};     // Algorithm-specific metrics for display
    this.trainSteps = 0;
    this.lastAction = 1;   // HOLD
    this.lastFeatures = null;
    this.lastReward = 0;
  }

  /**
   * Update internal state with new observation
   * @param {Float64Array} features - 20-dim feature vector
   * @param {number} reward - reward from last action
   * @param {boolean} done - episode boundary
   */
  update(features, reward, done) {
    throw new Error('update() must be implemented');
  }

  /**
   * Predict action / signal from features
   * @param {Float64Array} features - 20-dim feature vector
   * @returns {{ signal: number, confidence: number, action: number }}
   */
  predict(features) {
    throw new Error('predict() must be implemented');
  }

  /**
   * Get current signal result (called by ensemble)
   */
  getSignal() {
    return {
      signal: clamp(this.signal, -1, 1),
      conf: clamp(this.confidence, 0, 1),
      direction: this.signal > 0.1 ? 1 : this.signal < -0.1 ? -1 : 0,
      metrics: { ...this.metrics },
    };
  }

  /**
   * Convenience: convert 3-action Q-values to signal in [-1, 1]
   * actions: 0=BUY, 1=HOLD, 2=SELL
   */
  qToSignal(qBuy, qHold, qSell) {
    // Softmax-weighted directional signal
    const maxQ = Math.max(qBuy, qHold, qSell);
    const expBuy = Math.exp((qBuy - maxQ) * 2);
    const expHold = Math.exp((qHold - maxQ) * 2);
    const expSell = Math.exp((qSell - maxQ) * 2);
    const total = expBuy + expHold + expSell;

    const pBuy = expBuy / total;
    const pHold = expHold / total;
    const pSell = expSell / total;

    // Signal = pBuy - pSell, scaled
    this.signal = clamp((pBuy - pSell) * 2, -1, 1);
    this.confidence = clamp(Math.max(pBuy, pHold, pSell) * 1.2, 0.3, 0.99);

    return this.signal;
  }
}
