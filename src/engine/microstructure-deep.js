// ═════════════════════════════════════════════════════════════════════
// ADVANCED MARKET MICROSTRUCTURE ENGINE
// 1. Multi-Level OFI (Order Flow Imbalance across depth levels 1..10)
// 2. Lee-Ready (1991) & Bulk Volume Classification (BVC) Flow Tagger
// 3. Cumulative Volume Delta (CVD) & Delta Divergence Tracker
// 4. Kyle's Lambda (1985) + Square-Root Price Impact Propagator
// 5. Amihud (2002) Illiquidity Ratio
// 6. Marked Multivariate Hawkes Point Process (Bids vs Asks Mutual Excitation)
// ═════════════════════════════════════════════════════════════════════

import { clamp, mean, std } from '../utils/math.js';
import { VolatilitySurfaceEngine } from '../utils/quant-math.js';

// ─────────────────────────────────────────────────────────────────────
// 1. MULTI-LEVEL ORDER FLOW IMBALANCE (Cont, Kukanov, Stoikov 2014)
// ─────────────────────────────────────────────────────────────────────
export class MultiLevelOFIEngine {
  constructor(levels = 10) {
    this.levels = levels;
    this.prevBids = null;
    this.prevAsks = null;
    this.ofiHistory = [];
  }

  static extractLevel(item) {
    if (!item) return { price: 0, size: 0 };
    if (typeof item === 'object') {
      const price = Number(item.price ?? item[0] ?? 0);
      const size = Number(item.size ?? item.qty ?? item[1] ?? 0);
      return { price, size };
    }
    return { price: Number(item) || 0, size: 0 };
  }

  update(orderBook) {
    if (!orderBook || !Array.isArray(orderBook.bids) || !Array.isArray(orderBook.asks)) {
      return 0;
    }

    const nLevels = Math.min(this.levels, orderBook.bids.length, orderBook.asks.length);
    if (nLevels === 0) return 0;

    const curBids = [];
    const curAsks = [];
    for (let i = 0; i < nLevels; i++) {
      curBids.push(MultiLevelOFIEngine.extractLevel(orderBook.bids[i]));
      curAsks.push(MultiLevelOFIEngine.extractLevel(orderBook.asks[i]));
    }

    if (!this.prevBids || !this.prevAsks) {
      this.prevBids = curBids;
      this.prevAsks = curAsks;
      return 0;
    }

    let totalOFI = 0;
    let totalWeight = 0;

    for (let k = 0; k < nLevels; k++) {
      const b = curBids[k];
      const prevB = this.prevBids[k] || b;
      const a = curAsks[k];
      const prevA = this.prevAsks[k] || a;

      // Bid flow delta:
      // If b.p > prevB.p: new higher bid, flow = b.s
      // If b.p == prevB.p: change in bid depth = b.s - prevB.s
      // If b.p < prevB.p: bid cancelled or filled, flow = -prevB.s
      let bidFlow = 0;
      if (b.price > prevB.price) bidFlow = b.size;
      else if (b.price === prevB.price) bidFlow = b.size - prevB.size;
      else bidFlow = -prevB.size;

      // Ask flow delta:
      // If a.p < prevA.p: new lower ask (selling pressure), flow = a.s
      // If a.p == prevA.p: change in ask depth = a.s - prevA.s
      // If a.p > prevA.p: ask filled/cancelled, flow = -prevA.size
      let askFlow = 0;
      if (a.price < prevA.price) askFlow = a.size;
      else if (a.price === prevA.price) askFlow = a.size - prevA.size;
      else askFlow = -prevA.size;

      const levelOFI = bidFlow - askFlow;
      const depthWeight = Math.exp(-0.35 * k); // exponential decay over depth levels
      totalOFI += levelOFI * depthWeight;
      totalWeight += (b.size + a.size) * depthWeight;
    }

    this.prevBids = curBids;
    this.prevAsks = curAsks;

    const normalizedOFI = totalWeight > 0 ? clamp(totalOFI / totalWeight, -1, 1) : 0;
    this.ofiHistory.push(normalizedOFI);
    if (this.ofiHistory.length > 50) this.ofiHistory.shift();

    return normalizedOFI;
  }
}

