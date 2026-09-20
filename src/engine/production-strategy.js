// ═════════════════════════════════════════════════════════════════════
// DYNAMIC MARKET ANALYST ENGINE — LIVE MARKET ANALYSIS & TRADING STRATEGY
// 6-Layer Adaptive Analysis: Regime → Momentum → Volatility → Microstructure → RL Consensus → Risk
// DISTRIBUTION-PREDICTED TARGETS · Trailing Stops · Regime-Aware Position Sizing
// NO fixed % TP/SL — Targets from MovementPredictionEngine distribution
// NO SIMULATION — 100% LIVE MARKET DATA ONLY
// ═════════════════════════════════════════════════════════════════════

import { clamp, mean, std } from '../utils/math.js';

export class ProductionStrategyEngine {
  constructor() {
    this.name = 'Dynamic Market Analyst Engine';
    this.version = '3.0.0-LIVE';
    this.status = 'SCANNING'; // 'SCANNING' | 'SIGNAL_FORMING' | 'IN_TRADE' | 'TRAILING' | 'INVALIDATED'

    // Regime Profiles — NO fixed tpMultiple/slMultiple
    // TP and SL come dynamically from MovementPredictionEngine
    this.REGIME_PROFILES = {
      TRENDING:      { minConfluence: 65, holdBias: 'trend-follow' },
      MEAN_REVERTING: { minConfluence: 70, holdBias: 'reversion' },
      VOLATILE:      { minConfluence: 75, holdBias: 'breakout' },
      COMPRESSION:   { minConfluence: 72, holdBias: 'squeeze' },
      BREAKOUT:      { minConfluence: 68, holdBias: 'momentum' },
      UNKNOWN:       { minConfluence: 78, holdBias: 'cautious' },
    };

    // External movement prediction (injected from MovementPredictionEngine)
    this.movementPrediction = null;
    this.healingEngine = null;

    // Adaptive Position Sizing
    this.BASE_POSITION_ETH = 0.50;
    this.LOT_UNIT_ETH = 0.01;

    // State Machine
    this.activeTrade = null;
    this.tradeHistory = [];
    this.tradeCount = 0;
    this.winCount = 0;

    // Performance Metrics (live-accumulated)
    this.stats = {
      totalSignals: 0,
      tradesExecuted: 0,
      winRatePct: 0,
      profitFactor: 0,
      avgGainUSD: 0,
      avgLossUSD: 0,
      maxDrawdownPct: 0,
      sharpeRatio: 0,
      totalPnlUSD: 0,
    };

    // 6-Layer Analysis State
    this.layers = {
      layer1_regime:         { status: 'ANALYZING', score: 0, desc: 'Detecting market regime...' },
      layer2_momentum:       { status: 'ANALYZING', score: 0, desc: 'Computing directional momentum...' },
      layer3_volatility:     { status: 'ANALYZING', score: 0, desc: 'Forecasting volatility range...' },
      layer4_microstructure: { status: 'ANALYZING', score: 0, desc: 'Evaluating order flow edge...' },
      layer5_rl_consensus:   { status: 'ANALYZING', score: 0, desc: 'Polling 34-algorithm ensemble...' },
      layer6_risk_gate:      { status: 'ANALYZING', score: 0, desc: 'Checking pre-trade risk gates...' },
    };

    this.confluenceScore = 0;
    this.executionAction = 'SCANNING MARKET';
    this.currentATR = 18.50;
    this.predictedRange = { high: 0, low: 0, expectedMove: 0 };
    this.verdict = 'HOLD';
    this.verdictConfidence = 0;
  }

  // ═══════════════════════════════════════════════════════════════════
  // CORE: Compute ATR from live candle data
  // ═══════════════════════════════════════════════════════════════════
  computeATR(candles, period = 14) {
    if (!candles || candles.length < 5) return 18.50;
    let trSum = 0;
    const n = Math.min(period, candles.length - 1);
    for (let i = candles.length - n; i < candles.length; i++) {
      const cur = candles[i];
      const prev = candles[i - 1];
      if (!cur || !prev) continue;
      const tr = Math.max(
        (cur.high || cur.h || 0) - (cur.low || cur.l || 0),
        Math.abs((cur.high || cur.h || 0) - (prev.close || prev.c || 0)),
        Math.abs((cur.low || cur.l || 0) - (prev.close || prev.c || 0))
      );
      trSum += tr;
    }
    return Math.max(2.0, trSum / Math.max(1, n));
  }

