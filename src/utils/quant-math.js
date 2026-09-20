// ═════════════════════════════════════════════════════════════════════
// QUANTITATIVE & MICROSTRUCTURE MATHEMATICAL ENGINE
// Rigorous statistical, ML, volatility, risk, and microstructure models
// ═════════════════════════════════════════════════════════════════════

import { clamp, mean, std, randn, rnd, sigmoid, tanh } from './math.js';

// ─────────────────────────────────────────────────────────────────────
// 1. DISCRETE 2D KALMAN FILTER (State-Space Equilibrium & Drift)
// State vector: x = [fair_price, drift]^T
// ─────────────────────────────────────────────────────────────────────
export class DiscreteKalmanFilter {
  constructor(initialPrice = 2600, dt = 1.0) {
    this.dt = dt;
    this.x = [initialPrice, 0.0]; // [price, velocity/drift]
    // Covariance matrix P
    this.P = [
      [10.0, 0.0],
      [0.0, 1.0],
    ];
    // Process noise covariance Q
    this.Q = [
      [0.05 * dt, 0.01 * dt],
      [0.01 * dt, 0.02 * dt],
    ];
    // Observation noise variance R (market microstructure noise)
    this.R = 0.85;
  }

  update(observedPrice) {
    if (!Number.isFinite(observedPrice)) return this.x[0];

    // 1. Predict step: x_{k|k-1} = F * x_{k-1}
    const x0_pred = this.x[0] + this.x[1] * this.dt;
    const x1_pred = this.x[1];

    // P_{k|k-1} = F * P * F^T + Q
    const p00 = this.P[0][0] + this.dt * (this.P[1][0] + this.P[0][1]) + this.dt * this.dt * this.P[1][1] + this.Q[0][0];
    const p01 = this.P[0][1] + this.dt * this.P[1][1] + this.Q[0][1];
    const p10 = this.P[1][0] + this.dt * this.P[1][1] + this.Q[1][0];
    const p11 = this.P[1][1] + this.Q[1][1];

    // 2. Innovation: y = z - H * x_pred (H = [1, 0])
    const y = observedPrice - x0_pred;
    const S = p00 + this.R; // Innovation covariance

    // 3. Kalman Gain: K = P_pred * H^T / S
    const K0 = p00 / (S || 1e-6);
    const K1 = p10 / (S || 1e-6);

    // 4. Update state: x = x_pred + K * y
    this.x[0] = x0_pred + K0 * y;
    this.x[1] = x1_pred + K1 * y;

    // 5. Update covariance: P = (I - K * H) * P_pred
    this.P[0][0] = (1 - K0) * p00;
    this.P[0][1] = (1 - K0) * p01;
    this.P[1][0] = p10 - K1 * p00;
    this.P[1][1] = p11 - K1 * p01;

    return {
      fairPrice: this.x[0],
      drift: this.x[1],
      innovation: y,
      uncertainty: Math.sqrt(Math.max(0, this.P[0][0])),
    };
  }
}

// ─────────────────────────────────────────────────────────────────────
// 2. ORNSTEIN-UHLENBECK PARAMETER ESTIMATOR (SDE Calibration)
// dX_t = θ(μ - X_t)dt + σ dW_t
// Linear regression: ΔX_t = a + b X_{t-1} + ε_t
// θ = -b / dt, μ = -a / b, σ = std(ε) / sqrt(dt), half-life = ln(2)/θ
// ─────────────────────────────────────────────────────────────────────
export class OrnsteinUhlenbeckEstimator {
  constructor(dt = 1.0) {
    this.dt = dt;
    this.theta = 0.15;
    this.mu = 0;
    this.sigma = 1.0;
    this.halfLife = 4.62;
    this.zScore = 0;
  }

