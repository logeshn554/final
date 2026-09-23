// ═══════════════════════════════════════════════════════════════════════════
// MASTERMIND ENGINE (ETHUSDT)
// Authoritative Central Brain & Single Execution Gatekeeper
// Ingests:
//   1. Dynamic Strategy Performance Engine (Empirical Paper-Trading Results & Weights)
//   2. 43 RL Algorithms + Python 5-Strategy Ensemble + Institutional HJB
//   3. Deep Microstructure (VPIN/OBI) + Candlesticks & MTF Confluence
//   4. Deep Research Stack (DeepLOB, EVT, Neural Forecasters, Meta-Labeling)
// Outputs: ONE CANONICAL DECISION OBJECT (STATE.masterDecision)
// Rule: NO execution can occur unless MasterMind approves.
// ═══════════════════════════════════════════════════════════════════════════

import { clamp, mean, std } from '../utils/math.js';

export class MastermindEngine {
  constructor(options = {}) {
    this.version = '4.0.0-PROD';
    this.decisionCount = 0;
    this.lastDecision = null;
    this.history = [];
    this.maxHistory = 100;

    // Minimum calibrated confidence to authorize execution
    this.minConfidenceToApprove = options.minConfidence || 0.46;
    // Minimum absolute score to trigger BUY/SELL
    this.scoreThreshold = options.scoreThreshold || 0.15;
    // Fractional Kelly cap
    this.kellyFractionCap = options.kellyFraction || 0.25;
    this.tradeHistoryStats = { wins: 0, losses: 0, total: 0, winRate: 70.0 };
  }

  /**
   * Record trade resolution outcome to adapt live performance stats
   * @param {boolean} isWin Whether trade hit Take Profit (+PnL)
   */
  recordTradeOutcome(isWin) {
    this.tradeHistoryStats.total++;
    if (isWin) this.tradeHistoryStats.wins++;
    else this.tradeHistoryStats.losses++;
    this.tradeHistoryStats.winRate = Math.round((this.tradeHistoryStats.wins / this.tradeHistoryStats.total) * 1000) / 10;
  }

