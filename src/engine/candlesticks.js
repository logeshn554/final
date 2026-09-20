// ═════════════════════════════════════════════════════════════════════
// CANDLESTICK PATTERN RECOGNITION & ANATOMY ENGINE
// Complete Implementation of All Classical & Advanced Institutional Patterns:
// 1. Reversal Patterns (Kicker, Belt Hold, Counterattack, Hammer, Engulfing, Stars)
// 2. Continuation Patterns (Rising/Falling Windows, Tasuki Gaps, Three-Line Strike)
// 3. Doji Variations (Long-Legged, Rickshaw Man, Southern Doji, Doji Stars)
// 4. Complex Patterns (Hikkake False Breakout, Ladder Top/Bottom, Deliberation)
// 5. Candlestick Anatomy: Body Size Momentum, Wick Rejection (>2x Body),
//    Volume-Candle Confluence, Gap Classification, S/R Zones, Reliability Ranking
// ═════════════════════════════════════════════════════════════════════

import { STATE } from '../state.js';

export class CandlestickPatternEngine {
  constructor() {
    this.recentCandles = [];
    this.patternHistory = [];
  }



  /**
   * Convert candle into deep structural and anatomical metrics
   */
  analyzeCandle(c) {
    const body = Math.abs(c.close - c.open);
    const range = Math.max(0.01, c.high - c.low);
    const isBull = c.close >= c.open;
    const isBear = c.close < c.open;
    const upperShadow = isBull ? c.high - c.close : c.high - c.open;
    const lowerShadow = isBull ? c.open - c.low : c.close - c.low;
    const bodyRatio = body / range;
    const upperRatio = upperShadow / range;
    const lowerRatio = lowerShadow / range;
    const isDoji = bodyRatio < 0.08;

    // Wick Rejection Analysis (> 2x Body)
    const upperWickRejection = upperShadow >= Math.max(0.05, body * 2.0); // Bearish rejection of higher prices
    const lowerWickRejection = lowerShadow >= Math.max(0.05, body * 2.0); // Bullish rejection of lower prices

    // Center body offset for Rickshaw Man Doji
    const bodyCenter = (c.open + c.close) / 2;
    const candleCenter = (c.high + c.low) / 2;
    const isRickshawCenter = Math.abs(bodyCenter - candleCenter) / range < 0.08;

    return {
      ...c,
      body,
      range,
      isBull,
      isBear,
      upperShadow,
      lowerShadow,
      bodyRatio,
      upperRatio,
      lowerRatio,
      isDoji,
      upperWickRejection,
      lowerWickRejection,
      isRickshawCenter,
    };
  }

