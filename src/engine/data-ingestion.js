// ═══════════════════════════════════════════════════════
// LAYER 1: DATA INGESTION ENGINE
// High-Frequency Market Microstructure & Quantitative Data Feeds
// Strictly Numeric: L2/L3 Order Book, Depth, Micro-Price, Funding, OI, Liquidations, Dark Pool
// (NO News / NLP feeds)
// ═══════════════════════════════════════════════════════

import { clamp, rnd, gaussian } from '../utils/math.js';

export class DataIngestionEngine {
  constructor() {
    this.depthLevels = 10;
    this.orderBook = {
      bids: [], // [{ price, size, orders }]
      asks: [],
      microPrice: 0,
      midPrice: 0,
      spread: 0,
      totalBidVol: 0,
      totalAskVol: 0,
    };

    // Alternative quantitative feeds
    this.quantFeeds = {
      fundingRate: 0.00012,       // 0.012% per 8h
      annualizedFunding: 0.1314,  // ~13.14% APR
      openInterestETH: 482500,    // Open Interest in ETH
      deltaOI: 1250,              // 1m change in OI
      liquidationsLong: 142000,   // USD value of longs liquidated last hour
      liquidationsShort: 38000,   // USD value of shorts liquidated last hour
      darkPoolPrints: [],         // Institutional block trades / ATS prints
      blockTradeVol24h: 184500000,// $184.5M institutional volume
    };

    this.tickCount = 0;
    this.tradesStream = [];
  }

  /**
   * Process a tick: generate updated L2/L3 order book and quant feeds
   * @param {number} midPrice Current simulated mid price
   */
  update(midPrice) {
    this.tickCount++;

    // 1. Generate L2/L3 Order Book (10 levels)
    const bids = [];
    const asks = [];
    const baseSpread = Math.max(0.1, 0.25 + Math.sin(this.tickCount / 15) * 0.15 + rnd(-0.05, 0.05));
    const halfSpread = baseSpread / 2;

    let totalBidVol = 0;
    let totalAskVol = 0;

    for (let i = 0; i < this.depthLevels; i++) {
      // Non-linear depth step
      const step = (i + 1) * (0.35 + rnd(-0.05, 0.05));
      const bidPrice = Math.round((midPrice - halfSpread - step) * 100) / 100;
      const askPrice = Math.round((midPrice + halfSpread + step) * 100) / 100;

      // Realistic volume profiles (increasing with distance from mid price)
      const depthFactor = Math.pow(1.2, i);
      const bidSize = Math.max(1.5, Math.round((8 + depthFactor * 4 + rnd(-2, 5)) * 100) / 100);
      const askSize = Math.max(1.5, Math.round((8 + depthFactor * 4 + rnd(-2, 5)) * 100) / 100);

      const bidOrders = Math.max(1, Math.round(bidSize * 0.8 + rnd(1, 4)));
      const askOrders = Math.max(1, Math.round(askSize * 0.8 + rnd(1, 4)));

      bids.push({ price: bidPrice, size: bidSize, orders: bidOrders });
      asks.push({ price: askPrice, size: askSize, orders: askOrders });

      totalBidVol += bidSize;
      totalAskVol += askSize;
    }

    // Top of book
    const bestBid = bids[0].price;
    const bestAsk = asks[0].price;
    const bestBidSize = bids[0].size;
    const bestAskSize = asks[0].size;
    const spread = Math.max(0.01, bestAsk - bestBid);

    // Micro-price calculation (Volume-weighted top of book price)
    // P_micro = (V_bid * P_ask + V_ask * P_bid) / (V_bid + V_ask)
    const microPrice = (bestBidSize * bestAsk + bestAskSize * bestBid) / (bestBidSize + bestAskSize);

    this.orderBook = {
      bids,
      asks,
      bestBid,
      bestAsk,
      bestBidSize,
      bestAskSize,
      spread: Math.round(spread * 100) / 100,
      midPrice: (bestBid + bestAsk) / 2,
      microPrice: Math.round(microPrice * 100) / 100,
      totalBidVol: Math.round(totalBidVol * 10) / 10,
      totalAskVol: Math.round(totalAskVol * 10) / 10,
    };

    // 2. Generate simulated tick trade stream
    const numTrades = Math.floor(rnd(1, 4));
    for (let t = 0; t < numTrades; t++) {
      const isBuy = Math.random() > 0.48;
      const tradePrice = isBuy ? bestAsk : bestBid;
      const tradeSize = Math.round((rnd(0.2, 8.5)) * 100) / 100;
      this.tradesStream.unshift({
        time: Date.now(),
        price: tradePrice,
        size: tradeSize,
        side: isBuy ? 'BUY' : 'SELL',
      });
    }
    if (this.tradesStream.length > 50) this.tradesStream.length = 50;

    // 3. Alternative Quantitative Feeds Updates
    // Funding rate dynamics (drifts with momentum)
    const priceDrift = (midPrice - 3200) / 3200;
    this.quantFeeds.fundingRate = clamp(0.0001 + priceDrift * 0.0003 + gaussian(0, 0.00002), -0.0008, 0.0012);
    this.quantFeeds.annualizedFunding = this.quantFeeds.fundingRate * 3 * 365;

    // Open Interest dynamics
    const dOI = Math.round(gaussian(0, 450) + (priceDrift > 0 ? 300 : -200));
    this.quantFeeds.openInterestETH = Math.max(300000, this.quantFeeds.openInterestETH + dOI);
    this.quantFeeds.deltaOI = dOI;

    // Liquidation events (cluster during high volatility)
    if (Math.random() < 0.15) {
      if (Math.random() > 0.5) {
        this.quantFeeds.liquidationsLong += Math.round(rnd(15000, 120000));
      } else {
        this.quantFeeds.liquidationsShort += Math.round(rnd(12000, 95000));
      }
    }
    // Gradual decay of liquidation totals
    this.quantFeeds.liquidationsLong *= 0.985;
    this.quantFeeds.liquidationsShort *= 0.985;

    // Dark Pool / Block prints (large institutional ATS trades)
    if (Math.random() < 0.25) {
      const blockSide = Math.random() > 0.49 ? 'BUY' : 'SELL';
      const blockSize = Math.round(rnd(45, 380));
      const blockPrice = Math.round((midPrice + rnd(-0.8, 0.8)) * 100) / 100;
      const venue = ['Liquidnet ATS', 'B2C2 Dark', 'Wintermute OTC', 'Paradigm Block'][Math.floor(rnd(0, 4))];

      this.quantFeeds.darkPoolPrints.unshift({
        ts: new Date().toTimeString().split(' ')[0],
        venue,
        side: blockSide,
        size: blockSize,
        price: blockPrice,
        notionalUSD: Math.round(blockSize * blockPrice),
      });
      if (this.quantFeeds.darkPoolPrints.length > 20) this.quantFeeds.darkPoolPrints.pop();
      this.quantFeeds.blockTradeVol24h += blockSize * blockPrice;
    }

    return {
      orderBook: this.orderBook,
      quantFeeds: this.quantFeeds,
      recentTrades: this.tradesStream.slice(0, 10),
    };
  }
}
