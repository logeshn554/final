// ═════════════════════════════════════════════════════════════════════════════
// DYNAMIC MARKET MOVEMENT PREDICTION ENGINE
// Predicts HOW FAR the market can move from current price — NOT fixed % targets
//
// Core Components:
//   1. Historical Analog Finder — cosine-similarity search on feature snapshots
//   2. Quantile Regression Ensemble — predicts 10th/25th/50th/75th/90th percentiles
//   3. KDE Distribution Fitting — smooth probability density over future movement
//   4. MFE/MAE Distribution Estimator — per-direction expected max excursion
//   5. Dynamic Target Generator — converts distribution → actionable targets
//   6. Confidence Calculator — model agreement, analog quality, regime clarity
//
// NO fixed percentage TP. NO fixed ATR multiplier. NO hardcoded profit ratios.
// Targets emerge from the predicted distribution of future price movement.
// ═════════════════════════════════════════════════════════════════════════════

import { clamp, mean, std, percentile, cosineSim, randn } from '../utils/math.js';

// ─────────────────────────────────────────────────────────────────────────────
// HISTORICAL ANALOG DATABASE
// Stores feature snapshots + outcome measurements for similarity search
// ─────────────────────────────────────────────────────────────────────────────

class HistoricalAnalogDB {
  constructor(maxSize = 2000) {
    this.maxSize = maxSize;
    this.records = [];    // { features, regime, atr, price, outcome }
  }

  /** Store a completed observation with its measured outcome */
  store(snapshot) {
    this.records.push(snapshot);
    if (this.records.length > this.maxSize) this.records.shift();
  }

  /**
   * Find top-K most similar historical conditions using cosine similarity
   * on normalized feature vectors, optionally filtered by regime
   */
  findAnalogs(queryFeatures, regime = null, topK = 30) {
    if (this.records.length < 5) return [];

    const queryArr = Array.from(queryFeatures);
    const queryNorm = Math.sqrt(queryArr.reduce((s, v) => s + v * v, 0)) || 1;
    const normalizedQuery = queryArr.map(v => v / queryNorm);

    let candidates = this.records;
    // Prefer same-regime analogs but fallback to all if insufficient
    if (regime) {
      const regimeCandidates = candidates.filter(r => r.regime === regime);
      if (regimeCandidates.length >= 10) candidates = regimeCandidates;
    }

    const scored = candidates.map(rec => {
      const recArr = Array.from(rec.features);
      const recNorm = Math.sqrt(recArr.reduce((s, v) => s + v * v, 0)) || 1;
      const normalizedRec = recArr.map(v => v / recNorm);
      const similarity = cosineSim(normalizedQuery, normalizedRec);
      return { ...rec, similarity };
    });

    scored.sort((a, b) => b.similarity - a.similarity);
    return scored.slice(0, topK);
  }

  get size() { return this.records.length; }
}


// ─────────────────────────────────────────────────────────────────────────────
// QUANTILE PREDICTION MODEL
// Lightweight gradient-based quantile regression for movement prediction
// ─────────────────────────────────────────────────────────────────────────────

class QuantilePredictor {
  constructor(inputDim = 8, quantiles = [0.10, 0.25, 0.50, 0.75, 0.90]) {
    this.inputDim = inputDim;
    this.quantiles = quantiles;
    this.lr = 0.002;

    // Simple linear quantile regression weights (one set per quantile)
    this.weights = {};
    this.biases = {};
    for (const q of quantiles) {
      this.weights[q] = new Float64Array(inputDim);
      for (let i = 0; i < inputDim; i++) this.weights[q][i] = randn() * 0.05;
      this.biases[q] = 0;
    }

    this.trainCount = 0;
  }

  /** Predict quantiles of movement given feature vector */
  predict(features) {
    const result = {};
    for (const q of this.quantiles) {
      let pred = this.biases[q];
      for (let i = 0; i < Math.min(features.length, this.inputDim); i++) {
        pred += this.weights[q][i] * (features[i] || 0);
      }
      result[q] = pred;
    }
    return result;
  }