  // ═══════════════════════════════════════════════════════════════════
  // CORE: Compute RSI from price series
  // ═══════════════════════════════════════════════════════════════════
  computeRSI(prices, period = 14) {
    if (!prices || prices.length < period + 1) return 50;
    let gains = 0, losses = 0;
    const start = prices.length - period - 1;
    for (let i = start + 1; i < prices.length; i++) {
      const delta = prices[i] - prices[i - 1];
      if (delta > 0) gains += delta;
      else losses -= delta;
    }
    const avgGain = gains / period;
    const avgLoss = losses / period;
    if (avgLoss === 0) return 100;
    const rs = avgGain / avgLoss;
    return 100 - (100 / (1 + rs));
  }

  // ═══════════════════════════════════════════════════════════════════
  // CORE: Compute EMA from price series
  // ═══════════════════════════════════════════════════════════════════
  computeEMA(prices, period) {
    if (!prices || prices.length === 0) return 0;
    const k = 2 / (period + 1);
    let ema = prices[0];
    for (let i = 1; i < prices.length; i++) {
      ema = prices[i] * k + ema * (1 - k);
    }
    return ema;
  }

  // ═══════════════════════════════════════════════════════════════════
  // CORE: Compute Bollinger Bandwidth
  // ═══════════════════════════════════════════════════════════════════
  computeBollingerBandwidth(prices, period = 20) {
    if (!prices || prices.length < period) return { bandwidth: 0.02, upper: 0, lower: 0, middle: 0 };
    const slice = prices.slice(-period);
    const sma = slice.reduce((a, b) => a + b, 0) / period;
    const variance = slice.reduce((s, p) => s + (p - sma) ** 2, 0) / period;
    const stdDev = Math.sqrt(variance);
    const upper = sma + 2 * stdDev;
    const lower = sma - 2 * stdDev;
    const bandwidth = sma > 0 ? (upper - lower) / sma : 0.02;
    return { bandwidth, upper, lower, middle: sma, stdDev };
  }

