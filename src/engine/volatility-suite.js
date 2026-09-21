// ═════════════════════════════════════════════════════════════════════
// VOLATILITY SUITE — RESEARCH-GRADE VOLATILITY MODELING STACK
// 1. Classical Realized: Parkinson, Garman-Klass, Rogers-Satchell, Yang-Zhang, Bipower Variation
// 2. Conditional Heteroskedasticity: GARCH(1,1), EGARCH (leverage), GJR-GARCH (asymmetric)
// 3. Heterogeneous Autoregression: HAR-RV (Corsi 2009 multiscale daily/weekly/monthly)
// 4. Volatility Strategy Signals: Implied vs Realized (VRP), Term-Structure & Vol Carry
// ═════════════════════════════════════════════════════════════════════

import { clamp, mean, std } from '../utils/math.js';

// ─────────────────────────────────────────────────────────────────────
// 1. CLASSICAL HIGH-FREQUENCY REALIZED VOLATILITY ESTIMATORS
// ─────────────────────────────────────────────────────────────────────
export class RealizedVolatilityEstimators {
  /**
   * Parkinson (1980) High-Low Extreme Value Volatility
   * σ² = (1 / (4 ln 2 * N)) * ∑ (ln(High_t / Low_t))²
   * ~5x more efficient than close-to-close estimator
   */
  static parkinson(candles) {
    if (!candles || candles.length < 2) return 0.20;
    const n = candles.length;
    let sumLogSq = 0;
    const invConst = 1.0 / (4.0 * Math.LN2);

    for (let i = 0; i < n; i++) {
      const h = Math.max(1e-4, candles[i].high || candles[i].h || candles[i].close);
      const l = Math.max(1e-4, candles[i].low || candles[i].l || candles[i].close);
      const ratio = Math.log(h / l);
      sumLogSq += ratio * ratio;
    }

    const variance = (invConst * sumLogSq) / n;
    return Math.sqrt(Math.max(1e-6, variance)) * Math.sqrt(365 * 24); // Annualized
  }

  /**
   * Garman-Klass (1980) OHLC Volatility
   * Incorporates Open, High, Low, Close. ~8x more efficient than close-to-close.
   */
  static garmanKlass(candles) {
    if (!candles || candles.length < 2) return 0.22;
    const n = candles.length;
    let sum = 0;
    const c1 = 0.5;
    const c2 = 2.0 * Math.LN2 - 1.0;

    for (let i = 0; i < n; i++) {
      const c = candles[i];
      const o = Math.max(1e-4, c.open || c.o || c.close);
      const h = Math.max(1e-4, c.high || c.h || c.close);
      const l = Math.max(1e-4, c.low || c.l || c.close);
      const cl = Math.max(1e-4, c.close || c.c);

      const logHL = Math.log(h / l);
      const logCO = Math.log(cl / o);
      sum += c1 * logHL * logHL - c2 * logCO * logCO;
    }

    const variance = Math.max(1e-6, sum / n);
    return Math.sqrt(variance) * Math.sqrt(365 * 24);
  }

  /**
   * Rogers-Satchell (1991) Volatility
   * Handles non-zero drift: invariant to continuous drift in asset prices.
   */
  static rogersSatchell(candles) {
    if (!candles || candles.length < 2) return 0.22;
    const n = candles.length;
    let sum = 0;

    for (let i = 0; i < n; i++) {
      const c = candles[i];
      const o = Math.max(1e-4, c.open || c.o || c.close);
      const h = Math.max(1e-4, c.high || c.h || c.close);
      const l = Math.max(1e-4, c.low || c.l || c.close);
      const cl = Math.max(1e-4, c.close || c.c);

      const logHO = Math.log(h / o);
      const logHC = Math.log(h / cl);
      const logLO = Math.log(l / o);
      const logLC = Math.log(l / cl);

      sum += logHO * logHC + logLO * logLC;
    }

    const variance = Math.max(1e-6, sum / n);
    return Math.sqrt(variance) * Math.sqrt(365 * 24);
  }