  /**
   * Train on a batch of (features, actualMovement) pairs using pinball loss
   * Pinball loss: L_q(y, f) = q*(y-f) if y>=f, else (1-q)*(f-y)
   */
  train(samples) {
    if (samples.length < 3) return;

    for (const { features, movement } of samples) {
      for (const q of this.quantiles) {
        let pred = this.biases[q];
        for (let i = 0; i < Math.min(features.length, this.inputDim); i++) {
          pred += this.weights[q][i] * (features[i] || 0);
        }

        const error = movement - pred;
        const gradient = error >= 0 ? q : -(1 - q);
        const scaledLR = this.lr / (1 + this.trainCount * 0.0001);

        this.biases[q] += scaledLR * gradient;
        for (let i = 0; i < Math.min(features.length, this.inputDim); i++) {
          this.weights[q][i] += scaledLR * gradient * (features[i] || 0);
          // L2 regularization
          this.weights[q][i] *= (1 - 0.0001);
        }
      }
    }
    this.trainCount++;
  }
}


// ─────────────────────────────────────────────────────────────────────────────
// KDE DISTRIBUTION ESTIMATOR
// Kernel Density Estimation for smooth movement probability distributions
// ─────────────────────────────────────────────────────────────────────────────

class KDEEstimator {
  /**
   * Fit a KDE to observed movements and evaluate at query points
   * Uses Gaussian kernel with Silverman's bandwidth
   */
  static estimate(movements, queryPoints) {
    if (movements.length < 3) {
      return queryPoints.map(() => 1 / queryPoints.length);
    }

    const n = movements.length;
    const sigma = std(movements) || 1;
    // Silverman's rule of thumb
    const h = 1.06 * sigma * Math.pow(n, -0.2);

    const densities = queryPoints.map(x => {
      let density = 0;
      for (const xi of movements) {
        const u = (x - xi) / h;
        density += Math.exp(-0.5 * u * u) / (h * Math.sqrt(2 * Math.PI));
      }
      return density / n;
    });

    // Normalize to sum to 1
    const total = densities.reduce((a, b) => a + b, 0) || 1;
    return densities.map(d => d / total);
  }
}


// ─────────────────────────────────────────────────────────────────────────────
// MFE/MAE DISTRIBUTION ESTIMATOR
// Maximum Favorable / Adverse Excursion from historical analogs
// ─────────────────────────────────────────────────────────────────────────────

class ExcursionEstimator {
  /**
   * Compute MFE and MAE distributions from historical analogs
   * @param {Array} analogs - historical analog records with outcome data
   * @param {number} direction - 1 for LONG, -1 for SHORT
   * @returns {{ mfe, mae, probReach }}
   */
  static estimate(analogs, direction = 1) {
    if (analogs.length < 3) {
      return {
        mfe: { mean: 0, median: 0, p75: 0, p90: 0 },
        mae: { mean: 0, median: 0, p75: 0, p90: 0 },
        probReach: [],
      };
    }

    const mfeValues = [];
    const maeValues = [];

    for (const a of analogs) {
      const outcome = a.outcome || {};
      if (direction > 0) {
        // LONG: MFE = max upside, MAE = max downside
        mfeValues.push(outcome.maxUp || 0);
        maeValues.push(Math.abs(outcome.maxDown || 0));
      } else {
        // SHORT: MFE = max downside profit, MAE = max upside adverse
        mfeValues.push(Math.abs(outcome.maxDown || 0));
        maeValues.push(outcome.maxUp || 0);
      }
    }

    const mfeSorted = [...mfeValues].sort((a, b) => a - b);
    const maeSorted = [...maeValues].sort((a, b) => a - b);

    // Probability of reaching various MFE levels
    const mfeMean = mean(mfeValues);
    const levels = [0.25, 0.5, 0.75, 1.0, 1.25, 1.5, 2.0].map(m => m * mfeMean);
    const probReach = levels.map(level => ({
      level,
      probability: mfeValues.filter(v => v >= level).length / mfeValues.length,
    }));

    return {
      mfe: {
        mean: mean(mfeValues),
        median: percentile(mfeValues, 50),
        p75: percentile(mfeValues, 75),
        p90: percentile(mfeValues, 90),
      },
      mae: {
        mean: mean(maeValues),
        median: percentile(maeValues, 50),
        p75: percentile(maeValues, 75),
        p90: percentile(maeValues, 90),
      },
      probReach,
    };
  }
}


// ═════════════════════════════════════════════════════════════════════════════
// MAIN ENGINE: MovementPredictionEngine
// ═════════════════════════════════════════════════════════════════════════════