  /**
   * Detect all candlestick patterns and anatomical features across candle history
   * @param {Array<Object>} rawCandles Array of candles [ { open, high, low, close, volume, timestamp } ]
   */
  detectPatterns(rawCandles, saveToHistory = true, timeframe = '15m') {
    if (!rawCandles || rawCandles.length < 5) {
      return { patterns: [], score: 0, lastMetrics: null, activeCandleVerdict: null };
    }

    const n = rawCandles.length;
    const c0 = this.analyzeCandle(rawCandles[n - 1]); // Current active candle
    const c1 = this.analyzeCandle(rawCandles[n - 2]); // Prior candle
    const c2 = this.analyzeCandle(rawCandles[n - 3]); // 2 bars ago
    const c3 = this.analyzeCandle(rawCandles[n - 4]); // 3 bars ago
    const c4 = this.analyzeCandle(rawCandles[n - 5]); // 4 bars ago

    const patterns = [];

    // Prior trend determination
    const priorTrend = c2.close > c4.close ? 'UP' : c2.close < c4.close ? 'DOWN' : 'FLAT';

    // ─────────────────────────────────────────────────────────────────
    // 1. ADVANCED REVERSAL PATTERNS
    // ─────────────────────────────────────────────────────────────────

    // Bullish Kicker (★★★★★ - Strongest bullish reversal)
    // Day 1: Large red in downtrend. Day 2: Gaps UP and opens above Day 1 open (no overlap).
    if (c1.isBear && c0.isBull && c0.open > c1.open && c0.low > c1.high && c1.bodyRatio > 0.45 && c0.bodyRatio > 0.45) {
      patterns.push({
        name: 'Bullish Kicker',
        type: 'BULLISH',
        category: 'Reversal',
        reliability: '★★★★★',
        strength: 0.98,
        desc: 'Extreme institutional sentiment reversal: gapped up and opened above prior open.',
      });
    }

    // Bearish Kicker (★★★★★ - Strongest bearish reversal)
    // Day 1: Large green in uptrend. Day 2: Gaps DOWN and opens below Day 1 open (no overlap).
    if (c1.isBull && c0.isBear && c0.open < c1.open && c0.high < c1.low && c1.bodyRatio > 0.45 && c0.bodyRatio > 0.45) {
      patterns.push({
        name: 'Bearish Kicker',
        type: 'BEARISH',
        category: 'Reversal',
        reliability: '★★★★★',
        strength: 0.98,
        desc: 'Aggressive institutional dumping: gapped down and opened below prior open.',
      });
    }

    // Bullish Belt Hold (Yorikiri)
    // Opens at low of the day (no lower wick), closes near high with long green body after downtrend
    if (c0.isBull && c0.lowerRatio <= 0.04 && c0.bodyRatio >= 0.70 && priorTrend === 'DOWN') {
      patterns.push({
        name: 'Bullish Belt Hold (Yorikiri)',
        type: 'BULLISH',
        category: 'Reversal',
        reliability: '★★★★☆',
        strength: 0.85,
        desc: 'Opened at absolute low and surged upward without looking back.',
      });
    }

    // Bearish Belt Hold
    // Opens at high of the day (no upper wick), closes near low with long red body after uptrend
    if (c0.isBear && c0.upperRatio <= 0.04 && c0.bodyRatio >= 0.70 && priorTrend === 'UP') {
      patterns.push({
        name: 'Bearish Belt Hold',
        type: 'BEARISH',
        category: 'Reversal',
        reliability: '★★★★☆',
        strength: 0.85,
        desc: 'Opened at absolute high and collapsed downward with zero upper wick.',
      });
    }

    // Bullish Counterattack Line
    // c1 large red, c0 large green that opens lower but rallies to close exactly at c1 closing level
    if (c1.isBear && c0.isBull && Math.abs(c0.close - c1.close) / (c1.range || 1) < 0.05 && c0.open < c1.close && c0.bodyRatio > 0.4) {
      patterns.push({
        name: 'Bullish Counterattack Line',
        type: 'BULLISH',
        category: 'Reversal',
        reliability: '★★★★☆',
        strength: 0.82,
        desc: 'Bulls completely neutralize prior heavy selling pressure at support.',
      });
    }

    // Bearish Counterattack Line
    // c1 large green, c0 large red that opens higher but sells off to close exactly at c1 closing level
    if (c1.isBull && c0.isBear && Math.abs(c0.close - c1.close) / (c1.range || 1) < 0.05 && c0.open > c1.close && c0.bodyRatio > 0.4) {
      patterns.push({
        name: 'Bearish Counterattack Line',
        type: 'BEARISH',
        category: 'Reversal',
        reliability: '★★★★☆',
        strength: 0.82,
        desc: 'Bears completely neutralize prior bullish momentum at resistance.',
      });
    }

    // Classic Engulfing Patterns (★★★★☆)
    if (c1.isBear && c0.isBull && c0.open <= c1.close && c0.close >= c1.open && c0.body > c1.body) {
      patterns.push({
        name: 'Bullish Engulfing',
        type: 'BULLISH',
        category: 'Reversal',
        reliability: '★★★★☆',
        strength: 0.88,
        desc: 'Large green candle completely engulfs prior red candle.',
      });
    }
    if (c1.isBull && c0.isBear && c0.open >= c1.close && c0.close <= c1.open && c0.body > c1.body) {
      patterns.push({
        name: 'Bearish Engulfing',
        type: 'BEARISH',
        category: 'Reversal',
        reliability: '★★★★☆',
        strength: 0.88,
        desc: 'Large red candle completely engulfs prior green candle.',
      });
    }

    // Hammer & Shooting Star (★★★☆☆)
    if (c0.lowerWickRejection && c0.upperRatio <= 0.12 && c0.bodyRatio >= 0.15 && priorTrend === 'DOWN') {
      patterns.push({
        name: 'Hammer',
        type: 'BULLISH',
        category: 'Reversal',
        reliability: '★★★☆☆',
        strength: 0.76,
        desc: 'Lower wick > 2x body: severe rejection of lower prices at bottom.',
      });
    }
    if (c0.upperWickRejection && c0.lowerRatio <= 0.12 && c0.bodyRatio >= 0.15 && priorTrend === 'UP') {
      patterns.push({
        name: 'Shooting Star',
        type: 'BEARISH',
        category: 'Reversal',
        reliability: '★★★☆☆',
        strength: 0.78,
        desc: 'Upper wick > 2x body: severe rejection of higher prices at top.',
      });
    }

    // Morning Star & Evening Star (★★★★☆)
    const c2Mid = (c2.open + c2.close) / 2;
    if (c2.isBear && c1.bodyRatio < 0.35 && c0.isBull && c0.close > c2Mid) {
      patterns.push({
        name: c1.isDoji ? 'Morning Doji Star' : 'Morning Star',
        type: 'BULLISH',
        category: 'Reversal',
        reliability: '★★★★☆',
        strength: 0.90,
        desc: '3-candle bullish reversal: sell exhaustion followed by strong green advance.',
      });
    }
    if (c2.isBull && c1.bodyRatio < 0.35 && c0.isBear && c0.close < c2Mid) {
      patterns.push({
        name: c1.isDoji ? 'Evening Doji Star' : 'Evening Star',
        type: 'BEARISH',
        category: 'Reversal',
        reliability: '★★★★☆',
        strength: 0.90,
        desc: '3-candle bearish reversal: buy exhaustion followed by strong red breakdown.',
      });
    }

    // ─────────────────────────────────────────────────────────────────
    // 2. ADVANCED CONTINUATION PATTERNS
    // ─────────────────────────────────────────────────────────────────

    // Rising Window (Bullish Gap - "Ma")
    if (c0.low > c1.high) {
      patterns.push({
        name: 'Rising Window (Bullish Gap)',
        type: 'BULLISH',
        category: 'Continuation',
        reliability: '★★★★☆',
        strength: 0.85,
        desc: 'Unfilled gap between green candles acts as strong dynamic support zone.',
      });
    }

    // Falling Window (Bearish Gap)
    if (c0.high < c1.low) {
      patterns.push({
        name: 'Falling Window (Bearish Gap)',
        type: 'BEARISH',
        category: 'Continuation',
        reliability: '★★★★☆',
        strength: 0.85,
        desc: 'Unfilled gap between red candles acts as strong dynamic resistance zone.',
      });
    }

    // Upside Tasuki Gap
    if (c2.isBull && c1.isBull && c1.open > c2.close && c0.isBear && c0.open < c1.close && c0.close > c2.high) {
      patterns.push({
        name: 'Upside Tasuki Gap',
        type: 'BULLISH',
        category: 'Continuation',
        reliability: '★★★★☆',
        strength: 0.84,
        desc: 'Red candle pulls back into gap but fails to close it; confirms upward continuation.',
      });
    }

    // Downside Tasuki Gap
    if (c2.isBear && c1.isBear && c1.open < c2.close && c0.isBull && c0.open > c1.close && c0.close < c2.low) {
      patterns.push({
        name: 'Downside Tasuki Gap',
        type: 'BEARISH',
        category: 'Continuation',
        reliability: '★★★★☆',
        strength: 0.84,
        desc: 'Green candle rallies into gap but fails to close it; confirms downward continuation.',
      });
    }

    // Three-Line Strike (Bullish ★★★★☆)
    // 3 consecutive red candles followed by 1 massive green candle engulfing all three
    if (c3.isBear && c2.isBear && c1.isBear && c0.isBull && c0.close > c3.open && c0.open < c1.close) {
      patterns.push({
        name: 'Three-Line Strike (Bullish)',
        type: 'BULLISH',
        category: 'Continuation',
        reliability: '★★★★☆',
        strength: 0.92,
        desc: 'Bulls instantly absorb 3 bars of selling in a single dominant candle.',
      });
    }

    // Three-Line Strike (Bearish ★★★★☆)
    // 3 consecutive green candles followed by 1 massive red candle engulfing all three
    if (c3.isBull && c2.isBull && c1.isBull && c0.isBear && c0.close < c3.open && c0.open > c1.close) {
      patterns.push({
        name: 'Three-Line Strike (Bearish)',
        type: 'BEARISH',
        category: 'Continuation',
        reliability: '★★★★☆',
        strength: 0.92,
        desc: 'Bears instantly erase 3 bars of buying in a single dominant candle.',
      });
    }

    // Three White Soldiers & Three Black Crows (★★★★★)
    if (c2.isBull && c1.isBull && c0.isBull && c0.close > c1.close && c1.close > c2.close && c0.bodyRatio > 0.5 && c1.bodyRatio > 0.5) {
      patterns.push({
        name: 'Three White Soldiers',
        type: 'BULLISH',
        category: 'Continuation',
        reliability: '★★★★★',
        strength: 0.94,
        desc: 'Three consecutive strong advancing candles with higher closes.',
      });
    }
    if (c2.isBear && c1.isBear && c0.isBear && c0.close < c1.close && c1.close < c2.close && c0.bodyRatio > 0.5 && c1.bodyRatio > 0.5) {
      patterns.push({
        name: 'Three Black Crows',
        type: 'BEARISH',
        category: 'Continuation',
        reliability: '★★★★★',
        strength: 0.94,
        desc: 'Three consecutive heavy declining candles with lower closes.',
      });
    }

    // ─────────────────────────────────────────────────────────────────
    // 3. ADVANCED DOJI VARIATIONS
    // ─────────────────────────────────────────────────────────────────

    // Standalone Doji (★★☆☆☆, Indecision)
    if (c0.isDoji && !c0.isRickshawCenter && c0.upperRatio <= 0.4 && c0.lowerRatio <= 0.4) {
      patterns.push({
        name: 'Doji (standalone)',
        type: 'NEUTRAL',
        category: 'Indecision',
        patternType: 'Indecision',
        reliability: '★★☆☆☆',
        strength: 0.50,
        shortBadge: 'DOJI ★★☆☆☆ [IND]',
        desc: 'Open and close virtually identical; buyers and sellers in temporary stalemate.',
      });
    }

    // Spinning Top (★★☆☆☆, Indecision)
    if (c0.bodyRatio >= 0.08 && c0.bodyRatio <= 0.32 && c0.upperRatio >= 0.20 && c0.lowerRatio >= 0.20) {
      patterns.push({
        name: 'Spinning Top',
        type: 'NEUTRAL',
        category: 'Indecision',
        patternType: 'Indecision',
        reliability: '★★☆☆☆',
        strength: 0.50,
        shortBadge: 'SPINNING TOP ★★☆☆☆ [IND]',
        desc: 'Small real body with balanced upper and lower shadows indicating market indecision.',
      });
    }

    // Rickshaw Man Doji: Body exactly centered with long wicks both sides
    if (c0.isDoji && c0.isRickshawCenter && c0.upperRatio > 0.35 && c0.lowerRatio > 0.35) {
      patterns.push({
        name: 'Rickshaw Man Doji',
        type: 'NEUTRAL',
        category: 'Indecision',
        patternType: 'Indecision',
        reliability: '★★★☆☆',
        strength: 0.70,
        shortBadge: 'RICKSHAW DOJI ★★★☆☆ [IND]',
        desc: 'Body exactly centered: complete equilibrium before violent breakout.',
      });
    }

    // Long-Legged Doji at Key S/R Level
    if (c0.isDoji && (c0.upperRatio > 0.4 || c0.lowerRatio > 0.4) && !c0.isRickshawCenter) {
      patterns.push({
        name: 'Long-Legged Doji',
        type: 'NEUTRAL',
        category: 'Indecision',
        patternType: 'Indecision',
        reliability: '★★★☆☆',
        strength: 0.65,
        shortBadge: 'LONG-LEGGED DOJI ★★★☆☆ [IND]',
        desc: 'Extreme battle between bulls and bears; trend decided by next candle.',
      });
    }

    // Southern Doji (at bottom of downtrend)
    if (c0.isDoji && priorTrend === 'DOWN') {
      patterns.push({
        name: 'Southern Doji',
        type: 'BULLISH',
        category: 'Reversal',
        patternType: 'Reversal',
        reliability: '★★★☆☆',
        strength: 0.72,
        shortBadge: 'SOUTHERN DOJI ★★★☆☆ [REV]',
        desc: 'Doji at bottom of downtrend indicates exhaustion of sellers.',
      });
    }

    // ─────────────────────────────────────────────────────────────────
    // 4. COMPLEX MULTI-CANDLE PATTERNS
    // ─────────────────────────────────────────────────────────────────

    // Hikkake Pattern (Inside bar false breakout trap ★★★★☆)
    // Inside bar (c2 within c3), false break (c1), sharp reversal back (c0)
    const isInsideBar = c2.high <= c3.high && c2.low >= c3.low;
    if (isInsideBar) {
      // Bullish Hikkake: False break below c2 low, then c0 reverses and breaks above c2 high
      if (c1.low < c2.low && c0.close > c2.high) {
        patterns.push({
          name: 'Bullish Hikkake Pattern',
          type: 'BULLISH',
          category: 'Complex',
          reliability: '★★★★☆',
          strength: 0.90,
          desc: 'Inside bar false breakdown traps short sellers, sparking rapid rally.',
        });
      }
      // Bearish Hikkake: False break above c2 high, then c0 reverses and breaks below c2 low
      if (c1.high > c2.high && c0.close < c2.low) {
        patterns.push({
          name: 'Bearish Hikkake Pattern',
          type: 'BEARISH',
          category: 'Complex',
          reliability: '★★★★☆',
          strength: 0.90,
          desc: 'Inside bar false breakout traps buyers, triggering rapid sell-off.',
        });
      }
    }

    // Ladder Bottom Pattern (Bullish Reversal)
    // 4 red candles with lower opens/closes, 5th opens lower but closes sharply higher
    if (c4.isBear && c3.isBear && c2.isBear && c1.isBear && c0.isBull && c0.close > c1.open) {
      patterns.push({
        name: 'Ladder Bottom',
        type: 'BULLISH',
        category: 'Complex',
        reliability: '★★★★★',
        strength: 0.93,
        desc: 'Rare institutional seller exhaustion ending in a sharp bullish surge.',
      });
    }

    // Ladder Top Pattern (Bearish Reversal)
    // 4 green candles with higher closes, 5th opens higher but breaks down sharply
    if (c4.isBull && c3.isBull && c2.isBull && c1.isBull && c0.isBear && c0.close < c1.open) {
      patterns.push({
        name: 'Ladder Top',
        type: 'BEARISH',
        category: 'Complex',
        reliability: '★★★★★',
        strength: 0.93,
        desc: 'Rare institutional buyer exhaustion ending in a sharp bearish breakdown.',
      });
    }

    // Deliberation Pattern (Bearish Reversal)
    // 3 green soldiers, but 3rd soldier is noticeably small and stalled near top of 2nd
    if (c2.isBull && c1.isBull && c0.isBull && c0.bodyRatio < c1.bodyRatio * 0.5 && c0.open > c1.open) {
      patterns.push({
        name: 'Deliberation Pattern (Bearish)',
        type: 'BEARISH',
        category: 'Complex',
        reliability: '★★★★☆',
        strength: 0.82,
        desc: 'Bullish momentum stalls with miniature third soldier; impending reversal.',
      });
    }

    // Concealing Baby Swallow
    if (c3.isBear && c2.isBear && c1.isBear && c0.isBear && c0.open > c1.high) {
      patterns.push({
        name: 'Concealing Baby Swallow',
        type: 'BEARISH',
        category: 'Complex',
        reliability: '★★★★☆',
        strength: 0.86,
        desc: 'Four bearish candles continuation pattern.',
      });
    }

    // ─────────────────────────────────────────────────────────────────
    // 5. ANATOMY, WICK REJECTIONS & S/R ANALYSIS
    // ─────────────────────────────────────────────────────────────────

    // Dynamic Wick Rejection Signals
    if (c0.upperWickRejection) {
      patterns.push({
        name: 'Upper Wick Rejection (Bearish)',
        type: 'BEARISH',
        category: 'Anatomy',
        reliability: '★★★★☆',
        strength: 0.80,
        desc: `Upper shadow (${(c0.upperRatio * 100).toFixed(0)}%) > 2x body: sellers aggressively rejecting higher prices.`,
      });
    }
    if (c0.lowerWickRejection) {
      patterns.push({
        name: 'Lower Wick Rejection (Bullish)',
        type: 'BULLISH',
        category: 'Anatomy',
        reliability: '★★★★☆',
        strength: 0.80,
        desc: `Lower shadow (${(c0.lowerRatio * 100).toFixed(0)}%) > 2x body: buyers aggressively defending support.`,
      });
    }

    // Candle Body Size Momentum
    const prevBodies = [c1.body, c2.body, c3.body];
    const avgPrevBody = (prevBodies[0] + prevBodies[1] + prevBodies[2]) / 3 || 1;
    let bodyMomentum = 'NORMAL';
    if (c0.body >= avgPrevBody * 1.5) {
      bodyMomentum = 'ACCELERATING MOMENTUM';
    } else if (c0.body <= avgPrevBody * 0.5) {
      bodyMomentum = 'LOSING MOMENTUM';
    }

    // Support and resistance zones
    const rollingLows = rawCandles.slice(-25).map(c => c.low);
    const rollingHighs = rawCandles.slice(-25).map(c => c.high);
    const minLow = Math.min(...rollingLows);
    const maxHigh = Math.max(...rollingHighs);
    const isAtSupport = c0.low <= minLow * 1.003;
    const isAtResistance = c0.high >= maxHigh * 0.997;
    const zoneContext = isAtSupport ? 'DEMAND SUPPORT ZONE' : isAtResistance ? 'SUPPLY RESISTANCE ZONE' : 'MID-RANGE CONSOLIDATION';

    // Volume-Candle Confluence
    const avgVol = rawCandles.slice(-10).reduce((a, b) => a + (b.volume || 1), 0) / 10;
    const volRatio = (c0.volume || 1) / avgVol;
    let volConfirmation = 'NORMAL VOLUME';
    if (volRatio >= 1.5) {
      volConfirmation = c0.isBull ? 'HIGH INSTITUTIONAL BUYING' : 'HIGH INSTITUTIONAL SELLING';
    } else if (volRatio <= 0.6) {
      volConfirmation = 'LOW VOLUME (POTENTIAL EXHAUSTION)';
    }

    // Gap Classification
    let gapClassification = 'NONE';
    if (c0.open > c1.high) {
      gapClassification = (c0.high - c0.low) > avgPrevBody * 1.8 ? 'BREAKAWAY / RUNAWAY GAP UP' : 'COMMON GAP UP';
    } else if (c0.open < c1.low) {
      gapClassification = (c0.high - c0.low) > avgPrevBody * 1.8 ? 'BREAKAWAY / RUNAWAY GAP DOWN' : 'COMMON GAP DOWN';
    }

    // ─────────────────────────────────────────────────────────────────
    // 6. COMPOSITE DIRECTIONAL SCORE & ACTIVE CANDLE VERDICT
    // ─────────────────────────────────────────────────────────────────
    let bullScore = 0;
    let bearScore = 0;

    for (const p of patterns) {
      if (p.type === 'BULLISH') bullScore += p.strength;
      else if (p.type === 'BEARISH') bearScore += p.strength;
    }

    // Include candle body direction & wick pressure in composite score
    if (c0.isBull) bullScore += c0.bodyRatio * 0.3;
    if (c0.isBear) bearScore += c0.bodyRatio * 0.3;
    if (c0.lowerWickRejection) bullScore += 0.35;
    if (c0.upperWickRejection) bearScore += 0.35;

    const netScore = bullScore - bearScore;
    const compositeScore = Math.max(-1, Math.min(1, netScore));

    // Active Candle Verdict
    const isVerdictBearish = compositeScore < -0.15 || (c0.isBear && c0.bodyRatio > 0.4);
    const isVerdictBullish = compositeScore > 0.15 || (c0.isBull && c0.bodyRatio > 0.4);
    const activeVerdict = {
      isBearish: isVerdictBearish,
      isBullish: isVerdictBullish,
      tag: isVerdictBearish ? 'BEARISH (RED)' : isVerdictBullish ? 'BULLISH (GREEN)' : 'NEUTRAL / INDECISION',
      color: isVerdictBearish ? '#ef4444' : isVerdictBullish ? '#10b981' : '#94a3b8',
      score: Math.round(compositeScore * 1000) / 1000,
      primaryPattern: patterns.length > 0 ? patterns[0] : { name: isVerdictBearish ? 'Bearish Candle' : 'Bullish Candle', reliability: '★★★☆☆' },
    };

    // Store recognized pattern in rolling 1-hour+ history
    if (saveToHistory && patterns.length > 0) {
      const top = patterns[0];
      const now = Date.now();
      const last = this.patternHistory[0];
      if (!last || (now - last.timestamp > 15000 && last.pattern !== top.name)) {
        const d = new Date(now);
        const timeStr = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
        this.patternHistory.unshift({
          id: `pat_${now}`,
          timestamp: now,
          timeAgo: 'Just now',
          timeStr,
          timeframe,
          pattern: top.name,
          reliability: top.reliability || '★★★★☆',
          type: top.patternType || top.category || 'Reversal',
          price: `$${c0.close.toFixed(2)}`,
          outcome: 'ACTIVE (IN PROGRESS)',
        });
        if (this.patternHistory.length > 60) this.patternHistory.pop();
      }
    }

    return {
      patterns,
      score: Math.round(compositeScore * 1000) / 1000,
      activeCandleVerdict: activeVerdict,
      lastMetrics: {
        bodyRatio: Math.round(c0.bodyRatio * 100) / 100,
        upperRatio: Math.round(c0.upperRatio * 100) / 100,
        lowerRatio: Math.round(c0.lowerRatio * 100) / 100,
        upperShadow: Math.round(c0.upperShadow * 100) / 100,
        lowerShadow: Math.round(c0.lowerShadow * 100) / 100,
        body: Math.round(c0.body * 100) / 100,
        isDoji: c0.isDoji,
        trend: priorTrend,
        bodyMomentum,
        volumeConfirmation: volConfirmation,
        supportResistance: zoneContext,
        gap: gapClassification,
        upperWickRejection: c0.upperWickRejection,
        lowerWickRejection: c0.lowerWickRejection,
        isBearish: c0.isBear,
        isBullish: c0.isBull,
      },
    };
  }

  /**
   * Scan visible chart candles and detect historical patterns on every candle
   * Used to mark exact patterns directly onto the Candlestick Price Chart
   * @param {Array<Object>} candles
   */
  scanVisibleCandles(candles) {
    if (!candles || candles.length < 5) return [];
    const detected = [];
    for (let i = 4; i < candles.length; i++) {
      const slice = candles.slice(0, i + 1);
      const res = this.detectPatterns(slice, false);
      if (res.patterns && res.patterns.length > 0) {
        // Pick best pattern by star count
        const best = res.patterns.slice().sort((a, b) => {
          const starsA = (a.reliability.match(/★/g) || []).length;
          const starsB = (b.reliability.match(/★/g) || []).length;
          return starsB - starsA;
        })[0];
        detected.push({
          index: i,
          candle: candles[i],
          pattern: best,
        });
      }
    }
    return detected;
  }

  /**
   * Get 1-hour+ pattern recognition history
   */
  getPatternHistory() {
    return this.patternHistory;
  }
}
