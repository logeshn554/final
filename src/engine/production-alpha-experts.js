// ═══════════════════════════════════════════════════════════════════════
// PRODUCTION ALPHA EXPERTS
// Specialized production alpha engines for crypto perpetual markets (ETH/USDT)
// 1. Regime-Conditioned Momentum
// 2. Order-Flow / Microstructure Alpha
// 3. Funding / Basis Engine
// 4. Statistical Arbitrage Engine
// 5. Inventory-Aware Market Making
// ═══════════════════════════════════════════════════════════════════════

import { clamp, mean, std } from '../utils/math.js';

export const ALPHA_SOURCE_ROLES = {
  RL_ALPHA: 'RL_ALPHA',
  MARKET_MICROSTRUCTURE: 'MARKET_MICROSTRUCTURE',
  MOMENTUM: 'MOMENTUM',
  FUNDING_BASIS: 'FUNDING_BASIS',
  STAT_ARB: 'STAT_ARB',
  MARKET_MAKING: 'MARKET_MAKING',
  META_LABEL: 'META_LABEL',
  RISK: 'RISK',
  EXECUTION: 'EXECUTION',
};

/**
 * 1. REGIME-CONDITIONED MOMENTUM
 */
export class RegimeConditionedMomentumEngine {
  constructor() {
    this.name = 'RegimeConditionedMomentum';
    this.role = ALPHA_SOURCE_ROLES.MOMENTUM;
  }

  evaluate(ctx = {}) {
    const { prices = [], regime = 'UNKNOWN', atr = 16.0, mtf = {} } = ctx;
    const currentPrice = Number(ctx.price || (prices.length > 0 ? prices[prices.length - 1] : 0));
    const upperRegime = String(regime).toUpperCase();

    // Momentum is only valid in trending / expansion regimes
    const isTrendingRegime = upperRegime.includes('TREND') || upperRegime.includes('BULL') || upperRegime.includes('BEAR') || upperRegime.includes('BREAKOUT');
    if (!isTrendingRegime || prices.length < 20 || currentPrice <= 0) {
      return {
        role: this.role,
        eligible: false,
        direction: 0,
        signal: 'NO_TRADE',
        probability: 0.50,
        expectedMove: 0,
        holdingHorizon: '0m',
        reason: !isTrendingRegime ? `Regime ${upperRegime} does not support momentum` : 'Insufficient price history',
      };
    }

    // Compute returns and EMA slopes
    const pNow = currentPrice;
    const p5 = prices[prices.length - 5] || pNow;
    const p15 = prices[prices.length - 15] || pNow;
    const p20 = prices[prices.length - 20] || pNow;

    const shortMom = (pNow - p5) / (p5 || 1);
    const medMom = (pNow - p15) / (p15 || 1);
    const longMom = (pNow - p20) / (p20 || 1);

    const mtfScore = Number(mtf.confluenceScore || 0);
    const compositeMom = shortMom * 0.45 + medMom * 0.35 + longMom * 0.20 + (mtfScore * 0.002);

    let direction = 0;
    let prob = 0.50;
    if (compositeMom > 0.0015) {
      direction = 1;
      prob = clamp(0.52 + Math.abs(compositeMom) * 40, 0.52, 0.78);
    } else if (compositeMom < -0.0015) {
      direction = -1;
      prob = clamp(0.52 + Math.abs(compositeMom) * 40, 0.52, 0.78);
    }

    const expectedMove = Math.max(atr * 1.25, currentPrice * Math.abs(compositeMom) * 2.5);

    return {
      role: this.role,
      eligible: direction !== 0,
      direction,
      signal: direction > 0 ? 'BUY' : direction < 0 ? 'SELL' : 'NO_TRADE',
      probability: Math.round(prob * 1000) / 1000,
      expectedMove: Math.round(expectedMove * 100) / 100,
      holdingHorizon: '15m-45m',
      reason: direction !== 0 ? `Momentum confirmed in ${upperRegime} (${(compositeMom * 100).toFixed(2)}%)` : 'Momentum flat',
    };
  }
}

