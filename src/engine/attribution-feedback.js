// ═══════════════════════════════════════════════════════
// LAYER 6: MONITORING, ATTRIBUTION & FEEDBACK ENGINE
// PnL Attribution (Alpha vs Beta vs Execution), Post-Trade Slippage TCA,
// Model Drift & Alpha Decay, A/B Shadow Paper Trading, Walk-Forward Validation
// ═══════════════════════════════════════════════════════

import { clamp, mean, std } from '../utils/math.js';

export class AttributionFeedbackEngine {
  constructor() {
    // 1. PnL Attribution
    this.attribution = {
      totalPnLUSD: 0,
      alphaPnLUSD: 0,      // Pure alpha from strategies
      betaPnLUSD: 0,       // Systematic market movement
      executionPnLUSD: 0,  // Slippage savings from execution
      alphaPct: 0,
      betaPct: 0,
      executionPct: 0,
    };

    // 2. Slippage & TCA Metrics
    this.tca = {
      avgSlippageBps: 0.0,
      estimatedImpactBps: 0.0,
      slippageSavingsUSD: 0.0,
      sorAlphaSavingsBps: 0.0,
    };

    // 3. Model Drift & Decay
    this.modelDrift = {
      driftIndex: 0.0,         // [0, 1] 0=Stationary, 1=Severe Drift
      alphaHalfLifeHours: 24.0,
      correlationShift: 0.0,
      driftStatus: 'STABLE (Calibrating)',
    };

    // 4. A/B Shadow Paper Trading
    this.abTesting = {
      modelA: { name: 'MasterMind Consensus', pnlUSD: 0, sharpe: 0.0, winRate: 0.0 },
      modelB: { name: 'Benchmark Standalone', pnlUSD: 0, sharpe: 0.0, winRate: 0.0 },
      trackingError: 0.0,
      informationRatio: 0.0,
      leader: 'Awaiting Closed Paper Trades',
    };

    // 5. Walk-Forward Metrics
    this.walkForward = {
      oosSharpe: 0.0,
      inSampleSharpe: 0.0,
      calmarRatio: 0.0,
      profitFactor: 0.0,
      oosEfficiency: '--',
    };

    this.tickCount = 0;
    this.pnlHistoryA = [];
    this.pnlHistoryB = [];

    // Empirical rolling beta estimation state
    // We maintain parallel rolling windows of (price_delta, position_pnl) pairs
    // and derive beta = cov(position_pnl, price_delta) / var(price_delta)
    this._priceDeltas = [];   // rolling window of price changes
    this._positionPnLs = [];  // rolling window of position * priceDelta
    this._betaEstimate = null; // null until >= 20 samples (uses prior 0.35 before that)
    this._betaPrior = 0.35;   // Crypto-market-beta prior used before empirical estimation

    // Empirical rolling alpha window for z-score drift detection
    this._alphaHistory = [];  // rolling 60-tick window of compositeAlpha values
  }