  /**
   * Yang-Zhang (2000) Minimum-Variance Unbiased Volatility
   * Independent of continuous drift and handles overnight opening jump gaps.
   */
  static yangZhang(candles) {
    if (!candles || candles.length < 4) return 0.25;
    const n = candles.length;
    let sumOvernight = 0;
    let sumOpenClose = 0;
    let sumRS = 0;

    for (let i = 1; i < n; i++) {
      const cur = candles[i];
      const prev = candles[i - 1];
      const o = Math.max(1e-4, cur.open || cur.o || cur.close);
      const h = Math.max(1e-4, cur.high || cur.h || cur.close);
      const l = Math.max(1e-4, cur.low || cur.l || cur.close);
      const cl = Math.max(1e-4, cur.close || cur.c);
      const prevCl = Math.max(1e-4, prev.close || prev.c);

      const logOvernight = Math.log(o / prevCl);
      const logOC = Math.log(cl / o);
      const logHO = Math.log(h / o);
      const logHC = Math.log(h / cl);
      const logLO = Math.log(l / o);
      const logLC = Math.log(l / cl);

      sumOvernight += logOvernight * logOvernight;
      sumOpenClose += logOC * logOC;
      sumRS += logHO * logHC + logLO * logLC;
    }

    const k = 0.34 / (1.34 + (n + 1) / (n - 1));
    const varOvernight = sumOvernight / (n - 1);
    const varOpenClose = sumOpenClose / (n - 1);
    const varRS = sumRS / (n - 1);

    const totalVar = varOvernight + k * varOpenClose + (1.0 - k) * varRS;
    return Math.sqrt(Math.max(1e-6, totalVar)) * Math.sqrt(365 * 24);
  }

  /**
   * Barndorff-Nielsen & Shephard (2004) Bipower Variation (BV)
   * Robust against jump discontinuities: BV converges to integrated variance without jump noise.
   */
  static bipowerVariation(returns) {
    if (!returns || returns.length < 3) return 0.20;
    const n = returns.length;
    let sum = 0;
    const c = Math.PI / 2.0; // asymptotic scaling factor

    for (let i = 1; i < n; i++) {
      sum += Math.abs(returns[i]) * Math.abs(returns[i - 1]);
    }

    const bv = (c * sum) / (n - 1);
    return Math.sqrt(Math.max(1e-6, bv)) * Math.sqrt(365 * 24);
  }
}

// ─────────────────────────────────────────────────────────────────────
// 2. CONDITIONAL VOLATILITY: GARCH(1,1), EGARCH, GJR-GARCH
// ─────────────────────────────────────────────────────────────────────

/**
 * Standard Bollerslev (1986) GARCH(1,1) Engine
 * σ²_t = ω + α * ε²_{t-1} + β * σ²_{t-1}
 * Unconditional variance: σ² = ω / (1 - α - β)
 */
export class GARCH11 {
  constructor(omega = 1e-5, alpha = 0.09, beta = 0.88) {
    this.omega = omega;
    this.alpha = alpha;
    this.beta = beta;
    this.currentVariance = omega / Math.max(0.01, 1.0 - alpha - beta);
    this.lastResidual = 0;
  }

  update(returnVal) {
    const eps = returnVal;
    const epsSq = eps * eps;
    // Recursive update: σ²_t = ω + α * ε²_{t-1} + β * σ²_{t-1}
    this.currentVariance = this.omega + this.alpha * epsSq + this.beta * this.currentVariance;
    this.currentVariance = clamp(this.currentVariance, 1e-7, 0.01);
    this.lastResidual = eps;
    return Math.sqrt(this.currentVariance) * Math.sqrt(365 * 24); // Annualized Vol
  }

  forecast(steps = 5) {
    // Analytical multi-step ahead variance forecast
    const persistence = this.alpha + this.beta;
    const longTermVar = this.omega / Math.max(1e-4, 1.0 - persistence);
    const forecasts = [];
    let curV = this.currentVariance;

    for (let k = 1; k <= steps; k++) {
      curV = longTermVar + Math.pow(persistence, k) * (this.currentVariance - longTermVar);
      forecasts.push(Math.sqrt(Math.max(1e-7, curV)) * Math.sqrt(365 * 24));
    }
    return forecasts;
  }
}

/**
 * Nelson (1991) EGARCH(1,1) (Exponential GARCH with Asymmetric Leverage)
 * ln(σ²_t) = ω + β * ln(σ²_{t-1}) + α * (|z_{t-1}| - √(2/π)) + γ * z_{t-1}
 * where z_{t-1} = ε_{t-1} / σ_{t-1} is the standardized residual.
 * If γ < 0, bad news generates higher volatility than good news (leverage effect).
 */
export class EGARCH {
  constructor(omega = -0.15, alpha = 0.12, beta = 0.94, gamma = -0.10) {
    this.omega = omega;
    this.alpha = alpha;
    this.beta = beta;
    this.gamma = gamma; // Asymmetry parameter
    this.logVariance = -8.0;
    this.lastZ = 0;
  }

  update(returnVal) {
    const sigma = Math.sqrt(Math.exp(this.logVariance));
    const z = returnVal / Math.max(1e-5, sigma);
    const sqrt2OverPi = 0.7978845608; // E[|z|] for standard normal

    // ln(σ²_t) = ω + β * ln(σ²_{t-1}) + α * (|z| - √(2/π)) + γ * z
    this.logVariance = this.omega +
      this.beta * this.logVariance +
      this.alpha * (Math.abs(z) - sqrt2OverPi) +
      this.gamma * z;

    this.logVariance = clamp(this.logVariance, -14.0, -3.0);
    this.lastZ = z;

    const condVol = Math.sqrt(Math.exp(this.logVariance)) * Math.sqrt(365 * 24);
    return {
      vol: condVol,
      standardizedResidual: z,
      leverageShock: this.gamma * z,
    };
  }
}