// ─────────────────────────────────────────────────────────────────────
// 2. LEE-READY (1991) & BULK VOLUME CLASSIFICATION (BVC)
// ─────────────────────────────────────────────────────────────────────
export class TradeFlowClassifier {
  constructor() {
    this.lastTradePrice = 0;
    this.lastTradeSide = 1; // 1 = buy, -1 = sell
    this.cvd = 0; // Cumulative Volume Delta
    this.cvdHistory = [];
  }

  /**
   * Lee-Ready Algorithm:
   * 1. Quote Rule: Compare trade price P to mid-quote M.
   *    If P > M => Buy; If P < M => Sell.
   * 2. Tick Rule (if P == M): Compare P to previous trade price P_{t-1}.
   *    If P > P_{t-1} => Buy (uptick); If P < P_{t-1} => Sell (downtick);
   *    If P == P_{t-1} => Repeat last side (zero-tick).
   */
  classifyTrade(tradePrice, tradeSize, midPrice) {
    let side = 0;
    if (midPrice > 0 && Math.abs(tradePrice - midPrice) > 1e-4) {
      side = tradePrice > midPrice ? 1 : -1;
    } else {
      // Tick rule fallback
      if (tradePrice > this.lastTradePrice) side = 1;
      else if (tradePrice < this.lastTradePrice) side = -1;
      else side = this.lastTradeSide;
    }

    this.lastTradePrice = tradePrice;
    this.lastTradeSide = side;

    // Update CVD
    const signedVolume = side * (tradeSize || 1);
    this.cvd += signedVolume;
    this.cvdHistory.push(this.cvd);
    if (this.cvdHistory.length > 100) this.cvdHistory.shift();

    return { side, signedVolume, cvd: this.cvd };
  }

  /**
   * Bulk Volume Classification (Easley, Lopez de Prado, O'Hara 2012)
   * V_b = V * Φ(ΔP / σ_ΔP), V_s = V - V_b
   */
  static classifyBulkVolume(candle, rollingReturnStd = 0.005) {
    const pChange = (candle.close - candle.open) / (candle.open || 1);
    const z = pChange / Math.max(1e-5, rollingReturnStd);
    const buyProb = clamp(VolatilitySurfaceEngine.normCDF(z), 0.05, 0.95);
    const totalVol = candle.volume || 1;
    const buyVol = totalVol * buyProb;
    const sellVol = totalVol * (1.0 - buyProb);
    return { buyVol, sellVol, buyFraction: buyProb, delta: buyVol - sellVol };
  }
}

// ─────────────────────────────────────────────────────────────────────
// 3. KYLE'S LAMBDA (1985) & SQUARE-ROOT PRICE IMPACT PROPAGATOR
// ─────────────────────────────────────────────────────────────────────
export class PriceImpactModel {
  constructor() {
    this.tradePairs = []; // { deltaP, signedVolume }
    this.lambda = 0.025; // Kyle's lambda = Cov(ΔP, Q) / Var(Q)
    this.eta = 0.015;    // Bouchaud permanent square root coefficient
  }

  update(priceDelta, signedVol) {
    if (Number.isFinite(priceDelta) && Number.isFinite(signedVol)) {
      this.tradePairs.push({ dp: priceDelta, q: signedVol });
      if (this.tradePairs.length > 50) this.tradePairs.shift();
    }

    const n = this.tradePairs.length;
    if (n < 8) return this.lambda;

    const meanDP = mean(this.tradePairs.map(t => t.dp));
    const meanQ = mean(this.tradePairs.map(t => t.q));

    let cov = 0, varQ = 0;
    for (let i = 0; i < n; i++) {
      const dQ = this.tradePairs[i].q - meanQ;
      const dP = this.tradePairs[i].dp - meanDP;
      cov += dQ * dP;
      varQ += dQ * dQ;
    }

    if (varQ > 1e-6) {
      this.lambda = clamp(cov / varQ, 0.001, 0.15);
    }

    return this.lambda;
  }

