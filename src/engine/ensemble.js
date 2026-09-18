// ═══════════════════════════════════════════════════════
// ENSEMBLE ENGINE — Weighted aggregation of all 34 signals
// ═══════════════════════════════════════════════════════

import { STATE } from '../state.js';
import { clamp, mean, std, ema } from '../utils/math.js';
import { ALGORITHMS, HYPERPARAMS } from '../config.js';

/**
 * Performance-weighted ensemble aggregation.
 * Each algorithm's weight is proportional to its historical accuracy.
 */
export class EnsembleEngine {
  constructor() {
    this.weights = {};       // Performance-based weights per algo
    this.performances = {};  // Rolling performance tracking
    this.prevPredictions = {}; // For accuracy evaluation

    ALGORITHMS.forEach(a => {
      this.weights[a.id] = 1 / ALGORITHMS.length;
      this.performances[a.id] = { correct: 0, total: 0, recentReturns: [] };
    });
  }

  /**
   * Update ensemble with new signals from all algorithms
   * @param {Object} signals - { algoId: { signal, conf } }
   * @param {number} actualReturn - Realized return for evaluating past predictions
   */
  update(signals, actualReturn) {
    // Evaluate past predictions
    for (const [id, pred] of Object.entries(this.prevPredictions)) {
      const perf = this.performances[id];
      if (!perf) continue;

      const correct = (pred > 0 && actualReturn > 0) || (pred < 0 && actualReturn < 0);
      perf.total++;
      if (correct) perf.correct++;
      perf.recentReturns.push(pred * actualReturn); // Alignment score
      if (perf.recentReturns.length > 100) perf.recentReturns.shift();
    }

    // Update weights based on performance
    let totalWeight = 0;
    for (const a of ALGORITHMS) {
      const perf = this.performances[a.id];
      const sig = signals[a.id];
      if (!sig) continue;

      // Weight = accuracy * confidence * recency
      const accuracy = perf.total > 10 ? perf.correct / perf.total : 0.5;
      const avgAlignment = perf.recentReturns.length > 5
        ? mean(perf.recentReturns) * 10 + 0.5
        : 0.5;
      const conf = sig.conf || 0.5;

      this.weights[a.id] = clamp(accuracy * 0.4 + avgAlignment * 0.4 + conf * 0.2, 0.01, 1);
      totalWeight += this.weights[a.id];
    }

    // Normalize weights
    if (totalWeight > 0) {
      for (const id of Object.keys(this.weights)) {
        this.weights[id] /= totalWeight;
      }
    }

    // Compute weighted ensemble signal
    let ensemble = 0;
    for (const a of ALGORITHMS) {
      const sig = signals[a.id];
      if (!sig) continue;
      ensemble += this.weights[a.id] * sig.signal * sig.conf;
    }
    ensemble = clamp(ensemble * ALGORITHMS.length * 0.5, -1, 1);

    // Store predictions for next evaluation
    this.prevPredictions = {};
    for (const a of ALGORITHMS) {
      const sig = signals[a.id];
      if (sig) this.prevPredictions[a.id] = sig.signal;
    }

    // Update state
    STATE.ensemble = ensemble;
    STATE.ensembleHistory.push(ensemble);
    if (STATE.ensembleHistory.length > 200) STATE.ensembleHistory.shift();

    return ensemble;
  }

  /** Get weight for specific algorithm */
  getWeight(algoId) {
    return this.weights[algoId] || 0;
  }

  /** Get performance stats for algorithm */
  getPerformance(algoId) {
    return this.performances[algoId] || { correct: 0, total: 0 };
  }
}
