// ═══════════════════════════════════════════════════════
// MULTI-TIMEFRAME ENGINE (1h, 30m, 15m, 3m, 1m)
// Manages synchronized candle series across 5 timeframes
// Computes Multi-Timeframe Candlestick Pattern Confluence
// ═══════════════════════════════════════════════════════

import { CandlestickPatternEngine } from './candlesticks.js';
import { clamp } from '../utils/math.js';
import { STATE } from '../state.js';

export const TIMEFRAMES = ['1h', '30m', '15m', '3m', '1m'];

export const TF_SECONDS = {
  '1h': 3600,
  '30m': 1800,
  '15m': 900,
  '3m': 180,
  '1m': 60,
};

export class MultiTimeframeEngine {
  constructor() {
    this.patternEngine = new CandlestickPatternEngine();

    // In-memory candle stores for each timeframe
    this.candles = {
      '1h': [],
      '30m': [],
      '15m': [],
      '3m': [],
      '1m': [],
    };

    // Active candle being built
    this.activeCandles = {
      '1m': null,
      '3m': null,
      '15m': null,
      '30m': null,
      '1h': null,
    };

    this.confluenceScore = 0; // [-1, 1]
    this.alignment = 'MIXED';
    this.tfAnalysis = {
      '1h': { score: 0, trend: 'FLAT', patterns: [] },
      '30m': { score: 0, trend: 'FLAT', patterns: [] },
      '15m': { score: 0, trend: 'FLAT', patterns: [] },
      '3m': { score: 0, trend: 'FLAT', patterns: [] },
      '1m': { score: 0, trend: 'FLAT', patterns: [] },
    };

    const initialP = (typeof STATE !== 'undefined' && (STATE.price || (STATE.prices && STATE.prices.length > 0 ? STATE.prices[STATE.prices.length - 1] : 0))) || 2500.00;
    this.initHistoricalCandles(initialP);
  }

  /**
   * Load actual real historical candles directly from Binance API
   */
  loadBinanceKlines(tf, rawKlines) {
    if (!TIMEFRAMES.includes(tf) || !Array.isArray(rawKlines) || rawKlines.length === 0) return;
    this.candles[tf] = rawKlines.map(k => ({
      timestamp: k[0],
      open: parseFloat(k[1]),
      high: parseFloat(k[2]),
      low: parseFloat(k[3]),
      close: parseFloat(k[4]),
      volume: parseFloat(k[5]),
    }));
  }

  /**
   * Seed realistic initial historical candles across all 4 timeframes
   */
  initHistoricalCandles(currentPrice = ((typeof STATE !== 'undefined' && (STATE.price || (STATE.prices && STATE.prices.length > 0 ? STATE.prices[STATE.prices.length - 1] : 0))) || 2500.00)) {
    const counts = { '1m': 60, '3m': 60, '15m': 60, '30m': 60, '1h': 60 };
    const now = Date.now();
    const baseP = parseFloat(currentPrice) || 2500.00;

    for (const tf of TIMEFRAMES) {
      let p = baseP - (Math.random() - 0.5) * (baseP * 0.008);
      const stepSec = TF_SECONDS[tf];
      this.candles[tf] = [];

      for (let i = 0; i < counts[tf]; i++) {
        const t = now - (counts[tf] - i) * stepSec * 1000;
        const drift = (Math.sin(i / 8) + Math.cos(i / 14)) * (stepSec / 100);
        const open = p;
        p = Math.max(baseP * 0.5, p + drift + (Math.random() - 0.48) * (stepSec / 80));
        const close = p;
        const high = Math.max(open, close) + Math.random() * (stepSec / 120) + 1;
        const low = Math.min(open, close) - Math.random() * (stepSec / 120) - 1;
        const volume = Math.round(1000 + Math.random() * 4000 * (stepSec / 60));

        this.candles[tf].push({
          timestamp: t,
          open: Math.round(open * 100) / 100,
          high: Math.round(high * 100) / 100,
          low: Math.round(low * 100) / 100,
          close: Math.round(close * 100) / 100,
          volume,
        });
      }
    }
  }