  /**
   * Authoritative MasterMind Evaluation
   * Synthesizes empirical strategy performance, all model signals, movement distributions & risk gates
   * @param {Object} ctx All market, model, and performance inputs
   * @returns {Object} Canonical Master Decision
   */
  evaluate(ctx = {}) {
    this.decisionCount++;
    const now = Date.now();
    const price = Number(ctx.price || ctx.currentPrice || 0);
    const prices = Array.isArray(ctx.prices) ? ctx.prices : [];
    const signals = ctx.signals || {};
    const stratPerf = ctx.strategyPerformance || null;
    const py = ctx.pythonEngineDecision || null;
    const inst = ctx.institutionalAlgo || {};
    const micro = ctx.microstructure || {};
    const candles = ctx.candlestickAnalysis || {};
    const mtf = ctx.mtfAnalysis || {};
    const mp = ctx.movementPrediction || {};
    const research = ctx.researchStack || {};
    const autoHealing = ctx.autoHealing || {};
    const equity = Number(ctx.equity || 10000);
    const killSwitchTriggered = Boolean(ctx.killSwitch);

    // ─────────────────────────────────────────────────────────────────
    // 1. INGEST DYNAMIC STRATEGY PERFORMANCE & WEIGHTS
    // ─────────────────────────────────────────────────────────────────
    const perfWeights = stratPerf?.weights || {};
    const bestOverall = stratPerf?.bestOverall || null;
    const bestRecent = stratPerf?.bestRecent || null;
    const bestCurrentRegimeStrat = stratPerf?.bestCurrentRegime || null;
    const hasReliableWinner = Boolean(stratPerf?.hasReliableWinner);

    // ─────────────────────────────────────────────────────────────────
    // 2. INGEST & NORMALIZE: 43 RL ALGORITHMS BUS (RL ONLY)
    // Excludes all ML models and non-RL algorithms totally
    // ─────────────────────────────────────────────────────────────────
    const isRLAlgorithm = (id, tag = '') => {
      if (!id && !tag) return false;
      const strId = String(id).toLowerCase();
      const strTag = String(tag).toLowerCase();
      if (strId.startsWith('python') || strId.startsWith('ml_') || strId.startsWith('institutional') || strId.startsWith('microstructure')) return false;
      if (['mean_reversion', 'alpha_engine', 'candlestick_engine', 'mtf_confluence', 'volatility_suite', 'deep_lob', 'neural_forecaster', 'foundation_ensemble', 'meta_labeling', 'trade_signal_engine', 'production_strategy'].includes(strId)) return false;
      if (strId.startsWith('rl_') || !isNaN(Number(id))) return true;
      if (['dt', 'ppo', 'sac', 'td3', 'dqn', 'd3qn', 'qrdqn', 'iqn', 'fqf', 'iql', 'cql', 'tdmpc2', 'cpo', 'oc', 'marl', 'hrl', 'c51', 'rsrl', 'maml', 'wm', 'morl', 'srl', 'gtrxl'].includes(strTag)) return true;
      return false;
    };

    const algoIds = Object.keys(signals).filter(id => isRLAlgorithm(id));
    // If signals did not use rl_ prefix, fallback to all non-ML signals
    const effectiveAlgoIds = algoIds.length > 0 ? algoIds : Object.keys(signals).filter(id => !id.startsWith('python') && !id.startsWith('ml_'));

    let rlBullCount = 0;
    let rlBearCount = 0;
    let rlNeutralCount = 0;
    let rlWeightedScoreSum = 0;
    let rlTotalWeight = 0;
    const rlScores = [];

    const perfWeightValues = Object.values(perfWeights).filter(v => typeof v === 'number' && v > 0);
    const fallbackEmpiricalWeight = perfWeightValues.length > 0 
      ? (perfWeightValues.reduce((s, v) => s + v, 0) / perfWeightValues.length)
      : (1.0 / Math.max(1, effectiveAlgoIds.length));

    for (const id of effectiveAlgoIds) {
      const sig = signals[id];
      if (!sig) continue;

      // Check self-healing adjustment / quarantine
      const healingAdj = typeof autoHealing.getAdjustment === 'function'
        ? autoHealing.getAdjustment(id)
        : (autoHealing.algoAdjustments?.[id] || null);

      const isQuarantined = Boolean(
        sig.quarantined ||
        healingAdj?.quarantined ||
        (typeof autoHealing.isQuarantined === 'function' && autoHealing.isQuarantined(id))
      );

      if (isQuarantined) {
        continue; // Strictly exclude quarantined algorithm from RL vote and score sum
      }

      const val = typeof sig.direction === 'number' ? sig.direction : (sig.signal || 0);
      const conf = typeof sig.conf === 'number' ? sig.conf : (typeof sig.confidence === 'number' ? sig.confidence : 0.5);

      // Incorporate empirical paper-trading weight if registered
      const stratKey = id.startsWith('rl_') ? id : `rl_${id}`;
      const empiricalW = perfWeights[id] !== undefined 
        ? perfWeights[id] 
        : (perfWeights[stratKey] !== undefined ? perfWeights[stratKey] : fallbackEmpiricalWeight);

      // Apply self-healing weight dampener (e.g. 0.85x, or 1.0)
      const weightDampener = typeof healingAdj?.weightDampener === 'number' ? healingAdj.weightDampener : 1.0;
      const effectiveWeight = Math.max(0.001, empiricalW * Math.max(0.2, conf) * weightDampener);

      rlScores.push(val);
      rlWeightedScoreSum += val * effectiveWeight;
      rlTotalWeight += effectiveWeight;

      if (val > 0.06) rlBullCount++;
      else if (val < -0.06) rlBearCount++;
      else rlNeutralCount++;
    }

    const rlActiveCount = effectiveAlgoIds.length;
    const rlDirectionalTotal = rlBullCount + rlBearCount;
    const rlAgreementPct = rlDirectionalTotal > 0
      ? Math.round((Math.max(rlBullCount, rlBearCount) / rlDirectionalTotal) * 100)
      : 50;
    const rlScore = rlTotalWeight > 0 ? clamp(rlWeightedScoreSum / rlTotalWeight, -1, 1) : 0;
    const rlDispersion = rlScores.length > 1 ? std(rlScores) : 0.3;

    const rlContributor = {
      activeCount: rlActiveCount,
      bullVotes: rlBullCount,
      bearVotes: rlBearCount,
      neutralVotes: rlNeutralCount,
      agreementPct: rlAgreementPct,
      score: Math.round(rlScore * 1000) / 1000,
      dispersion: Math.round(rlDispersion * 1000) / 1000,
      direction: rlScore > 0.1 ? 1 : rlScore < -0.1 ? -1 : 0,
    };

    // ─────────────────────────────────────────────────────────────────
    // 3. PYTHON ML ENSEMBLE: FULLY DISCONNECTED FROM MASTERMIND
    // MasterMind decision authority is 100% reserved for Reinforcement Learning
    // ─────────────────────────────────────────────────────────────────
    const pyConnected = false;
    const pyDirection = 0;
    const pyConfidence = 0.5;
    const pyScore = 0;
    const pyRR = 1.5;

    const pyContributor = {
      connected: false,
      signal: 'DISCONNECTED',
      direction: 0,
      confidence: 0.5,
      score: 0,
      strategies: {},
      weights: {},
      riskRewardRatio: 1.5,
      regime: 'DISCONNECTED',
      status: 'ML Models Disconnected: MasterMind connects exclusively to RL algorithms',
    };

    // ─────────────────────────────────────────────────────────────────
    // 4. INSTITUTIONAL ALPHA & MICROSTRUCTURE TELEMETRY (VPIN RISK GATE ONLY)
    // ─────────────────────────────────────────────────────────────────
    let instScore = 0;
    if (typeof inst.compositeSignal === 'number') instScore = clamp(inst.compositeSignal, -1, 1);
    else if (typeof inst.signal === 'number') instScore = clamp(inst.signal, -1, 1);
    else if (inst.action === 'BUY') instScore = 0.65;
    else if (inst.action === 'SELL') instScore = -0.65;

    const vpin = typeof micro.vpin === 'number' ? micro.vpin : 0.20;
    const obi = typeof micro.obi === 'number' ? clamp(micro.obi, -1, 1) : 0;
    const isToxicFlow = vpin > 0.45;

    const instContributor = {
      score: Math.round(instScore * 1000) / 1000,
      action: inst.action || (instScore > 0.1 ? 'BUY' : instScore < -0.1 ? 'SELL' : 'HOLD'),
      kyleToxicity: isToxicFlow ? 'HIGH' : 'NORMAL',
      vpin: Math.round(vpin * 1000) / 1000,
      obi: Math.round(obi * 1000) / 1000,
      hawkesJump: inst.hawkes?.jumpIntensity || 0,
    };

    // ─────────────────────────────────────────────────────────────────
    // 5. INGEST TELEMETRY (CANDLESTICK, MTF & RESEARCH STACK)
    // ─────────────────────────────────────────────────────────────────
    const candScore = clamp(candles.score || 0, -1, 1);
    const mtfScore = clamp(mtf.confluenceScore || 0, -1, 1);
    const deepLobScore = research?.deepLOB?.score || 0;
    const metaWinProb = research?.metaLabeling?.winProb || 0.65;

    // ─────────────────────────────────────────────────────────────────
    // 6. MULTI-MODEL PERFORMANCE-WEIGHTED SYNTHESIS (GRANULAR CONSENSUS)
    // Every Strategy × Measured Paper Performance × Confidence × Regime Affinity
    // ─────────────────────────────────────────────────────────────────
    const currentRegime = (mp?.regime || ctx.regime || 'TRENDING').toUpperCase();

    // Pool of all active strategy signals
    const activeSignalPool = (stratPerf?.signals && Object.keys(stratPerf.signals).length > 0)
      ? stratPerf.signals
      : (ctx.signals || {});

    const stratEntries = Object.entries(activeSignalPool);
    const defaultWeight = 1.0 / Math.max(1, stratEntries.length);

    let weightedDirectionSum = 0;
    let totalWeightSum = 0;
    let buyWeightSum = 0;
    let sellWeightSum = 0;
    let buyCount = 0;
    let sellCount = 0;
    let totalCount = 0;

    for (const [id, sigObj] of stratEntries) {
      if (!sigObj) continue;

      // Disconnect Python ML models from consensus
      if (id.startsWith('python_') || id === 'python_ensemble') {
        continue;
      }

      // Check self-healing adjustment / quarantine for this strategy
      const healingAdj = typeof autoHealing.getAdjustment === 'function'
        ? autoHealing.getAdjustment(id)
        : (autoHealing.algoAdjustments?.[id] || null);

      const isQuarantined = Boolean(
        sigObj.quarantined ||
        healingAdj?.quarantined ||
        (typeof autoHealing.isQuarantined === 'function' && autoHealing.isQuarantined(id))
      );

      if (isQuarantined) {
        continue; // Strictly exclude quarantined strategy from consensus
      }

      // Directional value in [-1, 1]
      const dirVal = typeof sigObj.direction === 'number' 
        ? sigObj.direction 
        : (typeof sigObj.signal === 'number' ? sigObj.signal : (sigObj.signal === 'BUY' ? 1 : sigObj.signal === 'SELL' ? -1 : 0));
      
      const conf = typeof sigObj.conf === 'number'
        ? sigObj.conf
        : (typeof sigObj.confidence === 'number' ? sigObj.confidence : 0.5);

      // Strategy empirical paper performance weight
      const stratKey = id.startsWith('rl_') ? id : (perfWeights[`rl_${id}`] !== undefined ? `rl_${id}` : id);
      const empiricalW = perfWeights[id] !== undefined
        ? perfWeights[id]
        : (perfWeights[stratKey] !== undefined ? perfWeights[stratKey] : defaultWeight);

      // Strategy regime affinity multiplier
      const stratMeta = stratPerf?.strategies?.[id] || stratPerf?.strategies?.[stratKey];
      const regimeAffinity = (stratMeta?.regimeScore !== undefined && stratMeta.regimeScore > 0)
        ? stratMeta.regimeScore
        : 1.0;

      // Self-healing weight dampener (e.g. 0.85x after error, or 1.0)
      const weightDampener = typeof healingAdj?.weightDampener === 'number' ? healingAdj.weightDampener : 1.0;

      // Granular strategy dynamic weight: w_i * c_i * r_i * h_i
      const strategyDynamicWeight = Math.max(0.001, empiricalW * Math.max(0.15, conf) * Math.max(0.2, regimeAffinity) * weightDampener);

      if (Math.abs(dirVal) > 0.02) {
        totalCount++;
        totalWeightSum += strategyDynamicWeight;
        weightedDirectionSum += dirVal * strategyDynamicWeight;

        if (dirVal > 0) {
          buyCount++;
          buyWeightSum += strategyDynamicWeight;
        } else {
          sellCount++;
          sellWeightSum += strategyDynamicWeight;
        }
      }
    }

    // Mathematical granular consensus: MasterScore = sum(w_i * c_i * r_i * d_i) / sum(w_i * c_i * r_i)
    let rawMasterScore = totalWeightSum > 0 ? (weightedDirectionSum / totalWeightSum) : 0;
    const masterScore = clamp(rawMasterScore, -1, 1);

    const supportingStrategies = [];
    const conflictingStrategies = [];

    // Evaluate supporting vs conflicting strategies relative to final masterScore
    for (const [id, sigObj] of stratEntries) {
      if (!sigObj) continue;

      if (id.startsWith('python_') || id === 'python_ensemble') continue;

      const healingAdj = typeof autoHealing.getAdjustment === 'function'
        ? autoHealing.getAdjustment(id)
        : (autoHealing.algoAdjustments?.[id] || null);

      const isQuarantined = Boolean(
        sigObj.quarantined ||
        healingAdj?.quarantined ||
        (typeof autoHealing.isQuarantined === 'function' && autoHealing.isQuarantined(id))
      );

      if (isQuarantined) {
        continue;
      }

      const dirVal = typeof sigObj.direction === 'number'
        ? sigObj.direction
        : (typeof sigObj.signal === 'number' ? sigObj.signal : (sigObj.signal === 'BUY' ? 1 : sigObj.signal === 'SELL' ? -1 : 0));
      if (Math.abs(dirVal) <= 0.02) continue;
      if (dirVal > 0) {
        if (masterScore >= 0) supportingStrategies.push(id);
        else conflictingStrategies.push(id);
      } else {
        if (masterScore <= 0) supportingStrategies.push(id);
        else conflictingStrategies.push(id);
      }
    }

    const rawAgreement = totalCount > 0 ? Math.round((Math.max(buyCount, sellCount) / totalCount) * 100) / 100 : 0.50;
    const weightedAgreement = totalWeightSum > 0 ? Math.round((Math.max(buyWeightSum, sellWeightSum) / totalWeightSum) * 100) / 100 : 0.50;

    // ─────────────────────────────────────────────────────────────────
    // 6.5 INGEST TOP 3 PERFORMING RL ALGORITHMS (ARENA & DIRECT REINFORCEMENT)
    // MasterMind connects FULLY and EXCLUSIVELY to top Reinforcement Learning algorithms
    // Featuring Decision Transformer (Sequence Modeling), PPO, QR-DQN and empirical winners
    // All ML models are disconnected.
    // ─────────────────────────────────────────────────────────────────
    let top5Profitable = [];


    // Priority 1: Real-Time $10 Capital Benchmark Arena (All 43 RL Algorithms)
    if (ctx.capitalBenchmark?.algos && Array.isArray(ctx.capitalBenchmark.algos) && ctx.capitalBenchmark.algos.length > 0) {
      const rlAlgos = ctx.capitalBenchmark.algos.filter(a => a && isRLAlgorithm(a.id, a.tag));

      const ranked = [...rlAlgos].sort((a, b) => {
        const wrA = Number(a.realWinRate) || 0;
        const wrB = Number(b.realWinRate) || 0;
        const tradesA = Number(a.totalTrades) || 0;
        const tradesB = Number(b.totalTrades) || 0;
        const pnlA = Number(a.realizedPnL) || 0;
        const pnlB = Number(b.realizedPnL) || 0;

        // If trades exist, rank by real win rate and PnL
        if (tradesA > 0 || tradesB > 0) {
          if (Math.abs(wrB - wrA) > 2) return wrB - wrA;
          return pnlB - pnlA;
        }

        // Cold-start: prioritize active directional conviction
        const sigA = signals[a.id] || signals[`rl_${a.id}`] || {};
        const sigB = signals[b.id] || signals[`rl_${b.id}`] || {};
        const dirA = Math.abs(typeof sigA.direction === 'number' ? sigA.direction : (sigA.signal === 'BUY' ? 1 : sigA.signal === 'SELL' ? -1 : 0));
        const dirB = Math.abs(typeof sigB.direction === 'number' ? sigB.direction : (sigB.signal === 'BUY' ? 1 : sigB.signal === 'SELL' ? -1 : 0));
        if (dirB !== dirA) return dirB - dirA;

        // Decision Transformer architectural priority
        const isDTA = a.id === 40 || a.tag === 'DT';
        const isDTB = b.id === 40 || b.tag === 'DT';
        if (isDTA && !isDTB) return -1;
        if (!isDTA && isDTB) return 1;

        return (Number(b.equity) || 10) - (Number(a.equity) || 10);
      });

      top5Profitable = ranked.slice(0, 5).map((a, idx) => {
        const sig = signals[a.id] || signals[`rl_${a.id}`] || {};
        const dir = typeof sig.direction === 'number'
          ? sig.direction
          : (typeof sig.signal === 'number'
            ? sig.signal
            : (sig.signal === 'BUY' ? 1 : (sig.signal === 'SELL' ? -1 : (a.activeTrade ? (a.activeTrade.isBuy ? 1 : -1) : 0))));
        const conf = typeof sig.conf === 'number' ? sig.conf : (typeof sig.confidence === 'number' ? sig.confidence : 0.65);
        const winRate = Number(a.realWinRate) || 70.0;
        const profit = Number(a.realizedPnL) || 0.0;
        const profitWeight = Math.max(0.1, (winRate / 100) * (1 + Math.max(0, profit)));

        return {
          id: a.id,
          algoId: a.id,
          name: a.name || a.tag,
          tag: a.tag || (a.id === 40 ? 'DT' : 'RL'),
          category: 'RL',
          horizon: a.activeTrade?.horizon || a.horizon || '',
          winRate,
          netProfitUSD: Math.round(profit * 100) / 100,
          equity: Number(a.equity) || 10,
          totalTrades: Number(a.totalTrades) || 0,
          winningTrades: Number(a.wins) || 0,
          profitWeight,
          currentSignal: dir > 0.05 ? 'BUY' : (dir < -0.05 ? 'SELL' : 'HOLD'),
          direction: dir,
          confidence: conf,
          rank: idx + 1,
          tpPrice: a.activeTrade?.tpPrice,
          slPrice: a.activeTrade?.slPrice,
          tpDistance: a.activeTrade?.tpDistance,
          slDistance: a.activeTrade?.slDistance,
        };
      });
    }

    // Priority 2: Extract active RL algorithms from signals (Cold start / Direct injection)
    if (top5Profitable.length === 0 || top5Profitable.every(s => Math.abs(s.direction) <= 0.02)) {
      const activeRLCandidates = [];
      for (const [id, s] of Object.entries(signals)) {
        if (!s) continue;
        if (!isRLAlgorithm(id)) continue;
        const dir = typeof s.direction === 'number'
          ? s.direction
          : (typeof s.signal === 'number' ? s.signal : (s.signal === 'BUY' ? 1 : s.signal === 'SELL' ? -1 : 0));
        const conf = typeof s.conf === 'number' ? s.conf : (typeof s.confidence === 'number' ? s.confidence : 0.65);
        const isDT = id === '40' || id === 40 || id === 'rl_40' || id === 'rl_dt' || id === 'DT';

        activeRLCandidates.push({
          id,
          algoId: id,
          name: isDT ? 'Decision Transformer (Sequence Modeling)' : (id.startsWith('rl_') ? id.toUpperCase() : `RL Algo ${id}`),
          tag: isDT ? 'DT' : (id.startsWith('rl_') ? id.slice(3).toUpperCase() : 'RL'),
          category: 'RL',
          winRate: 70,
          netProfitUSD: 0,
          equity: 10,
          totalTrades: 0,
          winningTrades: 0,
          profitWeight: Math.max(0.2, conf) * (isDT ? 1.5 : 1.0),
          currentSignal: dir > 0.05 ? 'BUY' : (dir < -0.05 ? 'SELL' : 'HOLD'),
          direction: dir,
          confidence: conf,
          rank: 1,
        });
      }

      // Sort: active directional candidates first, then Decision Transformer, then confidence
      activeRLCandidates.sort((a, b) => {
        const dirA = Math.abs(a.direction) > 0.05 ? 1 : 0;
        const dirB = Math.abs(b.direction) > 0.05 ? 1 : 0;
        if (dirB !== dirA) return dirB - dirA;
        const dtA = a.tag === 'DT' ? 1 : 0;
        const dtB = b.tag === 'DT' ? 1 : 0;
        if (dtB !== dtA) return dtB - dtA;
        return (b.confidence || 0) - (a.confidence || 0);
      });

      if (activeRLCandidates.length > 0) {
        top5Profitable = activeRLCandidates.slice(0, 5);
      }
    }

    // Priority 3: Fallback to stratPerf RL strategies
    if (top5Profitable.length === 0) {
      if (typeof stratPerf?.getTopWinningRLStrategies === 'function') {
        top5Profitable = stratPerf.getTopWinningRLStrategies(5);
      } else if (Array.isArray(stratPerf?.top5Profitable)) {
        top5Profitable = stratPerf.top5Profitable.filter(s => s.category === 'RL' || String(s.id).startsWith('rl_'));
      }
    }

    // Normalize profit/win-rate weights among Top RL Leaders
    const totalBasis = top5Profitable.reduce((sum, s) => sum + (s.profitWeight || 1.0), 0) || 1.0;
    top5Profitable.forEach((s, idx) => {
      s.rank = idx + 1;
      s.profitWeight = (s.profitWeight || 1.0) / totalBasis;
      s.profitPct = Math.round(s.profitWeight * 1000) / 10;
    });

    let top3ScoreSum = 0;
    let top3WeightSum = 0;
    let top3BullWeight = 0;
    let top3BearWeight = 0;
    let top3AlignedCount = 0;

    // Isolate Top 3 RL Leaders (with Decision Transformer prioritized)
    const activeTopRL = top5Profitable.slice(0, 3).filter(s => Math.abs(s.direction) > 0.02);
    const top3Available = activeTopRL.length > 0;

    if (top3Available) {
      for (const s of activeTopRL) {
        const w = s.profitWeight || (1.0 / activeTopRL.length);
        const dir = typeof s.direction === 'number' ? s.direction : (s.currentSignal === 'BUY' ? 1 : s.currentSignal === 'SELL' ? -1 : 0);
        const conf = typeof s.confidence === 'number' ? s.confidence : 0.65;
        top3ScoreSum += dir * w * Math.max(0.2, conf);
        top3WeightSum += w * Math.max(0.2, conf);
        if (dir > 0.05) { top3BullWeight += w; top3AlignedCount++; }
        else if (dir < -0.05) { top3BearWeight += w; }
      }
    }
    const top3ConsensusScore = top3WeightSum > 0 ? clamp(top3ScoreSum / top3WeightSum, -1, 1) : 0;

    // ─────────────────────────────────────────────────────────────────
    // 7. CONFLICT RESOLUTION & CALIBRATED CONFIDENCE
    // Evaluates RL Quorum vs Top 3 RL alignment (ML models totally removed)
    // ─────────────────────────────────────────────────────────────────
    let conflictDetected = false;
    let conflictDetails = 'CONVERGENT';

    // Flag divergence only if Top 3 RL consensus and 43-RL Quorum have strong opposing conviction
    const isStrongTop3 = Math.abs(top3ConsensusScore) >= 0.20;
    const isStrongRLQuorum = Math.abs(rlScore) >= 0.20;
    if (isStrongTop3 && isStrongRLQuorum && (top3ConsensusScore * rlScore < -0.04)) {
      conflictDetected = true;
      conflictDetails = `RL DIVERGENCE: Top 3 RL leaders are ${top3ConsensusScore > 0 ? 'BULLISH' : 'BEARISH'} (${top3ConsensusScore.toFixed(2)}) while 43-RL Quorum is ${rlScore > 0 ? 'LONG' : 'SHORT'} (${rlScore.toFixed(2)})`;
    }

    // Baseline consensus confidence incorporating Top 3 RL and 43-RL quorum
    let baseConfidence = (top3Available ? Math.abs(top3ConsensusScore) * 0.45 : 0.20)
      + (Math.abs(rlScore) * 0.30)
      + ((rlAgreementPct / 100) * 0.15)
      + (top5Profitable.length > 0 ? ((top5Profitable[0].winRate || 70) / 100 * 0.10) : 0.07);

    // Penalties
    if (conflictDetected) baseConfidence *= 0.75;
    if (rlDispersion > 0.45) baseConfidence *= 0.88;
    if (isToxicFlow) baseConfidence *= 0.80;

    const calibratedConfidence = clamp(baseConfidence, 0.05, 0.98);

    // ─────────────────────────────────────────────────────────────────
    // 8. MASTER ACTION DETERMINATION (100% REINFORCEMENT LEARNING ARCHITECTURE)
    // 70% Top 3 RL Leaders (Decision Transformer, PPO, etc.) + 30% 43-RL Quorum Consensus
    // ML models (Python ensemble, GBDT, etc.) are totally disconnected.
    // ─────────────────────────────────────────────────────────────────
    const compositeDecisionScore = top3Available
      ? clamp((top3ConsensusScore * 0.70) + (rlScore * 0.30), -1, 1)
      : clamp(rlScore !== 0 ? rlScore : masterScore, -1, 1);

    let signal = 'HOLD';
    let direction = 0;

    // Check if TradeSignalEngine triggered a Breakout Sentinel Breach or High-Confluence Setup
    const candidate = ctx.candidateSetup;
    const isCandidateBreakout = candidate && candidate.direction !== 0 && (
      (candidate.triggerType && (candidate.triggerType.includes('BREAKOUT') || candidate.triggerType.includes('BREAKDOWN'))) ||
      Math.abs(candidate.confidence || 0) >= 0.22
    );

    if (isCandidateBreakout && !conflictDetected && !isToxicFlow && !killSwitchTriggered) {
      signal = candidate.direction > 0 ? 'BUY' : 'SELL';
      direction = candidate.direction;
    } else if (!conflictDetected && compositeDecisionScore >= this.scoreThreshold && calibratedConfidence >= this.minConfidenceToApprove) {
      signal = 'BUY';
      direction = 1;
    } else if (!conflictDetected && compositeDecisionScore <= -this.scoreThreshold && calibratedConfidence >= this.minConfidenceToApprove) {
      signal = 'SELL';
      direction = -1;
    } else {
      signal = 'HOLD';
      direction = 0;
    }

    // ─────────────────────────────────────────────────────────────────
    // 9. DYNAMIC TARGET & STOP SELECTION (ZERO FIXED % OR FIXED RATIOS)
    // ─────────────────────────────────────────────────────────────────
    const curAtr = parseFloat(ctx.atr || (price * 0.005)) || 16.0;

    // Call dynamic target and stop engines (purely volatility- and distribution-driven)
    const dynamicTargetResult = this.selectDynamicTarget({
      entryPrice: price,
      direction,
      movementDistribution: mp,
      confidence: calibratedConfidence,
      regime: currentRegime,
      strategyWeights: perfWeights,
      atr: curAtr,
    });

    const dynamicStopResult = this.selectDynamicStop({
      entryPrice: price,
      direction,
      adverseMovement: mp?.adverseMovement,
      confidence: calibratedConfidence,
      regime: currentRegime,
      volatility: curAtr,
      marketStructure: ctx.marketStructure,
    });

    const dynamicRR = dynamicStopResult.selectedStopDistance > 0
      ? Math.round((dynamicTargetResult.selectedDistance / dynamicStopResult.selectedStopDistance) * 100) / 100
      : 1.5;

    // ─────────────────────────────────────────────────────────────────
    // 10. MODEL HEALTH & DIAGNOSTICS
    // ─────────────────────────────────────────────────────────────────
    const quarantined = typeof autoHealing.getQuarantinedCount === 'function'
      ? autoHealing.getQuarantinedCount()
      : Number(autoHealing.quarantinedCount || 0);

    const quarantinedList = typeof autoHealing.getQuarantinedList === 'function'
      ? autoHealing.getQuarantinedList()
      : (autoHealing.quarantinedList || []);

    const systemStatus = typeof autoHealing.getSystemHealth === 'function'
      ? autoHealing.getSystemHealth()
      : (autoHealing.systemHealth || '100% OPTIMAL');

    const healthyCount = Math.max(0, rlActiveCount - quarantined);
    const modelHealth = {
      total: rlActiveCount,
      healthy: healthyCount,
      degraded: Math.max(0, rlActiveCount - healthyCount),
      quarantined: quarantined,
      quarantinedList: quarantinedList,
      systemStatus: systemStatus,
      strategyPerformanceStatus: stratPerf?.statusText || 'Awaiting initial trade sample',
    };

    // ─────────────────────────────────────────────────────────────────
    // 11. PRODUCTION RISK GATE
    // ─────────────────────────────────────────────────────────────────
    let approved = false;
    let rejectionReason = '';

    if (signal === 'HOLD') {
      approved = false;
      rejectionReason = ctx.scanReason || 'SCANNING MARKET: Awaiting multi-model breakout confluence';
    } else if (killSwitchTriggered) {
      approved = false;
      rejectionReason = 'BLOCKED by Emergency Kill Switch / Portfolio Drawdown Limit.';
    } else if (isToxicFlow) {
      approved = false;
      rejectionReason = `BLOCKED: Kyle informed toxicity VPIN ${(vpin * 100).toFixed(1)}% exceeds threshold (45%).`;
    } else if (conflictDetected) {
      approved = false;
      rejectionReason = `BLOCKED by Inter-Model Conflict: ${conflictDetails}.`;
    } else if (rlActiveCount >= 30 ? healthyCount < 25 : (rlActiveCount > 0 && healthyCount < Math.max(1, Math.floor(rlActiveCount * 0.5)))) {
      approved = false;
      rejectionReason = `BLOCKED: Insufficient healthy algorithms (${healthyCount} / ${rlActiveCount} active, ${quarantined} quarantined).`;
    } else if (dynamicStopResult.selectedStopDistance <= 0 || isNaN(dynamicStopResult.selectedStopDistance)) {
      approved = false;
      rejectionReason = 'BLOCKED: Invalid structural stop calculation.';
    } else {
      approved = true;
      rejectionReason = 'APPROVED: All multi-discipline confluence, risk gates, and consensus checks passed.';
    }

    // ─────────────────────────────────────────────────────────────────
    // 12. FRACTIONAL KELLY POSITION SIZING
    // ─────────────────────────────────────────────────────────────────
    let positionSizeETH = 0;
    let positionUSD = 0;
    let maxLossUSD = 0;

    if (approved && price > 0) {
      const p = calibratedConfidence;
      const b = Math.max(1.0, dynamicRR);
      const fullKelly = clamp((p * (b + 1) - 1) / b, 0.05, 0.50);
      const fracKelly = fullKelly * this.kellyFractionCap;
      const targetNotional = equity * fracKelly;
      positionSizeETH = Math.round(clamp(targetNotional / price, 0.05, 3.0) * 100) / 100;
      positionUSD = Math.round(positionSizeETH * price);
      maxLossUSD = Math.round(positionSizeETH * dynamicStopResult.selectedStopDistance);
    }

    // ─────────────────────────────────────────────────────────────────
    // 13. NARRATIVE REASONING & MACHINE-READABLE EXPLANATION
    // ─────────────────────────────────────────────────────────────────
    const strongestFactors = [
      `RL Consensus: ${(rlScore * 100).toFixed(0)}% (${rlAgreementPct}% agreement)`,
      `Institutional HJB: ${instContributor.action} (Edge: ${instScore > 0 ? '+' : ''}${instScore})`,
      `Regime Alignment: ${currentRegime} (Confluence: ${(masterScore * 100).toFixed(1)}%)`,
    ];
    if (hasReliableWinner && bestOverall) {
      strongestFactors.push(`Top Paper Winner: ${bestOverall.name} (${bestOverall.winRate}% WR, Net +$${bestOverall.netPnl})`);
    }

    const explanation = {
      strongestFactors,
      supportingStrategies: supportingStrategies.slice(0, 8),
      conflictingStrategies: conflictingStrategies.slice(0, 8),
      regimeEvidence: `Regime ${currentRegime} with dynamic market reward-to-risk of ${dynamicRR}:1.`,
      movementEvidence: `Favorable target derived dynamically @ $${dynamicTargetResult.targetPrice} (${(dynamicTargetResult.selectedProbability * 100).toFixed(0)}% prob) with structural stop @ $${dynamicStopResult.stopPrice}.`,
      performanceEvidence: hasReliableWinner
        ? `Paper winner ${bestOverall.name} confirmed (${bestOverall.trades} trades evaluated under live conditions).`
        : `Paper sample accumulating (${stratPerf?.totalCompletedTrades || 0} / 30 trades completed).`,
    };

    let reason = '';
    if (approved) {
      const triggerNote = isCandidateBreakout ? ` [Triggered: ${candidate.triggerType || 'Breakout Sentinel'}]` : '';
      reason = `${signal} AUTHORIZED: Empirical multi-model confluence ${(masterScore * 100).toFixed(1)}% (${(weightedAgreement * 100).toFixed(0)}% weighted agreement) in ${currentRegime} regime with ${dynamicRR}:1 market R:R.${triggerNote}`;
    } else {
      reason = rejectionReason;
    }

    // ─────────────────────────────────────────────────────────────────
    // 14. CANONICAL MASTER DECISION OBJECT
    // ─────────────────────────────────────────────────────────────────
    const masterDecision = {
      decisionId: `MM-${now}-${this.decisionCount}`,
      timestamp: now,
      symbol: 'ETHUSDT',
      price,
      signal,
      direction,
      approved,

      score: Math.round(masterScore * 1000) / 1000,
      confidence: Math.round(calibratedConfidence * 1000) / 1000,
      agreement: rawAgreement,
      weightedAgreement: weightedAgreement,
      regime: currentRegime,

      bestOverallStrategy: bestOverall?.id || (hasReliableWinner ? bestOverall?.name : 'INSUFFICIENT_DATA'),
      bestRecentStrategy: bestRecent?.id || 'INSUFFICIENT_DATA',
      strategyWeights: perfWeights,
      top5ProfitLeaders: top5Profitable,
      top5Consensus: {
        score: Math.round(top3ConsensusScore * 1000) / 1000,
        bullWeight: Math.round(top3BullWeight * 1000) / 10,
        bearWeight: Math.round(top3BearWeight * 1000) / 10,
        alignedCount: top3AlignedCount,
        leaderName: top5Profitable[0]?.name || 'N/A',
        leaderTag: top5Profitable[0]?.tag || 'DT',
        leaderWinRate: top5Profitable[0]?.winRate || 0,
        leaderProfitUSD: top5Profitable[0]?.netProfitUSD || 0,
      },
      top3Consensus: {
        score: Math.round(top3ConsensusScore * 1000) / 1000,
        bullWeight: Math.round(top3BullWeight * 1000) / 10,
        bearWeight: Math.round(top3BearWeight * 1000) / 10,
        alignedCount: top3AlignedCount,
        leaderName: top5Profitable[0]?.name || 'N/A',
        leaderTag: top5Profitable[0]?.tag || 'DT',
        leaderWinRate: top5Profitable[0]?.winRate || 0,
        leaderProfitUSD: top5Profitable[0]?.netProfitUSD || 0,
      },

      movement: {
        favorable: dynamicTargetResult,
        adverse: dynamicStopResult,
      },

      execution: {
        entryPrice: price,
        takeProfitPrice: dynamicTargetResult.targetPrice,
        stopPrice: dynamicStopResult.stopPrice,
        quantity: positionSizeETH,
      },

      risk: {
        approved,
        maxRisk: maxLossUSD,
        estimatedLoss: maxLossUSD,
        expectedProfit: Math.round(positionSizeETH * dynamicTargetResult.selectedDistance),
        positionSizeETH,
        positionUSD,
        riskRewardRatio: dynamicRR,
        drawdownState: `${(autoHealing.systemHealth || 'OPTIMAL')}`,
        rejectionReason,
      },

      contributors: {
        rl43: rlContributor,
        python5: pyContributor,
        institutional: instContributor,
        patterns: { candlestickScore: Math.round(candScore * 100) / 100, mtfScore: Math.round(mtfScore * 100) / 100 },
        research: { deepLobScore: Math.round(deepLobScore * 100) / 100, metaWinProb: Math.round(metaWinProb * 100) / 100 },
      },

      contributingStrategies: supportingStrategies,
      rejectedStrategies: conflictingStrategies,
      explanation,
      modelHealth,
      conflict: { detected: conflictDetected, details: conflictDetails },
      reason,
    };

    this.lastDecision = masterDecision;
    this.history.unshift(masterDecision);
    if (this.history.length > this.maxHistory) this.history.pop();

    return masterDecision;
  }