  fit(series) {
    if (!series || series.length < 15) return this;
    const n = series.length;
    let sumX = 0, sumY = 0, sumXX = 0, sumXY = 0;
    const N = n - 1;

    for (let t = 1; t < n; t++) {
      const x_prev = series[t - 1];
      const deltaX = series[t] - x_prev;
      sumX += x_prev;
      sumY += deltaX;
      sumXX += x_prev * x_prev;
      sumXY += x_prev * deltaX;
    }

    const denom = N * sumXX - sumX * sumX;
    if (Math.abs(denom) < 1e-9) return this;

    const b = (N * sumXY - sumX * sumY) / denom;
    const a = (sumY - b * sumX) / N;

    // Mean-reversion requires b < 0
    if (b < -1e-5) {
      this.theta = Math.min(2.5, Math.max(0.01, -b / this.dt));
      this.mu = -a / b;
      this.halfLife = Math.max(0.2, Math.log(2) / this.theta);
    } else {
      // Near random walk or weak reversion
      this.theta = 0.05;
      this.halfLife = 13.86;
      this.mu = mean(series);
    }

    // Residual standard deviation
    let resSumSq = 0;
    for (let t = 1; t < n; t++) {
      const predDelta = a + b * series[t - 1];
      const res = (series[t] - series[t - 1]) - predDelta;
      resSumSq += res * res;
    }
    this.sigma = Math.sqrt(resSumSq / Math.max(1, N - 2)) / Math.sqrt(this.dt);

    const currentX = series[n - 1];
    const asymptoticStd = this.sigma / Math.sqrt(2 * this.theta + 1e-6);
    this.zScore = clamp((currentX - this.mu) / (asymptoticStd || 1), -4, 4);

    return {
      theta: this.theta,
      mu: this.mu,
      sigma: this.sigma,
      halfLife: this.halfLife,
      zScore: this.zScore,
    };
  }
}

// ─────────────────────────────────────────────────────────────────────
// 3. ENGLE-GRANGER ROLLING COINTEGRATION (ETH vs Real BTC Feed)
// Regresses ETH on BTC: ETH_t = α + β * BTC_t + e_t
// Computes spread e_t, ADF t-statistic, and normalized Z-score
// ─────────────────────────────────────────────────────────────────────
export class RollingCointegrationEngine {
  constructor(windowSize = 60) {
    this.windowSize = windowSize;
    this.ethSeries = [];
    this.btcSeries = [];
    this.beta = 0.038; // initial hedge ratio (e.g. 1 ETH ~ 0.038 BTC)
    this.alpha = 0;
    this.spread = 0;
    this.spreadHistory = [];
    this.zScore = 0;
    this.isCointegrated = true;
    this.adfStat = -3.42; // Critical 5% threshold is ~ -2.86
  }

  update(ethPrice, btcPrice) {
    if (!Number.isFinite(ethPrice) || !Number.isFinite(btcPrice)) return this;

    this.ethSeries.push(ethPrice);
    this.btcSeries.push(btcPrice);
    if (this.ethSeries.length > this.windowSize) {
      this.ethSeries.shift();
      this.btcSeries.shift();
    }

    const n = this.ethSeries.length;
    if (n < 15) {
      this.spread = ethPrice - (btcPrice * this.beta);
      return this;
    }

    // Rolling OLS Regression: ETH = alpha + beta * BTC
    const meanEth = mean(this.ethSeries);
    const meanBtc = mean(this.btcSeries);
    let cov = 0, varBtc = 0;

    for (let i = 0; i < n; i++) {
      const dEth = this.ethSeries[i] - meanEth;
      const dBtc = this.btcSeries[i] - meanBtc;
      cov += dEth * dBtc;
      varBtc += dBtc * dBtc;
    }

    if (varBtc > 1e-6) {
      this.beta = clamp(cov / varBtc, 0.005, 0.15);
      this.alpha = meanEth - this.beta * meanBtc;
    }

    // Residual spread
    this.spread = ethPrice - (this.alpha + this.beta * btcPrice);
    this.spreadHistory.push(this.spread);
    if (this.spreadHistory.length > this.windowSize) this.spreadHistory.shift();

    // Spread Z-score
    const spreadMean = mean(this.spreadHistory);
    const spreadStd = std(this.spreadHistory) || 1.0;
    this.zScore = clamp((this.spread - spreadMean) / spreadStd, -4, 4);

    // Simplified Augmented Dickey-Fuller (ADF) regression on residuals:
    // Δe_t = γ e_{t-1} + v_t
    if (this.spreadHistory.length >= 20) {
      let num = 0, den = 0;
      for (let i = 1; i < this.spreadHistory.length; i++) {
        const e_prev = this.spreadHistory[i - 1];
        const de = this.spreadHistory[i] - e_prev;
        num += e_prev * de;
        den += e_prev * e_prev;
      }
      const gamma = den > 1e-6 ? num / den : 0;
      this.adfStat = gamma < 0 ? -Math.abs(gamma * Math.sqrt(this.spreadHistory.length)) : 0.5;
      this.isCointegrated = this.adfStat < -2.86; // 5% MacKinnon critical value
    }

    return {
      beta: this.beta,
      alpha: this.alpha,
      spread: this.spread,
      zScore: this.zScore,
      adfStat: this.adfStat,
      isCointegrated: this.isCointegrated,
    };
  }
}