/**
 * 2. ORDER-FLOW / MICROSTRUCTURE ALPHA
 */
export class OrderFlowMicrostructureEngine {
  constructor() {
    this.name = 'OrderFlowMicrostructure';
    this.role = ALPHA_SOURCE_ROLES.MARKET_MICROSTRUCTURE;
  }

  evaluate(ctx = {}) {
    const { orderBook = {}, microstructure = {}, recentTrades = [], latencyMs = 50 } = ctx;
    const bids = Array.isArray(orderBook.bids) ? orderBook.bids : [];
    const asks = Array.isArray(orderBook.asks) ? orderBook.asks : [];
    const spread = Number(orderBook.spread || (asks[0]?.price && bids[0]?.price ? asks[0].price - bids[0].price : 0.2));
    const price = Number(ctx.price || orderBook.midPrice || 0);

    const vpin = Number(microstructure.vpin !== undefined ? microstructure.vpin : 0.20);
    const obi = Number(microstructure.obi !== undefined ? microstructure.obi : 0);
    const ofi = Number(microstructure.ofi !== undefined ? microstructure.ofi : 0);

    // Microstructure rejection gates:
    // 1. Spread too wide (> 0.12% of price)
    const maxSpread = price * 0.0012;
    if (spread > maxSpread && maxSpread > 0) {
      return {
        role: this.role,
        eligible: false,
        direction: 0,
        signal: 'NO_TRADE',
        probability: 0.50,
        reason: `Spread $${spread.toFixed(2)} exceeds max allowed $${maxSpread.toFixed(2)}`,
      };
    }

    // 2. Depth too thin
    const totalBidVol = orderBook.totalBidVol || bids.slice(0, 5).reduce((s, b) => s + (b.size || 0), 0);
    const totalAskVol = orderBook.totalAskVol || asks.slice(0, 5).reduce((s, a) => s + (a.size || 0), 0);
    if (totalBidVol < 1.0 || totalAskVol < 1.0) {
      return {
        role: this.role,
        eligible: false,
        direction: 0,
        signal: 'NO_TRADE',
        probability: 0.50,
        reason: 'Order book depth too thin (< 1.0 ETH top-5 levels)',
      };
    }

    // 3. Toxicity gate (VPIN > 0.45 indicates toxic adverse selection)
    if (vpin > 0.45) {
      return {
        role: this.role,
        eligible: false,
        direction: 0,
        signal: 'NO_TRADE',
        probability: 0.40,
        reason: `VPIN toxicity ${(vpin * 100).toFixed(1)}% exceeds safety limit (45%)`,
      };
    }

    // 4. Latency gate (> 500ms)
    if (latencyMs > 500) {
      return {
        role: this.role,
        eligible: false,
        direction: 0,
        signal: 'NO_TRADE',
        probability: 0.50,
        reason: `Market feed latency ${latencyMs}ms exceeds 500ms ceiling`,
      };
    }

    // Signed trade aggressor volume
    let signedTradeVol = 0;
    if (Array.isArray(recentTrades) && recentTrades.length > 0) {
      for (const t of recentTrades.slice(0, 15)) {
        const qty = Number(t.size || t.qty || 1);
        if (t.side === 'BUY') signedTradeVol += qty;
        else if (t.side === 'SELL') signedTradeVol -= qty;
      }
    }

    const flowImbalance = (obi * 0.4) + (clamp(ofi, -1, 1) * 0.3) + (clamp(signedTradeVol / 10, -1, 1) * 0.3);

    let direction = 0;
    let prob = 0.50;
    if (flowImbalance > 0.15) {
      direction = 1;
      prob = clamp(0.53 + flowImbalance * 0.25, 0.53, 0.72);
    } else if (flowImbalance < -0.15) {
      direction = -1;
      prob = clamp(0.53 + Math.abs(flowImbalance) * 0.25, 0.53, 0.72);
    }

    return {
      role: this.role,
      eligible: direction !== 0,
      direction,
      signal: direction > 0 ? 'BUY' : direction < 0 ? 'SELL' : 'NO_TRADE',
      probability: Math.round(prob * 1000) / 1000,
      expectedMove: Math.round(Math.max(1.0, spread * 4) * 100) / 100,
      holdingHorizon: '1m-5m',
      flowImbalance: Math.round(flowImbalance * 100) / 100,
      vpin,
      reason: direction !== 0 ? `Microstructure order-flow confirmed (Imbalance: ${flowImbalance.toFixed(2)})` : 'Microstructure flow neutral',
    };
  }
}