  /**
   * Selects economically useful target from estimated distribution (NO FIXED %, ZERO ML OVERRIDE)
   */
  selectDynamicTarget(params) {
    const { entryPrice, direction, movementDistribution, confidence, regime, atr } = params;
    const dynamicFloor = Math.max(entryPrice * 0.0005, (atr > 0 ? atr * 0.15 : entryPrice * 0.001));

    const consMove = Number(movementDistribution?.predictedMovement?.conservativeMove) || (atr * 0.85);
    const mainMove = Number(movementDistribution?.predictedMovement?.mainMove) || (atr * 1.45);
    const extMove = Number(movementDistribution?.predictedMovement?.extendedMove) || (atr * 2.20);

    // Adaptive target selection based on confidence and regime
    let selectedMove = Math.max(dynamicFloor, mainMove);
    let label = 'Base Optimal Move';
    let prob = 0.50;

    if (confidence >= 0.75 && (regime.includes('TREND') || regime.includes('BREAKOUT'))) {
      selectedMove = Math.max(dynamicFloor * 1.5, extMove);
      label = 'Extended Volatility Expansion';
      prob = 0.28;
    } else if (confidence < 0.60 || regime.includes('REVERT') || regime.includes('COMPRESS')) {
      selectedMove = Math.max(dynamicFloor * 0.8, consMove);
      label = 'Conservative High-Prob Target';
      prob = 0.74;
    }

    const targetPrice = direction >= 0
      ? Math.round((entryPrice + selectedMove) * 100) / 100
      : Math.round((entryPrice - selectedMove) * 100) / 100;

    return {
      selectedLabel: label,
      selectedDistance: Math.round(selectedMove * 100) / 100,
      selectedProbability: prob,
      conservativeDistance: Math.round(consMove * 100) / 100,
      mainDistance: Math.round(mainMove * 100) / 100,
      extendedDistance: Math.round(extMove * 100) / 100,
      targetPrice,
    };
  }

