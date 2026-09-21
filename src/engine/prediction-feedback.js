// ═════════════════════════════════════════════════════════════════════════════
// PREDICTION FEEDBACK & FAILURE ANALYSIS ENGINE
// 
// Self-evaluating system that:
//   1. Tracks every prediction with its full market context snapshot
//   2. Compares predicted vs actual MFE/MAE/movement after each trade
//   3. Performs automatic failure analysis when predictions miss
//   4. Maintains historical failure-analysis memory
//   5. Adapts model weights through rolling regime-specific evaluation
//   6. Prevents overfitting through statistical significance testing
//
// Continuously answers: "Why did the prediction fail, and what should change?"
// ═════════════════════════════════════════════════════════════════════════════

import { clamp, mean, std, percentile } from '../utils/math.js';

// ─────────────────────────────────────────────────────────────────────────────
// FAILURE CATEGORIES — Taxonomy of prediction failure modes
// ─────────────────────────────────────────────────────────────────────────────

const FAILURE_CATEGORIES = {
  REGIME_MISIDENTIFICATION: {
    id: 'regime_mis',
    name: 'Regime Misidentification',
    desc: 'The detected regime did not match actual market behavior',
    component: 'regime_detection',
  },
  VOLATILITY_UNDERESTIMATE: {
    id: 'vol_under',
    name: 'Volatility Underestimated',
    desc: 'Actual price swings exceeded predicted volatility envelope',
    component: 'volatility_model',
  },
  VOLATILITY_OVERESTIMATE: {
    id: 'vol_over',
    name: 'Volatility Overestimated',
    desc: 'Market was calmer than predicted; targets too wide',
    component: 'volatility_model',
  },
  MOMENTUM_FAILURE: {
    id: 'mom_fail',
    name: 'Momentum Failure',
    desc: 'Directional momentum reversed before reaching predicted targets',
    component: 'momentum_model',
  },
  SR_VIOLATION: {
    id: 'sr_violation',
    name: 'Support/Resistance Violation',
    desc: 'Price broke through predicted support or resistance level unexpectedly',
    component: 'feature_engineering',
  },
  TIMING_ERROR: {
    id: 'timing',
    name: 'Entry Timing Error',
    desc: 'Prediction direction was correct but entry timing caused adverse excursion',
    component: 'entry_logic',
  },
  RANGE_TOO_WIDE: {
    id: 'range_wide',
    name: 'Predicted Range Too Wide',
    desc: 'Prediction interval was so wide that it lacked actionable value',
    component: 'prediction_model',
  },
  RANGE_TOO_NARROW: {
    id: 'range_narrow',
    name: 'Predicted Range Too Narrow',
    desc: 'Actual movement far exceeded the predicted range',
    component: 'prediction_model',
  },
  NOISE_AFFECTED: {
    id: 'noise',
    name: 'Signal Affected by Noise',
    desc: 'Prediction was dominated by transient noise rather than structural signal',
    component: 'feature_engineering',
  },
  DIRECTION_WRONG: {
    id: 'dir_wrong',
    name: 'Direction Incorrect',
    desc: 'The predicted direction was opposite to actual movement',
    component: 'prediction_model',
  },
  NORMAL_VARIANCE: {
    id: 'normal',
    name: 'Normal Statistical Variance',
    desc: 'Error within expected statistical noise — not a systematic failure',
    component: 'none',
  },
};


// ═════════════════════════════════════════════════════════════════════════════
// MAIN ENGINE: PredictionFeedbackEngine
// ═════════════════════════════════════════════════════════════════════════════

