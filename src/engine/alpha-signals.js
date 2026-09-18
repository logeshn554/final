// ═══════════════════════════════════════════════════════
// LAYER 2: ALPHA / SIGNAL GENERATION ENGINE
// Multi-Strategy Alpha: Stat-Arb, Factor Investing, Stacked ML, Microstructure
// + Integrated with all 34 Reinforcement Learning Algorithms
// (Zero News / NLP)
// ═══════════════════════════════════════════════════════

import { clamp, mean, std, rnd, dot, sigmoid, tanh } from '../utils/math.js';

export class AlphaSignalEngine {
  constructor() {
    // 1. Stat-Arb Spread Tracking
    this.syntheticBenchmarkPrice = 64500; // e.g. BTC/USDT benchmark proxy
    this.spreadRatio = 3200 / 64500;       // initial hedge ratio ~0.0496
    this.spreadHistory = [];
    this.zScoreHistory = [];
    this.statArbSignal = 0; // -1 to +1

    // 2. Factor Investing Scores
    this.factors = {
      momentum: 0,      // 12-1 return proxy
      meanReversion: 0, // 5-period price reversal
      lowVolatility: 0, // Inverse volatility factor
      liquidity: 0,     // Depth/spread liquidity factor
      carry: 0,         // Funding rate basis factor
    };
    this.factorSignal = 0;

    // 3. Machine Learning Ensemble Pipeline
    this.mlModels = {
      gbdtScore: 0,     // Gradient Boosted Decision Tree proxy
      lstmScore: 0,     // Sequential LSTM recurrent encoder proxy
      rfScore: 0,       // Random Forest bagging model proxy
      metaStackScore: 0 // Meta-learner stacked output
    };
    this.lstmState = 0; // recurrent memory state

    // 4. Market Microstructure Signals
    this.microstructure = {
      obi: 0,           // Order Book Imbalance [-1, 1]
      leeReadyFlow: 0,  // Net buyer vs seller initiated flow
      pin: 0.22,        // Probability of Informed Trading [0, 1]
      vpin: 0.18,       // Volume-Synchronized Probability of Toxicity [0, 1]
    };
    this.vpinBuckets = [];
    this.bucketVolume = 25.0; // ETH per VPIN volume bucket
    this.currentBucketBuy = 0;
    this.currentBucketSell = 0;

    // Composite Alpha
    this.compositeAlpha = 0;
    this.alphaBreakdown = {};
  }