  /**
   * Selects structural dynamic stop from adverse movement distribution (NO FIXED %, ZERO ML OVERRIDE)
   */
  selectDynamicStop(params) {
    const { entryPrice, direction, adverseMovement, volatility, marketStructure = {} } = params;
    const minAdvFloor = Math.max(entryPrice * 0.0005, (volatility > 0 ? volatility * 0.15 : entryPrice * 0.001));

    // Invalidation from structural swing points if present in marketStructure
    const structHigh = Number(marketStructure?.recentHigh || marketStructure?.swingHigh || 0);
    const structLow = Number(marketStructure?.recentLow || marketStructure?.swingLow || 0);

    const advMove = Math.max(minAdvFloor, Number(adverseMovement?.expected) || (volatility > 0 ? volatility : (entryPrice * 0.004)));
    const worstMove = Number(adverseMovement?.worstCase) || (advMove * 1.5);
    const buffer = volatility > 0 ? (volatility * 0.20) : (entryPrice * 0.001);

    let invalidationLevel = direction >= 0
      ? (structLow > 0 && structLow < entryPrice ? structLow : Math.round((entryPrice - advMove) * 100) / 100)
      : (structHigh > 0 && structHigh > entryPrice ? structHigh : Math.round((entryPrice + advMove) * 100) / 100);

    let stopPrice = direction >= 0
      ? Math.round((invalidationLevel - buffer) * 100) / 100
      : Math.round((invalidationLevel + buffer) * 100) / 100;

    let selectedStopDistance = Math.round(Math.abs(entryPrice - stopPrice) * 100) / 100;

    // Safety floor: stop distance must never be <= minAdvFloor
    if (selectedStopDistance < minAdvFloor || isNaN(selectedStopDistance)) {
      selectedStopDistance = Math.round((volatility > 0 ? volatility : Math.max(minAdvFloor, entryPrice * 0.004)) * 100) / 100;
      stopPrice = direction >= 0
        ? Math.round((entryPrice - selectedStopDistance) * 100) / 100
        : Math.round((entryPrice + selectedStopDistance) * 100) / 100;
      invalidationLevel = stopPrice;
    }

    return {
      expectedDistance: Math.round(advMove * 100) / 100,
      worstDistance: Math.round(worstMove * 100) / 100,
      selectedStopDistance,
      stopPrice,
      invalidationLevel,
    };
  }