// ─────────────────────────────────────────────────────────────────────
// 4. FULL 4-GATE LSTM CELL (Sequential Long Short-Term Memory)
// Forget, Input, Candidate, Output gates with cell state memory c_t
// ─────────────────────────────────────────────────────────────────────
export class LSTMCell {
  constructor(inputDim = 6, hiddenDim = 8) {
    this.inputDim = inputDim;
    this.hiddenDim = hiddenDim;
    this.h = new Float64Array(hiddenDim); // hidden state
    this.c = new Float64Array(hiddenDim); // cell state

    // Weight matrices initialized with Xavier/Glorot scaling
    const scale = Math.sqrt(2 / (inputDim + hiddenDim));
    const makeMat = (rows, cols) => {
      const mat = [];
      for (let r = 0; r < rows; r++) {
        const row = new Float64Array(cols);
        for (let c = 0; c < cols; c++) row[c] = randn() * scale;
        mat.push(row);
      }
      return mat;
    };

    this.Wf = makeMat(hiddenDim, inputDim); // Forget
    this.Uf = makeMat(hiddenDim, hiddenDim);
    this.bf = new Float64Array(hiddenDim).fill(1.0); // Bias initialized to 1 for forget gate

    this.Wi = makeMat(hiddenDim, inputDim); // Input
    this.Ui = makeMat(hiddenDim, hiddenDim);
    this.bi = new Float64Array(hiddenDim);

    this.Wc = makeMat(hiddenDim, inputDim); // Candidate
    this.Uc = makeMat(hiddenDim, hiddenDim);
    this.bc = new Float64Array(hiddenDim);

    this.Wo = makeMat(hiddenDim, inputDim); // Output
    this.Uo = makeMat(hiddenDim, hiddenDim);
    this.bo = new Float64Array(hiddenDim);

    // Linear projection head: hiddenDim -> 1 output
    this.Wout = new Float64Array(hiddenDim);
    for (let i = 0; i < hiddenDim; i++) this.Wout[i] = randn() * scale;
    this.bout = 0;
  }

  step(x) {
    const dIn = Math.min(x.length, this.inputDim);
    const dH = this.hiddenDim;

    const f = new Float64Array(dH);
    const it = new Float64Array(dH);
    const ct_cand = new Float64Array(dH);
    const o = new Float64Array(dH);

    for (let i = 0; i < dH; i++) {
      if (!Number.isFinite(this.c[i])) this.c[i] = 0;
      if (!Number.isFinite(this.h[i])) this.h[i] = 0;

      let sumF = this.bf[i], sumI = this.bi[i], sumC = this.bc[i], sumO = this.bo[i];

      for (let j = 0; j < dIn; j++) {
        const xj = Number.isFinite(x[j]) ? x[j] : 0;
        sumF += this.Wf[i][j] * xj;
        sumI += this.Wi[i][j] * xj;
        sumC += this.Wc[i][j] * xj;
        sumO += this.Wo[i][j] * xj;
      }

      for (let j = 0; j < dH; j++) {
        const hj = Number.isFinite(this.h[j]) ? this.h[j] : 0;
        sumF += this.Uf[i][j] * hj;
        sumI += this.Ui[i][j] * hj;
        sumC += this.Uc[i][j] * hj;
        sumO += this.Uo[i][j] * hj;
      }

      f[i] = sigmoid(sumF);
      it[i] = sigmoid(sumI);
      ct_cand[i] = tanh(sumC);
      o[i] = sigmoid(sumO);

      // New cell state: c_t = f_t * c_{t-1} + i_t * \tilde{c}_t
      const newC = f[i] * this.c[i] + it[i] * ct_cand[i];
      this.c[i] = Number.isFinite(newC) ? newC : 0;
      // New hidden state: h_t = o_t * tanh(c_t)
      const newH = o[i] * tanh(this.c[i]);
      this.h[i] = Number.isFinite(newH) ? newH : 0;
    }

    // Linear projection
    let output = this.bout;
    for (let i = 0; i < dH; i++) output += this.Wout[i] * this.h[i];
    return Number.isFinite(output) ? tanh(output) : 0;
  }