/**
 * Glosten, Jagannathan, and Runkle (1993) GJR-GARCH(1,1)
 * σ²_t = ω + (α + γ * I_{t-1}) * ε²_{t-1} + β * σ²_{t-1}
 * where I_{t-1} = 1 if ε_{t-1} < 0 (negative shock) else 0.
 */
export class GJRGARCH {
  constructor(omega = 1e-5, alpha = 0.05, beta = 0.85, gamma = 0.12) {
    this.omega = omega;
    this.alpha = alpha;
    this.beta = beta;
    this.gamma = gamma; // Leverage penalty for down-moves
    this.currentVariance = omega / Math.max(0.01, 1.0 - alpha - 0.5 * gamma - beta);
  }

  update(returnVal) {
    const eps = returnVal;
    const epsSq = eps * eps;
    const isNegative = eps < 0 ? 1.0 : 0.0;

    this.currentVariance = this.omega +
      (this.alpha + this.gamma * isNegative) * epsSq +
      this.beta * this.currentVariance;

    this.currentVariance = clamp(this.currentVariance, 1e-7, 0.01);
    return Math.sqrt(this.currentVariance) * Math.sqrt(365 * 24);
  }
}

// ─────────────────────────────────────────────────────────────────────
// 3. CORSI (2009) HAR-RV: HETEROGENEOUS AUTOREGRESSIVE REALIZED VOL
// Multiscale daily, weekly, and monthly realized volatility memory
// RV_{t+1d} = β₀ + β_d * RV_t^{(d)} + β_w * RV_t^{(w)} + β_m * RV_t^{(m)} + ε_t
// ─────────────────────────────────────────────────────────────────────
export class HARRVModel {
  constructor() {
    this.rvHistory = []; // Buffer of rolling hourly/daily RV measurements
    // Standard empirical weights for crypto/equities (Corsi 2009 / Bollerslev)
    this.beta0 = 0.02;
    this.betaD = 0.42; // Daily lag weight
    this.betaW = 0.35; // Weekly (5-day) lag weight
    this.betaM = 0.18; // Monthly (22-day) lag weight
    this.forecastRV = 0.30;
  }

  update(currentRealizedVol) {
    if (Number.isFinite(currentRealizedVol) && currentRealizedVol > 0) {
      this.rvHistory.push(currentRealizedVol);
      if (this.rvHistory.length > 60) this.rvHistory.shift();
    }

    const n = this.rvHistory.length;
    if (n < 5) return currentRealizedVol || 0.30;

    // Daily RV: RV_t^{(d)} = RV_t
    const rvD = this.rvHistory[n - 1];

    // Weekly RV: RV_t^{(w)} = (1/5) ∑_{i=0}^4 RV_{t-i}
    const wLen = Math.min(5, n);
    const rvW = mean(this.rvHistory.slice(n - wLen));

    // Monthly RV: RV_t^{(m)} = (1/22) ∑_{i=0}^{21} RV_{t-i}
    const mLen = Math.min(22, n);
    const rvM = mean(this.rvHistory.slice(n - mLen));

    // Corsi HAR-RV Forecast equation
    this.forecastRV = this.beta0 + this.betaD * rvD + this.betaW * rvW + this.betaM * rvM;
    return {
      forecastRV: Math.round(this.forecastRV * 1000) / 1000,
      rvDaily: Math.round(rvD * 1000) / 1000,
      rvWeekly: Math.round(rvW * 1000) / 1000,
      rvMonthly: Math.round(rvM * 1000) / 1000,
      trend: rvD > rvW ? 'EXPANDING' : 'COMPRESSING',
    };
  }
}