  /**
   * Bouchaud et al. Transient & Square-Root Impact:
   * I(Q) = λ * Q + η * sgn(Q) * √|Q|
   */
  computeExpectedImpact(tradeSize, isBuy = true) {
    const q = isBuy ? tradeSize : -tradeSize;
    const linearImpact = this.lambda * q;
    const sqrtImpact = this.eta * Math.sign(q) * Math.sqrt(Math.abs(q));
    const totalImpact = linearImpact + sqrtImpact;
    return {
      linearImpactBps: Math.round(linearImpact * 10000) / 100,
      sqrtImpactBps: Math.round(sqrtImpact * 10000) / 100,
      totalExpectedSlippageBps: Math.round(totalImpact * 10000) / 100,
    };
  }
}

// ─────────────────────────────────────────────────────────────────────
// 4. AMIHUD (2002) ILLIQUIDITY MEASURE
// ─────────────────────────────────────────────────────────────────────
export class AmihudIlliquidity {
  static compute(candles) {
    if (!candles || candles.length < 2) return 0.0001;
    let sumRatio = 0;
    let count = 0;

    for (let i = 1; i < candles.length; i++) {
      const c = candles[i];
      const prev = candles[i - 1];
      const ret = Math.abs((c.close - prev.close) / (prev.close || 1));
      const dollarVol = (c.volume || 1) * c.close;
      if (dollarVol > 10) {
        sumRatio += (ret * 1e6) / dollarVol; // Scaled to basis points per million USD
        count++;
      }
    }

    return count > 0 ? sumRatio / count : 0.0001;
  }
}

// ─────────────────────────────────────────────────────────────────────
// 5. MARKED MULTIVARIATE HAWKES POINT PROCESS (2D: Bids vs Asks)
// Mutually exciting bid and ask intensity with trade volume marks
// λ_buy(t) = μ_b + ∑_{t_i < t} α_bb * m_i * e^{-β_bb(t - t_i)} + ∑_{t_j < t} α_ba * m_j * e^{-β_ba(t - t_j)}
// λ_sell(t) = μ_s + ∑_{t_i < t} α_ab * m_i * e^{-β_ab(t - t_i)} + ∑_{t_j < t} α_aa * m_j * e^{-β_aa(t - t_j)}
// ─────────────────────────────────────────────────────────────────────
export class MarkedMultivariateHawkes {
  constructor() {
    this.muBuy = 0.50;
    this.muSell = 0.50;

    // Cross-excitation matrix A = [[α_bb, α_ba], [α_ab, α_aa]]
    this.alphaBB = 0.35; // Buy self-excitation
    this.alphaBA = 0.15; // Sell excites buy (cross-cover)
    this.alphaAB = 0.15; // Buy excites sell (resistance)
    this.alphaAA = 0.35; // Sell self-excitation

    this.beta = 1.20; // Decay speed

    this.buyEvents = [];  // { t: sec, mark: size }
    this.sellEvents = []; // { t: sec, mark: size }
  }

  addEvent(isBuy, tradeSize, timestampSec = null) {
    const t = timestampSec || (Date.now() / 1000);
    const mark = clamp(tradeSize || 1.0, 0.1, 10.0);

    if (isBuy) {
      this.buyEvents.push({ t, mark });
      if (this.buyEvents.length > 50) this.buyEvents.shift();
    } else {
      this.sellEvents.push({ t, mark });
      if (this.sellEvents.length > 50) this.sellEvents.shift();
    }
  }