export class PredictionFeedbackEngine {
  constructor() {
    this.name = 'Prediction Feedback & Failure Analysis Engine';
    this.version = '1.0.0';

    // Completed prediction records with outcomes
    this.completedPredictions = [];   // { prediction, outcome, analysis }
    this.maxHistory = 500;

    // Failure analysis memory
    this.failureMemory = [];          // { prediction, conditions, expected, actual, error, cause, correction }
    this.maxFailureMemory = 200;

    // Per-regime evaluation tracking
    this.regimeStats = {
      TRENDING:       this._initRegimeStats(),
      MEAN_REVERTING: this._initRegimeStats(),
      VOLATILE:       this._initRegimeStats(),
      COMPRESSION:    this._initRegimeStats(),
      BREAKOUT:       this._initRegimeStats(),
      UNKNOWN:        this._initRegimeStats(),
    };

    // Walk-forward validation windows
    this.walkForwardWindow = 50;    // Evaluate over rolling windows of 50 predictions
    this.minSamplesForAdjustment = 20; // Need at least 20 samples before adjusting
    this.significanceThreshold = 0.15; // Error must exceed 15% to trigger adjustment
    this.weightAdjustments = [];
    this.healingEngine = null;

    // Summary statistics
    this.stats = {
      totalPredictions: 0,
      correctDirection: 0,
      totalMFEError: 0,
      totalMAEError: 0,
      avgConfidence: 0,
      calibrationScore: 0,
    };
  }

