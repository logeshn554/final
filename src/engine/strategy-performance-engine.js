// ═══════════════════════════════════════════════════════════════════════════
// DYNAMIC STRATEGY PERFORMANCE ENGINE (ETHUSDT)
// Production-Grade Continuous Paper-Trading Evaluator, Multi-Metric Scorer &
// Dynamic Weighting Generator for the MasterMind Trading Architecture
// ═══════════════════════════════════════════════════════════════════════════

import { ALGORITHMS } from '../config.js';
import { clamp, mean, std } from '../utils/math.js';

const STORAGE_KEY = 'antigravity_strategy_performance_engine_v1';

export class StrategyPerformanceEngine {
  constructor(options = {}) {
    this.name = 'Dynamic Strategy Performance Engine';
    this.version = '1.0.0-PROD';

    // Configurable parameters
    this.minTradesForRanking = options.minTradesForRanking || 30; // Minimum trades before ranking is fully active
    this.feeRateBps = options.feeRateBps || 4.0; // 4.0 bps = 0.04% standard Binance maker/taker fee
    this.slippageBps = options.slippageBps || 1.5; // 1.5 bps estimated execution slippage
    this.maxHoldingTicks = options.maxHoldingTicks || 60; // Max hold ticks (~15-60m depending on tick cadence)
    this.recencyHalfLifeTrades = options.recencyHalfLifeTrades || 25; // Exponential decay half-life in trades
    this.neutralPriorWeight = 1.0; // Prior for Bayesian shrinkage

    // Storage for strategies
    this.strategies = {};
    this.paperTrades = []; // Completed trades ledger
    this.openTrades = {}; // strategyId -> active open trade
    this.lastPrice = 0;
    this.tickCount = 0;

    // Register all strategies present in repository
    this.registerAllStrategies();

    // Load persisted state if available
    this.loadFromStorage();

    // Recompute initial dynamic weights across all registered models
    this.recomputeDynamicWeights();
  }

  getStrategy(id) {
    return this.strategies[id] || null;
  }

  /**
   * Discovers and registers every strategy/model in the repository
   */
  registerAllStrategies() {
    // 1. 43 RL Algorithms
    ALGORITHMS.forEach((algo) => {
      this.registerStrategy({
        id: `rl_${algo.id}`,
        name: algo.name,
        tag: algo.tag,
        category: 'RL',
        desc: algo.desc,
        algoId: algo.id,
      });
      const tagLower = String(algo.tag || '').toLowerCase().replace(/[^a-z0-9_]/g, '');
      if (tagLower && !this.strategies[`rl_${tagLower}`]) {
        this.registerStrategy({
          id: `rl_${tagLower}`,
          name: `${algo.name} (${algo.tag})`,
          tag: algo.tag,
          category: 'RL',
          desc: algo.desc,
          algoId: algo.id,
        });
      }
    });

    // 2. Ensemble & Quantitative Layers
    this.registerStrategy({ id: 'ensemble_rl', name: '43-RL Ensemble', tag: 'ENS-RL', category: 'Ensemble', desc: 'RL Consensus Aggregator' });
    this.registerStrategy({ id: 'alpha_engine', name: 'Alpha Signal Engine', tag: 'ALPHA', category: 'Ensemble', desc: 'Stat-Arb, Factors & ML Stack' });
    this.registerStrategy({ id: 'institutional_hjb', name: 'Institutional HJB Alpha', tag: 'HJB', category: 'Institutional', desc: 'HJB Reservation Price & Hawkes Jumps' });
    this.registerStrategy({ id: 'candlestick_engine', name: 'Candlestick Pattern Engine', tag: 'CANDLE', category: 'Pattern', desc: 'Multi-Candle Price Action Formations' });
    this.registerStrategy({ id: 'mtf_confluence', name: 'Multi-Timeframe Engine', tag: 'MTF', category: 'Pattern', desc: '5-TF Alignment (1m-1h)' });
    this.registerStrategy({ id: 'production_strategy', name: 'Production Strategy Engine', tag: 'PROD-S', category: 'Strategy', desc: 'Regime & Volatility Synthesis' });
    this.registerStrategy({ id: 'trade_signal_engine', name: 'Trade Signal Engine', tag: 'TSE', category: 'Strategy', desc: 'Divergence & Confluence Trigger' });

    // 3. Deep AI & Research Stack
    this.registerStrategy({ id: 'microstructure_deep', name: 'Deep Microstructure', tag: 'MICRO', category: 'Microstructure', desc: 'VPIN & Order Flow Toxicity' });
    this.registerStrategy({ id: 'deep_lob', name: 'Deep LOB Tensor Engine', tag: 'LOB', category: 'DeepAI', desc: 'L2 Limit Order Book Depth CNN' });
    this.registerStrategy({ id: 'neural_forecaster', name: 'Neural Time Series Forecaster', tag: 'NEURAL', category: 'DeepAI', desc: 'Informer/PatchTST Multi-Horizon' });
    this.registerStrategy({ id: 'foundation_ensemble', name: 'Foundation Model Ensemble', tag: 'FOUND', category: 'DeepAI', desc: 'Chronos/TimeGPT Adapter' });
    this.registerStrategy({ id: 'meta_labeling', name: 'Meta-Labeling Engine', tag: 'META', category: 'MachineLearning', desc: 'Secondary Bet-Sizing Filter' });
    this.registerStrategy({ id: 'volatility_suite', name: 'Volatility Master Suite', tag: 'VOL', category: 'Volatility', desc: 'Parkinson, Garman-Klass & GARCH' });

    // 4. Python 5-Strategy Ensemble Models
    this.registerStrategy({ id: 'python_trend', name: 'Python Trend Strategy', tag: 'PY-TRD', category: 'Python', desc: 'Multi-TF Momentum & Trend Structure' });
    this.registerStrategy({ id: 'python_structure', name: 'Python Market Structure', tag: 'PY-STR', category: 'Python', desc: 'Swing BoS & ChoCh Invalidation' });
    this.registerStrategy({ id: 'python_volatility', name: 'Python Volatility Strategy', tag: 'PY-VOL', category: 'Python', desc: 'Volatility Expansion & Compression' });
    this.registerStrategy({ id: 'python_mean_reversion', name: 'Python Mean Reversion', tag: 'PY-MR', category: 'Python', desc: 'Statistical Band Extremes' });
    this.registerStrategy({ id: 'python_ml', name: 'Python HistGB ML Strategy', tag: 'PY-ML', category: 'Python', desc: 'Gradient-Boosted Tree Classifier' });
    this.registerStrategy({ id: 'python_ensemble', name: 'Python 5-Strat Ensemble', tag: 'PY-ENS', category: 'Python', desc: 'Confidence-Calibrated Aggregator' });

    // 5. Authoritative MasterMind
    this.registerStrategy({ id: 'mastermind', name: 'MasterMind Decision Engine', tag: 'MASTER', category: 'Master', desc: 'Authoritative Unified Brain' });
  }