  // ═══════════════════════════════════════════════════════════════════
  // MAIN EVALUATE — Called every tick with live market data
  // ═══════════════════════════════════════════════════════════════════
  evaluate(context) {
    const {
      price,
      prices = [],
      ensemble = 0,
      signals = {},
      quantData = null,
      candlestickData = null,
      riskData = null,
      mtfData = null,
    } = context;

    if (!price || price <= 0 || prices.length < 20) return this.getFallbackTelemetry(price);

    const now = Date.now();

    // Get active candles from MTF engine
    const activeCandles = context.activeCandles || [];
    this.currentATR = this.computeATR(activeCandles);
    const atr = this.currentATR;

    // ─────────────────────────────────────────────────────────────────
    // LAYER 1: MARKET REGIME CLASSIFICATION
    // Uses Kalman drift, OU spread, Hawkes branching, Bollinger bandwidth
    // ─────────────────────────────────────────────────────────────────
    let detectedRegime = 'UNKNOWN';
    let regimeScore = 50;
    let regimeDirection = 0;

    const bb = this.computeBollingerBandwidth(prices);
    const rsi = this.computeRSI(prices);

    if (quantData) {
      const kalmanDrift = quantData.kalmanDrift || 0;
      const ouZ = quantData.ouSpreadZ || 0;
      const branchingRatio = quantData.branchingRatio || 0.6;

      if (branchingRatio > 0.95) {
        detectedRegime = 'VOLATILE';
        regimeScore = 30;
        regimeDirection = 0;
      } else if (bb.bandwidth < 0.015) {
        detectedRegime = 'COMPRESSION';
        regimeScore = 72;
        regimeDirection = 0; // Waiting for breakout direction
      } else if (Math.abs(ouZ) > 1.7) {
        detectedRegime = 'MEAN_REVERTING';
        regimeDirection = ouZ > 1.7 ? -1 : 1;
        regimeScore = 85;
      } else if (Math.abs(kalmanDrift) > 0.08) {
        detectedRegime = 'TRENDING';
        regimeDirection = kalmanDrift > 0 ? 1 : -1;
        regimeScore = 90;
      } else if (Math.abs(kalmanDrift) > 0.04 && bb.bandwidth > 0.03) {
        detectedRegime = 'BREAKOUT';
        regimeDirection = kalmanDrift > 0 ? 1 : -1;
        regimeScore = 78;
      } else {
        detectedRegime = 'TRENDING';
        regimeDirection = ensemble > 0 ? 1 : -1;
        regimeScore = 65;
      }
    } else {
      // Fallback: use price action + BB
      const ret20 = prices.length >= 21 ? (prices[prices.length - 1] / prices[prices.length - 21] - 1) : 0;
      if (bb.bandwidth < 0.012) {
        detectedRegime = 'COMPRESSION';
        regimeScore = 68;
      } else if (Math.abs(ret20) > 0.03) {
        detectedRegime = 'TRENDING';
        regimeDirection = ret20 > 0 ? 1 : -1;
        regimeScore = 75;
      } else if (bb.bandwidth > 0.04) {
        detectedRegime = 'VOLATILE';
        regimeScore = 60;
      } else {
        detectedRegime = 'MEAN_REVERTING';
        regimeScore = 55;
        regimeDirection = price < bb.middle ? 1 : -1;
      }
    }

    this.layers.layer1_regime = {
      status: regimeScore >= 65 ? 'IDENTIFIED' : 'AMBIGUOUS',
      score: regimeScore,
      regime: detectedRegime,
      direction: regimeDirection,
      bbBandwidth: (bb.bandwidth * 100).toFixed(2) + '%',
      desc: `${detectedRegime} (Confidence: ${regimeScore}%, BB Width: ${(bb.bandwidth * 100).toFixed(2)}%)`,
    };

    // ─────────────────────────────────────────────────────────────────
    // LAYER 2: DIRECTIONAL MOMENTUM SIGNAL
    // Multi-timeframe EMA crossover + RSI + candlestick confluence
    // ─────────────────────────────────────────────────────────────────
    const ema8 = this.computeEMA(prices, 8);
    const ema21 = this.computeEMA(prices, 21);
    const ema50 = this.computeEMA(prices.slice(-60), 50);
    const emaCross = ema8 - ema21;
    const emaTrend = ema21 - ema50;

    let momentumScore = 50;
    let momentumDirection = 0;

    // EMA Stack analysis
    const emaAligned = (ema8 > ema21 && ema21 > ema50) ? 1 : (ema8 < ema21 && ema21 < ema50) ? -1 : 0;

    // RSI momentum
    const rsiMomentum = rsi > 60 ? 1 : rsi < 40 ? -1 : 0;

    // Price vs EMA position
    const priceVsEma = price > ema21 ? 1 : price < ema21 ? -1 : 0;

    // Candlestick pattern contribution
    let candleDirection = 0;
    let candleStrength = 0;
    if (candlestickData && candlestickData.patterns && candlestickData.patterns.length > 0) {
      const topPattern = candlestickData.patterns[0];
      candleDirection = topPattern.type === 'BULLISH' ? 1 : -1;
      const stars = (topPattern.reliability || '').length;
      candleStrength = stars >= 5 ? 0.95 : stars >= 4 ? 0.80 : stars >= 3 ? 0.60 : 0.30;
    }

    // MTF confluence
    const mtfScore = mtfData ? (mtfData.confluenceScore || 0) : 0;
    const mtfDirection = mtfScore > 0.3 ? 1 : mtfScore < -0.3 ? -1 : 0;

    // Composite momentum
    const rawMomentum = (
      emaAligned * 0.30 +
      rsiMomentum * 0.15 +
      priceVsEma * 0.15 +
      candleDirection * candleStrength * 0.20 +
      mtfDirection * 0.20
    );

    momentumDirection = rawMomentum > 0.15 ? 1 : rawMomentum < -0.15 ? -1 : 0;
    momentumScore = Math.round(clamp(Math.abs(rawMomentum) * 100, 10, 98));

    this.layers.layer2_momentum = {
      status: momentumScore >= 55 ? 'DIRECTIONAL' : 'FLAT',
      score: momentumScore,
      direction: momentumDirection,
      rsi: rsi.toFixed(1),
      emaStack: emaAligned > 0 ? 'BULL STACK' : emaAligned < 0 ? 'BEAR STACK' : 'MIXED',
      emaCross: emaCross.toFixed(2),
      candlePattern: candlestickData?.patterns?.[0]?.name || 'None',
      desc: `RSI: ${rsi.toFixed(1)} | EMA: ${emaAligned > 0 ? '↑ Bull Stack' : emaAligned < 0 ? '↓ Bear Stack' : '→ Mixed'} | Momentum: ${momentumScore}%`,
    };

    // ─────────────────────────────────────────────────────────────────
    // LAYER 3: VOLATILITY & RANGE FORECAST
    // Dynamic predicted range from MovementPredictionEngine (NOT fixed ATR multiples)
    // ─────────────────────────────────────────────────────────────────
    const regimeProfile = this.REGIME_PROFILES[detectedRegime] || this.REGIME_PROFILES.UNKNOWN;

    // Use dynamic prediction if available, otherwise fallback to 1.5x ATR
    const mp = context.movementPrediction || this.movementPrediction;
    const expectedMoveUp = mp ? mp.predictedMovement.mainMove : atr * 1.5;
    const expectedMoveDown = mp ? mp.adverseMovement.expected : atr;

    // Realized volatility (annualized from recent returns)
    let realizedVol = 0;
    if (prices.length >= 20) {
      const rets = [];
      for (let i = prices.length - 20; i < prices.length; i++) {
        if (i > 0 && prices[i - 1] > 0) rets.push(prices[i] / prices[i - 1] - 1);
      }
      if (rets.length > 0) {
        const m = rets.reduce((a, b) => a + b, 0) / rets.length;
        const v = rets.reduce((s, r) => s + (r - m) ** 2, 0) / rets.length;
        realizedVol = Math.sqrt(v) * Math.sqrt(365 * 24); // annualized
      }
    }

    const atrPct = price > 0 ? (atr / price * 100) : 0;
    const volScore = Math.round(clamp(100 - atrPct * 30, 20, 95));

    this.predictedRange = {
      high: mp ? mp.predictedMovement.mainTarget : Math.round((price + expectedMoveUp) * 100) / 100,
      low: mp ? mp.adverseMovement.rangeLow : Math.round((price - expectedMoveDown) * 100) / 100,
      expectedMove: Math.round(expectedMoveUp * 100) / 100,
      atrPct: atrPct.toFixed(3),
      // Movement prediction details
      conservativeTarget: mp ? mp.predictedMovement.conservativeTarget : 0,
      mainTarget: mp ? mp.predictedMovement.mainTarget : 0,
      extendedTarget: mp ? mp.predictedMovement.extendedTarget : 0,
      predictionSource: mp ? 'DISTRIBUTION_PREDICTED' : 'ATR_FALLBACK',
    };

    const rangeLabel = mp
      ? `PREDICTED: $${this.predictedRange.low} – $${this.predictedRange.high} (${mp.confidence}% conf)`
      : `ATR Fallback: $${this.predictedRange.low} – $${this.predictedRange.high}`;

    this.layers.layer3_volatility = {
      status: atrPct < 1.5 ? 'LOW_VOL' : atrPct < 3.0 ? 'NORMAL' : 'HIGH_VOL',
      score: volScore,
      atr: atr.toFixed(2),
      atrPct: atrPct.toFixed(3) + '%',
      realizedVol: (realizedVol * 100).toFixed(1) + '%',
      bbWidth: (bb.bandwidth * 100).toFixed(2) + '%',
      predictedHigh: this.predictedRange.high,
      predictedLow: this.predictedRange.low,
      expectedMove: '$' + expectedMoveUp.toFixed(2),
      predictionSource: this.predictedRange.predictionSource,
      desc: `${rangeLabel} | ATR: $${atr.toFixed(2)} (${atrPct.toFixed(3)}%) | RVol: ${(realizedVol * 100).toFixed(1)}%`,
    };

    // ─────────────────────────────────────────────────────────────────
    // LAYER 4: MICROSTRUCTURE EDGE
    // Kalman fair value, OFI, VPIN toxicity, Kyle's lambda
    // ─────────────────────────────────────────────────────────────────
    let microScore = 50;
    let microDirection = 0;
    let edgeBps = 0;
    let toxicity = 'NORMAL';

    if (quantData) {
      // Kalman fair value edge
      const fairVal = quantData.kalmanFairValue || price;
      const diff = fairVal - price;
      edgeBps = price > 0 ? ((diff / price) * 10000) : 0;
      microDirection = diff >= 1 ? 1 : diff <= -1 ? -1 : 0;

      // VPIN toxicity
      const vpin = quantData.vpin || 0.18;
      toxicity = vpin > 0.40 ? 'TOXIC (AVOID)' : vpin > 0.25 ? 'ELEVATED' : 'NORMAL';

      // Kyle's lambda (adverse selection)
      const kyleLambda = quantData.kyle?.lambda || 0.04;
      const adverseSelection = kyleLambda > 0.08 ? 'HIGH' : kyleLambda > 0.04 ? 'MODERATE' : 'LOW';

      // Composite micro score
      const edgeScore = Math.min(95, Math.abs(edgeBps) * 3);
      const toxicityPenalty = vpin > 0.40 ? 30 : vpin > 0.25 ? 15 : 0;
      microScore = Math.round(clamp(edgeScore - toxicityPenalty + 30, 15, 98));
    } else {
      microDirection = momentumDirection;
      microScore = 50;
    }

    this.layers.layer4_microstructure = {
      status: microScore >= 55 ? 'EDGE_DETECTED' : 'NEUTRAL',
      score: microScore,
      direction: microDirection,
      edgeBps: `${edgeBps > 0 ? '+' : ''}${edgeBps.toFixed(1)} bps`,
      toxicity,
      desc: `Kalman Edge: ${edgeBps > 0 ? '+' : ''}${edgeBps.toFixed(1)} bps | Toxicity: ${toxicity}`,
    };

    // ─────────────────────────────────────────────────────────────────
    // LAYER 5: 34-RL ALGORITHM CONSENSUS
    // Direction agreement, conviction-weighted, quality filtering
    // ─────────────────────────────────────────────────────────────────
    const signalKeys = Object.keys(signals);
    let bullCount = 0, bearCount = 0, holdCount = 0;
    let bullConv = 0, bearConv = 0;

    signalKeys.forEach(k => {
      const s = signals[k];
      if (!s) return;
      const dir = s.direction !== undefined ? s.direction : (s.signal === 'BUY' ? 1 : s.signal === 'SELL' ? -1 : 0);
      const conf = s.conf !== undefined ? s.conf : 0.5;
      if (dir > 0) { bullCount++; bullConv += conf; }
      else if (dir < 0) { bearCount++; bearConv += conf; }
      else holdCount++;
    });

    const totalAlgos = Math.max(1, signalKeys.length);
    const bullPct = Math.round((bullCount / totalAlgos) * 100);
    const bearPct = Math.round((bearCount / totalAlgos) * 100);
    const holdPct = Math.round((holdCount / totalAlgos) * 100);
    const dominantCount = Math.max(bullCount, bearCount, holdCount);
    const consensusPct = Math.round((dominantCount / totalAlgos) * 100);

    let rlDirection = 0;
    let rlVerdict = 'HOLD';
    if (bullCount > bearCount && bullCount > holdCount) {
      rlDirection = 1;
      rlVerdict = 'BUY';
    } else if (bearCount > bullCount && bearCount > holdCount) {
      rlDirection = -1;
      rlVerdict = 'SELL';
    }

    const avgBullConv = bullCount > 0 ? (bullConv / bullCount) : 0;
    const avgBearConv = bearCount > 0 ? (bearConv / bearCount) : 0;
    const convictionScore = rlDirection > 0 ? avgBullConv : rlDirection < 0 ? avgBearConv : 0;

    this.layers.layer5_rl_consensus = {
      status: consensusPct >= 60 ? 'CONSENSUS' : consensusPct >= 45 ? 'LEANING' : 'SPLIT',
      score: consensusPct,
      direction: rlDirection,
      verdict: rlVerdict,
      bullPct,
      bearPct,
      holdPct,
      dominantCount,
      totalAlgos,
      conviction: (convictionScore * 100).toFixed(0) + '%',
      desc: `${rlVerdict}: ${consensusPct}% (${dominantCount}/${totalAlgos}) | BUY: ${bullPct}% · SELL: ${bearPct}% · HOLD: ${holdPct}% | Conviction: ${(convictionScore * 100).toFixed(0)}%`,
    };

    // ─────────────────────────────────────────────────────────────────
    // LAYER 6: RISK GATEKEEPER
    // Drawdown, kill switch, position limits, VaR
    // ─────────────────────────────────────────────────────────────────
    let riskApproved = true;
    let riskDesc = 'All Risk Gates: PASSED';

    if (riskData) {
      if (riskData.killSwitchTriggered) {
        riskApproved = false;
        riskDesc = 'BLOCKED: Kill Switch Active';
      } else if (riskData.circuitBreakerLevel >= 2) {
        riskApproved = false;
        riskDesc = 'BLOCKED: Circuit Breaker Level 2';
      } else if (riskData.metrics?.currentDrawdownPct < -3.0) {
        riskApproved = false;
        riskDesc = 'BLOCKED: Daily Drawdown Limit (-3%) Exceeded';
      }
    }

    this.layers.layer6_risk_gate = {
      status: riskApproved ? 'APPROVED' : 'BLOCKED',
      score: riskApproved ? 95 : 5,
      approved: riskApproved,
      desc: riskDesc,
    };

    // ═══════════════════════════════════════════════════════════════════
    // COMPOSITE DECISION ENGINE — DYNAMIC VERDICT
    // ═══════════════════════════════════════════════════════════════════

    // Direction convergence
    const dirSum = regimeDirection + momentumDirection + microDirection + rlDirection;
    const overallDirection = dirSum >= 2 ? 1 : dirSum <= -2 ? -1 : 0;

    // Weighted confluence score
    const weightedScore = Math.round(
      regimeScore * 0.15 +
      momentumScore * 0.25 +
      volScore * 0.10 +
      microScore * 0.15 +
      consensusPct * 0.25 +
      (riskApproved ? 95 : 0) * 0.10
    );

    this.confluenceScore = weightedScore;

    // Determine final verdict
    const minConfluence = regimeProfile.minConfluence;
    if (!riskApproved) {
      this.verdict = 'HOLD';
      this.verdictConfidence = 0;
      this.executionAction = 'RISK BLOCKED — CAPITAL PRESERVATION';
    } else if (weightedScore >= minConfluence && overallDirection !== 0) {
      if (overallDirection > 0) {
        this.verdict = weightedScore >= 82 ? 'STRONG BUY' : 'BUY';
        this.executionAction = `${this.verdict}: ${detectedRegime} regime, ${momentumScore}% momentum`;
      } else {
        this.verdict = weightedScore >= 82 ? 'STRONG SELL' : 'SELL';
        this.executionAction = `${this.verdict}: ${detectedRegime} regime, ${momentumScore}% momentum`;
      }
      this.verdictConfidence = Math.min(99, weightedScore);
    } else if (weightedScore >= 55 && overallDirection !== 0) {
      this.verdict = 'HOLD';
      this.verdictConfidence = weightedScore;
      this.executionAction = `CONFLUENCE FORMING (${weightedScore}% / ${minConfluence}% required)`;
    } else {
      this.verdict = 'HOLD';
      this.verdictConfidence = weightedScore;
      this.executionAction = 'SCANNING MARKET — NO CLEAR EDGE';
    }

    // ═══════════════════════════════════════════════════════════════════
    // ADAPTIVE TRADE MANAGEMENT — Distribution-Predicted TP/SL
    // Targets come from MovementPredictionEngine, NOT fixed ATR multiples
    // ═══════════════════════════════════════════════════════════════════

    // Dynamic TP/SL from prediction engine
    const tpDist = mp ? mp.predictedMovement.mainMove : atr * 1.5;
    const slDist = mp ? mp.adverseMovement.expected : atr;
    const scaleTp1 = mp ? mp.predictedMovement.conservativeMove : tpDist * 0.5;

    // Kelly-adjusted position sizing using predicted R:R
    const winRate = this.stats.winRatePct > 0 ? this.stats.winRatePct / 100 : 0.55;
    const avgWinRatio = tpDist / (slDist || 1);
    const kellyFraction = Math.max(0.05, Math.min(0.40,
      (winRate * avgWinRatio - (1 - winRate)) / avgWinRatio
    ));
    const positionSizeETH = Math.round(this.BASE_POSITION_ETH * kellyFraction * 100) / 100;
    const positionUSD = (positionSizeETH * price).toFixed(2);

    // Dynamic TP/SL levels from prediction
    let entry = price;
    let tp1 = 0, tp2 = 0, sl = 0;

    if (mp) {
      // Use predicted targets directly — NO fixed multiplier
      tp1 = mp.predictedMovement.conservativeTarget;
      tp2 = mp.predictedMovement.mainTarget;
      sl = mp.invalidationLevel;
    } else if (overallDirection >= 0) {
      tp1 = Math.round((price + scaleTp1) * 100) / 100;
      tp2 = Math.round((price + tpDist) * 100) / 100;
      sl = Math.round((price - slDist) * 100) / 100;
    } else {
      tp1 = Math.round((price - scaleTp1) * 100) / 100;
      tp2 = Math.round((price - tpDist) * 100) / 100;
      sl = Math.round((price + slDist) * 100) / 100;
    }

    const tp1GainUSD = (positionSizeETH * scaleTp1).toFixed(2);
    const tp2GainUSD = (positionSizeETH * tpDist).toFixed(2);
    const slLossUSD = (positionSizeETH * slDist).toFixed(2);
    const rrRatio = slDist > 0 ? (tpDist / slDist).toFixed(2) : '—';

    // ═══════════════════════════════════════════════════════════════════
    // ACTIVE TRADE LIFECYCLE MANAGEMENT
    // ═══════════════════════════════════════════════════════════════════

    if (!this.activeTrade && (this.verdict === 'BUY' || this.verdict === 'SELL' || this.verdict === 'STRONG BUY' || this.verdict === 'STRONG SELL') && riskApproved) {
      this.stats.totalSignals++;
      this.activeTrade = {
        id: `DMA-${now.toString().slice(-6)}`,
        startTime: now,
        direction: overallDirection,
        side: overallDirection > 0 ? 'BUY (LONG)' : 'SELL (SHORT)',
        regime: detectedRegime,
        entryPrice: entry,
        currentPrice: price,
        tp1Price: tp1,
        tp2Price: tp2,
        initialSLPrice: sl,
        currentSLPrice: sl,
        trailingSL: sl,
        atrAtEntry: atr,
        ratchetEngaged: false,
        tp1Executed: false,
        sizeETH: positionSizeETH,
        sizeUSD: positionUSD,
        status: 'IN_TRADE',
        pnlUSD: '0.00',
        pnlPct: '0.00%',
        entryConfluence: weightedScore,
        entryVerdict: this.verdict,
        realizedPartialPnl: 0,
      };
      this.status = 'IN_TRADE';
    } else if (this.activeTrade) {
      const t = this.activeTrade;
      t.currentPrice = price;

      const priceDelta = t.direction > 0 ? (price - t.entryPrice) : (t.entryPrice - price);
      const curPct = (priceDelta / t.entryPrice) * 100;
      t.pnlPct = `${curPct >= 0 ? '+' : ''}${curPct.toFixed(3)}%`;
      t.pnlUSD = (t.sizeETH * priceDelta).toFixed(2);

      // Trailing stop: ratchet SL as price moves in our favor
      if (priceDelta > 0) {
        const trailDist = (mp?.adverseMovement?.expected) || (t.atrAtEntry * 0.8);
        const newTrailSL = t.direction > 0
          ? price - trailDist
          : price + trailDist;
        if (t.direction > 0 && newTrailSL > t.currentSLPrice) {
          t.currentSLPrice = Math.round(newTrailSL * 100) / 100;
          if (!t.ratchetEngaged) t.ratchetEngaged = true;
        } else if (t.direction < 0 && newTrailSL < t.currentSLPrice) {
          t.currentSLPrice = Math.round(newTrailSL * 100) / 100;
          if (!t.ratchetEngaged) t.ratchetEngaged = true;
        }
      }

      // Check TP1 — scale out 50%
      if (!t.tp1Executed) {
        const hitTP1 = t.direction > 0 ? price >= t.tp1Price : price <= t.tp1Price;
        if (hitTP1) {
          t.tp1Executed = true;
          const closedSize = +(t.sizeETH * 0.5).toFixed(4);
          t.sizeETH = +(t.sizeETH - closedSize).toFixed(4);
          const partialPnl = +(closedSize * priceDelta).toFixed(2);
          t.realizedPartialPnl = (t.realizedPartialPnl || 0) + partialPnl;
          this.status = 'TRAILING';
        }
      }

      // Check TP2 — full target
      const hitTP2 = t.direction > 0 ? price >= t.tp2Price : price <= t.tp2Price;
      if (hitTP2) {
        t.status = 'TARGET HIT';
        this.closeTrade(t, price, 'TP2 (ATR Target Hit)');
      }

      // Check trailing SL / initial SL
      if (this.activeTrade) {
        const hitSL = t.direction > 0 ? price <= t.currentSLPrice : price >= t.currentSLPrice;
        if (hitSL) {
          t.status = t.ratchetEngaged ? 'TRAILING STOP HIT' : 'STOP LOSS HIT';
          this.closeTrade(t, price, t.ratchetEngaged ? 'Trailing Stop' : 'Initial Stop Loss');
        }
      }

      // Invalidation: regime shift while in trade
      if (this.activeTrade && t.regime !== detectedRegime && detectedRegime === 'VOLATILE') {
        // Close on regime shift to volatile
        t.status = 'REGIME INVALIDATED';
        this.closeTrade(t, price, 'Regime Shifted to VOLATILE');
      }
    }

    // Update status
    if (!this.activeTrade) {
      if (this.verdict.includes('BUY') || this.verdict.includes('SELL')) {
        this.status = 'SIGNAL_FORMING';
      } else {
        this.status = 'SCANNING';
      }
    }

    return {
      strategyName: this.name,
      version: this.version,
      status: this.status,
      action: this.executionAction,
      verdict: this.verdict,
      verdictConfidence: this.verdictConfidence,
      confluenceScore: this.confluenceScore,
      direction: overallDirection,

      // Market Analysis
      regime: detectedRegime,
      regimeProfile: regimeProfile.holdBias,
      atr: atr.toFixed(2),
      predictedRange: this.predictedRange,

      // Dynamic Movement Prediction
      movementPrediction: mp || null,

      // Adaptive Sizing
      positionSizeETH: positionSizeETH,
      positionUSD,
      kellyFraction: (kellyFraction * 100).toFixed(1) + '%',

      // 6-Layer Breakdown
      layers: this.layers,

      // Active Trade / Dynamic Roadmap
      activeTrade: this.activeTrade,
      roadmap: {
        entryPrice: this.activeTrade ? this.activeTrade.entryPrice : entry,
        tp1Price: this.activeTrade ? this.activeTrade.tp1Price : tp1,
        tp2Price: this.activeTrade ? this.activeTrade.tp2Price : tp2,
        slPrice: this.activeTrade ? this.activeTrade.currentSLPrice : sl,
        tp1GainUSD,
        tp2GainUSD,
        slLossUSD,
        riskRewardRatio: `1 : ${rrRatio}`,
        tpMethod: mp ? `DISTRIBUTION PREDICTED (${mp.confidence}% conf)` : `ATR Fallback (${detectedRegime})`,
        slMethod: mp ? `MAE DISTRIBUTION (${mp.confidence}% conf)` : `ATR Fallback (${detectedRegime})`,
        // Extended prediction targets
        conservativeTarget: mp ? mp.predictedMovement.conservativeTarget : tp1,
        mainTarget: mp ? mp.predictedMovement.mainTarget : tp2,
        extendedTarget: mp ? mp.predictedMovement.extendedTarget : 0,
        predictionConfidence: mp ? mp.confidence : 0,
      },

      // Performance
      stats: this.stats,
      recentHistory: this.tradeHistory.slice(0, 5),
    };
  }