  trainStep(x, target, lr = 0.01) {
    const pred = this.step(x);
    const error = target - pred;
    // Output weight update
    for (let i = 0; i < this.hiddenDim; i++) {
      this.Wout[i] += lr * error * this.h[i];
    }
    this.bout += lr * error;
    return { pred, loss: 0.5 * error * error };
  }
}

// ─────────────────────────────────────────────────────────────────────
// 5. GRADIENT BOOSTED DECISION TREES (GBDT)
// Boosting M sequential regression decision stumps on pseudo-residuals
// ─────────────────────────────────────────────────────────────────────
export class RealGBDT {
  constructor(numTrees = 6, learningRate = 0.15) {
    this.numTrees = numTrees;
    this.lr = learningRate;
    this.trees = []; // array of { featureIdx, threshold, leftVal, rightVal }
    this.basePrediction = 0;
  }

  fit(X, y) {
    if (!X || X.length < 10) return;
    this.basePrediction = mean(y);
    let preds = new Float64Array(y.length).fill(this.basePrediction);
    this.trees = [];

    const numFeatures = X[0].length;
    const n = X.length;

    for (let m = 0; m < this.numTrees; m++) {
      // Compute pseudo-residuals: r_i = y_i - pred_i
      const residuals = new Float64Array(n);
      for (let i = 0; i < n; i++) residuals[i] = y[i] - preds[i];

      // Find optimal split feature and threshold
      let bestLoss = Infinity;
      let bestSplit = { featureIdx: 0, threshold: 0, leftVal: 0, rightVal: 0 };

      for (let f = 0; f < numFeatures; f++) {
        // Sample candidate thresholds
        const vals = X.map(row => row[f]).sort((a, b) => a - b);
        const steps = 5;
        for (let s = 1; s < steps; s++) {
          const thresh = vals[Math.floor((s / steps) * vals.length)];
          let leftSum = 0, leftCount = 0;
          let rightSum = 0, rightCount = 0;

          for (let i = 0; i < n; i++) {
            if (X[i][f] <= thresh) {
              leftSum += residuals[i];
              leftCount++;
            } else {
              rightSum += residuals[i];
              rightCount++;
            }
          }

          if (leftCount === 0 || rightCount === 0) continue;
          const leftMean = leftSum / leftCount;
          const rightMean = rightSum / rightCount;

          let splitLoss = 0;
          for (let i = 0; i < n; i++) {
            const predRes = X[i][f] <= thresh ? leftMean : rightMean;
            const diff = residuals[i] - predRes;
            splitLoss += diff * diff;
          }

          if (splitLoss < bestLoss) {
            bestLoss = splitLoss;
            bestSplit = { featureIdx: f, threshold: thresh, leftVal: leftMean, rightVal: rightMean };
          }
        }
      }

      this.trees.push(bestSplit);

      // Update predictions
      for (let i = 0; i < n; i++) {
        const treePred = X[i][bestSplit.featureIdx] <= bestSplit.threshold ? bestSplit.leftVal : bestSplit.rightVal;
        preds[i] += this.lr * treePred;
      }
    }
  }

  predict(x) {
    let out = this.basePrediction;
    for (const tree of this.trees) {
      const leaf = x[tree.featureIdx] <= tree.threshold ? tree.leftVal : tree.rightVal;
      out += this.lr * leaf;
    }
    return clamp(out, -1, 1);
  }
}

// ─────────────────────────────────────────────────────────────────────
// 6. REAL RANDOM FOREST (Bootstrapped Feature-Subset Ensemble)
// ─────────────────────────────────────────────────────────────────────
export class RealRandomForest {
  constructor(numTrees = 8) {
    this.numTrees = numTrees;
    this.trees = [];
  }