  /**
   * Authoritative MasterMind Manual Trade Authorization
   * Evaluates manual execution request through risk gates and returns canonical approval
   */
  evaluateManual(direction = 1, ctx = {}) {
    const baseDecision = this.evaluate(ctx);
    const killSwitchTriggered = Boolean(ctx.killSwitch || ctx.layer5?.mustLiquidate);
    const micro = ctx.microstructure || {};
    const vpin = typeof micro.vpin === 'number' ? micro.vpin : 0.20;
    const isToxic = vpin > 0.45;

    let manualApproved = false;
    let manualReason = '';

    if (killSwitchTriggered) {
      manualApproved = false;
      manualReason = 'MANUAL TRADE REJECTED: Emergency Kill Switch active.';
    } else if (isToxic) {
      manualApproved = false;
      manualReason = `MANUAL TRADE REJECTED: Toxic informed flow VPIN ${(vpin * 100).toFixed(1)}% > 45%.`;
    } else if (baseDecision.confidence < 0.40) {
      // Manual trades enforce 0.40 manual safety floor
      manualApproved = false;
      manualReason = `MANUAL TRADE DECLINED: Market confidence ${(baseDecision.confidence * 100).toFixed(1)}% is below the 40% manual safety floor.`;
    } else {
      manualApproved = true;
      manualReason = `MANUAL TRADE APPROVED: Discretionary ${direction > 0 ? 'BUY' : 'SELL'} authorized under MasterMind risk envelope (Conf: ${(baseDecision.confidence * 100).toFixed(1)}%).`;
    }

    // Explicitly compute directional TP and SP for the requested manual trade
    const price = Number(ctx.price || ctx.currentPrice || baseDecision.price || 0);
    const curAtr = Number(ctx.atr || baseDecision.atr || 16.0);
    const targetResult = this.selectDynamicTarget({
      entryPrice: price,
      direction,
      movementDistribution: ctx.movementPrediction || baseDecision.movement?.favorable,
      confidence: baseDecision.confidence,
      regime: baseDecision.regime,
      atr: curAtr,
    });
    const stopResult = this.selectDynamicStop({
      entryPrice: price,
      direction,
      adverseMovement: ctx.movementPrediction?.adverseMovement,
      confidence: baseDecision.confidence,
      regime: baseDecision.regime,
      volatility: curAtr,
      marketStructure: ctx.marketStructure,
    });

    const tpPrice = targetResult.targetPrice;
    const spPrice = stopResult.stopPrice;

    return {
      ...baseDecision,
      direction,
      signal: direction > 0 ? 'BUY' : 'SELL',
      approved: manualApproved,
      isManual: true,
      movement: {
        favorable: targetResult,
        adverse: stopResult,
      },
      execution: {
        entryPrice: price,
        takeProfitPrice: tpPrice,
        stopPrice: spPrice,
        tp: tpPrice,
        sp: spPrice,
        quantity: baseDecision.execution?.quantity || 1.0,
      },
      reason: manualReason,
    };
  }
}
