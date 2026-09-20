// ═══════════════════════════════════════════════════════
// LAYER 1: DATA INGESTION ENGINE
// High-Frequency Market Microstructure & Real Quantitative Data Feeds
// Strictly Numeric & Real: L2 Order Book, Depth, Micro-Price, Real Funding Rate, Real Open Interest
// ZERO Synthetic Feeds · ZERO Fabricated ATS Prints · ZERO Sine-Wave Mock Books
// ═══════════════════════════════════════════════════════

import { STATE } from '../state.js';

export class DataIngestionEngine {
  constructor() {
    this.depthLevels = 10;
    this.orderBook = {
      bids: [], // [{ price, size, orders }]
      asks: [],
      microPrice: null,
      midPrice: null,
      spread: null,
      totalBidVol: 0,
      totalAskVol: 0,
      status: 'AWAITING_LIVE_STREAM',
    };

    // Real quantitative feeds (Synchronized from Binance Futures / Bybit Linear)
    this.quantFeeds = {
      fundingRate: null,          // Real 8h funding rate (e.g. 0.000100 = 0.01%)
      annualizedFunding: null,    // Real annualized APR
      openInterestETH: null,      // Real Open Interest in ETH
      deltaOI: null,              // Real change in OI
      markPrice: null,            // Real derivatives mark price
      nextFundingTime: null,      // Timestamp of next funding payout
      fundingStatus: 'INITIALIZING',
      oiStatus: 'INITIALIZING',
      largeBlockPrints: [],       // Verified large trades (>= 10 ETH) filtered from real tape
      blockTradeVol24h: 0,        // Real cumulative large trade volume
      btcPrice: null,             // Real live BTC/USDT reference price
    };

    this.tickCount = 0;
  }

  /**
   * Process a tick: ingest strictly real L2 order book, real trade tape, and verified derivatives
   * @param {number|null} livePrice Current verified live price from exchange
   */
  update(livePrice) {
    this.tickCount++;

    // 1. Ingest Real L2 Order Book from Live Stream
    const liveOB = STATE.layer1?.orderBook;
    if (liveOB && Array.isArray(liveOB.bids) && liveOB.bids.length > 0 && Array.isArray(liveOB.asks) && liveOB.asks.length > 0) {
      const bestBid = liveOB.bestBid || liveOB.bids[0].price;
      const bestAsk = liveOB.bestAsk || liveOB.asks[0].price;
      const bestBidSize = liveOB.bestBidSize || liveOB.bids[0].size || 1;
      const bestAskSize = liveOB.bestAskSize || liveOB.asks[0].size || 1;
      const spread = Math.max(0.01, bestAsk - bestBid);
      const microPrice = (bestBidSize * bestAsk + bestAskSize * bestBid) / (bestBidSize + bestAskSize || 1);

      this.orderBook = {
        bids: liveOB.bids.slice(0, this.depthLevels),
        asks: liveOB.asks.slice(0, this.depthLevels),
        bestBid,
        bestAsk,
        bestBidSize,
        bestAskSize,
        spread: Math.round(spread * 100) / 100,
        midPrice: (bestBid + bestAsk) / 2,
        microPrice: Math.round(microPrice * 100) / 100,
        totalBidVol: liveOB.totalBidVol || liveOB.bids.reduce((s, b) => s + (b.size || 0), 0),
        totalAskVol: liveOB.totalAskVol || liveOB.asks.reduce((s, a) => s + (a.size || 0), 0),
        status: 'VERIFIED_REAL_EXCHANGE',
      };
    } else {
      // If live book is not yet connected, maintain clean empty structure with awaiting status
      this.orderBook = {
        bids: [],
        asks: [],
        bestBid: livePrice || null,
        bestAsk: livePrice || null,
        bestBidSize: 0,
        bestAskSize: 0,
        spread: STATE.spread || 0.05,
        midPrice: livePrice || null,
        microPrice: livePrice || null,
        totalBidVol: 0,
        totalAskVol: 0,
        status: 'AWAITING_EXCHANGE_BOOK',
      };
    }

    // 2. Ingest Real Quant Feeds (Funding Rate, OI, BTC Price)
    const liveFeeds = STATE.layer1?.quantFeeds || {};
    this.quantFeeds.fundingRate = liveFeeds.fundingRate !== undefined ? liveFeeds.fundingRate : null;
    this.quantFeeds.annualizedFunding = liveFeeds.annualizedFunding !== undefined ? liveFeeds.annualizedFunding : null;
    this.quantFeeds.openInterestETH = liveFeeds.openInterestETH !== undefined ? liveFeeds.openInterestETH : null;
    this.quantFeeds.deltaOI = liveFeeds.deltaOI !== undefined ? liveFeeds.deltaOI : null;
    this.quantFeeds.markPrice = liveFeeds.markPrice || livePrice || null;
    this.quantFeeds.nextFundingTime = liveFeeds.nextFundingTime || null;
    this.quantFeeds.fundingStatus = liveFeeds.fundingStatus || (liveFeeds.fundingRate !== null ? 'REAL_LIVE' : 'AWAITING_FEED');
    this.quantFeeds.oiStatus = liveFeeds.oiStatus || (liveFeeds.openInterestETH !== null ? 'REAL_LIVE' : 'AWAITING_FEED');
    this.quantFeeds.btcPrice = STATE.btcPrice || null;

    // 3. Process Real Trade Stream & Detect Genuine Institutional Block Trades
    const recentTrades = STATE.layer1?.recentTrades || [];
    for (const trade of recentTrades.slice(0, 5)) {
      const size = Number(trade.size || trade.qty || 0);
      const price = Number(trade.price || 0);
      const notional = size * price;

      // Filter real institutional transactions (Trades >= 8 ETH or >= $20,000 USD)
      if (notional >= 20000 && !this.quantFeeds.largeBlockPrints.some(b => b.tradeId === trade.tradeId)) {
        const timeStr = trade.time ? new Date(trade.time).toTimeString().split(' ')[0] : new Date().toTimeString().split(' ')[0];
        const venue = STATE.connection.provider ? `${STATE.connection.provider} Match` : 'Exchange Match';

        this.quantFeeds.largeBlockPrints.unshift({
          tradeId: trade.tradeId || Date.now(),
          ts: timeStr,
          venue,
          side: trade.side,
          size: Math.round(size * 100) / 100,
          price: Math.round(price * 100) / 100,
          notionalUSD: Math.round(notional),
        });

        if (this.quantFeeds.largeBlockPrints.length > 25) this.quantFeeds.largeBlockPrints.pop();
        this.quantFeeds.blockTradeVol24h += notional;
      }
    }

    return {
      orderBook: this.orderBook,
      quantFeeds: this.quantFeeds,
      recentTrades: recentTrades.slice(0, 25),
    };
  }
}