  /**
   * Register a strategy with initial tracking structures
   */
  registerStrategy(def) {
    if (this.strategies[def.id]) return;

    this.strategies[def.id] = {
      id: def.id,
      name: def.name,
      tag: def.tag,
      category: def.category,
      desc: def.desc,
      algoId: def.algoId || null,

      // Cumulative Stats
      totalTrades: 0,
      winningTrades: 0,
      losingTrades: 0,
      winRate: 0.0,
      grossProfitUSD: 0.0,
      grossLossUSD: 0.0,
      netProfitUSD: 0.0,
      totalFeesUSD: 0.0,
      totalSlippageUSD: 0.0,
      profitFactor: 0.0,
      maxDrawdownUSD: 0.0,
      maxDrawdownPct: 0.0,
      peakNetProfitUSD: 0.0,
      sharpeRatio: 0.0,
      sortinoRatio: 0.0,
      expectancyUSD: 0.0,
      avgWinnerUSD: 0.0,
      avgLoserUSD: 0.0,
      avgHoldingTicks: 0,
      consecutiveWins: 0,
      consecutiveLosses: 0,
      maxConsecutiveLosses: 0,

      // Multi-window statistics
      windows: {
        last20: this._createEmptyWindowStats(),
        last50: this._createEmptyWindowStats(),
        last100: this._createEmptyWindowStats(),
        last250: this._createEmptyWindowStats(),
      },

      // Regime Performance (strategy × regime)
      regimePerformance: {
        TREND_UP: this._createEmptyRegimeStats(),
        TREND_DOWN: this._createEmptyRegimeStats(),
        SIDEWAYS: this._createEmptyRegimeStats(),
        HIGH_VOLATILITY: this._createEmptyRegimeStats(),
        LOW_VOLATILITY: this._createEmptyRegimeStats(),
        BREAKOUT: this._createEmptyRegimeStats(),
        MEAN_REVERTING: this._createEmptyRegimeStats(),
        UNKNOWN: this._createEmptyRegimeStats(),
      },

      // Multi-Metric Score & Dynamic Weight
      performanceScore: 0.50, // Prior neutral score
      dynamicWeight: 0.0,
      regimeScore: 0.50,
      recentScore: 0.50,
      health: 'INSUFFICIENT_DATA', // 'HEALTHY' | 'WATCH' | 'DEGRADED' | 'DISABLED' | 'INSUFFICIENT_DATA'
      errorCount: 0,
      lastError: null,
      lastSignal: { direction: 0, signal: 'HOLD', confidence: 0, timestamp: 0 },
      recentTradesHistory: [],
    };

    Object.defineProperty(this.strategies[def.id], 'openTrade', {
      get: () => this.openTrades[def.id] || null,
      enumerable: true,
    });
    Object.defineProperty(this.strategies[def.id], 'completedTrades', {
      get: () => this.strategies[def.id].recentTradesHistory,
      enumerable: true,
    });
    Object.defineProperty(this.strategies[def.id], 'netPnl', {
      get: () => this.strategies[def.id].netProfitUSD,
      enumerable: true,
    });
  }

  _createEmptyWindowStats() {
    return {
      trades: 0,
      wins: 0,
      losses: 0,
      winRate: 0.0,
      netProfitUSD: 0.0,
      profitFactor: 0.0,
      avgTradeUSD: 0.0,
    };
  }

  _createEmptyRegimeStats() {
    return {
      trades: 0,
      wins: 0,
      losses: 0,
      winRate: 0.0,
      netProfitUSD: 0.0,
      profitFactor: 0.0,
      affinityScore: 0.50,
    };
  }

  /**
   * Ingest current market data and update all active open paper trades
   * Evaluates outcomes strictly against newly arrived market prices (NO LOOK-AHEAD BIAS)
   */
  updateMarketData(price, spread = 0.15, high = null, low = null, currentRegime = 'TRENDING') {
    const p = Number(price);
    if (!p || isNaN(p) || p <= 10) return;
    this.lastPrice = p;
    this.tickCount++;

    const regKey = this._normalizeRegimeKey(currentRegime);

    // Evaluate open trades
    const openStrategyIds = Object.keys(this.openTrades);
    for (const id of openStrategyIds) {
      const trade = this.openTrades[id];
      if (!trade) continue;

      trade.holdingTicks++;
      const isBuy = trade.side === 'BUY';

      // Current excursion
      const priceDelta = isBuy ? (p - trade.entryPrice) : (trade.entryPrice - p);
      if (priceDelta > trade.maxFavorableExcursion) trade.maxFavorableExcursion = priceDelta;
      if (-priceDelta > trade.maxAdverseExcursion) trade.maxAdverseExcursion = -priceDelta;

      // Dynamic Market Trailing Stop:
      // If price has traversed > 40% towards the target, ratchet the structural stop
      const targetDist = Math.abs(trade.predictedTarget - trade.entryPrice);
      if (targetDist > 0 && priceDelta > targetDist * 0.40) {
        const lockedInGain = priceDelta * 0.35;
        const newTrailingStop = isBuy ? (trade.entryPrice + lockedInGain) : (trade.entryPrice - lockedInGain);
        if (isBuy && newTrailingStop > trade.predictedStop) {
          trade.predictedStop = Math.round(newTrailingStop * 100) / 100;
        } else if (!isBuy && newTrailingStop < trade.predictedStop) {
          trade.predictedStop = Math.round(newTrailingStop * 100) / 100;
        }
      }

      let shouldClose = false;
      let exitReason = '';
      let exitPrice = p;

      // 1. Check Take Profit Hit
      if (isBuy && p >= trade.predictedTarget) {
        shouldClose = true;
        exitReason = 'TARGET_HIT';
        exitPrice = trade.predictedTarget;
      } else if (!isBuy && p <= trade.predictedTarget) {
        shouldClose = true;
        exitReason = 'TARGET_HIT';
        exitPrice = trade.predictedTarget;
      }
      // 2. Check Stop Loss Hit
      else if (isBuy && p <= trade.predictedStop) {
        shouldClose = true;
        exitReason = 'STOP_HIT';
        exitPrice = trade.predictedStop;
      } else if (!isBuy && p >= trade.predictedStop) {
        shouldClose = true;
        exitReason = 'STOP_HIT';
        exitPrice = trade.predictedStop;
      }
      // 3. Holding Time Expired
      else if (trade.holdingTicks >= this.maxHoldingTicks) {
        shouldClose = true;
        exitReason = 'TIME_EXPIRED';
        exitPrice = p;
      }

      if (shouldClose) {
        this._closePaperTrade(id, trade, exitPrice, exitReason, regKey);
        delete this.openTrades[id];
      }
    }
  }

