// ═════════════════════════════════════════════════════════════════════
// MARCOS LÓPEZ DE PRADO META-LABELING & TRIPLE-BARRIER SYSTEM
// Based on: "Advances in Financial Machine Learning" (2018)
// 1. Triple-Barrier Labeling: Upper TP Barrier, Lower SL Barrier, Vertical Time Horizon
// 2. Secondary Meta-Classifier: Predicts Probability of Primary Signal Success
// 3. Bet-Sizing Multiplier: Scales Position Size by Meta-Confidence
// ═════════════════════════════════════════════════════════════════════

import { clamp, mean, std, sigmoid } from '../utils/math.js';

export class TripleBarrierMethod {
  /**
   * Apply Triple-Barrier Labeling to a historical or live trade path
   * @param {number} entryPrice Entry price
   * @param {Array<number>} pricePath Subsequent price path
   * @param {number} ptMultiplier Profit-take barrier multiplier (e.g. 2.0x sigma)
   * @param {number} slMultiplier Stop-loss barrier multiplier (e.g. 1.5x sigma)
   * @param {number} sigma Volatility (dollar or percentage)
   * @param {number} maxHorizon Maximum time steps (vertical barrier)
   * @param {number} direction Trade direction (+1 buy, -1 sell)
   */
  static labelEvent(entryPrice, pricePath, ptMultiplier, slMultiplier, sigma, maxHorizon = 20, direction = 1) {
    if (!pricePath || pricePath.length === 0) return { label: 0, barrierHit: 'NONE', exitPrice: entryPrice, returnPct: 0 };

    const upperBarrier = direction > 0
      ? entryPrice + ptMultiplier * sigma
      : entryPrice + slMultiplier * sigma;

    const lowerBarrier = direction > 0
      ? entryPrice - slMultiplier * sigma
      : entryPrice - ptMultiplier * sigma;

    const limitSteps = Math.min(maxHorizon, pricePath.length);

    for (let t = 0; t < limitSteps; t++) {
      const p = pricePath[t];

      if (direction > 0) {
        // Long position
        if (p >= upperBarrier) {
          return { label: 1, barrierHit: 'PROFIT_TAKE', exitPrice: p, steps: t + 1, returnPct: (p - entryPrice) / entryPrice };
        }
        if (p <= lowerBarrier) {
          return { label: 0, barrierHit: 'STOP_LOSS', exitPrice: p, steps: t + 1, returnPct: (p - entryPrice) / entryPrice };
        }
      } else {
        // Short position
        if (p <= lowerBarrier) {
          return { label: 1, barrierHit: 'PROFIT_TAKE', exitPrice: p, steps: t + 1, returnPct: (entryPrice - p) / entryPrice };
        }
        if (p >= upperBarrier) {
          return { label: 0, barrierHit: 'STOP_LOSS', exitPrice: p, steps: t + 1, returnPct: (entryPrice - p) / entryPrice };
        }
      }
    }

    // Vertical barrier touched (time expired)
    const finalPrice = pricePath[limitSteps - 1];
    const netRet = direction > 0 ? (finalPrice - entryPrice) / entryPrice : (entryPrice - finalPrice) / entryPrice;
    return {
      label: netRet > 0 ? 1 : 0,
      barrierHit: 'VERTICAL_TIME_LIMIT',
      exitPrice: finalPrice,
      steps: limitSteps,
      returnPct: netRet,
    };
  }
}

/**
 * Secondary Meta-Classifier:
 * Estimates the probability that the primary model's recommendation will result in a win.
 * Prevents false positives and controls bet size.
 */
export class MetaLabelingEngine {
  constructor() {
    this.tradeHistory = []; // Buffer of { primarySignal, features, label (1 or 0) }
    // Feature weights for logistic meta-classifier
    // Features: [primaryConfidence, volatility, ofi, trendStrength, spreadBps]
    this.weights = new Float64Array([1.2, -0.8, 0.9, 1.1, -0.5]);
    this.bias = 0.2;
    this.totalEvaluated = 0;
    this.precisionScore = 0.72;
  }

  /**
   * Evaluate a prospective trade recommendation
   * @param {number} primaryDirection +1 (BUY) or -1 (SELL)
   * @param {number} primaryConfidence [0, 1]
   * @param {Object} marketContext { vol, ofi, trend, spreadBps }
   * @returns {{ metaApproved: boolean, winProbability: number, betSizeMultiplier: number }}
   */
  evaluateTrade(primaryDirection, primaryConfidence, marketContext = {}) {
    if (primaryDirection === 0) {
      return { metaApproved: false, winProbability: 0.5, betSizeMultiplier: 0, reason: 'HOLD' };
    }

    const c = primaryConfidence || 0.5;
    const vol = marketContext.vol || 0.25;
    const ofi = (marketContext.ofi || 0) * primaryDirection; // OFI aligned with direction
    const trend = (marketContext.trend || 0) * primaryDirection;
    const spread = marketContext.spreadBps || 1.0;

    // Standardized feature inputs
    const f0 = (c - 0.5) * 2;
    const f1 = (vol - 0.25) * 4;
    const f2 = ofi;
    const f3 = trend;
    const f4 = (spread - 1.0);

    const logit = this.bias +
      this.weights[0] * f0 +
      this.weights[1] * f1 +
      this.weights[2] * f2 +
      this.weights[3] * f3 +
      this.weights[4] * f4;

    const winProb = sigmoid(logit);

    // López de Prado bet sizing rule: size = 2 * P(win) - 1, clamped to [0, 1]
    const rawBetMultiplier = Math.max(0, 2.0 * winProb - 1.0);
    const metaApproved = winProb >= 0.55;

    return {
      metaApproved,
      winProbability: Math.round(winProb * 1000) / 1000,
      betSizeMultiplier: Math.round(rawBetMultiplier * 100) / 100,
      decisionReason: metaApproved
        ? `APPROVED (P(Win)=${(winProb * 100).toFixed(1)}%, Size Multiplier=${rawBetMultiplier.toFixed(2)})`
        : `VETOED (Low P(Win)=${(winProb * 100).toFixed(1)}% < 55%)`,
    };
  }

  recordTradeOutcome(features, outcomeLabel) {
    this.tradeHistory.push({ features, label: outcomeLabel });
    if (this.tradeHistory.length > 100) this.tradeHistory.shift();

    // Online gradient step
    const lr = 0.02;
    let logit = this.bias;
    for (let i = 0; i < 5; i++) logit += this.weights[i] * (features[i] || 0);
    const predProb = sigmoid(logit);
    const err = outcomeLabel - predProb;

    for (let i = 0; i < 5; i++) {
      this.weights[i] += lr * err * (features[i] || 0);
    }
    this.bias += lr * err;
    this.totalEvaluated++;
  }
}