export class MovementPredictionEngine {
  constructor() {
    this.name = 'Dynamic Movement Prediction Engine';
    this.version = '1.0.0';

    // Historical analog database
    this.analogDB = new HistoricalAnalogDB(2000);

    // Quantile predictors: one for upside movement, one for downside
    this.upsidePredictor = new QuantilePredictor(8);
    this.downsidePredictor = new QuantilePredictor(8);

    // Candle-based outcome tracker for building analog database
    this.pendingSnapshots = [];  // snapshots awaiting outcome measurement
    this.observationHorizon = 30; // ticks to wait before measuring outcome

    // Per-regime model performance tracking
    this.regimePerformance = {
      TRENDING:       { predErrors: [], mfeErrors: [], maeErrors: [], count: 0 },
      MEAN_REVERTING: { predErrors: [], mfeErrors: [], maeErrors: [], count: 0 },
      VOLATILE:       { predErrors: [], mfeErrors: [], maeErrors: [], count: 0 },
      COMPRESSION:    { predErrors: [], mfeErrors: [], maeErrors: [], count: 0 },
      BREAKOUT:       { predErrors: [], mfeErrors: [], maeErrors: [], count: 0 },
      UNKNOWN:        { predErrors: [], mfeErrors: [], maeErrors: [], count: 0 },
    };

    // Model weight per regime (adaptive)
    this.modelWeights = {
      TRENDING:       { analog: 0.35, quantile: 0.35, kde: 0.30 },
      MEAN_REVERTING: { analog: 0.40, quantile: 0.30, kde: 0.30 },
      VOLATILE:       { analog: 0.25, quantile: 0.35, kde: 0.40 },
      COMPRESSION:    { analog: 0.30, quantile: 0.40, kde: 0.30 },
      BREAKOUT:       { analog: 0.30, quantile: 0.40, kde: 0.30 },
      UNKNOWN:        { analog: 0.33, quantile: 0.34, kde: 0.33 },
    };

    // Last prediction for feedback tracking
    this.lastPrediction = null;
    this.predictionCount = 0;
  }