  /**
   * Update Alpha generation layer
   * @param {Object} dataLayer Output from Layer 1 Data Ingestion
   * @param {Array<number>} priceHistory Array of recent ETH prices
   * @param {Object} rlSignals Signals from the 34 RL algorithms
   * @param {Object} [institutionalData] Output from Pinnacle Institutional Quant Engine
   */
  update(dataLayer, priceHistory, rlSignals, institutionalData = null) {
    const { orderBook, quantFeeds, recentTrades } = dataLayer;
    const ethPrice = orderBook.midPrice;

    // ── 1. Statistical Arbitrage (Stat-Arb) ──
    // Benchmark walks with slight cointegration drift
    this.syntheticBenchmarkPrice += (Math.random() - 0.49) * 45;
    const currentSpread = ethPrice - (this.syntheticBenchmarkPrice * this.spreadRatio);
    this.spreadHistory.push(currentSpread);
    if (this.spreadHistory.length > 80) this.spreadHistory.shift();

    let zScore = 0;
    if (this.spreadHistory.length >= 20) {
      const spreadSlice = this.spreadHistory.slice(-40);
      const mu = mean(spreadSlice);
      const sigma = std(spreadSlice) || 1.0;
      zScore = (currentSpread - mu) / sigma;
    }
    this.zScoreHistory.push(zScore);
    if (this.zScoreHistory.length > 80) this.zScoreHistory.shift();

    // Fade when spread exceeds ±2.0 standard deviations
    if (zScore >= 2.0) {
      this.statArbSignal = -clamp((zScore - 1.5) * 0.5, 0.4, 1.0); // Overpriced spread -> Short ETH
    } else if (zScore <= -2.0) {
      this.statArbSignal = clamp((-zScore - 1.5) * 0.5, 0.4, 1.0); // Underpriced spread -> Long ETH
    } else if (Math.abs(zScore) < 0.5) {
      this.statArbSignal *= 0.8; // Mean reverted -> close/fade
    }

    // ── 2. Cross-Sectional Factor Investing ──
    const nPrices = priceHistory.length;
    if (nPrices >= 15) {
      // Momentum (medium-term trend)
      const momReturn = priceHistory[nPrices - 1] / priceHistory[Math.max(0, nPrices - 15)] - 1;
      this.factors.momentum = clamp(momReturn * 30, -1, 1);

      // Short-term Mean Reversion
      const shortReturn = priceHistory[nPrices - 1] / priceHistory[nPrices - 4] - 1;
      this.factors.meanReversion = -clamp(shortReturn * 40, -1, 1);

      // Low Volatility Factor
      const vol = std(priceHistory.slice(-15)) / ethPrice;
      this.factors.lowVolatility = clamp(1.0 - (vol * 150), -1, 1);

      // Liquidity Factor (low spread & high book depth = favorable)
      const depthRatio = (orderBook.totalBidVol + orderBook.totalAskVol) / 200;
      this.factors.liquidity = clamp(depthRatio - (orderBook.spread * 0.5), -1, 1);

      // Carry / Funding Factor (positive funding = short carry, negative = long carry)
      this.factors.carry = -clamp(quantFeeds.fundingRate * 2000, -1, 1);

      // Multi-factor rank-transformed composite
      const rawFactor = 0.25 * this.factors.momentum +
                        0.25 * this.factors.meanReversion +
                        0.15 * this.factors.lowVolatility +
                        0.15 * this.factors.liquidity +
                        0.20 * this.factors.carry;
      this.factorSignal = clamp(rawFactor * 1.5, -1, 1);
    }

    // ── 3. Machine Learning Ensemble Pipeline ──
    // Feature vector: [spread, zScore, mom, OBI, funding, vol]
    const mlInput = [
      currentSpread * 0.05,
      zScore,
      this.factors.momentum,
      (orderBook.bestBidSize - orderBook.bestAskSize) / (orderBook.bestBidSize + orderBook.bestAskSize),
      quantFeeds.fundingRate * 1000,
    ];

    // Model A: GBDT decision tree surrogate (piecewise non-linear thresholds)
    let gbdt = 0;
    if (mlInput[1] > 1.2 && mlInput[3] < -0.2) gbdt -= 0.6;
    else if (mlInput[1] < -1.2 && mlInput[3] > 0.2) gbdt += 0.6;
    if (mlInput[2] > 0.3) gbdt += 0.3; else if (mlInput[2] < -0.3) gbdt -= 0.3;
    this.mlModels.gbdtScore = clamp(gbdt, -1, 1);

    // Model B: Sequential LSTM Recurrent Cell proxy
    // h_t = tanh(W_h * h_{t-1} + W_x * x_t)
    this.lstmState = tanh(0.7 * this.lstmState + 0.3 * (mlInput[1] * -0.5 + mlInput[3] * 0.8));
    this.mlModels.lstmScore = this.lstmState;

    // Model C: Random Forest Bagging Model proxy (average of bootstrapped splits)
    const rfTrees = [
      mlInput[3] > 0.1 ? 0.5 : -0.5,
      mlInput[1] < -0.8 ? 0.7 : -0.2,
      mlInput[2] > 0 ? 0.4 : -0.4,
      mlInput[4] < 0 ? 0.3 : -0.3,
    ];
    this.mlModels.rfScore = clamp(mean(rfTrees), -1, 1);

    // Meta-Learner Stacking Layer: w1*GBDT + w2*LSTM + w3*RF
    this.mlModels.metaStackScore = clamp(
      0.35 * this.mlModels.gbdtScore +
      0.35 * this.mlModels.lstmScore +
      0.30 * this.mlModels.rfScore,
      -1, 1
    );

    // ── 4. Market Microstructure Signals ──
    // Order Book Imbalance (OBI)
    const topBid = orderBook.bestBidSize || 1;
    const topAsk = orderBook.bestAskSize || 1;
    this.microstructure.obi = (topBid - topAsk) / (topBid + topAsk);

    // Lee-Ready Trade-Side Classification
    let netTradeFlow = 0;
    for (const trade of recentTrades) {
      netTradeFlow += trade.side === 'BUY' ? trade.size : -trade.size;
    }
    this.microstructure.leeReadyFlow = clamp(netTradeFlow / 15, -1, 1);

    // VPIN (Volume-synchronized Probability of Toxicity)
    for (const trade of recentTrades) {
      if (trade.side === 'BUY') this.currentBucketBuy += trade.size;
      else this.currentBucketSell += trade.size;

      if (this.currentBucketBuy + this.currentBucketSell >= this.bucketVolume) {
        const bucketImbalance = Math.abs(this.currentBucketBuy - this.currentBucketSell) / this.bucketVolume;
        this.vpinBuckets.push(bucketImbalance);
        if (this.vpinBuckets.length > 15) this.vpinBuckets.shift();
        this.currentBucketBuy = 0;
        this.currentBucketSell = 0;
      }
    }
    if (this.vpinBuckets.length > 0) {
      this.microstructure.vpin = clamp(mean(this.vpinBuckets), 0.05, 0.95);
    }
    // PIN proxy: proportion of directional informed flow
    this.microstructure.pin = clamp(0.15 + (Math.abs(this.microstructure.obi) * 0.4) + (this.microstructure.vpin * 0.2), 0.1, 0.85);

    const microSignal = clamp(
      0.45 * this.microstructure.obi +
      0.35 * this.microstructure.leeReadyFlow -
      (this.microstructure.vpin > 0.45 ? 0.25 * Math.sign(this.microstructure.obi) : 0),
      -1, 1
    );

    // ── 5. Integrated Composite Alpha ──
    // Combine 4 Quant engines + 34 RL algorithms
    let rlEnsembleSum = 0;
    let rlCount = 0;
    for (const id in rlSignals) {
      if (rlSignals[id] && typeof rlSignals[id].signal === 'number') {
        rlEnsembleSum += rlSignals[id].signal;
        rlCount++;
      }
    }
    const rlComposite = rlCount > 0 ? rlEnsembleSum / rlCount : 0;

    // Production Alpha Weighting:
    // 30% RL Matrix (34 models) + 20% Stacked ML + 15% Pinnacle Institutional HJB + 15% Stat-Arb + 10% Factors + 10% Microstructure
    const instSig = institutionalData && typeof institutionalData.signal === 'number' ? institutionalData.signal : 0;
    this.compositeAlpha = clamp(
      0.30 * rlComposite +
      0.20 * this.mlModels.metaStackScore +
      0.15 * instSig +
      0.15 * this.statArbSignal +
      0.10 * this.factorSignal +
      0.10 * microSignal,
      -1, 1
    );

    this.alphaBreakdown = {
      rlComposite: Math.round(rlComposite * 1000) / 1000,
      mlStack: Math.round(this.mlModels.metaStackScore * 1000) / 1000,
      institutional: Math.round(instSig * 1000) / 1000,
      statArb: Math.round(this.statArbSignal * 1000) / 1000,
      factors: Math.round(this.factorSignal * 1000) / 1000,
      microstructure: Math.round(microSignal * 1000) / 1000,
      zScore: Math.round(zScore * 100) / 100,
      vpin: Math.round(this.microstructure.vpin * 1000) / 1000,
      obi: Math.round(this.microstructure.obi * 1000) / 1000,
    };

    return {
      compositeAlpha: Math.round(this.compositeAlpha * 1000) / 1000,
      alphaBreakdown: this.alphaBreakdown,
      statArb: {
        currentSpread: Math.round(currentSpread * 100) / 100,
        zScore: Math.round(zScore * 100) / 100,
        signal: this.statArbSignal,
        zHistory: this.zScoreHistory,
      },
      factors: this.factors,
      mlModels: this.mlModels,
      microstructure: this.microstructure,
    };
  }
}