  /**
   * Update Attribution and Feedback Engine
   * @param {number} currentPrice Current ETH price
   * @param {number} prevPrice Previous tick price
   * @param {number} position Current position in ETH
   * @param {number} totalPnL Total accumulated PnL
   * @param {Object} execResult Smart Execution layer output
   * @param {number} compositeAlpha Current composite alpha
   */
  update(currentPrice, prevPrice, position, totalPnL, execResult, compositeAlpha) {
    this.tickCount++;

    const priceDelta = currentPrice - (prevPrice || currentPrice);
    const tickPnL = position * priceDelta;

    // ── 1. Empirical Rolling Beta Estimation ──
    // Maintain rolling windows (last 60 ticks) of price changes and position PnL.
    // Estimate rolling OLS beta: cov(positionPnL, priceDelta) / var(priceDelta)
    this._priceDeltas.push(priceDelta);
    this._positionPnLs.push(tickPnL);
    if (this._priceDeltas.length > 60) {
      this._priceDeltas.shift();
      this._positionPnLs.shift();
    }

    let empiricalBeta = this._betaPrior; // start with prior
    if (this._priceDeltas.length >= 20) {
      const meanDelta = mean(this._priceDeltas);
      const meanPnL = mean(this._positionPnLs);
      let covSum = 0;
      let varSum = 0;
      for (let i = 0; i < this._priceDeltas.length; i++) {
        const dDelta = this._priceDeltas[i] - meanDelta;
        const dPnL = this._positionPnLs[i] - meanPnL;
        covSum += dDelta * dPnL;
        varSum += dDelta * dDelta;
      }
      if (varSum > 1e-12) {
        this._betaEstimate = clamp(covSum / varSum, -2.0, 2.0);
      }
      if (this._betaEstimate !== null) {
        empiricalBeta = this._betaEstimate;
      }
    }

    // Brinson & Factor PnL Attribution using empirical beta
    const betaReturnComponent = priceDelta * empiricalBeta;
    const tickBetaPnL = position * betaReturnComponent;

    // ── 2. Execution Alpha — Real Fill vs Market Savings ──
    // Use actual fill price vs. market price difference when available from execResult.
    // Never use fixed coefficient; fall back to 0 (no claimed savings) when not measurable.
    let tickExecPnL = 0;
    if (execResult && execResult.sliceETH > 0) {
      if (execResult.fillPrice && execResult.marketPrice && execResult.fillPrice > 0) {
        // Actual measured improvement: (market - fill) * quantity for a buy; (fill - market) * qty for a sell
        const side = execResult.side || 'BUY';
        const fillVsMarket = side === 'BUY'
          ? execResult.marketPrice - execResult.fillPrice
          : execResult.fillPrice - execResult.marketPrice;
        tickExecPnL = fillVsMarket * execResult.sliceETH;
      } else if (execResult.slippageSavingsBps !== undefined && execResult.slippageSavingsBps > 0) {
        tickExecPnL = (execResult.slippageSavingsBps / 10000) * execResult.sliceETH * (currentPrice || 1);
      }
      // If neither field is present, tickExecPnL remains 0 (no false positive savings claimed)
      this.tca.slippageSavingsUSD += tickExecPnL;
    }

    const tickAlphaPnL = tickPnL - tickBetaPnL + tickExecPnL;

    this.attribution.alphaPnLUSD += tickAlphaPnL;
    this.attribution.betaPnLUSD += tickBetaPnL;
    this.attribution.executionPnLUSD += tickExecPnL;
    this.attribution.totalPnLUSD = Math.round(totalPnL * 100) / 100;

    // Percentages
    const absTotal = Math.abs(this.attribution.alphaPnLUSD) +
                     Math.abs(this.attribution.betaPnLUSD) +
                     Math.abs(this.attribution.executionPnLUSD) || 1;
    this.attribution.alphaPct = Math.round((Math.abs(this.attribution.alphaPnLUSD) / absTotal) * 100);
    this.attribution.betaPct = Math.round((Math.abs(this.attribution.betaPnLUSD) / absTotal) * 100);
    this.attribution.executionPct = Math.max(0, 100 - this.attribution.alphaPct - this.attribution.betaPct);

    // ── 3. Post-Trade Slippage TCA ──
    if (execResult && execResult.slippageBps !== undefined) {
      this.tca.avgSlippageBps = Math.round((0.95 * this.tca.avgSlippageBps + 0.05 * Math.abs(execResult.slippageBps)) * 10) / 10;
    }

    // ── 4. Model Drift Detection (Rolling Z-Score Variance Test) ──
    // Maintain a rolling 60-tick window of compositeAlpha values.
    // Drift is measured as |z-score| of the current alpha relative to recent distribution.
    // This replaces the previous heuristic: |alpha| * 0.25.
    const alphaVal = compositeAlpha || 0;
    this._alphaHistory.push(alphaVal);
    if (this._alphaHistory.length > 60) {
      this._alphaHistory.shift();
    }

    if (this._alphaHistory.length >= 10) {
      const rollingMean = mean(this._alphaHistory);
      const rollingStd = std(this._alphaHistory);
      // z-score of current alpha vs. rolling distribution; clamped to [0, 3]
      const zScore = rollingStd > 1e-8 ? Math.abs(alphaVal - rollingMean) / rollingStd : 0;
      // driftIndex = 0 means stationary; 1 means 3-sigma departure (severe drift)
      this.modelDrift.driftIndex = Math.round(clamp(zScore / 3.0, 0, 1) * 100) / 100;
      // Correlation shift approximated as fraction of explained variance
      this.modelDrift.correlationShift = Math.round(clamp(1 - (1 / (1 + this.modelDrift.driftIndex * 2)), 0, 1) * 100) / 100;
    } else {
      // Not enough data yet — keep calibrating label
      this.modelDrift.driftIndex = 0;
      this.modelDrift.correlationShift = 0;
    }

    if (this.modelDrift.driftIndex < 0.25) {
      this.modelDrift.driftStatus = 'STABLE (Optimal)';
    } else if (this.modelDrift.driftIndex < 0.55) {
      this.modelDrift.driftStatus = 'MODERATE (Monitoring)';
    } else {
      this.modelDrift.driftStatus = 'DRIFT DETECTED (Re-calibrating)';
    }

    // ── 5. A/B Shadow Paper Trading ──
    this.abTesting.modelA.pnlUSD = Math.round(totalPnL * 100) / 100;
    // Benchmark B uses naive trend signal (price momentum without deep ensemble)
    const benchmarkSignal = Math.sign(priceDelta);
    const benchmarkDelta = benchmarkSignal * priceDelta * Math.abs(position || 1.0);
    this.abTesting.modelB.pnlUSD = Math.round((this.abTesting.modelB.pnlUSD + benchmarkDelta) * 100) / 100;

    this.pnlHistoryA.push(tickPnL);
    this.pnlHistoryB.push(benchmarkDelta);
    if (this.pnlHistoryA.length > 100) {
      this.pnlHistoryA.shift();
      this.pnlHistoryB.shift();
    }

    const diffPnL = this.abTesting.modelA.pnlUSD - this.abTesting.modelB.pnlUSD;
    this.abTesting.leader = diffPnL >= 0
      ? `Model A Lead (+$${diffPnL.toFixed(0)})`
      : `Model B Lead (+$${Math.abs(diffPnL).toFixed(0)})`;

    // Real tracking error calculation
    if (this.pnlHistoryA.length > 5) {
      const activeDiffs = this.pnlHistoryA.map((a, i) => a - (this.pnlHistoryB[i] || 0));
      this.abTesting.trackingError = Math.round(std(activeDiffs) * 1000) / 1000;
      const meanDiff = mean(activeDiffs);
      this.abTesting.informationRatio = this.abTesting.trackingError > 0
        ? Math.round((meanDiff / this.abTesting.trackingError) * 100) / 100
        : 0.0;
    }

    // ── 6. Walk-Forward Metrics ──
    if (this.walkForward.inSampleSharpe > 0) {
      const oosRatio = this.walkForward.oosSharpe / this.walkForward.inSampleSharpe;
      this.walkForward.oosEfficiency = `${(oosRatio * 100).toFixed(1)}% (Target > 70%)`;
    } else {
      this.walkForward.oosEfficiency = 'Calibrating';
    }

    return {
      attribution: this.attribution,
      tca: this.tca,
      modelDrift: this.modelDrift,
      abTesting: this.abTesting,
      walkForward: this.walkForward,
    };
  }
}