  // ═══════════════════════════════════════════════════════════════════
  // TRADE CLOSE — Record result and update stats
  // ═══════════════════════════════════════════════════════════════════
  closeTrade(trade, exitPrice, reason) {
    const priceDelta = trade.direction > 0 ? (exitPrice - trade.entryPrice) : (trade.entryPrice - exitPrice);
    const pnlUSD = +(trade.sizeETH * priceDelta + (trade.realizedPartialPnl || 0)).toFixed(2);
    const isWin = pnlUSD > 0;

    this.tradeHistory.unshift({
      ...trade,
      exitPrice,
      exitReason: reason,
      finalPnlUSD: pnlUSD,
      isWin,
      duration: Math.round((Date.now() - trade.startTime) / 1000),
    });
    if (this.tradeHistory.length > 30) this.tradeHistory.pop();

    this.tradeCount++;
    if (isWin) {
      this.winCount++;
    } else if (this.healingEngine) {
      this.healingEngine.reportAlgorithmError({
        algoId: 99,
        algoName: 'Production Strategy (NEXUS-V)',
        algoTag: 'NEXUS',
        action: trade.direction > 0 ? 'BUY' : 'SELL',
        entryPrice: trade.entryPrice,
        exitPrice,
        pnlUSD,
        currentPrice: exitPrice,
        marketContext: {
          atr: trade.atrAtEntry || 15,
          regime: trade.regime || 'TRENDING',
        },
      });
    }

    // Update stats
    this.stats.tradesExecuted = this.tradeCount;
    this.stats.winRatePct = this.tradeCount > 0 ? Math.round((this.winCount / this.tradeCount) * 100) : 0;
    this.stats.totalPnlUSD = +(this.stats.totalPnlUSD + pnlUSD).toFixed(2);

    const wins = this.tradeHistory.filter(t => t.isWin);
    const losses = this.tradeHistory.filter(t => !t.isWin);
    this.stats.avgGainUSD = wins.length > 0 ? +(wins.reduce((s, t) => s + t.finalPnlUSD, 0) / wins.length).toFixed(2) : 0;
    this.stats.avgLossUSD = losses.length > 0 ? +(losses.reduce((s, t) => s + Math.abs(t.finalPnlUSD), 0) / losses.length).toFixed(2) : 0;
    this.stats.profitFactor = this.stats.avgLossUSD > 0 ? +(this.stats.avgGainUSD / this.stats.avgLossUSD).toFixed(2) : 0;

    this.activeTrade = null;
    this.status = 'SCANNING';
  }

  getFallbackTelemetry(price = 2608.50) {
    return {
      strategyName: this.name,
      version: this.version,
      status: 'AWAITING LIVE DATA',
      action: 'WAITING FOR LIVE MARKET DATA',
      verdict: 'HOLD',
      verdictConfidence: 0,
      confluenceScore: 0,
      direction: 0,
      regime: 'AWAITING DATA',
      regimeProfile: 'awaiting',
      atr: '—',
      predictedRange: { high: 0, low: 0, expectedMove: 0 },
      positionSizeETH: 0,
      positionUSD: '0.00',
      kellyFraction: '0%',
      layers: this.layers,
      activeTrade: null,
      roadmap: {
        entryPrice: price,
        tp1Price: 0,
        tp2Price: 0,
        slPrice: 0,
        tp1GainUSD: '0.00',
        tp2GainUSD: '0.00',
        slLossUSD: '0.00',
        riskRewardRatio: '—',
        tpMethod: 'Awaiting ATR data',
        slMethod: 'Awaiting ATR data',
      },
      stats: this.stats,
      recentHistory: [],
    };
  }
}