  /**
   * Seed the analog database from REAL historical market candles
   * Derives actual conditional excursions (MFE/MAE) from genuine exchange price bars
   * @param {Array<Object>} candles Array of { timestamp, open, high, low, close, volume }
   */
  seedFromRealCandles(candles) {
    if (!Array.isArray(candles) || candles.length < 20) return;

    const windowSize = 10;
    for (let i = 0; i < candles.length - windowSize; i++) {
      const baseCandle = candles[i];
      let maxUp = 0;
      let maxDown = 0;

      for (let j = 1; j <= windowSize; j++) {
        const future = candles[i + j];
        const highDiff = future.high - baseCandle.close;
        const lowDiff = baseCandle.close - future.low;
        if (highDiff > maxUp) maxUp = highDiff;
        if (lowDiff > maxDown) maxDown = lowDiff;
      }

      const finalMove = candles[i + windowSize].close - baseCandle.close;
      const atrEst = Math.max(1.0, baseCandle.high - baseCandle.low);
      const direction = finalMove >= 0 ? 1 : -1;

      // Extract real normalized feature signature from candle geometry & momentum
      const features = new Float64Array(8);
      features[0] = clamp((baseCandle.close - baseCandle.open) / atrEst, -2, 2); // Body ratio
      features[1] = clamp((baseCandle.high - Math.max(baseCandle.open, baseCandle.close)) / atrEst, 0, 2); // Upper shadow
      features[2] = clamp((Math.min(baseCandle.open, baseCandle.close) - baseCandle.low) / atrEst, 0, 2); // Lower shadow
      features[3] = clamp(finalMove / atrEst, -3, 3); // Momentum

      const regime = maxUp + maxDown > atrEst * 4 ? 'VOLATILE' :
                     Math.abs(finalMove) > atrEst * 2 ? 'TRENDING' :
                     'MEAN_REVERTING';

      this.analogDB.store({
        features,
        regime,
        atr: atrEst,
        price: baseCandle.close,
        direction,
        outcome: {
          maxUp: Math.round(maxUp * 100) / 100,
          maxDown: Math.round(maxDown * 100) / 100,
          netMove: Math.round(finalMove * 100) / 100,
          finalMove: Math.round(finalMove * 100) / 100,
        },
      });
    }

    // Train quantile predictors on real candle excursion samples
    if (this.analogDB.records.length >= 10) {
      const upSamples = this.analogDB.records.map(r => ({
        features: Array.from(r.features),
        movement: r.outcome.maxUp,
      }));
      this.upsidePredictor.train(upSamples);

      const downSamples = this.analogDB.records.map(r => ({
        features: Array.from(r.features),
        movement: r.outcome.maxDown,
      }));
      this.downsidePredictor.train(downSamples);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // MAIN PREDICT — Called every tick with full market context
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Predict how far the market can move from current price
   *
   * @param {Object} context
   *   - price: current price
   *   - prices: historical price array
   *   - features: 20-dim feature vector from feature extraction
   *   - atr: current ATR value
   *   - regime: detected market regime string
   *   - ensemble: ensemble signal [-1, 1]
   *   - signals: per-algorithm signal map
   *   - rsi: current RSI
   *   - momentum: momentum score
   *   - volatilityScore: volatility layer score
   *   - microDirection: microstructure direction
   *   - regimeConfidence: HMM regime confidence
   *   - candlestickScore: candlestick pattern score
   *   - mtfConfluence: multi-timeframe confluence score
   *   - quantData: institutional quant data
   *
   * @returns {Object} Full prediction with distribution, targets, confidence
   */
  predict(context) {
    const {
      price = 2500,
      prices = [],
      features = new Float64Array(8),
      atr = 15,
      regime = 'UNKNOWN',
      ensemble = 0,
      signals = {},
      rsi = 50,
      momentum = 0,
      volatilityScore = 50,
      microDirection = 0,
      regimeConfidence = 50,
      candlestickScore = 0,
      mtfConfluence = 0,
      quantData = null,
    } = context;

    // ─── Build prediction feature vector (8-dim) ───
    const predFeatures = this._buildPredFeatures(context);

    // ─── 1. HISTORICAL ANALOG SEARCH ───
    const analogs = this.analogDB.findAnalogs(predFeatures, regime, 30);
    const analogMovements = analogs.map(a => a.outcome?.netMove || 0);
    const analogUpMoves = analogs.map(a => a.outcome?.maxUp || 0);
    const analogDownMoves = analogs.map(a => Math.abs(a.outcome?.maxDown || 0));
    const analogQuality = analogs.length > 0
      ? mean(analogs.map(a => a.similarity || 0))
      : 0;

    // ─── 2. QUANTILE REGRESSION PREDICTIONS ───
    const upsideQuantiles = this.upsidePredictor.predict(predFeatures);
    const downsideQuantiles = this.downsidePredictor.predict(predFeatures);

    // Scale by current volatility relative to average
    const volScale = atr > 0 ? clamp(atr / 15, 0.3, 3.0) : 1.0;

    // ─── 3. KDE DISTRIBUTION ───
    // Generate query points spanning the expected range
    const maxRange = atr * 4;
    const nPoints = 20;
    const upQueryPoints = [];
    const downQueryPoints = [];
    for (let i = 0; i < nPoints; i++) {
      upQueryPoints.push((i / nPoints) * maxRange);
      downQueryPoints.push((i / nPoints) * maxRange);
    }
    const upDensity = KDEEstimator.estimate(analogUpMoves, upQueryPoints);
    const downDensity = KDEEstimator.estimate(analogDownMoves, downQueryPoints);

    // ─── 4. MFE/MAE ESTIMATION ───
    const direction = this._determineDirection(ensemble, momentum, microDirection, candlestickScore, mtfConfluence);
    const excursion = ExcursionEstimator.estimate(analogs, direction);

    // ─── 5. ENSEMBLE THE THREE MODELS ───
    const weights = this.modelWeights[regime] || this.modelWeights.UNKNOWN;

    // Upside prediction (how far price can move favorably)
    const analogUpMedian = analogUpMoves.length > 0 ? percentile(analogUpMoves, 50) : atr * 1.5;
    const analogUp75 = analogUpMoves.length > 0 ? percentile(analogUpMoves, 75) : atr * 2;
    const analogUp25 = analogUpMoves.length > 0 ? percentile(analogUpMoves, 25) : atr * 0.8;

    const quantileUp50 = Math.abs(upsideQuantiles[0.50] || 0) * volScale;
    const quantileUp75 = Math.abs(upsideQuantiles[0.75] || 0) * volScale;
    const quantileUp25 = Math.abs(upsideQuantiles[0.25] || 0) * volScale;

    const kdeUp50 = this._kdePercentile(upQueryPoints, upDensity, 0.50);
    const kdeUp75 = this._kdePercentile(upQueryPoints, upDensity, 0.75);
    const kdeUp25 = this._kdePercentile(upQueryPoints, upDensity, 0.25);

    // Weighted ensemble for favorable movement
    const conservativeMove = Math.max(1,
      weights.analog * analogUp25 +
      weights.quantile * quantileUp25 +
      weights.kde * kdeUp25
    );
    const mainMove = Math.max(2,
      weights.analog * analogUpMedian +
      weights.quantile * quantileUp50 +
      weights.kde * kdeUp50
    );
    const extendedMove = Math.max(3,
      weights.analog * analogUp75 +
      weights.quantile * quantileUp75 +
      weights.kde * kdeUp75
    );

    // Downside prediction (adverse movement)
    const analogDownMedian = analogDownMoves.length > 0 ? percentile(analogDownMoves, 50) : atr;
    const analogDown75 = analogDownMoves.length > 0 ? percentile(analogDownMoves, 75) : atr * 1.5;
    const quantileDown50 = Math.abs(downsideQuantiles[0.50] || 0) * volScale;
    const quantileDown75 = Math.abs(downsideQuantiles[0.75] || 0) * volScale;
    const kdeDown50 = this._kdePercentile(downQueryPoints, downDensity, 0.50);
    const kdeDown75 = this._kdePercentile(downQueryPoints, downDensity, 0.75);

    const expectedAdverseMove = Math.max(1,
      weights.analog * analogDownMedian +
      weights.quantile * quantileDown50 +
      weights.kde * kdeDown50
    );
    const worstAdverseMove = Math.max(2,
      weights.analog * analogDown75 +
      weights.quantile * quantileDown75 +
      weights.kde * kdeDown75
    );

    // ─── 6. GENERATE DYNAMIC TARGETS ───
    const signal = direction > 0 ? 'BUY' : direction < 0 ? 'SELL' : 'HOLD';

    let conservativeTarget, mainTarget, extendedTarget;
    let adverseLow, adverseHigh;
    let invalidationLevel;

    if (direction >= 0) {
      // LONG targets
      conservativeTarget = Math.round((price + conservativeMove) * 100) / 100;
      mainTarget = Math.round((price + mainMove) * 100) / 100;
      extendedTarget = Math.round((price + extendedMove) * 100) / 100;
      adverseLow = Math.round((price - worstAdverseMove) * 100) / 100;
      adverseHigh = Math.round((price - expectedAdverseMove) * 100) / 100;
      invalidationLevel = Math.round((price - worstAdverseMove * 1.1) * 100) / 100;
    } else {
      // SHORT targets
      conservativeTarget = Math.round((price - conservativeMove) * 100) / 100;
      mainTarget = Math.round((price - mainMove) * 100) / 100;
      extendedTarget = Math.round((price - extendedMove) * 100) / 100;
      adverseLow = Math.round((price + expectedAdverseMove) * 100) / 100;
      adverseHigh = Math.round((price + worstAdverseMove) * 100) / 100;
      invalidationLevel = Math.round((price + worstAdverseMove * 1.1) * 100) / 100;
    }

    // ─── 7. PROBABILITY DISTRIBUTION ───
    const probabilityMap = this._buildProbabilityMap(
      price, direction, analogUpMoves, analogDownMoves,
      mainMove, conservativeMove, extendedMove, atr
    );

    // ─── 8. CONFIDENCE CALCULATION ───
    const confidence = this._calculateConfidence(
      analogs, analogQuality, regimeConfidence, volatilityScore,
      ensemble, conservativeMove, mainMove, extendedMove, direction
    );

    // ─── 9. MODEL AGREEMENT ───
    const modelAgreement = this._assessModelAgreement(
      analogUpMedian, quantileUp50, kdeUp50,
      analogDownMedian, quantileDown50, kdeDown50
    );

    // ─── 10. PREDICTION INTERVAL (uncertainty) ───
    const predictionInterval = {
      low: Math.round((direction >= 0
        ? price + conservativeMove * 0.6
        : price - extendedMove * 1.2) * 100) / 100,
      high: Math.round((direction >= 0
        ? price + extendedMove * 1.3
        : price - conservativeMove * 0.6) * 100) / 100,
    };

    // ─── BUILD FULL OUTPUT ───
    const prediction = {
      timestamp: Date.now(),
      predictionId: `PRED-${++this.predictionCount}`,

      // Signal
      signal,
      direction,
      currentPrice: price,

      // Predicted Movement
      predictedMovement: {
        conservativeMove: Math.round(conservativeMove * 100) / 100,
        mainMove: Math.round(mainMove * 100) / 100,
        extendedMove: Math.round(extendedMove * 100) / 100,
        conservativeTarget,
        mainTarget,
        extendedTarget,
      },

      // Probability Distribution
      probabilityMap,

      // Risk
      adverseMovement: {
        expected: Math.round(expectedAdverseMove * 100) / 100,
        worst: Math.round(worstAdverseMove * 100) / 100,
        rangeLow: adverseLow,
        rangeHigh: adverseHigh,
      },
      invalidationLevel,

      // Confidence
      confidence: Math.round(confidence),
      modelAgreement: Math.round(modelAgreement),

      // Prediction Interval
      predictionInterval,

      // Market Context
      regime,
      regimeConfidence: Math.round(regimeConfidence),
      atr: Math.round(atr * 100) / 100,

      // MFE/MAE from excursion analysis
      excursion,

      // Analog quality
      analogCount: analogs.length,
      analogQuality: Math.round(analogQuality * 100),

      // Risk/Reward
      riskRewardRatio: expectedAdverseMove > 0
        ? Math.round((mainMove / expectedAdverseMove) * 100) / 100
        : 0,

      // Reasons
      reasons: this._buildReasons(
        regime, direction, momentum, rsi, candlestickScore,
        mtfConfluence, analogQuality, analogs.length,
        conservativeMove, mainMove, extendedMove, atr, modelAgreement
      ),
    };

    // Store pending snapshot for outcome measurement
    this._recordPendingSnapshot(predFeatures, price, regime, direction, atr, prediction);

    this.lastPrediction = prediction;
    return prediction;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // OUTCOME RECORDING — Called every tick to measure past predictions
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Process pending snapshots: measure outcomes for expired snapshots
   * and train the quantile models on the new data
   */
  processOutcomes(currentPrice, prices, tick) {
    const now = tick || Date.now();
    const completedSnapshots = [];

    for (let i = this.pendingSnapshots.length - 1; i >= 0; i--) {
      const snap = this.pendingSnapshots[i];
      snap.ticksElapsed = (snap.ticksElapsed || 0) + 1;

      // Track max up and max down during observation window
      if (currentPrice > snap.entryPrice) {
        snap.maxUp = Math.max(snap.maxUp || 0, currentPrice - snap.entryPrice);
      }
      if (currentPrice < snap.entryPrice) {
        snap.maxDown = Math.min(snap.maxDown || 0, currentPrice - snap.entryPrice);
      }

      // Horizon reached: record outcome
      if (snap.ticksElapsed >= this.observationHorizon) {
        const outcome = {
          maxUp: snap.maxUp || 0,
          maxDown: snap.maxDown || 0,
          netMove: currentPrice - snap.entryPrice,
          finalMove: currentPrice - snap.entryPrice,
        };

        // Store in analog database
        this.analogDB.store({
          features: snap.features,
          regime: snap.regime,
          atr: snap.atr,
          price: snap.entryPrice,
          direction: snap.direction,
          outcome,
        });

        completedSnapshots.push({ ...snap, outcome });
        this.pendingSnapshots.splice(i, 1);
      }
    }

    // Retrain quantile predictors with completed data (batch update)
    if (completedSnapshots.length > 0) {
      const upSamples = completedSnapshots.map(s => ({
        features: Array.from(s.features),
        movement: s.outcome.maxUp,
      }));
      const downSamples = completedSnapshots.map(s => ({
        features: Array.from(s.features),
        movement: Math.abs(s.outcome.maxDown),
      }));

      this.upsidePredictor.train(upSamples);
      this.downsidePredictor.train(downSamples);
    }

    return completedSnapshots;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // INTERNAL HELPERS
  // ═══════════════════════════════════════════════════════════════════════════

  /** Build 8-dimensional prediction feature vector */
  _buildPredFeatures(context) {
    const {
      features = new Float64Array(20),
      atr = 15,
      rsi = 50,
      momentum = 0,
      ensemble = 0,
      candlestickScore = 0,
      mtfConfluence = 0,
      volatilityScore = 50,
    } = context;

    return new Float64Array([
      (features[0] || 0),            // 1-bar return
      (features[4] || 0),            // volatility
      (rsi - 50) / 50,               // RSI normalized
      clamp(momentum / 100, -1, 1),  // momentum normalized
      clamp(ensemble, -1, 1),        // ensemble signal
      clamp(candlestickScore, -1, 1),// candlestick
      clamp(mtfConfluence, -1, 1),   // MTF confluence
      clamp(volatilityScore / 100, 0, 1), // vol score normalized
    ]);
  }

  /** Determine overall direction from multiple inputs */
  _determineDirection(ensemble, momentum, microDirection, candlestickScore, mtfConfluence) {
    const score = ensemble * 0.30 + (momentum / 100) * 0.25 +
      microDirection * 0.15 + candlestickScore * 0.15 + mtfConfluence * 0.15;
    if (score > 0.08) return 1;
    if (score < -0.08) return -1;
    return 0;
  }

  /** Extract percentile from KDE density */
  _kdePercentile(queryPoints, densities, targetPercentile) {
    if (queryPoints.length === 0) return 0;
    let cumulative = 0;
    for (let i = 0; i < queryPoints.length; i++) {
      cumulative += densities[i] || 0;
      if (cumulative >= targetPercentile) return queryPoints[i];
    }
    return queryPoints[queryPoints.length - 1];
  }

  /** Build probability map for reaching different price levels */
  _buildProbabilityMap(price, direction, upMoves, downMoves, mainMove, consMove, extMove, atr) {
    const levels = [];
    const reference = direction >= 0 ? upMoves : downMoves.map(d => Math.abs(d));
    const n = reference.length || 1;

    // Create meaningful price levels
    const distances = [consMove * 0.5, consMove, mainMove, extMove, extMove * 1.5];
    const labels = ['Near', 'Conservative', 'Main Target', 'Extended', 'Stretch'];

    for (let i = 0; i < distances.length; i++) {
      const dist = distances[i];
      const priceLevel = direction >= 0
        ? Math.round((price + dist) * 100) / 100
        : Math.round((price - dist) * 100) / 100;

      // Probability from analog data
      const reachCount = reference.filter(m => m >= dist).length;
      const prob = Math.round((reachCount / n) * 100);

      levels.push({
        label: labels[i],
        price: priceLevel,
        distance: Math.round(dist * 100) / 100,
        probability: clamp(prob, 1, 99),
      });
    }

    // Downside probability
    const adverseRef = direction >= 0 ? downMoves.map(d => Math.abs(d)) : upMoves;
    const adverseDistances = [atr * 0.5, atr, atr * 1.5];
    const adverseLabels = ['Minor Pullback', 'Moderate Adverse', 'Deep Adverse'];

    for (let i = 0; i < adverseDistances.length; i++) {
      const dist = adverseDistances[i];
      const priceLevel = direction >= 0
        ? Math.round((price - dist) * 100) / 100
        : Math.round((price + dist) * 100) / 100;

      const reachCount = adverseRef.filter(m => m >= dist).length;
      const prob = Math.round((reachCount / n) * 100);

      levels.push({
        label: adverseLabels[i],
        price: priceLevel,
        distance: Math.round(dist * 100) / 100,
        probability: clamp(prob, 1, 99),
        isAdverse: true,
      });
    }

    return levels;
  }

  /** Calculate overall prediction confidence */
  _calculateConfidence(analogs, analogQuality, regimeConfidence, volatilityScore,
    ensemble, consMove, mainMove, extMove, direction) {

    // 1. Analog match quality (0-25)
    const analogConf = clamp(analogQuality * 25, 0, 25);

    // 2. Regime clarity (0-20)
    const regimeConf = clamp(regimeConfidence * 0.2, 0, 20);

    // 3. Model consistency — how tight is the prediction range (0-20)
    const rangeRatio = extMove > 0 ? consMove / extMove : 0.5;
    const consistencyConf = clamp(rangeRatio * 25, 5, 20);

    // 4. Directional conviction (0-20)
    const convictionConf = clamp(Math.abs(ensemble) * 20, 0, 20);

    // 5. Analog database size bonus (0-15)
    const dbSizeConf = clamp(analogs.length / 30 * 15, 0, 15);

    return clamp(analogConf + regimeConf + consistencyConf + convictionConf + dbSizeConf, 10, 95);
  }

  /** Assess how well the three models agree */
  _assessModelAgreement(analogUp, quantileUp, kdeUp, analogDown, quantileDown, kdeDown) {
    const upValues = [analogUp, quantileUp, kdeUp].filter(v => v > 0);
    const downValues = [analogDown, quantileDown, kdeDown].filter(v => v > 0);

    if (upValues.length < 2) return 50;

    const upStdDev = std(upValues);
    const upMean = mean(upValues) || 1;
    const upCV = upStdDev / upMean; // coefficient of variation

    const downStdDev = std(downValues);
    const downMean = mean(downValues) || 1;
    const downCV = downStdDev / downMean;

    const avgCV = (upCV + downCV) / 2;
    // Lower CV = higher agreement
    return clamp(Math.round(100 - avgCV * 150), 10, 98);
  }

  /** Build human-readable reasoning for the prediction */
  _buildReasons(regime, direction, momentum, rsi, candlestickScore,
    mtfConfluence, analogQuality, analogCount,
    consMove, mainMove, extMove, atr, modelAgreement) {

    const reasons = [];

    // Direction reason
    if (direction > 0) {
      reasons.push(`Bullish bias from ensemble consensus (momentum: ${momentum}%, RSI: ${rsi?.toFixed?.(1) || rsi})`);
    } else if (direction < 0) {
      reasons.push(`Bearish bias from ensemble consensus (momentum: ${momentum}%, RSI: ${rsi?.toFixed?.(1) || rsi})`);
    } else {
      reasons.push('No clear directional bias — market is indecisive');
    }

    // Regime reason
    reasons.push(`${regime} regime detected — prediction models weighted for ${regime.toLowerCase()} conditions`);

    // Movement range reason
    reasons.push(`Historical analogs (${analogCount} matches, ${Math.round(analogQuality * 100)}% quality) show ${consMove.toFixed(1)}–${extMove.toFixed(1)} point favorable movement under similar conditions`);

    // Model agreement
    if (modelAgreement > 75) {
      reasons.push(`Strong model agreement (${modelAgreement}%) — analog, quantile, and KDE models converge`);
    } else if (modelAgreement > 50) {
      reasons.push(`Moderate model agreement (${modelAgreement}%) — some divergence between prediction methods`);
    } else {
      reasons.push(`Low model agreement (${modelAgreement}%) — prediction uncertainty is elevated`);
    }

    // Volatility context
    const moveToATR = mainMove / (atr || 1);
    if (moveToATR > 2) {
      reasons.push(`Predicted movement (${mainMove.toFixed(1)}pts) exceeds 2x ATR (${atr.toFixed(1)}) — extended move likely in current conditions`);
    } else if (moveToATR < 0.8) {
      reasons.push(`Predicted movement (${mainMove.toFixed(1)}pts) below 1x ATR — limited opportunity, consider reduced size`);
    }

    // Candlestick + MTF
    if (Math.abs(candlestickScore) > 0.3) {
      reasons.push(`Candlestick patterns ${candlestickScore > 0 ? 'support' : 'contradict'} the predicted direction`);
    }
    if (Math.abs(mtfConfluence) > 0.3) {
      reasons.push(`Multi-timeframe confluence ${mtfConfluence > 0 ? 'bullish' : 'bearish'} alignment detected`);
    }

    return reasons;
  }

  /** Record a pending snapshot for future outcome measurement */
  _recordPendingSnapshot(features, price, regime, direction, atr, prediction) {
    // Limit pending snapshots to avoid memory bloat (one every 5 ticks)
    if (this.pendingSnapshots.length > 0) {
      const lastSnap = this.pendingSnapshots[this.pendingSnapshots.length - 1];
      if ((lastSnap.ticksElapsed || 0) < 5) return;
    }

    this.pendingSnapshots.push({
      features: new Float64Array(features),
      entryPrice: price,
      regime,
      direction,
      atr,
      prediction,
      maxUp: 0,
      maxDown: 0,
      ticksElapsed: 0,
    });

    // Cap pending snapshots
    if (this.pendingSnapshots.length > 100) {
      this.pendingSnapshots.shift();
    }
  }

  /** Get current analog database size */
  getAnalogCount() {
    return this.analogDB.size;
  }

  /** Get per-regime model performance stats */
  getRegimePerformance() {
    return this.regimePerformance;
  }

  /** Get model weights */
  getModelWeights() {
    return this.modelWeights;
  }
}