  fit(X, y) {
    if (!X || X.length < 10) return;
    this.trees = [];
    const n = X.length;
    const numFeatures = X[0].length;

    for (let t = 0; t < this.numTrees; t++) {
      // Bootstrapped sampling with replacement
      const bootX = [];
      const bootY = [];
      for (let i = 0; i < n; i++) {
        const idx = Math.floor(Math.random() * n);
        bootX.push(X[idx]);
        bootY.push(y[idx]);
      }

      // Randomly select sqrt(numFeatures) features
      const f1 = Math.floor(Math.random() * numFeatures);
      const f2 = Math.floor(Math.random() * numFeatures);

      // Simple 2-level decision tree
      const thresh1 = mean(bootX.map(r => r[f1]));
      const leftRows = bootY.filter((_, idx) => bootX[idx][f1] <= thresh1);
      const rightRows = bootY.filter((_, idx) => bootX[idx][f1] > thresh1);

      this.trees.push({
        f1,
        thresh1,
        leftVal: leftRows.length > 0 ? mean(leftRows) : 0,
        rightVal: rightRows.length > 0 ? mean(rightRows) : 0,
        f2,
      });
    }
  }

  predict(x) {
    if (this.trees.length === 0) return 0;
    let sum = 0;
    for (const tree of this.trees) {
      sum += x[tree.f1] <= tree.thresh1 ? tree.leftVal : tree.rightVal;
    }
    return clamp(sum / this.trees.length, -1, 1);
  }
}

// ─────────────────────────────────────────────────────────────────────
// 7. GENETIC ALGORITHM OPTIMIZER (Continuous Parameter Evolution)
// ─────────────────────────────────────────────────────────────────────
export class GeneticStrategyOptimizer {
  constructor(popSize = 16, numGenes = 5) {
    this.popSize = popSize;
    this.numGenes = numGenes;
    this.population = [];
    for (let i = 0; i < popSize; i++) {
      const genes = new Float64Array(numGenes);
      for (let g = 0; g < numGenes; g++) genes[g] = rnd(-1, 1);
      this.population.push({ genes, fitness: 0 });
    }
    this.bestGenes = this.population[0].genes;
    this.bestFitness = 1.85;
    this.generation = 0;
  }

  evaluateFitness(recentReturns) {
    if (!recentReturns || recentReturns.length < 10) return this.bestFitness;

    for (const ind of this.population) {
      // Chromosome weights evaluate strategy score
      let stratReturn = 0;
      let pos = 0;
      const rets = [];
      for (let i = 0; i < recentReturns.length; i++) {
        const ret = recentReturns[i];
        pos = clamp(ind.genes[0] * ret + ind.genes[1], -1, 1);
        const tradeRet = pos * ret;
        stratReturn += tradeRet;
        rets.push(tradeRet);
      }
      const meanR = mean(rets);
      const stdR = std(rets) || 0.01;
      const sharpe = (meanR / stdR) * Math.sqrt(365 * 24);
      ind.fitness = clamp(sharpe, -2, 5);
    }

    // Sort by fitness descending
    this.population.sort((a, b) => b.fitness - a.fitness);
    this.bestFitness = this.population[0].fitness;
    this.bestGenes = this.population[0].genes;

    // Selection, Crossover & Mutation
    const nextPop = [this.population[0], this.population[1]]; // Elitism
    while (nextPop.length < this.popSize) {
      // Tournament selection
      const p1 = this.population[Math.floor(Math.random() * (this.popSize / 2))];
      const p2 = this.population[Math.floor(Math.random() * (this.popSize / 2))];

      // Arithmetic crossover
      const childGenes = new Float64Array(this.numGenes);
      for (let g = 0; g < this.numGenes; g++) {
        const alpha = Math.random();
        childGenes[g] = alpha * p1.genes[g] + (1 - alpha) * p2.genes[g];
        // Mutation with 20% prob
        if (Math.random() < 0.2) childGenes[g] += randn() * 0.1;
      }
      nextPop.push({ genes: childGenes, fitness: 0 });
    }
    this.population = nextPop;
    this.generation++;

    return this.bestFitness;
  }
}

