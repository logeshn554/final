// ═══════════════════════════════════════════════════════
// LAYER 4: SMART EXECUTION ENGINE
// Almgren-Chriss Optimal Liquidation, TWAP, VWAP, Implementation Shortfall (IS)
// Smart Order Routing (SOR) & Venue Selection (Lit vs Dark ATS vs DEX)
// ═══════════════════════════════════════════════════════

import { clamp, rnd, mean } from '../utils/math.js';

export class SmartExecutionEngine {
  constructor() {
    this.totalExecutionHorizon = 10; // 10-step execution horizon
    this.currentStep = 0;
    this.activeOrder = null; // { totalSizeETH, side, arrivalPrice, executedETH }
    
    // Almgren-Chriss model parameters
    this.timingRiskLambda = 1e-5;    // Risk-aversion parameter
    this.volatilitySigma = 0.025;     // Asset volatility
    this.temporaryImpactEta = 0.08;   // Temporary price impact coeff
    this.kappa = Math.sqrt((this.timingRiskLambda * Math.pow(this.volatilitySigma, 2)) / this.temporaryImpactEta) || 0.35;

    // Execution venues for simulated Paper Trading against real exchange L2 order books
    this.venues = [
      { id: 'binance', name: 'Binance L2 Depth', type: 'PAPER_L2', fillProb: 1.0, feeBps: 2.0, executedShare: 0 },
      { id: 'coinbase', name: 'Coinbase L2 Depth', type: 'PAPER_L2', fillProb: 1.0, feeBps: 3.5, executedShare: 0 },
      { id: 'bybit', name: 'Bybit L2 Depth', type: 'PAPER_L2', fillProb: 1.0, feeBps: 2.5, executedShare: 0 },
    ];

    // Historical execution metrics
    this.executionLog = [];
    this.realizedSlippageBps = 0;
    this.arrivalPrice = 0;
    this.vwapBenchmark = 0;
    this.effectiveVWAP = 0;
    this.acTrajectory = []; // Almgren-Chriss ideal remaining schedule
  }

  /**
   * Plan and slice execution for a target position change
   * @param {number} targetPositionETH Desired target position from Layer 3
   * @param {number} currentPositionETH Currently held position
   * @param {number} currentPrice Current mid price
   * @param {string} mode 'ALMGREN_CHRISS' | 'TWAP' | 'VWAP' | 'IS'
   */
  planExecution(targetPositionETH, currentPositionETH, currentPrice, mode = 'ALMGREN_CHRISS') {
    const deltaETH = targetPositionETH - currentPositionETH;
    if (Math.abs(deltaETH) < 0.01) {
      return { active: false, sliceETH: 0, mode: 'IDLE' };
    }

    const side = deltaETH > 0 ? 'BUY' : 'SELL';
    const totalSizeETH = Math.abs(deltaETH);
    this.arrivalPrice = currentPrice;

    // Calculate Almgren-Chriss trajectory curve
    // x_j = X * sinh(kappa * (T - t_j)) / sinh(kappa * T)
    const T = this.totalExecutionHorizon;
    this.acTrajectory = [];
    for (let j = 0; j <= T; j++) {
      const remainingRatio = Math.sinh(this.kappa * (T - j)) / (Math.sinh(this.kappa * T) || 1);
      const remainingSize = totalSizeETH * clamp(remainingRatio, 0, 1);
      this.acTrajectory.push(Math.round(remainingSize * 1000) / 1000);
    }

    this.activeOrder = {
      totalSizeETH,
      remainingETH: totalSizeETH,
      executedETH: 0,
      side,
      arrivalPrice: currentPrice,
      mode,
      totalSlices: T,
      currentSlice: 0,
      executedWeightedPrice: 0,
    };

    return { active: true, totalSizeETH, mode, trajectory: this.acTrajectory };
  }

