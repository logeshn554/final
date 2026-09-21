// ═════════════════════════════════════════════════════════════════════
// MULTI-EXCHANGE RESILIENT LIVE MARKET CONNECTOR (BINANCE + COINBASE + BYBIT)
// Real-Time Live ETH/USDT (ETH/USD): Ticker, L2 Depth, Real-Time Trades, Multi-TF Klines
// 100% Public Data · Automatic failover if regional ISP blocks Binance (e.g. India / US)
// True Liveness & Network Connection Supervisor (Pauses on Network Disconnect)
// ═════════════════════════════════════════════════════════════════════

import { STATE, log } from '../state.js';

export class BinanceLiveStream {
  constructor() {
    this.ws = null;
    this.wsDepth = null;
    this.wsTrades = null;
    this.wsBtcTicker = null;
    this.cbWs = null;

    this.activeProvider = 'DETECTING'; // 'BINANCE' | 'COINBASE' | 'BYBIT' | 'MOCK'
    this.isConnected = false;
    this.lastMsgTime = 0;
    this.watchdogTimer = null;
    this.heartbeatTimer = null;
    this.callbacks = { onTicker: null, onDepth: null, onTrade: null, onBtcTicker: null, onStatus: null };
    this.onStatusChange = () => {};

    // Endpoints
    this.binanceRestUrls = [
      'https://data-api.binance.vision',
      'https://api.binance.com',
      'https://api1.binance.com',
      'https://api2.binance.com',
    ];
    this.binanceWsUrls = [
      'wss://stream.binance.com:443/ws',
      'wss://stream.binance.vision/ws',
      'wss://stream.binance.com:9443/ws',
    ];

    this.coinbaseWsUrl = 'wss://ws-feed.exchange.coinbase.com';
    this.coinbaseRestBase = 'https://api.exchange.coinbase.com';
    this.bybitRestBase = 'https://api.bybit.com';
    this.binanceFuturesUrls = [
      'https://fapi.binance.com',
      'https://fapi.binance.vision',
    ];
    this._derivativesSyncCounter = 0;
    this.isBinanceBlocked = false;
    this.isBinanceFuturesBlocked = false;
  }

  /**
   * Check if client browser is currently online
   */
  isBrowserOnline() {
    return typeof navigator !== 'undefined' ? (navigator.onLine !== false) : true;
  }