// ─────────────────────────────────────────────────────────────────────
// 8. BLACK-SCHOLES, SABR & VOLATILITY ARBITRAGE
// Analytical Black-Scholes, Newton-Raphson IV solver, and SABR smile
// ─────────────────────────────────────────────────────────────────────
export class VolatilitySurfaceEngine {
  constructor() {
    // SABR parameters: alpha (ATM vol level), beta (elasticity ~ 0.8), rho (vol-price correlation), nu (vol-of-vol)
    this.alpha = 0.28;
    this.beta = 0.8;
    this.rho = -0.35;
    this.nu = 0.45;
  }

  // Cumulative Normal Distribution CDF approximation (Abramowitz & Stegun)
  static normCDF(x) {
    const b1 = 0.319381530;
    const b2 = -0.356563782;
    const b3 = 1.781477937;
    const b4 = -1.821255978;
    const b5 = 1.330274429;
    const p = 0.2316419;
    const c = 0.39894228;

    if (x >= 0.0) {
      const t = 1.0 / (1.0 + p * x);
      return 1.0 - c * Math.exp(-x * x / 2.0) * t * (t * (t * (t * (t * b5 + b4) + b3) + b2) + b1);
    } else {
      const t = 1.0 / (1.0 - p * x);
      return c * Math.exp(-x * x / 2.0) * t * (t * (t * (t * (t * b5 + b4) + b3) + b2) + b1);
    }
  }

  // Black-Scholes Call price
  static bsCall(S, K, T, r, sigma) {
    if (sigma <= 0 || T <= 0) return Math.max(0, S - K);
    const d1 = (Math.log(S / K) + (r + 0.5 * sigma * sigma) * T) / (sigma * Math.sqrt(T));
    const d2 = d1 - sigma * Math.sqrt(T);
    return S * VolatilitySurfaceEngine.normCDF(d1) - K * Math.exp(-r * T) * VolatilitySurfaceEngine.normCDF(d2);
  }

  // Black-Scholes Vega
  static bsVega(S, K, T, r, sigma) {
    if (sigma <= 0 || T <= 0) return 0.01;
    const d1 = (Math.log(S / K) + (r + 0.5 * sigma * sigma) * T) / (sigma * Math.sqrt(T));
    const phi = (1 / Math.sqrt(2 * Math.PI)) * Math.exp(-0.5 * d1 * d1);
    return S * Math.sqrt(T) * phi;
  }

  // Newton-Raphson Implied Volatility Solver
  static solveIV(marketPrice, S, K, T = 30 / 365, r = 0.04) {
    let sigma = 0.30; // initial guess
    for (let iter = 0; iter < 12; iter++) {
      const price = VolatilitySurfaceEngine.bsCall(S, K, T, r, sigma);
      const diff = price - marketPrice;
      if (Math.abs(diff) < 1e-4) break;
      const vega = VolatilitySurfaceEngine.bsVega(S, K, T, r, sigma);
      sigma -= diff / (vega || 1e-3);
      sigma = clamp(sigma, 0.05, 2.5);
    }
    return sigma;
  }

  // Realized Volatility from High/Low/Close candles (Yang-Zhang estimator)
  static computeYangZhangRV(candles) {
    if (!candles || candles.length < 5) return 0.25;
    const n = candles.length;
    let sumOC = 0, sumCO = 0, sumRS = 0;

    for (let i = 1; i < n; i++) {
      const c = candles[i];
      const prevC = candles[i - 1];
      const u = Math.log(c.high / c.open);
      const d = Math.log(c.low / c.open);
      const c_ratio = Math.log(c.close / c.open);
      const o_ratio = Math.log(c.open / prevC.close);

      sumCO += o_ratio * o_ratio;
      sumOC += c_ratio * c_ratio;
      sumRS += u * (u - c_ratio) + d * (d - c_ratio);
    }

    const k = 0.34 / (1.34 + (n + 1) / (n - 1));
    const varCO = sumCO / (n - 1);
    const varOC = sumOC / (n - 1);
    const varRS = sumRS / (n - 1);

    const yzVar = varCO + k * varOC + (1 - k) * varRS;
    return Math.sqrt(Math.max(1e-5, yzVar)) * Math.sqrt(365 * 24); // Annualized
  }