  /**
   * Process a new live price tick and update all 5 timeframes
   * @param {number} price Current mid price
   * @param {number} volume Tick volume
   */
  update(price, volume = 50) {
    const now = Date.now();

    for (const tf of TIMEFRAMES) {
      const stepMs = TF_SECONDS[tf] * 1000;
      let active = this.activeCandles[tf];

      if (!active || now - active.startTime >= stepMs) {
        // Roll current active candle into historical array
        if (active) {
          this.candles[tf].push({
            timestamp: active.startTime,
            open: active.open,
            high: active.high,
            low: active.low,
            close: active.close,
            volume: active.volume,
          });
          if (this.candles[tf].length > 120) this.candles[tf].shift();
        }

        // Start new active candle
        this.activeCandles[tf] = {
          startTime: Math.floor(now / stepMs) * stepMs,
          open: price,
          high: price,
          low: price,
          close: price,
          volume: volume,
        };
      } else {
        // Update active candle in progress
        active.high = Math.max(active.high, price);
        active.low = Math.min(active.low, price);
        active.close = price;
        active.volume += volume;
      }

      // Run Candlestick Pattern Engine for this timeframe
      const fullSeries = [...this.candles[tf], this.activeCandles[tf]];
      const analysis = this.patternEngine.detectPatterns(fullSeries);

      // Determine timeframe trend
      const n = fullSeries.length;
      const tfTrend = n >= 10
        ? (fullSeries[n - 1].close > fullSeries[n - 6].close ? 'UP' : fullSeries[n - 1].close < fullSeries[n - 6].close ? 'DOWN' : 'FLAT')
        : 'FLAT';

      this.tfAnalysis[tf] = {
        score: analysis.score,
        trend: tfTrend,
        patterns: analysis.patterns.slice(0, 3), // top patterns
        lastCandle: this.activeCandles[tf],
      };
    }

    // ── MULTI-TIMEFRAME CONFLUENCE SYNTHESIS ──
    // 30% 1h (Macro) + 25% 30m (Structure) + 20% 15m (Momentum) + 15% 3m (Execution Trigger) + 10% 1m (Micro-Scalp)
    const s1h = this.tfAnalysis['1h'].score;
    const s30m = this.tfAnalysis['30m'].score;
    const s15m = this.tfAnalysis['15m'].score;
    const s3m = this.tfAnalysis['3m'].score;
    const s1m = this.tfAnalysis['1m'].score;

    this.confluenceScore = clamp(
      0.30 * s1h +
      0.25 * s30m +
      0.20 * s15m +
      0.15 * s3m +
      0.10 * s1m,
      -1, 1
    );

    // Confluence Alignment check across all 5 timeframes
    const bullishCount = [s1h > 0.1, s30m > 0.1, s15m > 0.1, s3m > 0.1, s1m > 0.1].filter(Boolean).length;
    const bearishCount = [s1h < -0.1, s30m < -0.1, s15m < -0.1, s3m < -0.1, s1m < -0.1].filter(Boolean).length;

    if (bullishCount >= 4) {
      this.alignment = bullishCount === 5 ? 'STRONG BULLISH CONFLUENCE (5/5)' : 'BULLISH CONFLUENCE (4/5)';
    } else if (bearishCount >= 4) {
      this.alignment = bearishCount === 5 ? 'STRONG BEARISH CONFLUENCE (5/5)' : 'BEARISH CONFLUENCE (4/5)';
    } else {
      this.alignment = 'MIXED TIMEFRAMES';
    }

    return {
      candles: this.candles,
      activeCandles: this.activeCandles,
      tfAnalysis: this.tfAnalysis,
      confluenceScore: Math.round(this.confluenceScore * 1000) / 1000,
      alignment: this.alignment,
    };
  }

  /**
   * Get candles for a specific requested timeframe
   */
  getCandles(tf = '15m') {
    const base = this.candles[tf] || this.candles['15m'] || [];
    const active = this.activeCandles[tf];
    return active ? [...base, active] : base;
  }
}