// ─────────────────────────────────────────────────────────────────────
// 4. VOLATILITY RISK PREMIUM (VRP) & VOLATILITY CARRY
// ─────────────────────────────────────────────────────────────────────
export class VolatilityRiskPremium {
  /**
   * Computes Volatility Risk Premium: VRP = IV - RV
   * Typically positive (volatility buyers pay insurance premium to option sellers).
   * High positive VRP favors short volatility/gamma harvesting; negative VRP favors long vol breakout.
   */
  static evaluate(impliedVol, realizedVol, historicalVRP = []) {
    const iv = Math.max(0.05, impliedVol || 0.35);
    const rv = Math.max(0.05, realizedVol || 0.28);
    const vrpSpread = iv - rv; // e.g. +0.07 (+7 vol pts)

    let vrpZ = 0;
    if (historicalVRP.length >= 10) {
      const m = mean(historicalVRP);
      const s = std(historicalVRP) || 0.02;
      vrpZ = clamp((vrpSpread - m) / s, -3.0, 3.0);
    } else {
      vrpZ = clamp((vrpSpread - 0.04) / 0.03, -3.0, 3.0);
    }

    let strategyBias = 'NEUTRAL';
    if (vrpZ > 1.2) {
      strategyBias = 'HARVEST_VOL_PREMIUM'; // Selling overpriced volatility
    } else if (vrpZ < -1.0) {
      strategyBias = 'LONG_VOL_BREAKOUT'; // Cheap options / volatility expansion imminent
    }

    return {
      impliedVol: Math.round(iv * 1000) / 1000,
      realizedVol: Math.round(rv * 1000) / 1000,
      vrpSpread: Math.round(vrpSpread * 1000) / 1000,
      vrpZScore: Math.round(vrpZ * 100) / 100,
      strategyBias,
    };
  }
}

// ─────────────────────────────────────────────────────────────────────
// 5. MASTER INTEGRATED VOLATILITY SUITE
// ─────────────────────────────────────────────────────────────────────
export class VolatilityMasterSuite {
  constructor() {
    this.garch = new GARCH11();
    this.egarch = new EGARCH();
    this.gjr = new GJRGARCH();
    this.har = new HARRVModel();
    this.vrpHistory = [];
    this.latestMetrics = null;
  }

  update(candles, currentPrice, impliedVol = null) {
    if (!candles || candles.length < 5) return this.getDefault();

    // 1. Compute Classical High-Frequency Estimators
    const parkinson = RealizedVolatilityEstimators.parkinson(candles);
    const garmanKlass = RealizedVolatilityEstimators.garmanKlass(candles);
    const rogersSatchell = RealizedVolatilityEstimators.rogersSatchell(candles);
    const yangZhang = RealizedVolatilityEstimators.yangZhang(candles);

    // Close-to-close returns
    const returns = [];
    for (let i = 1; i < candles.length; i++) {
      const p1 = candles[i].close || candles[i].c;
      const p0 = candles[i - 1].close || candles[i - 1].c;
      if (p0 > 0) returns.push(Math.log(p1 / p0));
    }
    const bipower = RealizedVolatilityEstimators.bipowerVariation(returns);
    const lastRet = returns.length > 0 ? returns[returns.length - 1] : 0;

    // 2. Conditional Volatility Updates
    const garchVol = this.garch.update(lastRet);
    const egarchOut = this.egarch.update(lastRet);
    const gjrVol = this.gjr.update(lastRet);

    // 3. Corsi HAR-RV Forecast
    const harOut = this.har.update(yangZhang);

    // 4. Volatility Risk Premium
    const effectiveIV = impliedVol !== null ? impliedVol : (yangZhang * 1.12);
    const vrpOut = VolatilityRiskPremium.evaluate(effectiveIV, yangZhang, this.vrpHistory);
    this.vrpHistory.push(vrpOut.vrpSpread);
    if (this.vrpHistory.length > 50) this.vrpHistory.shift();

    // Robust consensus annualized volatility estimate
    const consensusVol = (
      yangZhang * 0.30 +
      garmanKlass * 0.20 +
      garchVol * 0.25 +
      (typeof harOut === 'object' ? harOut.forecastRV : harOut) * 0.25
    );

    this.latestMetrics = {
      consensusVol: Math.round(consensusVol * 1000) / 1000,
      yangZhang: Math.round(yangZhang * 1000) / 1000,
      garmanKlass: Math.round(garmanKlass * 1000) / 1000,
      parkinson: Math.round(parkinson * 1000) / 1000,
      rogersSatchell: Math.round(rogersSatchell * 1000) / 1000,
      bipower: Math.round(bipower * 1000) / 1000,
      garch11: Math.round(garchVol * 1000) / 1000,
      egarch: Math.round(egarchOut.vol * 1000) / 1000,
      leverageShock: Math.round(egarchOut.leverageShock * 1000) / 1000,
      gjrGarch: Math.round(gjrVol * 1000) / 1000,
      harForecast: harOut,
      vrp: vrpOut,
    };

    return this.latestMetrics;
  }

  getDefault() {
    return {
      consensusVol: 0.28,
      yangZhang: 0.28,
      garmanKlass: 0.27,
      parkinson: 0.25,
      rogersSatchell: 0.26,
      bipower: 0.24,
      garch11: 0.28,
      egarch: 0.28,
      leverageShock: 0,
      gjrGarch: 0.28,
      harForecast: { forecastRV: 0.28, trend: 'STABLE' },
      vrp: { impliedVol: 0.32, realizedVol: 0.28, vrpSpread: 0.04, vrpZScore: 0.5, strategyBias: 'NEUTRAL' },
    };
  }
}