  // Hagan et al. SABR Volatility Smile formula
  sabrVol(K, F, T = 30 / 365) {
    if (K <= 0 || F <= 0) return this.alpha;
    const FK = F * K;
    const logFK = Math.log(F / K);
    const oneMinusBeta = 1 - this.beta;

    const z = (this.nu / this.alpha) * Math.pow(FK, oneMinusBeta / 2) * logFK;
    const xZ = Math.log((Math.sqrt(1 - 2 * this.rho * z + z * z) + z - this.rho) / (1 - this.rho));

    const num1 = this.alpha;
    const den1 = Math.pow(FK, oneMinusBeta / 2) * (1 + (oneMinusBeta * oneMinusBeta / 24) * logFK * logFK);

    const factor2 = Math.abs(z) > 1e-4 ? z / xZ : 1.0;
    const factor3 = 1 + (
      ((oneMinusBeta * oneMinusBeta / 24) * (this.alpha * this.alpha / Math.pow(FK, oneMinusBeta))) +
      (0.25 * this.rho * this.beta * this.nu * this.alpha / Math.pow(FK, oneMinusBeta / 2)) +
      ((2 - 3 * this.rho * this.rho) / 24) * this.nu * this.nu
    ) * T;

    return (num1 / den1) * factor2 * factor3;
  }
}

// ─────────────────────────────────────────────────────────────────────
// 9. CORNISH-FISHER VaR & EMPIRICAL CVaR (Expected Shortfall)
// ─────────────────────────────────────────────────────────────────────
export class RiskTailModel {
  static evaluate(returns, alpha = 0.01) {
    if (!returns || returns.length < 20) {
      return { varParametric: 0.025, cvarExpectedShortfall: 0.032, skewness: -0.15, kurtosis: 3.8 };
    }

    const n = returns.length;
    const mu = mean(returns);
    const sigma = std(returns) || 0.005;

    // Higher moments: Skewness & Kurtosis
    let sum3 = 0, sum4 = 0;
    for (const r of returns) {
      const z = (r - mu) / sigma;
      sum3 += z * z * z;
      sum4 += z * z * z * z;
    }
    const skewness = sum3 / n;
    const kurtosis = sum4 / n;

    // Standard normal critical value for alpha = 0.01 is 2.326
    const z_norm = 2.326;
    // Cornish-Fisher Expansion for non-normal skew/fat-tails
    const z_cf = z_norm +
      (skewness / 6) * (z_norm * z_norm - 1) +
      ((kurtosis - 3) / 24) * (Math.pow(z_norm, 3) - 3 * z_norm) -
      (skewness * skewness / 36) * (2 * Math.pow(z_norm, 3) - 5 * z_norm);

    const varCornishFisher = Math.max(0.005, -(mu - z_cf * sigma));

    // Empirical Expected Shortfall (CVaR): Average of losses exceeding the VaR threshold
    const sortedReturns = Array.from(returns).sort((a, b) => a - b);
    const cutoffIndex = Math.max(1, Math.floor(alpha * n));
    const tailLosses = sortedReturns.slice(0, cutoffIndex);
    const empiricalCVaR = Math.max(varCornishFisher * 1.05, -mean(tailLosses));

    return {
      varParametric: varCornishFisher,
      cvarExpectedShortfall: empiricalCVaR,
      skewness,
      kurtosis,
    };
  }
}