  getIntensities(currentTimeSec = null) {
    const t = currentTimeSec || (Date.now() / 1000);

    let lambdaBuy = this.muBuy;
    let lambdaSell = this.muSell;

    // Excitation from previous buy events
    for (const ev of this.buyEvents) {
      const dt = t - ev.t;
      if (dt > 0 && dt < 15.0) {
        const decay = Math.exp(-this.beta * dt);
        lambdaBuy += this.alphaBB * ev.mark * decay;
        lambdaSell += this.alphaAB * ev.mark * decay;
      }
    }

    // Excitation from previous sell events
    for (const ev of this.sellEvents) {
      const dt = t - ev.t;
      if (dt > 0 && dt < 15.0) {
        const decay = Math.exp(-this.beta * dt);
        lambdaBuy += this.alphaBA * ev.mark * decay;
        lambdaSell += this.alphaAA * ev.mark * decay;
      }
    }

    // Spectral radius of kernel matrix Γ = A / β
    const tr = (this.alphaBB + this.alphaAA) / this.beta;
    const det = (this.alphaBB * this.alphaAA - this.alphaBA * this.alphaAB) / (this.beta * this.beta);
    const spectralRadius = 0.5 * (tr + Math.sqrt(Math.max(0, tr * tr - 4 * det)));

    const cascadeRisk = spectralRadius > 0.85 ? 'HIGH_EXCITATION' : spectralRadius > 0.65 ? 'MODERATE' : 'STABLE';
    const netIntensityBias = (lambdaBuy - lambdaSell) / Math.max(0.1, lambdaBuy + lambdaSell);

    return {
      lambdaBuy: Math.round(lambdaBuy * 100) / 100,
      lambdaSell: Math.round(lambdaSell * 100) / 100,
      netIntensityBias: Math.round(netIntensityBias * 100) / 100,
      spectralRadius: Math.round(spectralRadius * 1000) / 1000,
      cascadeRisk,
    };
  }
}

// ─────────────────────────────────────────────────────────────────────
// 6. INTEGRATED DEEP MICROSTRUCTURE ENGINE
// ─────────────────────────────────────────────────────────────────────
export class DeepMicrostructureEngine {
  constructor() {
    this.ofiEngine = new MultiLevelOFIEngine(10);
    this.tradeClassifier = new TradeFlowClassifier();
    this.impactModel = new PriceImpactModel();
    this.hawkes2D = new MarkedMultivariateHawkes();
    this.latestSnapshot = null;
  }

  update(orderBook, recentTrades = [], candles = []) {
    // 1. Multi-Level OFI (10 levels)
    const ofi = this.ofiEngine.update(orderBook);

    // 2. Lee-Ready Trade Flow & 2D Hawkes Updates
    let recentDelta = 0;
    const mid = orderBook && orderBook.bestBid && orderBook.bestAsk
      ? (Number(orderBook.bestBid) + Number(orderBook.bestAsk)) / 2
      : 0;

    if (recentTrades && recentTrades.length > 0) {
      for (const tr of recentTrades.slice(-15)) {
        const price = Number(tr.price || tr.p || 0);
        const size = Number(tr.size || tr.qty || tr.q || 1);
        const classResult = this.tradeClassifier.classifyTrade(price, size, mid);
        const isBuy = classResult.side > 0;
        this.hawkes2D.addEvent(isBuy, size, (tr.time || Date.now()) / 1000);
        recentDelta += classResult.signedVolume;
      }
    }

    // 3. Price Impact Model
    const lastPriceDelta = candles.length >= 2
      ? (candles[candles.length - 1].close - candles[candles.length - 2].close)
      : 0;
    const kyleLambda = this.impactModel.update(lastPriceDelta, recentDelta);
    const impactBps = this.impactModel.computeExpectedImpact(1.0, true);

    // 4. Amihud Illiquidity
    const amihud = AmihudIlliquidity.compute(candles);

    // 5. Marked Multivariate Hawkes Intensities
    const hawkesState = this.hawkes2D.getIntensities();

    this.latestSnapshot = {
      multiLevelOFI: ofi,
      cvd: Math.round(this.tradeClassifier.cvd * 100) / 100,
      kyleLambda: Math.round(kyleLambda * 10000) / 10000,
      slippageBps1Unit: impactBps.totalExpectedSlippageBps,
      amihudIlliq: Math.round(amihud * 1000) / 1000,
      hawkes2D: hawkesState,
      microstructureScore: clamp(
        ofi * 0.40 +
        hawkesState.netIntensityBias * 0.35 +
        (recentDelta > 0 ? 0.25 : -0.25),
        -1, 1
      ),
    };

    return this.latestSnapshot;
  }

  getDefault() {
    return {
      multiLevelOFI: 0,
      cvd: 0,
      kyleLambda: 0.025,
      slippageBps1Unit: 1.2,
      amihudIlliq: 0.005,
      hawkes2D: { lambdaBuy: 0.5, lambdaSell: 0.5, netIntensityBias: 0, spectralRadius: 0.58, cascadeRisk: 'STABLE' },
      microstructureScore: 0,
    };
  }
}