/**
 * 3. FUNDING / BASIS ENGINE
 */
export class FundingBasisEngine {
  constructor() {
    this.name = 'FundingBasis';
    this.role = ALPHA_SOURCE_ROLES.FUNDING_BASIS;
  }

  evaluate(ctx = {}) {
    const { quantFeeds = {}, feeBps = 4.0, hedgeCostBps = 2.0, execCostBps = 1.5 } = ctx;
    const fundingRate = Number(quantFeeds.fundingRate !== null && quantFeeds.fundingRate !== undefined ? quantFeeds.fundingRate : 0);
    const annualizedFunding = Number(quantFeeds.annualizedFunding !== null ? quantFeeds.annualizedFunding : fundingRate * 3 * 365);

    // Carry evaluation: funding per 8h converted to basis points
    // 0.0001 = 0.01% = 1.0 bps
    const grossFundingBps = fundingRate * 10000;
    const totalCostsBps = feeBps + hedgeCostBps + execCostBps;

    // To earn carry: if funding is strongly positive (> costs), short perp / long spot;
    // if strongly negative (< -costs), long perp / short spot.
    const netCarryBps = Math.abs(grossFundingBps) - totalCostsBps;

    if (netCarryBps <= 0.5) {
      return {
        role: this.role,
        eligible: false,
        direction: 0,
        signal: 'NO_TRADE',
        netCarryBps: Math.round(netCarryBps * 10) / 10,
        reason: `Net carry ${netCarryBps.toFixed(1)} bps <= minimum hurdle after fees and costs`,
      };
    }

    // Direction for the perpetual leg
    const direction = fundingRate > 0 ? -1 : 1;
    const prob = clamp(0.55 + (netCarryBps / 20) * 0.2, 0.55, 0.80);

    return {
      role: this.role,
      eligible: true,
      direction,
      signal: direction > 0 ? 'BUY' : 'SELL',
      probability: Math.round(prob * 1000) / 1000,
      grossFundingBps: Math.round(grossFundingBps * 10) / 10,
      netCarryBps: Math.round(netCarryBps * 10) / 10,
      annualizedAPR: `${(annualizedFunding * 100).toFixed(2)}%`,
      holdingHorizon: '8h-24h',
      reason: `Net carry positive (${netCarryBps.toFixed(1)} bps after fees/slippage)`,
    };
  }
}

/**
 * 4. STATISTICAL ARBITRAGE ENGINE
 */
export class StatisticalArbitrageEngine {
  constructor() {
    this.name = 'StatisticalArbitrage';
    this.role = ALPHA_SOURCE_ROLES.STAT_ARB;
  }