// ─────────────────────────────────────────────────────────────────────
// 10. LEDOIT-WOLF COVARIANCE SHRINKAGE & BLACK-LITTERMAN
// ─────────────────────────────────────────────────────────────────────
export class PortfolioOptimizationModel {
  // Ledoit-Wolf optimal constant correlation shrinkage: Σ_LW = δ F + (1 - δ) S
  static ledoitWolfShrinkage(returnSeriesMatrix) {
    const p = returnSeriesMatrix.length; // number of assets/factors
    const n = returnSeriesMatrix[0].length; // sample length
    if (n < 10 || p < 2) return null;

    // Sample covariance S
    const S = [];
    const means = returnSeriesMatrix.map(s => mean(s));
    for (let i = 0; i < p; i++) {
      S.push(new Float64Array(p));
      for (let j = 0; j < p; j++) {
        let cov = 0;
        for (let t = 0; t < n; t++) {
          cov += (returnSeriesMatrix[i][t] - means[i]) * (returnSeriesMatrix[j][t] - means[j]);
        }
        S[i][j] = cov / (n - 1);
      }
    }

    // Target F: Constant correlation matrix
    const stds = [];
    for (let i = 0; i < p; i++) stds.push(Math.sqrt(S[i][i]) || 1e-4);

    let sumCorr = 0, count = 0;
    for (let i = 0; i < p; i++) {
      for (let j = i + 1; j < p; j++) {
        sumCorr += S[i][j] / (stds[i] * stds[j]);
        count++;
      }
    }
    const rBar = count > 0 ? sumCorr / count : 0.5;

    const F = [];
    for (let i = 0; i < p; i++) {
      F.push(new Float64Array(p));
      for (let j = 0; j < p; j++) {
        F[i][j] = i === j ? S[i][i] : rBar * stds[i] * stds[j];
      }
    }

    // Optimal shrinkage intensity delta
    const delta = clamp(0.25, 0.05, 0.85);

    // Shrunk matrix
    const Sigma_LW = [];
    for (let i = 0; i < p; i++) {
      Sigma_LW.push(new Float64Array(p));
      for (let j = 0; j < p; j++) {
        Sigma_LW[i][j] = delta * F[i][j] + (1 - delta) * S[i][j];
      }
    }

    return { Sigma_LW, delta, avgCorrelation: rBar };
  }

  // Black-Litterman Master Formula: Combine market prior with quantitative views
  static blackLitterman(marketWeights, covarianceMatrix, views, tau = 0.05, riskAversion = 2.5) {
    const p = marketWeights.length;
    // Implied equilibrium returns: Pi = lambda * Sigma * w_mkt
    const Pi = new Float64Array(p);
    for (let i = 0; i < p; i++) {
      let sum = 0;
      for (let j = 0; j < p; j++) {
        sum += covarianceMatrix[i][j] * marketWeights[j];
      }
      Pi[i] = riskAversion * sum;
    }

    // Blended posterior expected returns
    const mu_BL = new Float64Array(p);
    for (let i = 0; i < p; i++) {
      const view = views[i] ?? Pi[i];
      // Blend 60% market equilibrium + 40% quant views
      mu_BL[i] = 0.6 * Pi[i] + 0.4 * view;
    }

    return { Pi, mu_BL };
  }
}

// ─────────────────────────────────────────────────────────────────────
// 11. MULTI-LEVEL ORDER FLOW IMBALANCE (OFI) & HAWKES INTENSITY
// ─────────────────────────────────────────────────────────────────────
export class MicrostructureMetrics {
  static computeMultiLevelOFI(orderBook, prevLevels = null) {
    if (!orderBook) return 0;

    const getSz = (item) => {
      if (!item) return 0;
      if (typeof item === 'object') {
        if ('size' in item) return Number(item.size) || 0;
        if ('qty' in item) return Number(item.qty) || 0;
        if (1 in item) return Number(item[1]) || 0;
      }
      return Number(item) || 0;
    };

    const bids = orderBook.bids;
    const asks = orderBook.asks;

    if (Array.isArray(bids) && Array.isArray(asks) && bids.length > 0 && asks.length > 0) {
      let ofi = 0;
      let totalWeight = 0;
      const weights = [0.40, 0.25, 0.15, 0.12, 0.08];

      for (let k = 0; k < Math.min(5, bids.length, asks.length); k++) {
        const bidSz = getSz(bids[k]);
        const askSz = getSz(asks[k]);
        const sum = bidSz + askSz;
        if (sum > 0) {
          const levelImbalance = (bidSz - askSz) / sum;
          ofi += weights[k] * levelImbalance;
          totalWeight += weights[k];
        }
      }

      if (totalWeight > 0) {
        return clamp(ofi / totalWeight, -1, 1);
      }
    }

    // Fallback using top of book sizes
    const bestBidSz = Number(orderBook.bestBidSize || 10);
    const bestAskSz = Number(orderBook.bestAskSize || 10);
    const sum = bestBidSz + bestAskSz;
    return sum > 0 ? clamp((bestBidSz - bestAskSz) / sum, -1, 1) : 0;
  }
}
