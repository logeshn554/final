// ═══════════════════════════════════════════════════════
// FEATURE EXTRACTION — Technical Indicators & State Vector
// Computes 20-dimensional feature vector each tick
// ═══════════════════════════════════════════════════════

import { mean, std, clamp, ema } from '../utils/math.js';

/**
 * Compute RSI (Relative Strength Index)
 * @param {number[]} prices - Price array
 * @param {number} period - Lookback period
 * @returns {number} RSI in [0, 100]
 */
function computeRSI(prices, period = 14) {
  if (prices.length < period + 1) return 50;
  let gains = 0, losses = 0;
  const start = prices.length - period - 1;
  for (let i = start + 1; i < prices.length; i++) {
    const diff = prices[i] - prices[i - 1];
    if (diff > 0) gains += diff;
    else losses -= diff;
  }
  gains /= period;
  losses /= period;
  if (losses === 0) return 100;
  const rs = gains / losses;
  return 100 - 100 / (1 + rs);
}

/**
 * Compute MACD
 * @returns {{ macd: number, signal: number, histogram: number }}
 */
function computeMACD(prices, fast = 12, slow = 26, sig = 9) {
  if (prices.length < slow + sig) return { macd: 0, signal: 0, histogram: 0 };

  const emaCalc = (data, period) => {
    const k = 2 / (period + 1);
    let e = data[0];
    for (let i = 1; i < data.length; i++) e = data[i] * k + e * (1 - k);
    return e;
  };

  const recentPrices = prices.slice(-(slow + sig));
  const emaFast = emaCalc(recentPrices, fast);
  const emaSlow = emaCalc(recentPrices, slow);
  const macd = emaFast - emaSlow;

  // Approximate signal line
  const macdHistory = [];
  for (let i = 0; i < sig; i++) {
    const subPrices = recentPrices.slice(0, recentPrices.length - sig + i + 1);
    const ef = emaCalc(subPrices, fast);
    const es = emaCalc(subPrices, slow);
    macdHistory.push(ef - es);
  }
  const signalLine = emaCalc(macdHistory, sig);

  return { macd, signal: signalLine, histogram: macd - signalLine };
}

/**
 * Compute Bollinger Bands
 * @returns {{ upper: number, middle: number, lower: number, percentB: number }}
 */
function computeBollinger(prices, period = 20, numStd = 2) {
  if (prices.length < period) return { upper: 0, middle: 0, lower: 0, percentB: 0.5 };
  const slice = prices.slice(-period);
  const middle = mean(slice);
  const sd = std(slice);
  const upper = middle + numStd * sd;
  const lower = middle - numStd * sd;
  const currentPrice = prices[prices.length - 1];
  const percentB = (upper - lower) !== 0 ? (currentPrice - lower) / (upper - lower) : 0.5;
  return { upper, middle, lower, percentB: clamp(percentB, 0, 1) };
}

/**
 * Compute ATR (Average True Range) using true OHLC candles without synthetic approximation
 */
export function computeATR(candlesOrPrices, period = 14) {
  if (!candlesOrPrices || candlesOrPrices.length < 2) return 0;
  
  // If array of OHLC candle objects
  if (typeof candlesOrPrices[0] === 'object' && candlesOrPrices[0] !== null && 'high' in candlesOrPrices[0]) {
    const len = candlesOrPrices.length;
    const count = Math.min(len - 1, period);
    if (count <= 0) return 0;
    let trSum = 0;
    const start = len - count;
    for (let i = start; i < len; i++) {
      const c = candlesOrPrices[i];
      const prevClose = candlesOrPrices[i - 1].close;
      const tr = Math.max(
        c.high - c.low,
        Math.abs(c.high - prevClose),
        Math.abs(c.low - prevClose)
      );
      trSum += tr;
    }
    return trSum / count;
  }

  // Fallback if only raw price closes provided (close-to-close true range without Math.random())
  const prices = candlesOrPrices;
  const count = Math.min(prices.length - 1, period);
  if (count <= 0) return 0;
  let trSum = 0;
  const start = prices.length - count;
  for (let i = start; i < prices.length; i++) {
    trSum += Math.abs(prices[i] - prices[i - 1]);
  }
  return trSum / count;
}

/**
 * Compute OBV-like momentum from volume
 */
function computeOBVMomentum(prices, volumes, period = 10) {
  if (prices.length < period + 1 || volumes.length < period + 1) return 0;
  let obv = 0;
  const start = prices.length - period;
  for (let i = start; i < prices.length; i++) {
    if (prices[i] > prices[i - 1]) obv += volumes[i] || 1;
    else if (prices[i] < prices[i - 1]) obv -= volumes[i] || 1;
  }
  return obv / (period * (mean(volumes.slice(-period)) || 1));
}