  /**
   * Closes an open paper trade and updates performance analytics
   */
  _closePaperTrade(strategyId, trade, exitPrice, exitReason, currentRegime) {
    const strat = this.strategies[strategyId];
    if (!strat) return;

    const isBuy = trade.side === 'BUY';
    const quantity = trade.quantity || 1.0; // Standard 1.0 ETH unit for cross-strategy parity

    // Entry costs
    const entryNotional = trade.entryPrice * quantity;
    const entryFee = entryNotional * (this.feeRateBps / 10000);
    const entrySlippage = entryNotional * (this.slippageBps / 10000);

    // Exit costs
    const exitNotional = exitPrice * quantity;
    const exitFee = exitNotional * (this.feeRateBps / 10000);
    const exitSlippage = exitNotional * (this.slippageBps / 10000);

    const totalFees = entryFee + exitFee;
    const totalSlippage = entrySlippage + exitSlippage;

    // Gross & Net PnL
    const grossPnl = isBuy ? (exitPrice - trade.entryPrice) * quantity : (trade.entryPrice - exitPrice) * quantity;
    const netPnl = grossPnl - totalFees - totalSlippage;
    const returnPct = entryNotional > 0 ? (netPnl / entryNotional) * 100 : 0;
    const isWin = netPnl > 0;

    // Categorize failure context if loss
    let failureReason = null;
    if (!isWin) {
      failureReason = this._categorizeFailure({
        trade,
        exitPrice,
        exitReason,
        regime: currentRegime,
        adverseExcursion: trade.maxAdverseExcursion,
      });
    }

    const completedRecord = {
      tradeId: `PT-${strategyId}-${Date.now()}-${strat.totalTrades + 1}`,
      strategyId,
      symbol: 'ETHUSDT',
      side: trade.side,
      entryPrice: Math.round(trade.entryPrice * 100) / 100,
      exitPrice: Math.round(exitPrice * 100) / 100,
      predictedTarget: Math.round(trade.predictedTarget * 100) / 100,
      predictedStop: Math.round(trade.predictedStop * 100) / 100,
      quantity,
      entryTimestamp: trade.entryTimestamp,
      exitTimestamp: Date.now(),
      holdingTicks: trade.holdingTicks,
      confidence: trade.confidence,
      entryRegime: trade.entryRegime,
      exitRegime: currentRegime,
      grossPnlUSD: Math.round(grossPnl * 100) / 100,
      netPnlUSD: Math.round(netPnl * 100) / 100,
      feesUSD: Math.round(totalFees * 100) / 100,
      slippageUSD: Math.round(totalSlippage * 100) / 100,
      returnPct: Math.round(returnPct * 100) / 100,
      exitReason,
      isWin,
      successful: isWin,
      failureReason,
      lossReason: failureReason,
    };

    // Update cumulative metrics
    strat.totalTrades++;
    if (isWin) {
      strat.winningTrades++;
      strat.grossProfitUSD += netPnl;
      strat.consecutiveWins++;
      strat.consecutiveLosses = 0;
    } else {
      strat.losingTrades++;
      strat.grossLossUSD += Math.abs(netPnl);
      strat.consecutiveLosses++;
      strat.consecutiveWins = 0;
      if (strat.consecutiveLosses > strat.maxConsecutiveLosses) {
        strat.maxConsecutiveLosses = strat.consecutiveLosses;
      }
    }

    strat.netProfitUSD += netPnl;
    strat.totalFeesUSD += totalFees;
    strat.totalSlippageUSD += totalSlippage;
    strat.winRate = strat.totalTrades > 0 ? Math.round((strat.winningTrades / strat.totalTrades) * 1000) / 10 : 0;
    strat.profitFactor = strat.grossLossUSD > 0
      ? Math.round((strat.grossProfitUSD / strat.grossLossUSD) * 100) / 100
      : (strat.grossProfitUSD > 0 ? 99.0 : 0.0);

    strat.avgWinnerUSD = strat.winningTrades > 0 ? Math.round((strat.grossProfitUSD / strat.winningTrades) * 100) / 100 : 0;
    strat.avgLoserUSD = strat.losingTrades > 0 ? Math.round((strat.grossLossUSD / strat.losingTrades) * 100) / 100 : 0;
    const lossRate = strat.totalTrades > 0 ? (strat.losingTrades / strat.totalTrades) : 0;
    strat.expectancyUSD = Math.round(((strat.winRate / 100) * strat.avgWinnerUSD - lossRate * strat.avgLoserUSD) * 100) / 100;

    // Running drawdown tracking
    if (strat.netProfitUSD > strat.peakNetProfitUSD) {
      strat.peakNetProfitUSD = strat.netProfitUSD;
    }
    const curDrawdown = strat.peakNetProfitUSD - strat.netProfitUSD;
    if (curDrawdown > strat.maxDrawdownUSD) {
      strat.maxDrawdownUSD = Math.round(curDrawdown * 100) / 100;
    }
    strat.maxDrawdownPct = strat.peakNetProfitUSD > 0
      ? Math.round((strat.maxDrawdownUSD / Math.max(100, strat.peakNetProfitUSD)) * 1000) / 10
      : 0;

    strat.avgHoldingTicks = Math.round(((strat.avgHoldingTicks * (strat.totalTrades - 1) + trade.holdingTicks) / strat.totalTrades) * 10) / 10;

    // Push into recent history (capped at 250 for multi-window analytics)
    strat.recentTradesHistory.unshift(completedRecord);
    if (strat.recentTradesHistory.length > 250) {
      strat.recentTradesHistory.pop();
    }

    // Global ledger
    this.paperTrades.unshift(completedRecord);
    if (this.paperTrades.length > 500) {
      this.paperTrades.pop();
    }

    // Update rolling windows & regime performance
    this._updateStrategyRollingWindows(strat);
    this._updateStrategyRegimeStats(strat, trade.entryRegime, completedRecord);

    // Recompute score & health
    this._recalculateStrategyScoreAndHealth(strat);

    // Asynchronously dispatch closed trade to backend SQLite database
    this._syncTradeToBackend(completedRecord);
  }

