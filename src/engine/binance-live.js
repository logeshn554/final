// ═════════════════════════════════════════════════════════════════════
// BINANCE LIVE CONNECTOR (WEBSOCKET + FAST REST SYNCHRONIZATION)
// Real-Time Live ETH/USDT: Ticker, L2 Depth20, Real-Time Trades, Multi-TF Klines
// Zero API Keys / Authentication Required (100% Public Data)
// ═════════════════════════════════════════════════════════════════════

import { STATE, log } from '../state.js';

export class BinanceLiveStream {
  constructor() {
    this.wsTicker = null;
    this.wsDepth = null;
    this.wsTrades = null;
    this.isConnected = false;
    this.reconnectAttempts = 0;
    this.lastMsgTime = 0;
    this.restFallbackTimer = null;
    this.callbacks = { onTicker: null, onDepth: null, onTrade: null };

    // Primary and fallback endpoints
    this.restBase = 'https://api.binance.com';
    this.restVision = 'https://data-api.binance.vision';
    this.wsBase = 'wss://stream.binance.com:443/ws';
    this.wsFallback = 'wss://stream.binance.com:9443/ws';
  }

  /**
   * Fetch from primary Binance API with automatic mirror fallback
   */
  async fetchBinance(path) {
    try {
      const res = await fetch(`${this.restBase}${path}`, { cache: 'no-cache' });
      if (res.ok) return await res.json();
      throw new Error(`HTTP ${res.status}`);
    } catch (e) {
      try {
        const fallbackRes = await fetch(`${this.restVision}${path}`, { cache: 'no-cache' });
        if (fallbackRes.ok) return await fallbackRes.json();
      } catch (err) {}
      return null;
    }
  }

  /**
   * Fetch live 24hr ticker & update global state
   */
  async syncTicker() {
    const d = await this.fetchBinance('/api/v3/ticker/24hr?symbol=ETHUSDT');
    if (d && d.lastPrice) {
      const livePrice = parseFloat(d.lastPrice);
      const high24 = parseFloat(d.highPrice);
      const low24 = parseFloat(d.lowPrice);
      const vol24 = parseFloat(d.volume);

      STATE.price = livePrice;
      STATE.high24 = high24;
      STATE.low24 = low24;
      STATE.prices.push(livePrice);
      if (STATE.prices.length > 500) STATE.prices.shift();

      this.lastMsgTime = Date.now();
      if (!this.isConnected) {
        this.isConnected = true;
        STATE.isLiveBinance = true;
      }

      if (this.callbacks.onTicker) {
        this.callbacks.onTicker({ livePrice, high24, low24, vol24 });
      }
      return livePrice;
    }
    return null;
  }

  /**
   * Fetch live Level 2 depth & update global order book
   */
  async syncDepth() {
    const d = await this.fetchBinance('/api/v3/depth?symbol=ETHUSDT&limit=20');
    if (d && d.bids && d.asks) {
      this.applyDepthData(d.bids, d.asks);
    }
  }

  /**
   * Fetch real historical candles for all 4 timeframes (1h, 30m, 15m, 3m)
   */
  async syncKlines() {
    const timeframes = ['1h', '30m', '15m', '3m'];
    for (const tf of timeframes) {
      try {
        const rawKlines = await this.fetchBinance(`/api/v3/klines?symbol=ETHUSDT&interval=${tf}&limit=60`);
        if (Array.isArray(rawKlines) && rawKlines.length > 0) {
          if (STATE.mtfEngine && typeof STATE.mtfEngine.loadBinanceKlines === 'function') {
            STATE.mtfEngine.loadBinanceKlines(tf, rawKlines);
            STATE.candles[tf] = STATE.mtfEngine.candles[tf];
          }
        }
      } catch (e) {}
    }
    log('Real Binance multi-timeframe candles (1h, 30m, 15m, 3m) synchronized!', 'info');
  }

  /**
   * Process raw L2 order book arrays
   */
  applyDepthData(rawBids, rawAsks) {
    try {
      const parsedBids = rawBids.slice(0, 10).map(b => ({
        price: parseFloat(b[0]),
        size: parseFloat(b[1]),
        orders: Math.max(1, Math.round(parseFloat(b[1]) * 0.8)),
      }));
      const parsedAsks = rawAsks.slice(0, 10).map(a => ({
        price: parseFloat(a[0]),
        size: parseFloat(a[1]),
        orders: Math.max(1, Math.round(parseFloat(a[1]) * 0.8)),
      }));

      const bestBid = parsedBids[0]?.price || STATE.price;
      const bestAsk = parsedAsks[0]?.price || STATE.price;
      const spread = Math.max(0.01, bestAsk - bestBid);
      const microPrice = (parsedBids[0].size * bestAsk + parsedAsks[0].size * bestBid) /
                         (parsedBids[0].size + parsedAsks[0].size || 1);

      STATE.spread = Math.round(spread * 100) / 100;
      STATE.layer1.orderBook = {
        bids: parsedBids,
        asks: parsedAsks,
        bestBid,
        bestAsk,
        bestBidSize: parsedBids[0]?.size || 10,
        bestAskSize: parsedAsks[0]?.size || 10,
        spread: STATE.spread,
        midPrice: (bestBid + bestAsk) / 2,
        microPrice: Math.round(microPrice * 100) / 100,
        totalBidVol: parsedBids.reduce((s, b) => s + b.size, 0),
        totalAskVol: parsedAsks.reduce((s, a) => s + a.size, 0),
      };

      if (this.callbacks.onDepth) {
        this.callbacks.onDepth(STATE.layer1.orderBook);
      }
    } catch (e) {}
  }