  /**
   * Fetch with timeout helper
   */
  async fetchWithTimeout(url, options = {}, timeoutMs = 1200) {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { ...options, signal: controller.signal, cache: 'no-cache' });
      clearTimeout(id);
      if (res.ok) return await res.json();
      return null;
    } catch (e) {
      clearTimeout(id);
      return null;
    }
  }

  /**
   * Fetch from Binance mirrors (with instant failover if blocked)
   */
  async fetchBinance(path) {
    if (this.isBinanceBlocked) return null;
    for (const base of this.binanceRestUrls) {
      try {
        const data = await this.fetchWithTimeout(`${base}${path}`, {}, 1200);
        if (data) return data;
      } catch (e) {}
    }
    this.isBinanceBlocked = true;
    return null;
  }

  /**
   * Fetch from Coinbase API
   */
  async fetchCoinbase(path) {
    try {
      return await this.fetchWithTimeout(`${this.coinbaseRestBase}${path}`, {}, 1200);
    } catch (e) {
      return null;
    }
  }

  /**
   * Fetch from Bybit API
   */
  async fetchBybit(path) {
    try {
      return await this.fetchWithTimeout(`${this.bybitRestBase}${path}`, {}, 1500);
    } catch (e) {
      return null;
    }
  }

  /**
   * Fetch from Binance Futures (Derivatives) mirrors (with instant failover if blocked)
   */
  async fetchBinanceFutures(path) {
    if (this.isBinanceFuturesBlocked) return null;
    for (const base of this.binanceFuturesUrls) {
      try {
        const data = await this.fetchWithTimeout(`${base}${path}`, {}, 1200);
        if (data) return data;
      } catch (e) {}
    }
    this.isBinanceFuturesBlocked = true;
    return null;
  }

  /**
   * Synchronize real derivatives data: Funding Rate & Open Interest
   */
  async syncDerivatives() {
    if (!this.isBrowserOnline()) return;

    try {
      // 1. Try Bybit Linear derivatives first (globally accessible, unblocked)
      const bybitDeriv = await this.fetchBybit('/v5/market/tickers?category=linear&symbol=ETHUSDT');
      if (bybitDeriv?.result?.list?.[0]) {
        const d = bybitDeriv.result.list[0];
        if (d.fundingRate !== undefined) {
          const f = parseFloat(d.fundingRate);
          STATE.layer1.quantFeeds.fundingRate = f;
          STATE.layer1.quantFeeds.annualizedFunding = f * 3 * 365;
          STATE.layer1.quantFeeds.fundingStatus = 'REAL_LIVE_BYBIT';
        }
        if (d.openInterest !== undefined) {
          const newOI = parseFloat(d.openInterest);
          const prevOI = STATE.layer1.quantFeeds.openInterestETH || newOI;
          STATE.layer1.quantFeeds.deltaOI = Math.round(newOI - prevOI);
          STATE.layer1.quantFeeds.openInterestETH = Math.round(newOI);
          STATE.layer1.quantFeeds.oiStatus = 'REAL_LIVE_BYBIT';
        }
        if (STATE.dataFeedTimes) STATE.dataFeedTimes.derivativesTime = Date.now();
        return;
      }

      // 2. Try Binance Futures only if Bybit fails and Binance is not blocked
      if (!this.isBinanceFuturesBlocked) {
        const prem = await this.fetchBinanceFutures('/fapi/v1/premiumIndex?symbol=ETHUSDT');
        if (prem && prem.lastFundingRate !== undefined) {
          const fundingRate = parseFloat(prem.lastFundingRate);
          const markPrice = prem.markPrice ? parseFloat(prem.markPrice) : STATE.price;
          const nextFundingTime = prem.nextFundingTime ? parseInt(prem.nextFundingTime) : 0;

          STATE.layer1.quantFeeds.fundingRate = fundingRate;
          STATE.layer1.quantFeeds.annualizedFunding = fundingRate * 3 * 365;
          STATE.layer1.quantFeeds.markPrice = markPrice;
          STATE.layer1.quantFeeds.nextFundingTime = nextFundingTime;
          STATE.layer1.quantFeeds.fundingStatus = 'REAL_LIVE_BINANCE';
          if (STATE.dataFeedTimes) STATE.dataFeedTimes.derivativesTime = Date.now();
        }

        const oi = await this.fetchBinanceFutures('/fapi/v1/openInterest?symbol=ETHUSDT');
        if (oi && oi.openInterest) {
          const newOI = parseFloat(oi.openInterest);
          const prevOI = STATE.layer1.quantFeeds.openInterestETH || newOI;
          STATE.layer1.quantFeeds.deltaOI = Math.round(newOI - prevOI);
          STATE.layer1.quantFeeds.openInterestETH = Math.round(newOI);
          STATE.layer1.quantFeeds.oiStatus = 'REAL_LIVE_BINANCE';
          if (STATE.dataFeedTimes) STATE.dataFeedTimes.derivativesTime = Date.now();
          return;
        }
      }
    } catch (e) {
      if (!STATE.layer1.quantFeeds.fundingStatus) {
        STATE.layer1.quantFeeds.fundingStatus = 'UNAVAILABLE';
      }
    }
  }

  /**
   * Synchronize ETH ticker from fastest available exchange
   */
  async syncTicker() {
    if (!this.isBrowserOnline()) return null;

    const t0 = performance.now();

    // 1. Try Bybit Spot first (fast, unblocked globally)
    const byData = await this.fetchBybit('/v5/market/tickers?category=spot&symbol=ETHUSDT');
    if (byData?.result?.list?.[0]?.lastPrice) {
      const row = byData.result.list[0];
      const livePrice = parseFloat(row.lastPrice);
      const high24 = parseFloat(row.highPrice24h);
      const low24 = parseFloat(row.lowPrice24h);
      const vol24 = parseFloat(row.volume24h);
      const lat = Math.round(performance.now() - t0);

      this.recordLivePrice(livePrice, high24, low24, vol24, 'BYBIT', lat);
      return livePrice;
    }

    // 2. Try Coinbase
    const cbData = await this.fetchCoinbase('/products/ETH-USD/ticker');
    if (cbData && cbData.price) {
      const livePrice = parseFloat(cbData.price);
      const high24 = cbData.high_24h ? parseFloat(cbData.high_24h) : livePrice * 1.02;
      const low24 = cbData.low_24h ? parseFloat(cbData.low_24h) : livePrice * 0.98;
      const vol24 = cbData.volume ? parseFloat(cbData.volume) : 50000;
      const lat = Math.round(performance.now() - t0);

      this.recordLivePrice(livePrice, high24, low24, vol24, 'COINBASE', lat);
      return livePrice;
    }

    // 3. Try Binance only if others fail and not blocked
    if (!this.isBinanceBlocked) {
      const bData = await this.fetchBinance('/api/v3/ticker/24hr?symbol=ETHUSDT');
      if (bData && bData.lastPrice) {
        const livePrice = parseFloat(bData.lastPrice);
        const high24 = parseFloat(bData.highPrice);
        const low24 = parseFloat(bData.lowPrice);
        const vol24 = parseFloat(bData.volume);
        const lat = Math.round(performance.now() - t0);

        this.recordLivePrice(livePrice, high24, low24, vol24, 'BINANCE', lat);
        return livePrice;
      }
    }

    return null;
  }

  /**
   * Synchronize BTC ticker from fastest available exchange
   */
  async syncBtcTicker() {
    if (!this.isBrowserOnline()) return;

    // 1. Try Bybit
    const byData = await this.fetchBybit('/v5/market/tickers?category=spot&symbol=BTCUSDT');
    if (byData?.result?.list?.[0]?.lastPrice) {
      this.recordBtcPrice(parseFloat(byData.result.list[0].lastPrice));
      return;
    }

    // 2. Try Coinbase
    const cbData = await this.fetchCoinbase('/products/BTC-USD/ticker');
    if (cbData && cbData.price) {
      this.recordBtcPrice(parseFloat(cbData.price));
      return;
    }

    // 3. Try Binance only if not blocked
    if (!this.isBinanceBlocked) {
      const bData = await this.fetchBinance('/api/v3/ticker/price?symbol=BTCUSDT');
      if (bData && bData.price) {
        this.recordBtcPrice(parseFloat(bData.price));
      }
    }
  }

  /**
   * Synchronize L2 Order Book
   */
  async syncDepth() {
    if (!this.isBrowserOnline()) return;

    // 1. Try Bybit Depth
    const byDepth = await this.fetchBybit('/v5/market/orderbook?category=spot&symbol=ETHUSDT&limit=20');
    if (byDepth?.result?.b && byDepth?.result?.a) {
      this.applyDepthData(byDepth.result.b, byDepth.result.a);
      return;
    }

    // 2. Try Coinbase Depth
    const cbDepth = await this.fetchCoinbase('/products/ETH-USD/book?level=2');
    if (cbDepth && cbDepth.bids && cbDepth.asks) {
      this.applyDepthData(cbDepth.bids, cbDepth.asks);
      return;
    }

    // 3. Try Binance Depth only if not blocked
    if (!this.isBinanceBlocked) {
      const bDepth = await this.fetchBinance('/api/v3/depth?symbol=ETHUSDT&limit=20');
      if (bDepth && bDepth.bids && bDepth.asks) {
        this.applyDepthData(bDepth.bids, bDepth.asks);
      }
    }
  }

  /**
   * Synchronize recent real trades
   */
  async syncTrades() {
    if (!this.isBrowserOnline()) return;

    // 1. Try Coinbase Trades
    const cbTrades = await this.fetchCoinbase('/products/ETH-USD/trades?limit=25');
    if (Array.isArray(cbTrades) && cbTrades.length > 0) {
      for (const item of cbTrades) {
        this.recordTrade({
          time: new Date(item.time).getTime(),
          tradeId: item.trade_id,
          price: parseFloat(item.price),
          size: parseFloat(item.size),
          side: item.side ? item.side.toUpperCase() : 'BUY',
        });
      }
      return;
    }

    // 2. Try Bybit Trades
    const byTrades = await this.fetchBybit('/v5/market/recent-trade?category=spot&symbol=ETHUSDT&limit=25');
    if (byTrades?.result?.list && Array.isArray(byTrades.result.list) && byTrades.result.list.length > 0) {
      for (const item of byTrades.result.list) {
        this.recordTrade({
          time: parseInt(item.time, 10),
          tradeId: item.execId,
          price: parseFloat(item.price),
          size: parseFloat(item.size),
          side: item.side ? item.side.toUpperCase() : 'BUY',
        });
      }
      return;
    }

    // 3. Try Binance Trades only if not blocked
    if (!this.isBinanceBlocked) {
      const bTrades = await this.fetchBinance('/api/v3/trades?symbol=ETHUSDT&limit=25');
      if (Array.isArray(bTrades) && bTrades.length > 0) {
        for (const item of bTrades) {
          this.recordTrade({
            time: item.time,
            tradeId: item.id,
            price: parseFloat(item.price),
            size: parseFloat(item.qty),
            side: item.isBuyerMaker ? 'SELL' : 'BUY',
          });
        }
      }
    }
  }

  /**
   * Synchronize multi-timeframe candles (Bybit primary -> Binance fallback)
   */
  async syncKlines() {
    if (!this.isBrowserOnline()) return;

    const timeframes = ['1h', '30m', '15m', '3m', '1m'];
    for (const tf of timeframes) {
      try {
        let klines = null;

        // 1. Try Bybit spot klines first (unblocked, fast)
        const bybitInterval = tf === '1h' ? '60' : tf === '30m' ? '30' : tf === '15m' ? '15' : tf === '3m' ? '3' : '1';
        const bybitData = await this.fetchBybit(`/v5/market/kline?category=spot&symbol=ETHUSDT&interval=${bybitInterval}&limit=60`);
        if (bybitData?.result?.list && Array.isArray(bybitData.result.list) && bybitData.result.list.length > 0) {
          klines = bybitData.result.list.map(k => [
            parseInt(k[0], 10),
            k[1],
            k[2],
            k[3],
            k[4],
            k[5],
          ]).reverse();
        }

        // 2. Try Binance only if Bybit had no data and Binance is not blocked
        if (!klines && !this.isBinanceBlocked) {
          const rawKlines = await this.fetchBinance(`/api/v3/klines?symbol=ETHUSDT&interval=${tf}&limit=60`);
          if (Array.isArray(rawKlines) && rawKlines.length > 0) {
            klines = rawKlines;
          }
        }

        if (klines && klines.length > 0) {
          if (STATE.mtfEngine && typeof STATE.mtfEngine.loadBinanceKlines === 'function') {
            STATE.mtfEngine.loadBinanceKlines(tf, klines);
            STATE.candles[tf] = STATE.mtfEngine.candles[tf];
          }
          if (STATE.dataFeedTimes) STATE.dataFeedTimes.klinesTime = Date.now();
        }
      } catch (e) {}
    }
  }

  /**
   * Record real live market tick into STATE
   */
  recordLivePrice(livePrice, high24, low24, vol24, provider, latencyMs = 25) {
    if (!livePrice || isNaN(livePrice) || livePrice <= 0) return;

    STATE.price = livePrice;
    if (high24) STATE.high24 = Math.max(STATE.high24 || 0, high24);
    if (low24) STATE.low24 = Math.min(STATE.low24 || 999999, low24);

    STATE.prices.push(livePrice);
    if (STATE.prices.length > 500) STATE.prices.shift();
    if (vol24) {
      STATE.volumes.push(vol24);
      if (STATE.volumes.length > 500) STATE.volumes.shift();
    }

    const now = Date.now();
    this.lastMsgTime = now;
    this.activeProvider = provider;
    if (STATE.dataFeedTimes) STATE.dataFeedTimes.priceTime = now;

    STATE.connection.isOnline = true;
    STATE.connection.status = 'connected';
    STATE.connection.provider = provider;
    STATE.connection.latencyMs = latencyMs;
    STATE.connection.lastHeartbeat = now;
    STATE.connection.packetsReceived++;
    STATE.connection.lastRealPrice = livePrice;
    STATE.connection.errorMessage = '';

    if (!this.isConnected) {
      this.isConnected = true;
      log(`Connected to LIVE ${provider} Market Feed (ETH price: $${livePrice.toFixed(2)})`, 'info');
      this.onStatusChange(true, provider, latencyMs);
    }

    if (this.callbacks.onTicker) {
      this.callbacks.onTicker({ livePrice, high24: STATE.high24, low24: STATE.low24, vol24 });
    }
  }

  recordBtcPrice(btcPrice) {
    if (!btcPrice || isNaN(btcPrice) || btcPrice <= 0) return;
    STATE.btcPrice = btcPrice;
    STATE.btcPrices.push(btcPrice);
    if (STATE.btcPrices.length > 200) STATE.btcPrices.shift();
    if (STATE.dataFeedTimes) STATE.dataFeedTimes.btcTime = Date.now();
    if (this.callbacks.onBtcTicker) this.callbacks.onBtcTicker(btcPrice);
  }

  recordTrade(trade) {
    if (!trade || !trade.price) return;
    if (!STATE.layer1.recentTrades.some(t => t.tradeId === trade.tradeId)) {
      STATE.layer1.recentTrades.unshift(trade);
      if (STATE.layer1.recentTrades.length > 50) STATE.layer1.recentTrades.pop();
      if (STATE.dataFeedTimes) STATE.dataFeedTimes.tradesTime = trade.time || Date.now();
      if (this.callbacks.onTrade) this.callbacks.onTrade(trade);
    }
  }

  applyDepthData(rawBids, rawAsks) {
    try {
      if (!Array.isArray(rawBids) || !Array.isArray(rawAsks)) return;
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

      if (parsedBids.length === 0 || parsedAsks.length === 0) return;

      const bestBid = parsedBids[0]?.price || STATE.price;
      const bestAsk = parsedAsks[0]?.price || STATE.price;
      const spread = Math.max(0.01, bestAsk - bestBid);
      const microPrice = (parsedBids[0].size * bestAsk + parsedAsks[0].size * bestBid) /
                         (parsedBids[0].size + parsedAsks[0].size || 1);

      STATE.spread = Math.round(spread * 100) / 100;
      if (STATE.dataFeedTimes) STATE.dataFeedTimes.depthTime = Date.now();
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
   * Connect to real-time live market stream
   */
  async connect(onStatusChange = () => {}) {
    this.onStatusChange = onStatusChange;

    // Check physical browser connectivity first
    if (!this.isBrowserOnline()) {
      this.handleOffline('Browser network is offline. Live exchange connection paused.');
      return;
    }

    STATE.connection.mode = 'live';
    STATE.connection.status = 'connecting';
    STATE.connection.errorMessage = '';
    log('Connecting to real live market exchanges (Binance / Coinbase / Bybit)...', 'info');

    // 1. Initial REST probe to immediately verify network and get live prices
    const initialPrice = await this.syncTicker();
    await this.syncBtcTicker();
    await this.syncDepth();
    await this.syncTrades();
    await this.syncDerivatives();
    this.syncKlines();

    if (!initialPrice && !this.isBrowserOnline()) {
      this.handleOffline('Unable to reach live market exchanges. Please check your internet connection.');
      return;
    }

    // 2. Start WebSocket feeds (Binance primary with Coinbase fallback)
    this.initWebSockets();

    // 3. Start Connection Supervisor / Heartbeat watchdog
    this.startSupervisor();
  }

  /**
   * Initialize WebSockets with automatic failover
   */
  initWebSockets() {
    this.cleanupWebSockets();

    // Try globally accessible Coinbase WebSocket first (unblocked, zero CORS issues, real-time)
    this.initCoinbaseWebSocket();

    // If Coinbase WS is connecting/open, we are set; otherwise fallback to Binance
    if (!this.cbWs || this.cbWs.readyState > 1) {
      const wsBase = this.binanceWsUrls[0];
      try {
        this.ws = new WebSocket(`${wsBase}/ethusdt@ticker`);
        this.ws.onopen = () => {
          this.activeProvider = 'BINANCE';
          this.lastMsgTime = Date.now();
          log('Binance Live WebSocket connected (Port 443)', 'info');
        };
        this.ws.onmessage = (event) => {
          try {
            const d = JSON.parse(event.data);
            if (d && d.c) {
              const livePrice = parseFloat(d.c);
              const high24 = parseFloat(d.h);
              const low24 = parseFloat(d.l);
              const vol24 = parseFloat(d.q);
              const lat = d.E ? Math.max(1, Math.min(999, Date.now() - d.E)) : 18;
              this.recordLivePrice(livePrice, high24, low24, vol24, 'BINANCE', lat);
            }
          } catch (e) {}
        };
      } catch (e) {}
    }

    // Set a watchdog: if no message arrives from Binance within 3.5s, switch to Coinbase
    if (this.watchdogTimer) clearTimeout(this.watchdogTimer);
    this.watchdogTimer = setTimeout(() => {
      if (Date.now() - this.lastMsgTime > 3500 && this.isBrowserOnline() && this.cbWs === null) {
        log('Binance live stream quiet/restricted. Switching to Coinbase Exchange Feed...', 'info');
        this.initCoinbaseWebSocket();
      }
    }, 3500);
  }

  /**
   * Coinbase Exchange WebSocket (Unblocked globally, zero CORS issues, no auth)
   */
  initCoinbaseWebSocket() {
    if (this.cbWs && this.cbWs.readyState <= 1) return;

    try {
      this.cbWs = new WebSocket(this.coinbaseWsUrl);

      this.cbWs.onopen = () => {
        const subMsg = {
          type: 'subscribe',
          product_ids: ['ETH-USD', 'BTC-USD'],
          channels: ['ticker', 'matches', 'level2_batch'],
        };
        this.cbWs.send(JSON.stringify(subMsg));
        log('Coinbase Exchange Live WebSocket connected & subscribed!', 'info');
      };

      this.cbWs.onmessage = (event) => {
        try {
          const d = JSON.parse(event.data);
          if (!d) return;

          if (d.type === 'ticker' && d.product_id === 'ETH-USD' && d.price) {
            const livePrice = parseFloat(d.price);
            const high24 = d.high_24h ? parseFloat(d.high_24h) : livePrice * 1.02;
            const low24 = d.low_24h ? parseFloat(d.low_24h) : livePrice * 0.98;
            const vol24 = d.volume_24h ? parseFloat(d.volume_24h) : 50000;
            const packetTime = d.time ? new Date(d.time).getTime() : Date.now();
            const lat = Math.max(1, Math.min(999, Date.now() - packetTime));

            this.recordLivePrice(livePrice, high24, low24, vol24, 'COINBASE', lat);
          } else if (d.type === 'ticker' && d.product_id === 'BTC-USD' && d.price) {
            this.recordBtcPrice(parseFloat(d.price));
          } else if (d.type === 'match' && d.product_id === 'ETH-USD') {
            this.recordTrade({
              time: new Date(d.time).getTime(),
              tradeId: d.trade_id,
              price: parseFloat(d.price),
              size: parseFloat(d.size),
              side: d.side ? d.side.toUpperCase() : 'BUY',
            });
          } else if (d.type === 'snapshot' && d.product_id === 'ETH-USD' && d.bids && d.asks) {
            this.applyDepthData(d.bids, d.asks);
          }
        } catch (e) {}
      };

      this.cbWs.onerror = () => {};
      this.cbWs.onclose = () => {
        if (STATE.connection.mode === 'live' && this.isBrowserOnline() && this.activeProvider === 'COINBASE') {
          setTimeout(() => {
            if (STATE.connection.mode === 'live' && this.isBrowserOnline()) {
              this.initCoinbaseWebSocket();
            }
          }, 3000);
        }
      };
    } catch (e) {}
  }

  /**
   * Heartbeat supervisor: continuously validates real network packets
   */
  startSupervisor() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);

    this.heartbeatTimer = setInterval(async () => {
      // 1. Check browser network status
      if (!this.isBrowserOnline()) {
        this.handleOffline('Internet connection disconnected. Live market stream paused.');
        return;
      }

      // 2. If in live mode, check if we haven't received a live packet in > 4.5 seconds
      const elapsed = Date.now() - this.lastMsgTime;
      if (elapsed > 4500) {
        // Feed is quiet or disconnected: poll REST backup
        const polledPrice = await this.syncTicker();
        await this.syncDepth();
        await this.syncBtcTicker();

        if (!polledPrice && elapsed > 10000) {
          // Both WS and REST are unresponsive: mark as disconnected
          this.isConnected = false;
          STATE.connection.status = 'disconnected';
          STATE.connection.errorMessage = 'Live feed disconnected. Retrying...';
          this.onStatusChange(false, 'disconnected');
        }
      }

      // 3. Periodically refresh real multi-timeframe candles (1m, 3m, 15m, 30m, 1h)
      this._klineSyncCounter = (this._klineSyncCounter || 0) + 1;
      if (this._klineSyncCounter >= 8) {
        this._klineSyncCounter = 0;
        this.syncKlines();
      }

      // 4. Periodically refresh real derivatives (Funding rate & Open Interest)
      this._derivativesSyncCounter = (this._derivativesSyncCounter || 0) + 1;
      if (this._derivativesSyncCounter >= 12) {
        this._derivativesSyncCounter = 0;
        this.syncDerivatives();
      }
    }, 2000);
  }

  /**
   * Handle when network connection goes offline
   */
  handleOffline(reason = 'Internet disconnected') {
    this.isConnected = false;
    STATE.connection.isOnline = false;
    STATE.connection.status = 'offline';
    STATE.connection.errorMessage = reason;
    this.cleanupWebSockets();

    this.onStatusChange(false, 'offline');
    log(`🔴 ${reason}`, 'warn');
  }

  /**
   * Clean up all WebSocket connections
   */
  cleanupWebSockets() {
    if (this.ws) { try { this.ws.close(); } catch(e){} this.ws = null; }
    if (this.wsDepth) { try { this.wsDepth.close(); } catch(e){} this.wsDepth = null; }
    if (this.wsTrades) { try { this.wsTrades.close(); } catch(e){} this.wsTrades = null; }
    if (this.wsBtcTicker) { try { this.wsBtcTicker.close(); } catch(e){} this.wsBtcTicker = null; }
    if (this.cbWs) { try { this.cbWs.close(); } catch(e){} this.cbWs = null; }
  }

  /**
   * Pause live stream (e.g. user toggled off or network went down)
   */
  pause() {
    this.cleanupWebSockets();
    if (this.watchdogTimer) clearTimeout(this.watchdogTimer);
    this.isConnected = false;
    STATE.connection.status = 'disconnected';
  }

  /**
   * Reconnect when network returns
   */
  reconnect() {
    log('Network reconnected! Re-establishing live market feed...', 'info');
    STATE.connection.isOnline = true;
    STATE.connection.status = 'connecting';
    this.connect(this.onStatusChange);
  }

  /**
   * Disconnect completely
   */
  disconnect(onStatusChange = () => {}) {
    this.pause();
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
    STATE.connection.status = 'disconnected';
    STATE.connection.provider = 'DISCONNECTED';
    onStatusChange(false);
    log('Live market stream disconnected.', 'info');
  }
}

// Alias for universal naming
export { BinanceLiveStream as LiveMarketStream };