  /**
   * Execute child slice for the current tick
   * @param {number} currentPrice Current market price
   * @param {number} spread Current spread
   * @param {number} toxicity VPIN or microstructure toxicity score
   * @param {Array<Object>} recentTrades Recent real Binance trade tape
   */
  executeSlice(currentPrice, spread, toxicity = 0.2, recentTrades = []) {
    if (!this.activeOrder || this.activeOrder.remainingETH <= 0.001) {
      return {
        active: false,
        sliceETH: 0,
        venueFills: [],
        effectivePrice: currentPrice,
        slippageBps: 0,
      };
    }

    const order = this.activeOrder;
    order.currentSlice++;
    const j = order.currentSlice;
    const T = order.totalSlices;

    let sliceSizeETH = 0;

    if (order.mode === 'ALMGREN_CHRISS') {
      // Delta from hyperbolic trajectory
      const prevRemaining = this.acTrajectory[j - 1] ?? order.remainingETH;
      const currRemaining = this.acTrajectory[j] ?? 0;
      sliceSizeETH = Math.max(0.01, prevRemaining - currRemaining);
    } else if (order.mode === 'TWAP') {
      // Uniform slicing with 10% random jitter
      sliceSizeETH = (order.totalSizeETH / T) * (1 + rnd(-0.1, 0.1));
    } else if (order.mode === 'VWAP') {
      // U-shaped volume curve (higher at start and end)
      const uFactor = 0.8 + 0.6 * Math.pow((j - T / 2) / (T / 2), 2);
      sliceSizeETH = (order.totalSizeETH / T) * uFactor;
    } else {
      // Implementation Shortfall: Front-load if toxicity is rising
      const urgency = 1.0 + toxicity * 0.8;
      sliceSizeETH = (order.remainingETH / Math.max(1, T - j + 1)) * urgency;
    }

    sliceSizeETH = clamp(sliceSizeETH, 0.01, order.remainingETH);

    // Smart Order Routing (SOR) venue allocation across real exchange L2 books
    const venueFills = [];
    let remainingToRoute = sliceSizeETH;

    // Match fill price against real exchange trade executions if available
    let fillPriceLit;
    let matchedExchangeTrade = null;
    if (Array.isArray(recentTrades) && recentTrades.length > 0) {
      // Find crossing liquidity from real exchange trade tape
      const opposing = recentTrades.filter(t => order.side === 'BUY' ? t.side === 'SELL' : t.side === 'BUY');
      matchedExchangeTrade = opposing.length > 0 ? opposing[0] : recentTrades[0];
      fillPriceLit = matchedExchangeTrade.price;
    } else {
      // Order book spread + microstructure impact
      const litImpact = (sliceSizeETH / 10) * 0.25;
      fillPriceLit = order.side === 'BUY'
        ? currentPrice + (spread / 2) + litImpact
        : currentPrice - (spread / 2) - litImpact;
    }

    const binanceAlloc = remainingToRoute * 0.60;
    const coinbaseAlloc = remainingToRoute * 0.25;
    const bybitAlloc = remainingToRoute * 0.15;

    if (binanceAlloc > 0.005) {
      venueFills.push({
        venue: 'Binance L2 Depth',
        size: Math.round(binanceAlloc * 1000) / 1000,
        price: Math.round(fillPriceLit * 100) / 100,
        feeBps: 2.0,
        tradeId: matchedExchangeTrade ? matchedExchangeTrade.tradeId || matchedExchangeTrade.time : undefined,
      });
    }
    if (coinbaseAlloc > 0.005) {
      venueFills.push({
        venue: 'Coinbase L2 Depth',
        size: Math.round(coinbaseAlloc * 1000) / 1000,
        price: Math.round(fillPriceLit * 100) / 100,
        feeBps: 3.5,
      });
    }
    if (bybitAlloc > 0.005) {
      venueFills.push({
        venue: 'Bybit L2 Depth',
        size: Math.round(bybitAlloc * 1000) / 1000,
        price: Math.round(fillPriceLit * 100) / 100,
        feeBps: 2.5,
      });
    }

    // Compute effective weighted execution price of this slice
    let totalWeightedVal = 0;
    let totalSliceFilled = 0;
    for (const f of venueFills) {
      totalWeightedVal += f.size * f.price;
      totalSliceFilled += f.size;
    }
    const effectiveSlicePrice = totalSliceFilled > 0 ? totalWeightedVal / totalSliceFilled : currentPrice;

    // Update parent order tracking
    order.executedETH += sliceSizeETH;
    order.remainingETH = Math.max(0, order.totalSizeETH - order.executedETH);
    order.executedWeightedPrice = ((order.executedWeightedPrice * (order.executedETH - sliceSizeETH)) + (effectiveSlicePrice * sliceSizeETH)) / order.executedETH;

    // Slippage vs Arrival Price in basis points
    const slippageBps = order.arrivalPrice > 0
      ? ((effectiveSlicePrice - order.arrivalPrice) / order.arrivalPrice) * 10000 * (order.side === 'BUY' ? 1 : -1)
      : 0;

    this.realizedSlippageBps = Math.round(slippageBps * 10) / 10;
    this.effectiveVWAP = Math.round(order.executedWeightedPrice * 100) / 100;

    const isComplete = order.remainingETH <= 0.005 || order.currentSlice >= T;
    if (isComplete) {
      this.executionLog.unshift({
        side: order.side,
        totalSizeETH: Math.round(order.executedETH * 1000) / 1000,
        arrivalPrice: Math.round(order.arrivalPrice * 100) / 100,
        avgPrice: Math.round(order.executedWeightedPrice * 100) / 100,
        slippageBps: this.realizedSlippageBps,
        mode: order.mode,
        ts: new Date().toTimeString().split(' ')[0],
      });
      if (this.executionLog.length > 20) this.executionLog.pop();
      this.activeOrder = null;
    }

    return {
      active: !isComplete,
      sliceETH: Math.round(sliceSizeETH * 1000) / 1000,
      remainingETH: Math.round((order ? order.remainingETH : 0) * 1000) / 1000,
      effectivePrice: Math.round(effectiveSlicePrice * 100) / 100,
      slippageBps: this.realizedSlippageBps,
      venueFills,
      progressPct: Math.round((order ? (order.executedETH / order.totalSizeETH) : 1) * 100),
      acTrajectory: this.acTrajectory,
    };
  }
}