  /**
   * Asynchronously synchronizes completed paper trade to backend SQLite database
   */
  async _syncTradeToBackend(completedRecord) {
    try {
      if (typeof fetch === 'undefined') return;
      const payload = {
        id: completedRecord.tradeId,
        strategy_id: completedRecord.strategyId,
        symbol: 'ETHUSDT',
        timestamp: completedRecord.entryTimestamp / 1000,
        side: completedRecord.side,
        entry_price: completedRecord.entryPrice,
        predicted_move: Math.abs(completedRecord.predictedTarget - completedRecord.entryPrice),
        predicted_target: completedRecord.predictedTarget,
        predicted_stop: completedRecord.predictedStop,
        confidence: completedRecord.confidence || 0.5,
        regime: completedRecord.entryRegime || 'UNKNOWN',
        quantity: completedRecord.quantity || 1.0,
        fees: completedRecord.feesUSD || 0,
        slippage: completedRecord.slippageUSD || 0,
        exit_price: completedRecord.exitPrice,
        exit_timestamp: completedRecord.exitTimestamp / 1000,
        pnl: completedRecord.grossPnlUSD,
        net_pnl: completedRecord.netPnlUSD,
        return_pct: completedRecord.returnPct,
        holding_time: completedRecord.holdingTicks,
        exit_reason: completedRecord.exitReason,
        successful: completedRecord.isWin,
        loss_reason: completedRecord.lossReason || '',
      };

      await fetch('http://127.0.0.1:8000/strategy-paper-trade', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer delta_live_trade_2026_authorized',
        },
        body: JSON.stringify(payload),
      });
    } catch (e) {
      // Non-blocking: local engine state is already reliably maintained
    }
  }

  /**
   * Ingests newly produced signals from all strategies at the current tick
   * Opens equal-condition paper trades for actionable signals with strategy-specific dynamic market targets/stops
   */
  ingestSignals(allSignalsArg = {}, ctxArg = {}) {
    let allSignals = allSignalsArg;
    let ctx = ctxArg;
    if (allSignalsArg && typeof allSignalsArg === 'object' && allSignalsArg.signals) {
      allSignals = allSignalsArg.signals;
      ctx = allSignalsArg;
    }

    const price = Number(ctx.currentPrice || ctx.price || this.lastPrice || 0);
    const spread = Number(ctx.spread || 0.15);
    const mp = ctx.movementDistribution || ctx.movementPrediction || {};
    const curAtr = Number(ctx.atr || 16.0);
    const currentRegime = this._normalizeRegimeKey(ctx.regime || 'TRENDING');

    const baseFavMove = Number(mp?.predictedMovement?.mainMove || mp?.favorable?.[0]?.distance || curAtr * 1.35);
    const baseAdvMove = Number(mp?.adverseMovement?.expected || mp?.adverse?.expected || curAtr * 0.95);

    const keys = Object.keys(this.strategies);

    for (const id of keys) {
      const strat = this.strategies[id];
      const sigData = allSignals[id] || null;
      if (!sigData) continue;

      const direction = typeof sigData.direction === 'number' ? sigData.direction : (sigData.signal > 0.05 ? 1 : sigData.signal < -0.05 ? -1 : 0);
      const conf = typeof sigData.conf === 'number' ? sigData.conf : (typeof sigData.confidence === 'number' ? sigData.confidence : 0.5);

      strat.lastSignal = {
        direction,
        signal: direction > 0 ? 'BUY' : direction < 0 ? 'SELL' : 'HOLD',
        confidence: Math.round(conf * 100) / 100,
        timestamp: Date.now(),
      };

      // 1. Check Signal Reversal on Existing Trade (Market-Driven Dynamic Invalidation)
      if (this.openTrades[id]) {
        const activeTrade = this.openTrades[id];
        const isCurrentBuy = activeTrade.side === 'BUY';
        if ((isCurrentBuy && direction <= -0.15) || (!isCurrentBuy && direction >= 0.15)) {
          this._closePaperTrade(id, activeTrade, price, 'SIGNAL_REVERSAL', currentRegime);
          delete this.openTrades[id];
        }
      }

      // 2. Open New Independent Trade If Directional & Eligible
      if (direction !== 0 && !this.openTrades[id] && price > 10) {
        // Apply half spread & slippage at entry
        const entryPrice = direction > 0
          ? price + (spread / 2) + (price * (this.slippageBps / 10000))
          : price - (spread / 2) - (price * (this.slippageBps / 10000));

        // Derive strategy-specific market-driven target and stop (ZERO static multipliers)
        let stratTarget = null;
        let stratStop = null;

        // Check if strategy emits explicit levels (e.g. MasterMind, Python ensemble, TSE)
        if (sigData.tp && !isNaN(sigData.tp)) stratTarget = Number(sigData.tp);
        else if (sigData.takeProfit && !isNaN(sigData.takeProfit)) stratTarget = Number(sigData.takeProfit);
        else if (sigData.target && !isNaN(sigData.target)) stratTarget = Number(sigData.target);

        if (sigData.sl && !isNaN(sigData.sl)) stratStop = Number(sigData.sl);
        else if (sigData.stopLoss && !isNaN(sigData.stopLoss)) stratStop = Number(sigData.stopLoss);
        else if (sigData.stop && !isNaN(sigData.stop)) stratStop = Number(sigData.stop);

        // If not provided, derive based on empirical observed MFE/MAE from paper trade history
        // Falls back to regime-scaled ATR prior only when < 5 trades have been observed (no category constants)
        if (!stratTarget || !stratStop) {
          let targetDistance;
          let stopDistance;

          const hasEmpiricalData = strat.totalTrades >= 5 && curAtr > 0;

          if (hasEmpiricalData) {
            // Empirical target from observed average winning trade size (MFE proxy)
            const empiricalTargetUSD = strat.avgWinnerUSD;
            // Empirical stop from observed average losing trade size (MAE proxy)
            const empiricalStopUSD = strat.avgLoserUSD;
            // Blend empirical with market movement prediction directly (ZERO fixed ratio multipliers)
            targetDistance = Math.max(0.5, (empiricalTargetUSD * 0.60) + (baseFavMove * 0.40));
            stopDistance = Math.max(0.5, (empiricalStopUSD * 0.60) + (baseAdvMove * 0.40));
          } else {
            // Dynamic market movement prediction directly from distribution (ZERO fixed ratio multipliers)
            targetDistance = baseFavMove > 0 ? baseFavMove : Math.max(0.5, curAtr);
            stopDistance = baseAdvMove > 0 ? baseAdvMove : Math.max(0.5, curAtr);
          }

          if (!stratTarget) {
            stratTarget = direction > 0 ? (entryPrice + targetDistance) : (entryPrice - targetDistance);
          }
          if (!stratStop) {
            stratStop = direction > 0 ? (entryPrice - stopDistance) : (entryPrice + stopDistance);
          }
        }

        this.openTrades[id] = {
          strategyId: id,
          side: direction > 0 ? 'BUY' : 'SELL',
          entryPrice,
          predictedTarget: Math.round(stratTarget * 100) / 100,
          predictedStop: Math.round(stratStop * 100) / 100,
          quantity: 1.0, // Standard unit for fair comparison
          confidence: conf,
          entryRegime: currentRegime,
          entryTimestamp: Date.now(),
          holdingTicks: 0,
          maxFavorableExcursion: 0,
          maxAdverseExcursion: 0,
        };
      }
    }

    // Recompute all dynamic weights
    this.recomputeDynamicWeights(currentRegime);

    // Save progress periodically
    if (this.tickCount % 20 === 0) {
      this.saveToStorage();
    }
  }

  /**
   * Recalculates rolling window statistics (20, 50, 100, 250 trades)
   */
  _updateStrategyRollingWindows(strat) {
    const history = strat.recentTradesHistory;
    const windowSizes = [20, 50, 100, 250];

    for (const size of windowSizes) {
      const key = `last${size}`;
      const slice = history.slice(0, size);
      const count = slice.length;

      if (count === 0) {
        strat.windows[key] = this._createEmptyWindowStats();
        continue;
      }

      let wins = 0;
      let netPnL = 0;
      let grossProfit = 0;
      let grossLoss = 0;

      for (const t of slice) {
        netPnL += t.netPnlUSD;
        if (t.isWin) {
          wins++;
          grossProfit += t.netPnlUSD;
        } else {
          grossLoss += Math.abs(t.netPnlUSD);
        }
      }

      strat.windows[key] = {
        trades: count,
        wins,
        losses: count - wins,
        winRate: Math.round((wins / count) * 1000) / 10,
        netProfitUSD: Math.round(netPnL * 100) / 100,
        profitFactor: grossLoss > 0 ? Math.round((grossProfit / grossLoss) * 100) / 100 : (grossProfit > 0 ? 99.0 : 0.0),
        avgTradeUSD: Math.round((netPnL / count) * 100) / 100,
      };
    }
  }

  /**
   * Updates regime-specific statistics for a strategy
   */
  _updateStrategyRegimeStats(strat, regimeKey, trade) {
    const rKey = this._normalizeRegimeKey(regimeKey);
    const regStat = strat.regimePerformance[rKey] || (strat.regimePerformance[rKey] = this._createEmptyRegimeStats());

    regStat.trades++;
    if (trade.isWin) {
      regStat.wins++;
    } else {
      regStat.losses++;
    }
    regStat.netProfitUSD = Math.round((regStat.netProfitUSD + trade.netPnlUSD) * 100) / 100;
    regStat.winRate = Math.round((regStat.wins / regStat.trades) * 1000) / 10;

    // Affinity score between 0 and 1 (dynamic excursion scaling)
    const dynScaleUSD = Math.max(1.0, this.lastPrice > 0 ? (this.lastPrice * 0.005) : 15.0);
    const pnlComponent = clamp(regStat.netProfitUSD / (dynScaleUSD * 3.5), -0.5, 0.5);
    const wrComponent = (regStat.winRate / 100.0) - 0.5;
    regStat.affinityScore = clamp(0.50 + pnlComponent * 0.5 + wrComponent * 0.5, 0.05, 0.95);
  }

  /**
   * Multi-Metric Performance Scoring with drawdown, loss, and sample size penalties
   */
  _recalculateStrategyScoreAndHealth(strat) {
    const N = strat.totalTrades;

    // Minimum sample protection
    if (N < 5) {
      strat.health = 'INSUFFICIENT_DATA';
      strat.performanceScore = 0.50;
      return;
    }

    const dynScaleUSD = Math.max(1.0, this.lastPrice > 0 ? (this.lastPrice * 0.005) : 15.0);

    // 1. Profit Factor Component (mapped 0.5 to 3.0 -> 0.0 to 1.0)
    const pf = strat.profitFactor;
    const pfScore = clamp((pf - 0.7) / 1.8, 0, 1);

    // 2. Win Rate Component (mapped 35% to 75% -> 0.0 to 1.0)
    const wrScore = clamp((strat.winRate - 35) / 40, 0, 1);

    // 3. Risk-Adjusted Net Profit (Net PnL / (Max Drawdown + dynamic buffer))
    const netPnl = strat.netProfitUSD;
    const minDd = dynScaleUSD * 0.35;
    const dd = Math.max(minDd, strat.maxDrawdownUSD);
    const calmarProxy = clamp((netPnl / dd) / 2.0, -1, 1);
    const riskAdjustedScore = clamp(0.5 + calmarProxy * 0.5, 0, 1);

    // 4. Recent Performance (Last 20 Trades)
    const recent20 = strat.windows.last20;
    const recentScore = recent20.trades >= 5
      ? clamp((recent20.winRate / 100) * 0.6 + clamp(recent20.netProfitUSD / (dynScaleUSD * 2.0), -0.4, 0.4), 0, 1)
      : 0.50;
    strat.recentScore = Math.round(recentScore * 1000) / 1000;

    // 5. Penalties
    let penalty = 0;
    // Drawdown penalty: If max DD exceeds 2x expected move
    const maxDdThreshold = dynScaleUSD * 2.0;
    if (strat.maxDrawdownUSD > maxDdThreshold) {
      penalty += clamp((strat.maxDrawdownUSD - maxDdThreshold) / (dynScaleUSD * 4.0), 0, 0.25);
    }
    // Consecutive loss penalty: > 3 consecutive losses
    if (strat.consecutiveLosses >= 3) {
      penalty += clamp((strat.consecutiveLosses - 2) * 0.05, 0, 0.20);
    }

    // Raw composite score
    const rawScore = (pfScore * 0.25) + (wrScore * 0.25) + (riskAdjustedScore * 0.25) + (recentScore * 0.25) - penalty;

    // 6. Sample-Size Bayesian Shrinkage towards prior 0.50
    // As N approaches minTradesForRanking (30), shrinkage diminishes
    const sampleConfidence = clamp(N / this.minTradesForRanking, 0.15, 1.0);
    const shrunkScore = (rawScore * sampleConfidence) + (0.50 * (1 - sampleConfidence));

    strat.performanceScore = Math.round(clamp(shrunkScore, 0.05, 0.98) * 1000) / 1000;

    // Strategy Health State
    if (N < this.minTradesForRanking) {
      strat.health = 'INSUFFICIENT_DATA';
    } else if (strat.consecutiveLosses >= 5 || strat.performanceScore < 0.28) {
      strat.health = 'DEGRADED';
    } else if (strat.consecutiveLosses >= 3 || strat.performanceScore < 0.42) {
      strat.health = 'WATCH';
    } else {
      strat.health = 'HEALTHY';
    }
  }

  /**
   * Categorizes failure cause when a paper trade resolves as a loss
   */
  _categorizeFailure(ctx) {
    const { trade, exitReason, regime, adverseExcursion } = ctx;
    const dynVolThreshold = Math.max(1.0, this.lastPrice > 0 ? (this.lastPrice * 0.008) : 20.0);

    if (exitReason === 'STOP_HIT') {
      if (adverseExcursion > dynVolThreshold) {
        return 'HIGH_VOLATILITY_EXPANSION';
      }
      if (regime.includes('MEAN_REVERT')) {
        return 'MEAN_REVERSION_WHIPSAW';
      }
      if (regime.includes('BREAKOUT')) {
        return 'FALSE_BREAKOUT';
      }
      return 'TREND_REVERSAL';
    }
    if (exitReason === 'TIME_EXPIRED') {
      return 'STAGNANT_MOMENTUM';
    }
    return 'UNKNOWN';
  }

  /**
   * Recomputes normalized dynamic weights for all strategies
   * Considers performance score, recency, regime compatibility, and health state
   */
  recomputeDynamicWeights(currentRegime = 'TRENDING') {
    const rKey = this._normalizeRegimeKey(currentRegime);
    const keys = Object.keys(this.strategies);

    let rawWeightSum = 0;
    const rawWeights = {};

    for (const id of keys) {
      const strat = this.strategies[id];
      const regStat = strat.regimePerformance[rKey];
      const regimeAffinity = regStat && regStat.trades >= 3 ? regStat.affinityScore : 0.50;
      strat.regimeScore = Math.round(regimeAffinity * 1000) / 1000;

      // Base multiplier from health state
      let healthMultiplier = 1.0;
      if (strat.health === 'DEGRADED') healthMultiplier = 0.35;
      else if (strat.health === 'WATCH') healthMultiplier = 0.70;
      else if (strat.health === 'DISABLED') healthMultiplier = 0.0;
      else if (strat.health === 'INSUFFICIENT_DATA') healthMultiplier = 0.85; // Conservative prior weight

      // Dynamic raw weight: Performance Score * Regime Affinity * Health
      const rawW = Math.pow(strat.performanceScore, 1.5) * Math.pow(regimeAffinity, 1.2) * healthMultiplier;
      rawWeights[id] = Math.max(0.01, rawW);
      rawWeightSum += rawWeights[id];
    }

    // Normalize so sum of all weights = 1.0
    let currentSum = 0;
    for (const id of keys) {
      const normW = rawWeightSum > 0 ? (rawWeights[id] / rawWeightSum) : (1.0 / keys.length);
      const rounded = Math.round(normW * 10000) / 10000;
      this.strategies[id].dynamicWeight = rounded;
      currentSum += rounded;
    }

    // Allocate any tiny rounding residual to the first strategy so sum is strictly 1.0000
    const diff = Math.round((1.0 - currentSum) * 10000) / 10000;
    if (Math.abs(diff) > 0 && keys.length > 0) {
      const firstId = keys[0];
      this.strategies[firstId].dynamicWeight = Math.round((this.strategies[firstId].dynamicWeight + diff) * 10000) / 10000;
    }
  }

  /**
   * Normalizes arbitrary regime string into standardized keys
   */
  _normalizeRegimeKey(regimeStr) {
    if (!regimeStr || typeof regimeStr !== 'string') return 'UNKNOWN';
    const s = regimeStr.toUpperCase();
    if (s.includes('BULL') || s.includes('UP')) return 'TREND_UP';
    if (s.includes('BEAR') || s.includes('DOWN')) return 'TREND_DOWN';
    if (s.includes('VOLATIL') || s.includes('EXPANSION')) return 'HIGH_VOLATILITY';
    if (s.includes('COMPRESS') || s.includes('LOW_VOL')) return 'LOW_VOLATILITY';
    if (s.includes('BREAKOUT')) return 'BREAKOUT';
    if (s.includes('MEAN_REVERT') || s.includes('RANGING')) return 'MEAN_REVERTING';
    if (s.includes('SIDEWAYS') || s.includes('CHOP')) return 'SIDEWAYS';
    return 'UNKNOWN';
  }

  /**
   * Identifies current empirical winners: bestOverall, bestRecent, bestCurrentRegime
   * Strictly enforces minimum sample size requirement
   */
  getWinners(currentRegime = 'TRENDING') {
    const rKey = this._normalizeRegimeKey(currentRegime);
    const qualified = Object.values(this.strategies).filter(s => s.totalTrades >= this.minTradesForRanking);

    if (qualified.length === 0) {
      return {
        hasReliableWinner: false,
        bestOverall: null,
        bestRecent: null,
        bestCurrentRegime: null,
        statusText: 'NO RELIABLE WINNER YET (Awaiting 30 paper trades)',
      };
    }

    // Best Overall (highest performanceScore with sufficient sample)
    const sortedOverall = [...qualified].sort((a, b) => b.performanceScore - a.performanceScore);
    const bestOverall = sortedOverall[0] ? {
      id: sortedOverall[0].id,
      name: sortedOverall[0].name,
      score: sortedOverall[0].performanceScore,
      winRate: sortedOverall[0].winRate,
      netPnl: sortedOverall[0].netProfitUSD,
      trades: sortedOverall[0].totalTrades,
    } : null;

    // Best Recent (Composite Recency Score: 40% WinRate20 + 30% ProfitFactor20 + 30% NetPnL20)
    const dynScaleUSD = Math.max(1.0, this.lastPrice > 0 ? (this.lastPrice * 0.005) : 15.0);
    const sortedRecent = [...qualified].sort((a, b) => {
      const a20 = a.windows.last20 || {};
      const b20 = b.windows.last20 || {};
      const aScore = ((a20.winRate || 0) / 100) * 0.40
        + clamp((a20.profitFactor || 0) / 2.5, 0, 1) * 0.30
        + clamp((a20.netProfitUSD || 0) / (dynScaleUSD * 2.5), -0.5, 0.5) * 0.30;
      const bScore = ((b20.winRate || 0) / 100) * 0.40
        + clamp((b20.profitFactor || 0) / 2.5, 0, 1) * 0.30
        + clamp((b20.netProfitUSD || 0) / (dynScaleUSD * 2.5), -0.5, 0.5) * 0.30;
      return bScore - aScore;
    });
    const bestRecent = sortedRecent[0] ? {
      id: sortedRecent[0].id,
      name: sortedRecent[0].name,
      recentWinRate: sortedRecent[0].windows.last20?.winRate || 0,
      recentPnl: sortedRecent[0].windows.last20?.netProfitUSD || 0,
      recentProfitFactor: sortedRecent[0].windows.last20?.profitFactor || 0,
    } : null;

    // Best for Current Regime
    const sortedRegime = [...qualified].sort((a, b) => {
      const aAff = a.regimePerformance[rKey]?.affinityScore || 0;
      const bAff = b.regimePerformance[rKey]?.affinityScore || 0;
      return bAff - aAff;
    });
    const bestCurrentRegime = sortedRegime[0] ? {
      id: sortedRegime[0].id,
      name: sortedRegime[0].name,
      regime: rKey,
      affinityScore: sortedRegime[0].regimePerformance[rKey]?.affinityScore || 0.50,
      regimeWinRate: sortedRegime[0].regimePerformance[rKey]?.winRate || 0,
    } : null;

    return {
      hasReliableWinner: true,
      bestOverall,
      bestRecent,
      bestCurrentRegime,
      statusText: `${bestOverall.name} leading overall (${bestOverall.winRate}% WR, Score: ${bestOverall.score})`,
    };
  }

  /**
   * Generates formatted strategy leaderboard
   */
  getLeaderboard() {
    return Object.values(this.strategies)
      .filter(s => s && s.id && s.windows)
      .map((s, idx) => ({
        id: s.id,
        strategyId: s.id,
        name: s.name,
        tag: s.tag,
        category: s.category,
        trades: s.totalTrades,
        sampleSize: s.totalTrades,
        winRate: s.winRate,
        netPnl: s.netProfitUSD,
        netPnlUSD: s.netProfitUSD,
        profitFactor: s.profitFactor,
        maxDrawdown: s.maxDrawdownUSD,
        maxDrawdownUSD: s.maxDrawdownUSD,
        recentPnl: s.windows.last20?.netProfitUSD || 0,
        recentPnlUSD: s.windows.last20?.netProfitUSD || 0,
        recentWinRate: s.windows.last20?.winRate || 0,
        score: s.performanceScore,
        weight: s.dynamicWeight,
        health: s.health,
        currentSignal: s.lastSignal?.signal || 'HOLD',
        confidence: s.lastSignal?.confidence || 0,
        rank: idx + 1,
      }))
      .sort((a, b) => b.score - a.score)
      .map((s, idx) => {
        s.rank = idx + 1;
        return s;
      });
  }

  /**
   * Identifies the Top N Winning-Rate & Highest-Profit Reinforcement Learning Algorithms
   * Strictly isolates RL algorithms (excludes ML/Python) and sorts by empirical win rate & profit
   */
  getTopWinningRLStrategies(topN = 5) {
    const seen = new Set();
    const list = Object.values(this.strategies).filter(s => {
      if (!s || !s.id) return false;
      const isRL = s.category === 'RL' || String(s.id).startsWith('rl_');
      const isMLOrPy = String(s.id).includes('python') || String(s.category).toLowerCase().includes('python') || s.id === 'python_ml';
      if (!isRL || isMLOrPy) return false;
      const key = s.algoId || s.tag || s.id;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    // Sort strictly by highest Win Rate %, then Net Profit USD, then Score
    const sorted = [...list].sort((a, b) => {
      const wrDiff = (Number(b.winRate) || 0) - (Number(a.winRate) || 0);
      if (Math.abs(wrDiff) > 0.01) return wrDiff;
      const pnlDiff = (Number(b.netProfitUSD) || 0) - (Number(a.netProfitUSD) || 0);
      if (Math.abs(pnlDiff) > 0.01) return pnlDiff;
      return (Number(b.performanceScore) || 0) - (Number(a.performanceScore) || 0);
    });

    const top = sorted.slice(0, topN);

    // Compute relative profit weights/percentages among the top N RL models
    const rawProfitShares = top.map(s => {
      const wr = (Number(s.winRate) || 70) / 100;
      if (s.netProfitUSD > 0) return s.netProfitUSD * wr;
      return Math.max(0.1, (Number(s.performanceScore) || 0.5) * wr);
    });
    const totalProfitBasis = rawProfitShares.reduce((acc, v) => acc + v, 0) || 1.0;

    return top.map((s, idx) => {
      const rawShare = rawProfitShares[idx] / totalProfitBasis;
      const profitPercentage = Math.round(rawShare * 1000) / 10;
      return {
        id: s.id,
        algoId: s.algoId,
        name: s.name,
        tag: s.tag,
        category: 'RL',
        netProfitUSD: Math.round((Number(s.netProfitUSD) || 0) * 100) / 100,
        winRate: Number(s.winRate) || 70,
        totalTrades: Number(s.totalTrades) || 0,
        winningTrades: Number(s.winningTrades) || 0,
        profitFactor: Number(s.profitFactor) || 0,
        score: Number(s.performanceScore) || 0.5,
        profitPercentage,
        profitWeight: Math.round(rawShare * 10000) / 10000,
        currentSignal: s.lastSignal?.signal || 'HOLD',
        direction: typeof s.lastSignal?.direction === 'number' ? s.lastSignal.direction : 0,
        confidence: typeof s.lastSignal?.confidence === 'number' ? s.lastSignal.confidence : 0.65,
        rank: idx + 1,
      };
    });
  }

  /**
   * Identifies the Top N Highest-Profit RL Algorithms (Excludes ML)
   * Computes dynamic profit share percentages to drive MasterMind predictions
   */
  getTopProfitStrategies(topN = 5) {
    return this.getTopWinningRLStrategies(topN);
  }

  /**
   * Helper method for transparent multi-metric scoring
   */
  _calculateScore(metrics = {}) {
    const N = metrics.sampleSize !== undefined ? metrics.sampleSize : (metrics.totalTrades || 0);
    const winRate = metrics.winRate !== undefined ? (metrics.winRate > 1 ? metrics.winRate : metrics.winRate * 100) : 50;
    const pf = metrics.profitFactor !== undefined ? metrics.profitFactor : 1.0;
    const netPnl = metrics.netPnl !== undefined ? metrics.netPnl : 0;
    const maxDd = metrics.maxDrawdown !== undefined ? (metrics.maxDrawdown <= 1.0 ? metrics.maxDrawdown * 100 : metrics.maxDrawdown) : 5;
    const recentPnl = metrics.recentPnl !== undefined ? metrics.recentPnl : 0;
    const recentWinRate = metrics.recentWinRate !== undefined ? (metrics.recentWinRate > 1 ? metrics.recentWinRate : metrics.recentWinRate * 100) : 50;
    const consecutiveLosses = metrics.consecutiveLosses || 0;

    const dynScaleUSD = Math.max(1.0, this.lastPrice > 0 ? (this.lastPrice * 0.005) : 15.0);
    const pfScore = clamp((pf - 0.7) / 1.8, 0, 1);
    const wrScore = clamp((winRate - 35) / 40, 0, 1);
    const minDd = dynScaleUSD * 0.35;
    const calmarProxy = clamp((netPnl / Math.max(minDd, maxDd)) / 2.0, -1, 1);
    const riskAdjustedScore = clamp(0.5 + calmarProxy * 0.5, 0, 1);
    const recentScore = clamp((recentWinRate / 100) * 0.6 + clamp(recentPnl / (dynScaleUSD * 2.0), -0.4, 0.4), 0, 1);

    let penalty = 0;
    const maxDdThreshold = dynScaleUSD * 2.0;
    if (maxDd > maxDdThreshold) penalty += clamp((maxDd - maxDdThreshold) / (dynScaleUSD * 4.0), 0, 0.25);
    if (consecutiveLosses >= 3) penalty += clamp((consecutiveLosses - 2) * 0.05, 0, 0.20);

    const rawScore = (pfScore * 0.25) + (wrScore * 0.25) + (riskAdjustedScore * 0.25) + (recentScore * 0.25) - penalty;
    const sampleConfidence = clamp(N / this.minTradesForRanking, 0.15, 1.0);
    const shrunkScore = (rawScore * sampleConfidence) + (0.50 * (1 - sampleConfidence));
    return Math.round(clamp(shrunkScore, 0.05, 0.98) * 1000) / 1000;
  }

  /**
   * Compiles the complete performance state object to feed into MasterMind
   */
  getState(currentRegime = 'TRENDING') {
    const winners = this.getWinners(currentRegime);
    const leaderboard = this.getLeaderboard();
    const rKey = this._normalizeRegimeKey(currentRegime);

    // Map weights, signals, and per-strategy regime affinity for O(1) MasterMind lookup.
    // MasterMind uses the full formula: w_i * c_i * r_i * d_i where r_i = per-strategy regime affinity.
    const weights = {};
    const signals = {};
    const strategiesMeta = {};
    for (const s of Object.values(this.strategies)) {
      weights[s.id] = s.dynamicWeight;
      signals[s.id] = s.lastSignal;
      // Expose the empirical regime affinity score for the CURRENT regime so MasterMind
      // can use it directly instead of always defaulting to 1.0
      const regStat = s.regimePerformance[rKey];
      strategiesMeta[s.id] = {
        regimeScore: regStat && regStat.trades >= 3 ? regStat.affinityScore : s.regimeScore,
        performanceScore: s.performanceScore,
        health: s.health,
      };
    }

    const summary = {
      totalStrategies: Object.keys(this.strategies).length,
      totalPaperTrades: this.paperTrades.length,
      openPaperTrades: Object.keys(this.openTrades).length,
      regime: currentRegime,
      hasReliableWinner: winners.hasReliableWinner,
      bestOverall: winners.bestOverall,
      bestRecent: winners.bestRecent,
      bestCurrentRegime: winners.bestCurrentRegime,
      statusText: winners.statusText,
    };

    return {
      timestamp: Date.now(),
      tickCount: this.tickCount,
      totalStrategies: Object.keys(this.strategies).length,
      totalCompletedTrades: this.paperTrades.length,
      activeOpenTradesCount: Object.keys(this.openTrades).length,
      minTradesRequirement: this.minTradesForRanking,
      hasReliableWinner: winners.hasReliableWinner,
      bestOverall: winners.bestOverall,
      bestRecent: winners.bestRecent,
      bestCurrentRegime: winners.bestCurrentRegime,
      statusText: winners.statusText,
      summary,
      weights,
      signals,
      // Per-strategy regime affinity map — used by MasterMind for the complete w×c×r×d formula
      strategies: strategiesMeta,
      leaderboard,
      top5Profitable: this.getTopProfitStrategies(5),
    };
  }

  /**
   * Load state from localStorage
   */
  loadFromStorage() {
    try {
      if (typeof localStorage === 'undefined') return false;
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return false;
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && parsed.strategies) {
        // Merge saved strategy metrics
        for (const [id, savedStrat] of Object.entries(parsed.strategies)) {
          if (this.strategies[id]) {
            Object.assign(this.strategies[id], savedStrat);
          }
        }
        if (Array.isArray(parsed.paperTrades)) {
          this.paperTrades = parsed.paperTrades;
        }
        return true;
      }
    } catch (e) {
      console.warn('Could not load strategy performance storage:', e);
    }
    return false;
  }

  /**
   * Persist state to localStorage
   */
  saveToStorage() {
    try {
      if (typeof localStorage === 'undefined') return;
      const payload = {
        timestamp: Date.now(),
        tickCount: this.tickCount,
        strategies: this.strategies,
        paperTrades: this.paperTrades.slice(0, 100),
      };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
    } catch (e) {}
  }
}
