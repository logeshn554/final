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
   * Get policy advantage / conviction for dynamic excursion sizing
   * Subclasses can override this with algorithm-specific mechanics
   * (e.g. Q-gap, GAE advantage, entropy, return-to-go, VaR quantile).
   */
  getPolicyAdvantage() {
    const intensity = Math.abs(this.signal);
    const conf = typeof this.confidence === 'number' ? this.confidence : 0.5;
    return clamp(intensity * 0.75 + conf * 0.5, 0.1, 1.5);
  }

  /**
   * Automatically detect and set dynamic TP (take profit) and SL (stop loss)
   * ZERO FIXED RATIO: derived organically from the RL policy's internal advantage/state,
   * live market volatility (ATR), and movement prediction distribution.
   */
  detectDynamicLevels(marketContext = {}) {
    const price = Number(marketContext.price || marketContext.currentPrice || 0);
    const atr = Number(marketContext.atr || (price > 0 ? price * 0.0068 : 15.0));
    const mp = marketContext.movementPrediction || marketContext.movementDistribution || null;
    const direction = this.signal > 0.05 ? 1 : this.signal < -0.05 ? -1 : 0;

    // Algorithm-specific conviction / advantage
    const conf = typeof this.confidence === 'number' ? this.confidence : 0.5;
    const policyAdvantage = typeof this.getPolicyAdvantage === 'function'
      ? this.getPolicyAdvantage()
      : (Math.abs(this.signal) * 0.75 + conf * 0.5);

    // Dynamic market baselines from distribution if available
    const baseFav = Number(mp?.predictedMovement?.mainMove || mp?.favorable?.[0]?.distance || 0);
    const baseAdv = Number(mp?.adverseMovement?.expected || mp?.adverse?.expected || 0);

    // Automatic TP & SL distance detection: NO FIXED RATIO!
    let tpDist;
    let slDist;

    if (baseFav > 0 && baseAdv > 0) {
      // Dynamic scaling according to policy conviction: higher advantage captures more of favorable distribution
      tpDist = Math.max(atr * 0.25, baseFav * (0.85 + Math.min(1.0, policyAdvantage) * 0.35));
      slDist = Math.max(atr * 0.15, baseAdv * (1.05 - Math.min(0.5, policyAdvantage * 0.3)));
    } else {
      tpDist = Math.max(atr * 0.25, atr * (0.75 + policyAdvantage * 0.45));
      slDist = Math.max(atr * 0.15, atr * (0.45 + (1 - conf) * 0.35));
    }

    tpDist = Math.round(tpDist * 100) / 100;
    slDist = Math.round(slDist * 100) / 100;

    let tpPrice = null;
    let slPrice = null;
    if (price > 0) {
      if (direction >= 0) {
        tpPrice = Math.round((price + tpDist) * 100) / 100;
        slPrice = Math.round((price - slDist) * 100) / 100;
      } else {
        tpPrice = Math.round((price - tpDist) * 100) / 100;
        slPrice = Math.round((price + slDist) * 100) / 100;
      }
    }

    return {
      tpDistance: tpDist,
      slDistance: slDist,
      tpPrice,
      slPrice,
      tp: tpPrice,
      sl: slPrice,
      takeProfit: tpPrice,
      stopLoss: slPrice,
      target: tpPrice,
      stop: slPrice,
      policyAdvantage: Math.round(policyAdvantage * 100) / 100,
    };
  }

  /**
   * Get current signal result (called by ensemble, paper trading, and strategy engines)
   * @param {Float64Array} [features] Optional features to evaluate dynamic policy
   * @param {Object} [marketContext] Live market context (price, atr, movementPrediction)
   */
  getSignal(features = null, marketContext = null) {
    if (features && typeof this.predict === 'function') {
      try {
        const pred = this.predict(features);
        if (pred && typeof pred.signal === 'number') {
          this.signal = pred.signal;
          if (typeof pred.confidence === 'number') this.confidence = pred.confidence;
        }
      } catch (e) {}
    }
    const base = {
      signal: clamp(this.signal, -1, 1),
      conf: clamp(this.confidence, 0, 1),
      direction: this.signal > 0.05 ? 1 : this.signal < -0.05 ? -1 : 0,
      metrics: { ...this.metrics },
    };

    if (marketContext) {
      const levels = this.detectDynamicLevels(marketContext);
      Object.assign(base, levels);
    }
    return base;
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