  _initRegimeStats() {
    return {
      predictions: 0,
      correctDirection: 0,
      mfeErrors: [],
      maeErrors: [],
      rangeErrors: [],
      avgPredictedMove: 0,
      avgActualMove: 0,
      confidenceCalibration: [],   // { predictedConf, wasCorrect }
      lastEvaluated: 0,
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // RECORD OUTCOME — Called when a prediction's observation window completes
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Record the actual outcome of a prediction and perform analysis
   *
   * @param {Object} prediction - The original prediction object
   * @param {Object} outcome - Measured outcome
   *   - actualMFE: actual maximum favorable excursion
   *   - actualMAE: actual maximum adverse excursion
   *   - actualFinalMove: net price change at end of observation window
   *   - exitPrice: price at evaluation time
   *   - maxPrice: highest price during window
   *   - minPrice: lowest price during window
   *
   * @returns {Object} Analysis result
   */
  recordOutcome(prediction, outcome) {
    if (!prediction || !outcome) return null;

    const analysis = this._analyzeOutcome(prediction, outcome);

    const record = {
      predictionId: prediction.predictionId,
      timestamp: Date.now(),
      prediction,
      outcome,
      analysis,
    };

    this.completedPredictions.push(record);
    if (this.completedPredictions.length > this.maxHistory) {
      this.completedPredictions.shift();
    }

    // Update regime stats
    this._updateRegimeStats(prediction, outcome, analysis);

    // Update global stats
    this._updateGlobalStats(prediction, outcome, analysis);

    // If failure is significant, add to failure memory & trigger autonomous healing
    if (analysis.isFailure) {
      this._recordFailure(prediction, outcome, analysis);
      if (this.healingEngine) {
        this.healingEngine.reportAlgorithmError({
          algoId: 0,
          algoName: 'Dynamic Movement Predictor',
          algoTag: 'DMP',
          action: prediction.direction > 0 ? 'BUY' : prediction.direction < 0 ? 'SELL' : 'HOLD',
          entryPrice: prediction.currentPrice || 0,
          exitPrice: outcome.exitPrice || ((prediction.currentPrice || 0) + (outcome.actualFinalMove || 0)),
          pnlUSD: outcome.actualFinalMove || 0,
          currentPrice: outcome.exitPrice || prediction.currentPrice,
          marketContext: {
            regime: prediction.regime,
            atr: prediction.atr,
            vpin: 0.20,
          },
        });
      }
    }

    this.stats.totalPredictions++;

    return analysis;
  }


  // ═══════════════════════════════════════════════════════════════════════════
  // OUTCOME ANALYSIS — Compare predicted vs actual
  // ═══════════════════════════════════════════════════════════════════════════

  _analyzeOutcome(prediction, outcome) {
    const pred = prediction.predictedMovement || {};
    const dir = prediction.direction || 0;

    // Actual excursions
    const actualMFE = outcome.actualMFE || 0;
    const actualMAE = outcome.actualMAE || 0;
    const actualFinalMove = outcome.actualFinalMove || 0;

    // Predicted values
    const predictedMainMove = pred.mainMove || 0;
    const predictedConservative = pred.conservativeMove || 0;
    const predictedExtended = pred.extendedMove || 0;
    const predictedAdverse = prediction.adverseMovement?.expected || 0;

    // ─── Direction Accuracy ───
    const directionCorrect = dir === 0
      ? true  // HOLD is never "wrong" per se
      : (dir > 0 && actualFinalMove > 0) || (dir < 0 && actualFinalMove < 0);

    // ─── MFE Error (how well we predicted the favorable excursion) ───
    const mfeError = predictedMainMove > 0
      ? (actualMFE - predictedMainMove) / predictedMainMove
      : 0;

    // ─── MAE Error (how well we predicted the adverse excursion) ───
    const maeError = predictedAdverse > 0
      ? (actualMAE - predictedAdverse) / predictedAdverse
      : 0;

    // ─── Range Accuracy ───
    // Did actual move fall within [conservative, extended]?
    const withinRange = actualMFE >= predictedConservative * 0.7 &&
      actualMFE <= predictedExtended * 1.3;

    // ─── Target Achievement ───
    const hitConservative = actualMFE >= predictedConservative;
    const hitMain = actualMFE >= predictedMainMove;
    const hitExtended = actualMFE >= predictedExtended;

    // ─── Confidence Calibration ───
    // A well-calibrated model: 70% confidence → 70% of predictions should be correct
    const wasSuccessful = directionCorrect && hitConservative;

    // ─── Failure Classification ───
    const isFailure = !directionCorrect || Math.abs(mfeError) > 0.4 || Math.abs(maeError) > 0.5;
    let failureCategory = null;
    let failureDetails = '';

    if (isFailure) {
      const classification = this._classifyFailure(
        prediction, outcome, directionCorrect, mfeError, maeError, withinRange
      );
      failureCategory = classification.category;
      failureDetails = classification.details;
    }

    return {
      directionCorrect,
      mfeError: Math.round(mfeError * 1000) / 1000,
      maeError: Math.round(maeError * 1000) / 1000,
      withinRange,
      hitConservative,
      hitMain,
      hitExtended,
      wasSuccessful,
      isFailure,
      failureCategory,
      failureDetails,
      actualMFE: Math.round(actualMFE * 100) / 100,
      actualMAE: Math.round(actualMAE * 100) / 100,
      actualFinalMove: Math.round(actualFinalMove * 100) / 100,
      predictedMainMove: Math.round(predictedMainMove * 100) / 100,
      predictedAdverse: Math.round(predictedAdverse * 100) / 100,
      predictionConfidence: prediction.confidence || 0,
    };
  }


  // ═══════════════════════════════════════════════════════════════════════════
  // FAILURE CLASSIFICATION — Root cause analysis
  // ═══════════════════════════════════════════════════════════════════════════

  _classifyFailure(prediction, outcome, directionCorrect, mfeError, maeError, withinRange) {
    const regime = prediction.regime || 'UNKNOWN';
    const atr = prediction.atr || 15;
    const actualMFE = outcome.actualMFE || 0;
    const actualMAE = outcome.actualMAE || 0;
    const confidence = prediction.confidence || 50;

    // Priority-ordered failure classification

    // 1. Direction completely wrong
    if (!directionCorrect && Math.abs(outcome.actualFinalMove || 0) > atr * 0.5) {
      return {
        category: FAILURE_CATEGORIES.DIRECTION_WRONG,
        details: `Predicted ${prediction.direction > 0 ? 'BUY' : 'SELL'} but price moved ${(outcome.actualFinalMove || 0).toFixed(2)} in opposite direction. Ensemble signal may have been stale or regime was misread.`,
      };
    }

    // 2. Regime misidentification
    if (actualMAE > atr * 2.5 && regime !== 'VOLATILE') {
      return {
        category: FAILURE_CATEGORIES.REGIME_MISIDENTIFICATION,
        details: `Detected ${regime} but actual volatility (MAE: ${actualMAE.toFixed(1)}) suggests VOLATILE regime. HMM transition probabilities may need recalibration.`,
      };
    }

    // 3. Volatility underestimated
    if (maeError > 0.5) {
      return {
        category: FAILURE_CATEGORIES.VOLATILITY_UNDERESTIMATE,
        details: `Predicted adverse move of ${prediction.adverseMovement?.expected?.toFixed(1) || '?'} but actual MAE was ${actualMAE.toFixed(1)} (${(maeError * 100).toFixed(0)}% larger). ATR may be lagging true volatility.`,
      };
    }

    // 4. Volatility overestimated
    if (mfeError < -0.5 && maeError < -0.3) {
      return {
        category: FAILURE_CATEGORIES.VOLATILITY_OVERESTIMATE,
        details: `Both MFE (${actualMFE.toFixed(1)}) and MAE (${actualMAE.toFixed(1)}) were smaller than predicted. Market was calmer than expected. Consider tightening prediction range.`,
      };
    }

    // 5. Momentum failure
    if (directionCorrect && mfeError < -0.4 && actualMFE < prediction.predictedMovement?.conservativeMove * 0.5) {
      return {
        category: FAILURE_CATEGORIES.MOMENTUM_FAILURE,
        details: `Direction was correct but momentum stalled early. MFE reached only ${actualMFE.toFixed(1)} vs conservative target of ${prediction.predictedMovement?.conservativeMove?.toFixed(1)}. Momentum may have faded or met resistance.`,
      };
    }

    // 6. Range too narrow
    if (!withinRange && actualMFE > prediction.predictedMovement?.extendedMove * 1.5) {
      return {
        category: FAILURE_CATEGORIES.RANGE_TOO_NARROW,
        details: `Actual MFE (${actualMFE.toFixed(1)}) far exceeded extended target (${prediction.predictedMovement?.extendedMove?.toFixed(1)}). Model underestimated potential movement magnitude.`,
      };
    }

    // 7. Timing error
    if (directionCorrect && actualMAE > atr * 1.5 && actualMFE > prediction.predictedMovement?.conservativeMove) {
      return {
        category: FAILURE_CATEGORIES.TIMING_ERROR,
        details: `Direction correct and target reached, but suffered ${actualMAE.toFixed(1)} adverse excursion first. Entry timing was suboptimal.`,
      };
    }

    // 8. Noise
    if (confidence < 45 && Math.abs(outcome.actualFinalMove || 0) < atr * 0.3) {
      return {
        category: FAILURE_CATEGORIES.NOISE_AFFECTED,
        details: `Low-confidence prediction (${confidence}%) with minimal actual movement (${(outcome.actualFinalMove || 0).toFixed(1)}). Signal was likely dominated by noise.`,
      };
    }

    // 9. Normal variance (error within expected bounds)
    return {
      category: FAILURE_CATEGORIES.NORMAL_VARIANCE,
      details: `Prediction error within normal statistical bounds. MFE error: ${(mfeError * 100).toFixed(0)}%, MAE error: ${(maeError * 100).toFixed(0)}%. No systematic issue detected.`,
    };
  }


  // ═══════════════════════════════════════════════════════════════════════════
  // FAILURE MEMORY — Persistent learning from mistakes
  // ═══════════════════════════════════════════════════════════════════════════

  _recordFailure(prediction, outcome, analysis) {
    // Don't record normal variance as failures
    if (analysis.failureCategory?.id === 'normal') return;

    const failureRecord = {
      timestamp: Date.now(),
      predictionId: prediction.predictionId,
      regime: prediction.regime,
      conditions: {
        price: prediction.currentPrice,
        atr: prediction.atr,
        confidence: prediction.confidence,
        modelAgreement: prediction.modelAgreement,
        direction: prediction.direction,
        regime: prediction.regime,
      },
      expected: {
        mainMove: prediction.predictedMovement?.mainMove,
        conservativeMove: prediction.predictedMovement?.conservativeMove,
        extendedMove: prediction.predictedMovement?.extendedMove,
        adverseMove: prediction.adverseMovement?.expected,
      },
      actual: {
        mfe: analysis.actualMFE,
        mae: analysis.actualMAE,
        finalMove: analysis.actualFinalMove,
      },
      error: {
        mfeError: analysis.mfeError,
        maeError: analysis.maeError,
        directionCorrect: analysis.directionCorrect,
      },
      cause: analysis.failureCategory,
      causeDetails: analysis.failureDetails,
      correction: this._determineCorrectionAction(analysis),
    };

    this.failureMemory.push(failureRecord);
    if (this.failureMemory.length > this.maxFailureMemory) {
      this.failureMemory.shift();
    }
  }

  /** Determine what corrective action the system should consider */
  _determineCorrectionAction(analysis) {
    if (!analysis.failureCategory) return 'None — within normal bounds';

    switch (analysis.failureCategory.id) {
      case 'regime_mis':
        return 'Increase HMM transition sensitivity; add Bollinger bandwidth as regime confirmation signal';
      case 'vol_under':
        return 'Apply 1.15x volatility scaling factor for next 10 predictions in this regime; increase ATR lookback period';
      case 'vol_over':
        return 'Reduce volatility scaling by 0.9x; tighten prediction interval; prefer KDE model which adapts faster';
      case 'mom_fail':
        return 'Require RSI + EMA stack alignment before high-confidence directional predictions; add momentum acceleration check';
      case 'sr_violation':
        return 'Incorporate swing high/low detection into analog matching features; weight recent S/R levels higher';
      case 'timing':
        return 'Add entry confirmation delay (wait for pullback to 50% of initial range); use limit entry instead of market';
      case 'range_wide':
        return 'Increase quantile predictor weight; reduce KDE bandwidth; require higher analog similarity threshold';
      case 'range_narrow':
        return 'Expand distribution tails; increase KDE bandwidth; apply breakout detection filter before capping range';
      case 'noise':
        return 'Increase minimum confidence threshold from 35% to 50% before issuing directional signals';
      case 'dir_wrong':
        return 'Re-examine ensemble weighting; check if contrarian model (mean-reversion) should have dominated';
      default:
        return 'Monitor — insufficient data for systematic correction';
    }
  }


  // ═══════════════════════════════════════════════════════════════════════════
  // REGIME STATS — Per-regime performance tracking
  // ═══════════════════════════════════════════════════════════════════════════

  _updateRegimeStats(prediction, outcome, analysis) {
    const regime = prediction.regime || 'UNKNOWN';
    const rs = this.regimeStats[regime] || this.regimeStats.UNKNOWN;

    rs.predictions++;
    if (analysis.directionCorrect) rs.correctDirection++;

    rs.mfeErrors.push(analysis.mfeError);
    rs.maeErrors.push(analysis.maeError);
    rs.rangeErrors.push(analysis.withinRange ? 0 : 1);

    if (rs.mfeErrors.length > 100) rs.mfeErrors.shift();
    if (rs.maeErrors.length > 100) rs.maeErrors.shift();
    if (rs.rangeErrors.length > 100) rs.rangeErrors.shift();

    rs.avgPredictedMove = mean([
      ...(rs.avgPredictedMove ? [rs.avgPredictedMove * (rs.predictions - 1)] : []),
      prediction.predictedMovement?.mainMove || 0,
    ].filter(v => v > 0)) || 0;

    rs.avgActualMove = mean([
      ...(rs.avgActualMove ? [rs.avgActualMove * (rs.predictions - 1)] : []),
      analysis.actualMFE,
    ].filter(v => v > 0)) || 0;

    rs.confidenceCalibration.push({
      predictedConf: prediction.confidence,
      wasCorrect: analysis.wasSuccessful,
    });
    if (rs.confidenceCalibration.length > 100) rs.confidenceCalibration.shift();
  }

  _updateGlobalStats(prediction, outcome, analysis) {
    if (analysis.directionCorrect) this.stats.correctDirection++;
    this.stats.totalMFEError += Math.abs(analysis.mfeError);
    this.stats.totalMAEError += Math.abs(analysis.maeError);

    const n = this.stats.totalPredictions + 1;
    this.stats.avgConfidence = ((this.stats.avgConfidence * (n - 1)) + (prediction.confidence || 0)) / n;

    // Calibration score: how close is average confidence to actual success rate?
    if (n > 10) {
      const successRate = (this.stats.correctDirection / n) * 100;
      this.stats.calibrationScore = Math.round(100 - Math.abs(successRate - this.stats.avgConfidence));
    }
  }


  // ═══════════════════════════════════════════════════════════════════════════
  // ADAPTIVE WEIGHT ADJUSTMENT — Walk-forward validated, overfitting-resistant
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Evaluate whether model weights should be adjusted for a given regime.
   * Only adjusts if:
   *   1. Enough samples exist (>= minSamplesForAdjustment)
   *   2. Error is statistically significant (> significanceThreshold)
   *   3. Error is consistent across the walk-forward window
   *
   * @returns {Object|null} Weight adjustment recommendation, or null if no change
   */
  evaluateAndAdjust(regime, currentWeights) {
    const rs = this.regimeStats[regime];
    if (!rs || rs.predictions < this.minSamplesForAdjustment) return null;

    // Use recent window for evaluation
    const recentMFE = rs.mfeErrors.slice(-this.walkForwardWindow);
    const recentMAE = rs.maeErrors.slice(-this.walkForwardWindow);

    if (recentMFE.length < this.minSamplesForAdjustment) return null;

    const avgMFEError = mean(recentMFE);
    const avgMAEError = mean(recentMAE);
    const mfeStd = std(recentMFE);
    const maeStd = std(recentMAE);

    // Statistical significance test: is the mean error significantly different from 0?
    // Using t-test approximation
    const n = recentMFE.length;
    const tStatMFE = Math.abs(avgMFEError) / (mfeStd / Math.sqrt(n) || 1);
    const tStatMAE = Math.abs(avgMAEError) / (maeStd / Math.sqrt(n) || 1);

    // Require t > 2 (approximately p < 0.05) AND error > threshold
    const mfeSignificant = tStatMFE > 2 && Math.abs(avgMFEError) > this.significanceThreshold;
    const maeSignificant = tStatMAE > 2 && Math.abs(avgMAEError) > this.significanceThreshold;

    if (!mfeSignificant && !maeSignificant) return null;

    // Determine adjustment direction
    const adjustment = { ...currentWeights };
    let reason = '';

    if (mfeSignificant && avgMFEError < 0) {
      // We're consistently overestimating favorable movement
      // Shift weight toward the model that's most conservative
      adjustment.analog = clamp(adjustment.analog + 0.05, 0.15, 0.55);
      adjustment.quantile = clamp(adjustment.quantile - 0.025, 0.15, 0.55);
      adjustment.kde = clamp(adjustment.kde - 0.025, 0.15, 0.55);
      reason = `MFE overestimated by ${(avgMFEError * 100).toFixed(0)}% (t=${tStatMFE.toFixed(1)}). Shifting weight to analog model.`;
    } else if (mfeSignificant && avgMFEError > 0) {
      // We're consistently underestimating favorable movement
      adjustment.quantile = clamp(adjustment.quantile + 0.05, 0.15, 0.55);
      adjustment.analog = clamp(adjustment.analog - 0.025, 0.15, 0.55);
      adjustment.kde = clamp(adjustment.kde - 0.025, 0.15, 0.55);
      reason = `MFE underestimated by ${(avgMFEError * 100).toFixed(0)}% (t=${tStatMFE.toFixed(1)}). Shifting weight to quantile model.`;
    }

    if (maeSignificant && avgMAEError > 0) {
      // We're underestimating adverse movement — increase risk awareness
      adjustment.kde = clamp(adjustment.kde + 0.03, 0.15, 0.55);
      reason += ` MAE underestimated by ${(avgMAEError * 100).toFixed(0)}%. Increasing KDE weight for better tail estimation.`;
    }

    // Normalize weights to sum to 1
    const total = adjustment.analog + adjustment.quantile + adjustment.kde;
    adjustment.analog /= total;
    adjustment.quantile /= total;
    adjustment.kde /= total;

    // Round
    adjustment.analog = Math.round(adjustment.analog * 100) / 100;
    adjustment.quantile = Math.round(adjustment.quantile * 100) / 100;
    adjustment.kde = Math.round(adjustment.kde * 100) / 100;

    this.weightAdjustments.push({
      timestamp: Date.now(),
      regime,
      oldWeights: { ...currentWeights },
      newWeights: { ...adjustment },
      reason: reason.trim(),
      sampleSize: n,
      avgMFEError: Math.round(avgMFEError * 1000) / 1000,
      avgMAEError: Math.round(avgMAEError * 1000) / 1000,
    });
    if (this.weightAdjustments.length > 50) this.weightAdjustments.shift();

    return { weights: adjustment, reason: reason.trim() };
  }


  // ═══════════════════════════════════════════════════════════════════════════
  // PUBLIC GETTERS — For UI rendering
  // ═══════════════════════════════════════════════════════════════════════════

  /** Get the most recent failure analysis report */
  getLatestFailureReport() {
    const recentFailures = this.failureMemory.slice(-10);
    if (recentFailures.length === 0) return null;

    // Count failure types
    const categoryCounts = {};
    for (const f of recentFailures) {
      const catName = f.cause?.name || 'Unknown';
      categoryCounts[catName] = (categoryCounts[catName] || 0) + 1;
    }

    // Most common failure
    const topCategory = Object.entries(categoryCounts)
      .sort((a, b) => b[1] - a[1])[0];

    return {
      recentFailures: recentFailures.slice(-5).reverse(),
      totalFailures: this.failureMemory.length,
      categoryCounts,
      topFailureType: topCategory ? topCategory[0] : 'None',
      topFailureCount: topCategory ? topCategory[1] : 0,
      latestCorrection: recentFailures[recentFailures.length - 1]?.correction || 'None',
    };
  }

  /** Get recent failures list for UI display */
  getRecentFailures(count = 5) {
    return this.failureMemory.slice(-count).reverse();
  }

  /** Get per-regime performance summary */
  getRegimeReport() {
    const report = {};
    for (const [regime, rs] of Object.entries(this.regimeStats)) {
      if (rs.predictions === 0) continue;
      report[regime] = {
        predictions: rs.predictions,
        directionAccuracy: rs.predictions > 0
          ? Math.round((rs.correctDirection / rs.predictions) * 100)
          : 0,
        avgMFEError: rs.mfeErrors.length > 0
          ? Math.round(mean(rs.mfeErrors) * 1000) / 1000
          : 0,
        avgMAEError: rs.maeErrors.length > 0
          ? Math.round(mean(rs.maeErrors) * 1000) / 1000
          : 0,
        rangeAccuracy: rs.rangeErrors.length > 0
          ? Math.round((1 - mean(rs.rangeErrors)) * 100)
          : 0,
      };
    }
    return report;
  }

  /** Get model weight adjustment history */
  getAdjustmentHistory() {
    return this.weightAdjustments.slice(-10).reverse();
  }

  /** Get overall stats */
  getStats() {
    return {
      ...this.stats,
      directionAccuracy: this.stats.totalPredictions > 0
        ? Math.round((this.stats.correctDirection / this.stats.totalPredictions) * 100)
        : 0,
      avgMFEError: this.stats.totalPredictions > 0
        ? Math.round((this.stats.totalMFEError / this.stats.totalPredictions) * 1000) / 1000
        : 0,
      avgMAEError: this.stats.totalPredictions > 0
        ? Math.round((this.stats.totalMAEError / this.stats.totalPredictions) * 1000) / 1000
        : 0,
      calibrationScore: this.stats.calibrationScore,
      failureMemorySize: this.failureMemory.length,
    };
  }

  /** Get recent completed predictions for UI display */
  getRecentPredictions(count = 5) {
    return this.completedPredictions.slice(-count).reverse();
  }

  /** Find past predictions with similar market conditions */
  findSimilarPastPredictions(regime, direction, confidence) {
    return this.completedPredictions
      .filter(r =>
        r.prediction.regime === regime &&
        r.prediction.direction === direction &&
        Math.abs((r.prediction.confidence || 0) - confidence) < 20
      )
      .slice(-5)
      .reverse();
  }
}