  evaluate(ctx = {}) {
    const { statArb = {}, regime = 'UNKNOWN' } = ctx;
    const zScore = Number(statArb.zScore || 0);
    const halfLife = Number(statArb.halfLife || 12.0); // bars or minutes
    const isCointegrated = Boolean(statArb.cointegrated ?? (Math.abs(zScore) < 4.0));
    const upperRegime = String(regime).toUpperCase();

    // Reject stat arb during extreme non-stationary breakout regimes
    if (upperRegime.includes('BREAKOUT') || upperRegime.includes('EXPLOSIVE')) {
      return {
        role: this.role,
        eligible: false,
        direction: 0,
        signal: 'NO_TRADE',
        reason: `Regime ${upperRegime} invalidates cointegration stability`,
      };
    }

    if (!isCointegrated || halfLife > 45 || halfLife < 1) {
      return {
        role: this.role,
        eligible: false,
        direction: 0,
        signal: 'NO_TRADE',
        reason: 'Cointegration relationship not verified or half-life unreasonable',
      };
    }

    // Must exceed entry threshold (|z| >= 1.8) and overcome spread friction
    let direction = 0;
    if (zScore >= 1.85) {
      direction = -1; // Short overpriced asset, expect mean reversion
    } else if (zScore <= -1.85) {
      direction = 1;  // Long underpriced asset, expect mean reversion
    }

    if (direction === 0) {
      return {
        role: this.role,
        eligible: false,
        direction: 0,
        signal: 'NO_TRADE',
        zScore: Math.round(zScore * 100) / 100,
        reason: `Z-score ${zScore.toFixed(2)} inside neutral band [-1.85, 1.85]`,
      };
    }

    const prob = clamp(0.53 + (Math.abs(zScore) - 1.85) * 0.12, 0.53, 0.74);
    return {
      role: this.role,
      eligible: true,
      direction,
      signal: direction > 0 ? 'BUY' : 'SELL',
      probability: Math.round(prob * 1000) / 1000,
      zScore: Math.round(zScore * 100) / 100,
      halfLife,
      holdingHorizon: `${Math.round(halfLife)}m`,
      reason: `Stat-Arb mean reversion triggered (z = ${zScore.toFixed(2)})`,
    };
  }
}

/**
 * 5. INVENTORY-AWARE MARKET MAKING ENGINE
 */
export class InventoryAwareMarketMakingEngine {
  constructor() {
    this.name = 'InventoryMarketMaking';
    this.role = ALPHA_SOURCE_ROLES.MARKET_MAKING;
  }

  evaluate(ctx = {}) {
    const { institutional = {}, orderBook = {}, positionETH = 0, maxPositionETH = 2.0, regime = 'UNKNOWN' } = ctx;
    const upperRegime = String(regime).toUpperCase();

    // Never market-make blindly during strong one-directional trend/momentum
    if (upperRegime.includes('TREND_UP') || upperRegime.includes('TREND_DOWN') || upperRegime.includes('BREAKOUT')) {
      return {
        role: this.role,
        eligible: false,
        direction: 0,
        signal: 'NO_TRADE',
        reason: `Market making disabled during strong trend regime (${upperRegime})`,
      };
    }

    const avellaneda = institutional.avellaneda || {};
    const reservationPrice = Number(avellaneda.reservationPrice || 0);
    const midPrice = Number(orderBook.midPrice || ctx.price || 0);

    if (midPrice <= 0 || reservationPrice <= 0) {
      return {
        role: this.role,
        eligible: false,
        direction: 0,
        signal: 'NO_TRADE',
        reason: 'HJB reservation price not available',
      };
    }

    // Inventory skew: q / q_max
    const inventorySkew = clamp(positionETH / (maxPositionETH || 1), -1, 1);
    const priceSkew = (reservationPrice - midPrice);

    // If reservation price deviates from mid price, quote skews towards flattening inventory
    let direction = 0;
    if (inventorySkew < -0.35 || priceSkew > 0.40) {
      direction = 1; // Under-allocated or reservation price higher -> lean bid
    } else if (inventorySkew > 0.35 || priceSkew < -0.40) {
      direction = -1; // Over-allocated or reservation price lower -> lean ask
    }

    const prob = clamp(0.52 + Math.abs(inventorySkew) * 0.15, 0.52, 0.68);
    return {
      role: this.role,
      eligible: direction !== 0,
      direction,
      signal: direction > 0 ? 'BUY' : direction < 0 ? 'SELL' : 'NO_TRADE',
      probability: Math.round(prob * 1000) / 1000,
      reservationPrice: Math.round(reservationPrice * 100) / 100,
      inventorySkew: Math.round(inventorySkew * 100) / 100,
      reason: direction !== 0 ? `Inventory-aware quote skew (Inv: ${inventorySkew.toFixed(2)})` : 'Inventory neutral',
    };
  }
}