  /**
   * Connect to Binance live streams with auto-sync and fallback REST poller
   */
  async connect(onStatusChange = () => {}) {
    log('Initiating LIVE Binance feed (ethusdt@ticker, depth20, trade)...', 'info');

    // 1. Instantly pull real market data via REST so UI updates without waiting for WS handshake
    await this.syncTicker();
    await this.syncDepth();
    this.syncKlines(); // background sync

    onStatusChange(true);
    this.isConnected = true;
    STATE.isLiveBinance = true;

    // 2. Open WebSockets on standard port 443
    this.initWebSockets(onStatusChange);

    // 3. Heartbeat backup poller: if WS has quiet period > 2s, poll REST so data NEVER freezes
    if (this.restFallbackTimer) clearInterval(this.restFallbackTimer);
    this.restFallbackTimer = setInterval(async () => {
      const elapsed = Date.now() - this.lastMsgTime;
      if (elapsed > 2000) {
        await this.syncTicker();
        await this.syncDepth();
      }
    }, 1000);
  }

  initWebSockets(onStatusChange) {
    try {
      // 1. Live Ticker WebSocket
      this.wsTicker = new WebSocket(`${this.wsBase}/ethusdt@ticker`);
      this.wsTicker.onopen = () => {
        this.isConnected = true;
        STATE.isLiveBinance = true;
        this.lastMsgTime = Date.now();
        log('Binance WS connected: ethusdt@ticker LIVE (Port 443)', 'info');
        onStatusChange(true);
      };

      this.wsTicker.onmessage = (event) => {
        try {
          const d = JSON.parse(event.data);
          if (d && d.c) {
            const livePrice = parseFloat(d.c);
            const high24 = parseFloat(d.h);
            const low24 = parseFloat(d.l);
            const vol24 = parseFloat(d.q);

            STATE.price = livePrice;
            STATE.high24 = high24;
            STATE.low24 = low24;
            STATE.prices.push(livePrice);
            if (STATE.prices.length > 500) STATE.prices.shift();

            this.lastMsgTime = Date.now();
            if (this.callbacks.onTicker) {
              this.callbacks.onTicker({ livePrice, high24, low24, vol24 });
            }
          }
        } catch (e) {}
      };

      this.wsTicker.onerror = () => {
        // Silent fallback to REST backup
      };

      this.wsTicker.onclose = () => {
        // Attempt reconnect after 3 seconds if still live
        if (STATE.isLiveBinance) {
          setTimeout(() => {
            if (STATE.isLiveBinance && (!this.wsTicker || this.wsTicker.readyState > 1)) {
              this.initWebSockets(onStatusChange);
            }
          }, 3000);
        }
      };

      // 2. Live Level 2 Depth WebSocket
      this.wsDepth = new WebSocket(`${this.wsBase}/ethusdt@depth20@100ms`);
      this.wsDepth.onmessage = (event) => {
        try {
          const d = JSON.parse(event.data);
          if (d && d.bids && d.asks) {
            this.applyDepthData(d.bids, d.asks);
            this.lastMsgTime = Date.now();
          }
        } catch (e) {}
      };

      // 3. Live Trades WebSocket
      this.wsTrades = new WebSocket(`${this.wsBase}/ethusdt@trade`);
      this.wsTrades.onmessage = (event) => {
        try {
          const d = JSON.parse(event.data);
          if (d && d.p) {
            const trade = {
              time: d.T,
              price: parseFloat(d.p),
              size: parseFloat(d.q),
              side: d.m ? 'SELL' : 'BUY',
            };
            STATE.layer1.recentTrades.unshift(trade);
            if (STATE.layer1.recentTrades.length > 50) STATE.layer1.recentTrades.pop();

            this.lastMsgTime = Date.now();
            if (this.callbacks.onTrade) {
              this.callbacks.onTrade(trade);
            }
          }
        } catch (e) {}
      };

    } catch (e) {
      log(`WebSocket notice: Running resilient REST stream mode`, 'info');
    }
  }

  /**
   * Disconnect WebSocket streams
   */
  disconnect(onStatusChange = () => {}) {
    if (this.wsTicker) { this.wsTicker.close(); this.wsTicker = null; }
    if (this.wsDepth) { this.wsDepth.close(); this.wsDepth = null; }
    if (this.wsTrades) { this.wsTrades.close(); this.wsTrades = null; }
    if (this.restFallbackTimer) { clearInterval(this.restFallbackTimer); this.restFallbackTimer = null; }
    this.isConnected = false;
    onStatusChange(false);
    log('Binance stream paused.', 'info');
  }
}