/**
 * Extract full 20-dimensional feature vector from market state
 * @param {Object} state - Global state
 * @returns {Float64Array} 20-dim feature vector, normalized
 */
export function extractFeatures(state) {
  const { prices, volumes, position, entryPrice, price } = state;
  const features = new Float64Array(20);

  if (prices.length < 2) {
    return features; // Need at least 2 prices for 1-bar return
  }

  // 0: Price return 1-bar (normalized)
  features[0] = (prices[prices.length - 1] / prices[prices.length - 2] - 1) * 100;

  // 1: Price return 5-bar
  features[1] = prices.length >= 6
    ? (prices[prices.length - 1] / prices[prices.length - 6] - 1) * 100
    : 0;

  // 2: Price return 10-bar
  features[2] = prices.length >= 11
    ? (prices[prices.length - 1] / prices[prices.length - 11] - 1) * 100
    : 0;

  // 3: Price return 20-bar
  features[3] = prices.length >= 21
    ? (prices[prices.length - 1] / prices[prices.length - 21] - 1) * 100
    : 0;

  // 4: Volatility (rolling 20-bar std of returns)
  const returns = [];
  for (let i = Math.max(1, prices.length - 20); i < prices.length; i++) {
    returns.push(prices[i] / prices[i - 1] - 1);
  }
  features[4] = std(returns) * 100;

  // 5: RSI (14) normalized to [-1, 1]
  features[5] = (computeRSI(prices, 14) - 50) / 50;

  // 6: MACD signal
  const macd = computeMACD(prices);
  features[6] = clamp(macd.histogram / (price * 0.001 || 1), -3, 3);

  // 7: MACD histogram direction
  features[7] = macd.histogram > 0 ? 1 : -1;

  // 8: Bollinger %B (normalized to [-1, 1])
  const bb = computeBollinger(prices);
  features[8] = (bb.percentB - 0.5) * 2;

  // 9: Volume change (relative)
  if (volumes.length >= 10) {
    const recentVol = mean(volumes.slice(-5));
    const prevVol = mean(volumes.slice(-10, -5));
    features[9] = prevVol > 0 ? clamp((recentVol / prevVol - 1), -2, 2) : 0;
  }

  // 10: OBV momentum
  features[10] = clamp(computeOBVMomentum(prices, volumes), -2, 2);

  // 11: Momentum (10-bar rate of change)
  features[11] = prices.length >= 11
    ? clamp((price / prices[prices.length - 11] - 1) * 50, -3, 3)
    : 0;

  // 12: Mean reversion (distance from 20-bar SMA)
  const sma20 = mean(prices.slice(-20));
  features[12] = clamp((price - sma20) / (std(prices.slice(-20)) || 1), -3, 3);

  // 13: Trend strength (slope of 20-bar linear regression, simplified)
  if (prices.length >= 20) {
    const slice = prices.slice(-20);
    let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
    const n = slice.length;
    for (let i = 0; i < n; i++) {
      sumX += i; sumY += slice[i]; sumXY += i * slice[i]; sumX2 += i * i;
    }
    const slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);
    features[13] = clamp(slope / (price * 0.001 || 1), -3, 3);
  }

  // 14: Current position (normalized)
  features[14] = clamp(position / 5.0, -1, 1);

  // 15: Unrealized PnL (normalized)
  const unrealPnL = position !== 0 ? (price - entryPrice) / entryPrice * Math.sign(position) : 0;
  features[15] = clamp(unrealPnL * 100, -5, 5);

  // 16: ATR (normalized using real OHLC candles)
  const activeCandles = (state.candles && state.candles[state.selectedTimeframe || '15m']) || [];
  const rawATR = activeCandles.length >= 2 ? computeATR(activeCandles, 14) : computeATR(prices, 14);
  features[16] = clamp(rawATR / (price * 0.01 || 1), 0, 3);

  // 17: Candlestick Pattern recognition composite score [-3, 3]
  if (state.candlestickAnalysis && typeof state.candlestickAnalysis.score === 'number') {
    features[17] = clamp(state.candlestickAnalysis.score * 3.0, -3, 3);
  } else {
    const high = Math.max(...prices.slice(-60));
    features[17] = clamp((price - high) / (high * 0.01 || 1), -3, 0);
  }

  // 18: Quant Algorithms Composite Signal (Classical + Institutional + DeepLOB + Neural Forecaster) [-3, 3]
  let classicalSig = state.tradingAlgos && typeof state.tradingAlgos.compositeSignal === 'number'
    ? state.tradingAlgos.compositeSignal
    : 0;
  let instSig = state.institutionalAlgo
    ? (typeof state.institutionalAlgo.compositeSignal === 'number'
        ? state.institutionalAlgo.compositeSignal
        : (typeof state.institutionalAlgo.signal === 'number' ? state.institutionalAlgo.signal : 0))
    : 0;
  let lobSig = state.researchStack?.deepLOB?.directionalSignal || 0;
  let neuralSig = state.researchStack?.neuralForecaster?.compositeSignal || 0;
  features[18] = clamp((0.25 * classicalSig + 0.35 * instSig + 0.20 * lobSig + 0.20 * neuralSig) * 3.0, -3, 3);

  // 19: Microstructure Imbalance & Adverse Selection (Multi-Level OFI + Kyle's Lambda + Avellaneda Skew)
  if (state.researchStack?.microstructure) {
    const ofi10 = state.researchStack.microstructure.multiLevelOFI || 0;
    const kyleL = state.researchStack.microstructure.kyleLambda || 0.02;
    features[19] = clamp(ofi10 * 2.0 - kyleL * 10.0, -3, 3);
  } else if (state.institutionalAlgo && state.institutionalAlgo.avellaneda) {
    const invSkew = state.institutionalAlgo.avellaneda.inventorySkew || 0;
    const kyleOffset = state.institutionalAlgo.kyle?.adverseSelectionBps || 0;
    features[19] = clamp((invSkew * 0.5) + (kyleOffset * 0.2), -3, 3);
  } else {
    features[19] = clamp(state.spread / (price * 0.001 || 1), 0, 3);
  }


  // Clip all features to [-5, 5] for stability
  for (let i = 0; i < 20; i++) {
    features[i] = clamp(features[i], -5, 5);
    if (!isFinite(features[i])) features[i] = 0;
  }

  return features;
}

/**
 * Discretize feature vector into a state index for tabular methods
 * Uses simple hashing of binned features
 */
export function discretizeState(features, numBins = 5) {
  let hash = 0;
  const prime = 31;
  for (let i = 0; i < Math.min(features.length, 6); i++) {
    // Bin feature into [0, numBins-1]
    const binned = Math.floor(clamp((features[i] + 5) / 10 * numBins, 0, numBins - 1));
    hash = (hash * prime + binned) % 10000;
  }
  return Math.abs(hash);
}

/**
 * Compute reward for a transition with real executable microstructure costs
 * Incorporates: Binance fees (taker 0.04% / maker 0.02%), bid-ask spread,
 * Kyle's Lambda market impact, intraday funding rate, and non-linear drawdown penalty
 * @param {number} action - 0:buy, 1:hold, 2:sell
 * @param {number} priceBefore - price at action time
 * @param {number} priceAfter - price at next step
 * @param {number} position - current position
 * @param {Object} options - execution parameters { spread, feeRate, kylesLambda, fundingRate, drawdown, size }
 * @returns {number} net executable reward
 */
export function computeReward(action, priceBefore, priceAfter, position, options = {}) {
  const priceChange = (priceAfter - priceBefore) / (priceBefore || 1);
  let reward = 0;

  // Gross PnL from position
  reward += position * priceChange * 10;

  // Directional action alignment
  if (action === 0) { // BUY
    reward += priceChange * 5;
  } else if (action === 2) { // SELL
    reward -= priceChange * 5;
  }

  // Real Executable Trading Friction Costs
  if (action !== 1) {
    // 1. Binance Taker/Maker Trading Fee (default 0.04% taker)
    const feeRate = options.feeRate ?? 0.0004;
    reward -= feeRate * 10;

    // 2. Bid-Ask Half Spread Crossing Cost
    const spread = options.spread ?? 0.15;
    const spreadCost = (spread / (2 * priceBefore)) * 10;
    reward -= spreadCost;

    // 3. Kyle's Lambda Adverse Selection Market Impact
    const lambda = options.kylesLambda ?? 0.015;
    const tradeSize = options.size ?? 0.05;
    const marketImpact = lambda * tradeSize * 5;
    reward -= marketImpact;
  }

  // 4. Perpetual Funding Rate Cost (e.g. 0.01% / 8h)
  const fundingRate = options.fundingRate ?? 0.0001;
  const fundingCost = Math.abs(position) * Math.abs(fundingRate) * 2;
  reward -= fundingCost;

  // 5. Risk-Averse Drawdown Penalty (penalize drawdowns above 1.5%)
  const dd = options.drawdown ?? 0;
  if (dd > 1.5) {
    const ddPenalty = Math.pow((dd - 1.5) * 0.1, 2);
    reward -= ddPenalty;
  }

  return clamp(reward, -2, 2);
}
