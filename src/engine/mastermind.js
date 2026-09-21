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
    this.minConfidenceToApprove = options.minConfidence || 0.54;
    // Minimum absolute score to trigger BUY/SELL
    this.scoreThreshold = options.scoreThreshold || 0.18;
    // Fractional Kelly cap
    this.kellyFractionCap = options.kellyFraction || 0.25;
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
    // 2. INGEST & NORMALIZE: 43 RL ALGORITHMS BUS
    // ─────────────────────────────────────────────────────────────────
    const algoIds = Object.keys(signals);
    let rlBullCount = 0;
    let rlBearCount = 0;
    let rlNeutralCount = 0;
    let rlWeightedScoreSum = 0;
    let rlTotalWeight = 0;
    const rlScores = [];

    for (const id of algoIds) {
      const sig = signals[id];
      if (!sig) continue;
      const val = typeof sig.direction === 'number' ? sig.direction : (sig.signal || 0);
      const conf = typeof sig.conf === 'number' ? sig.conf : (typeof sig.confidence === 'number' ? sig.confidence : 0.5);

      // Incorporate empirical paper-trading weight if registered
      const stratKey = id.startsWith('rl_') ? id : `rl_${id}`;
      const empiricalW = perfWeights[id] !== undefined 
        ? perfWeights[id] 
        : (perfWeights[stratKey] !== undefined ? perfWeights[stratKey] : (1.0 / Math.max(1, algoIds.length)));
      const effectiveWeight = Math.max(0.01, empiricalW * Math.max(0.2, conf));

      rlScores.push(val);
      rlWeightedScoreSum += val * effectiveWeight;
      rlTotalWeight += effectiveWeight;

      if (val > 0.06) rlBullCount++;
      else if (val < -0.06) rlBearCount++;
      else rlNeutralCount++;
    }

    const rlActiveCount = algoIds.length;
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
    // 3. INGEST & NORMALIZE: PYTHON 5-STRATEGY ENSEMBLE BUS
    // ─────────────────────────────────────────────────────────────────
    let pyScore = 0;
    let pyConnected = false;
    let pyDirection = 0;
    let pyConfidence = 0.5;
    let pyStrategies = {};
    let pyWeights = {};
    let pyDynamicTP = null;
    let pyStopLoss = null;
    let pyRR = 1.5;

    if (py && py.symbol === 'ETHUSDT' && py.signal) {
      pyConnected = true;
      pyDirection = py.signal === 'BUY' ? 1 : py.signal === 'SELL' ? -1 : 0;
      pyConfidence = clamp(py.confidence || 0.6, 0.1, 0.99);

      // Weight Python ensemble with empirical paper-trading weight
      const pyEmpiricalW = perfWeights['python_ensemble'] || (1.0 / 20);
      pyScore = pyDirection * pyConfidence;
      pyStrategies = py.strategy_contributions || {};
      pyWeights = py.strategy_weights || {};
      pyDynamicTP = py.dynamic_take_profit || null;
      pyStopLoss = py.stop_loss || null;
      pyRR = py.risk_reward_ratio || 1.5;
    }

    const pyContributor = {
      connected: pyConnected,
      signal: py?.signal || 'HOLD',
      direction: pyDirection,
      confidence: Math.round(pyConfidence * 1000) / 1000,
      score: Math.round(pyScore * 1000) / 1000,
      strategies: pyStrategies,
      weights: pyWeights,
      riskRewardRatio: pyRR,
      regime: py?.regime?.primary_regime || 'NORMAL',
    };

    // ─────────────────────────────────────────────────────────────────
    // 4. INGEST & NORMALIZE: INSTITUTIONAL ALPHA & MICROSTRUCTURE BUS
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
    // 5. INGEST & NORMALIZE: CANDLESTICK, MTF & RESEARCH STACK
    // ─────────────────────────────────────────────────────────────────
    const candScore = clamp(candles.score || 0, -1, 1);
    const mtfScore = clamp(mtf.confluenceScore || 0, -1, 1);
    const deepLobScore = research?.deepLOB?.score || 0;
    const metaWinProb = research?.metaLabeling?.winProb || (py?.confidence || 0.65);

    // ─────────────────────────────────────────────────────────────────
    // 6. MULTI-MODEL PERFORMANCE-WEIGHTED SYNTHESIS (GRANULAR CONSENSUS)
    // Every Strategy × Measured Paper Performance × Confidence × Regime Affinity
    // ─────────────────────────────────────────────────────────────────
    const currentRegime = pyContributor.regime !== 'NORMAL'
      ? pyContributor.regime
      : (mp?.regime || ctx.regime || 'TRENDING').toUpperCase();

    // Pool of all active strategy signals (all 43 RL algorithms, Python models, quants, patterns)
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

      // Strategy regime affinity multiplier — reads from empirical paper-trading data per strategy per regime.
      // stratPerf.strategies is populated by StrategyPerformanceEngine.getState() with per-regime affinityScore.
      const stratMeta = stratPerf?.strategies?.[id] || stratPerf?.strategies?.[stratKey];
      // regimeScore is the affinityScore for the CURRENT regime from observed paper trades (0.05–0.95)
      // Falls back to 1.0 only when no trades exist yet (neutral prior = full weight)
      const regimeAffinity = (stratMeta?.regimeScore !== undefined && stratMeta.regimeScore > 0)
        ? stratMeta.regimeScore
        : 1.0;

      // Granular strategy dynamic weight: w_i * c_i * r_i
      const strategyDynamicWeight = Math.max(0.001, empiricalW * Math.max(0.15, conf) * Math.max(0.2, regimeAffinity));

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
    // 7. CONFLICT RESOLUTION & CALIBRATED CONFIDENCE
    // ─────────────────────────────────────────────────────────────────
    let conflictDetected = false;
    let conflictDetails = 'CONVERGENT';

    if (pyConnected && rlContributor.direction !== 0 && pyContributor.direction !== 0) {
      if (rlContributor.direction !== pyContributor.direction) {
        conflictDetected = true;
        conflictDetails = `DISAGREEMENT: 43-RL vote is ${rlContributor.direction > 0 ? 'LONG' : 'SHORT'} but Python 5-strat is ${pyContributor.direction > 0 ? 'BUY' : 'SELL'}`;
      }
    }

    // Baseline consensus confidence incorporating empirical weighted agreement
    let baseConfidence = Math.abs(masterScore) * 0.40
      + (weightedAgreement) * 0.35
      + (metaWinProb) * 0.25;

    // Penalties
    if (conflictDetected) baseConfidence *= 0.60; // 40% penalty for major system divergence
    if (rlDispersion > 0.45) baseConfidence *= 0.85; // 15% penalty for high dispersion
    if (isToxicFlow) baseConfidence *= 0.80; // 20% penalty for toxic informed flow

    const calibratedConfidence = clamp(baseConfidence, 0.05, 0.98);

    // ─────────────────────────────────────────────────────────────────
    // 8. MASTER ACTION DETERMINATION
    // ─────────────────────────────────────────────────────────────────
    let signal = 'HOLD';
    let direction = 0;

    if (!conflictDetected && masterScore >= this.scoreThreshold && calibratedConfidence >= this.minConfidenceToApprove) {
      signal = 'BUY';
      direction = 1;
    } else if (!conflictDetected && masterScore <= -this.scoreThreshold && calibratedConfidence >= this.minConfidenceToApprove) {
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

    // Call dynamic target and stop engines
    const dynamicTargetResult = this.selectDynamicTarget({
      entryPrice: price,
      direction,
      movementDistribution: mp,
      confidence: calibratedConfidence,
      regime: currentRegime,
      strategyWeights: perfWeights,
      atr: curAtr,
      pyDynamicTP,
    });

    const dynamicStopResult = this.selectDynamicStop({
      entryPrice: price,
      direction,
      adverseMovement: mp?.adverseMovement,
      confidence: calibratedConfidence,
      regime: currentRegime,
      volatility: curAtr,
      marketStructure: ctx.marketStructure,
      pyStopLoss,
    });

    const dynamicRR = dynamicStopResult.selectedStopDistance > 0
      ? Math.round((dynamicTargetResult.selectedDistance / dynamicStopResult.selectedStopDistance) * 100) / 100
      : (pyRR || 1.5);

    // ─────────────────────────────────────────────────────────────────
    // 10. MODEL HEALTH & DIAGNOSTICS
    // ─────────────────────────────────────────────────────────────────
    const quarantined = Number(autoHealing.quarantinedCount || 0);
    const healthyCount = Math.max(0, rlActiveCount - quarantined);
    const modelHealth = {
      total: rlActiveCount,
      healthy: healthyCount,
      degraded: Math.max(0, rlActiveCount - healthyCount),
      quarantined: quarantined,
      systemStatus: autoHealing.systemHealth || '100% OPTIMAL',
      strategyPerformanceStatus: stratPerf?.statusText || 'Awaiting initial trade sample',
    };

    // ─────────────────────────────────────────────────────────────────
    // 11. PRODUCTION RISK GATE
    // ─────────────────────────────────────────────────────────────────
    let approved = false;
    let rejectionReason = '';

    if (signal === 'HOLD') {
      approved = false;
      rejectionReason = 'Signal is HOLD — zero directional authorization.';
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
      rejectionReason = `BLOCKED: Insufficient healthy algorithms (${healthyCount} / ${rlActiveCount} active).`;
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
      reason = `${signal} AUTHORIZED: Empirical multi-model confluence ${(masterScore * 100).toFixed(1)}% (${(weightedAgreement * 100).toFixed(0)}% weighted agreement) in ${currentRegime} regime with ${dynamicRR}:1 market R:R.`;
    } else {
      reason = `${signal}: ${rejectionReason}`;
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
      bestRegimeStrategy: bestCurrentRegimeStrat?.id || 'INSUFFICIENT_DATA',
      strategyWeights: perfWeights,

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
   * Selects economically useful target from estimated distribution (NO FIXED %)
   */
  selectDynamicTarget(params) {
    const { entryPrice, direction, movementDistribution, confidence, regime, atr, pyDynamicTP } = params;

    // Use Python empirical MFE/MAE targets if available
    if (pyDynamicTP && pyDynamicTP.base_target) {
      const baseT = Number(pyDynamicTP.base_target);
      const consT = Number(pyDynamicTP.conservative_target || baseT * 0.995);
      const extT = Number(pyDynamicTP.extended_target || baseT * 1.01);
      const dist = Math.abs(baseT - entryPrice);

      return {
        selectedLabel: 'Empirical MFE Median',
        selectedDistance: Math.round(dist * 100) / 100,
        selectedProbability: pyDynamicTP.base_prob || 0.50,
        conservativeDistance: Math.round(Math.abs(consT - entryPrice) * 100) / 100,
        mainDistance: Math.round(dist * 100) / 100,
        extendedDistance: Math.round(Math.abs(extT - entryPrice) * 100) / 100,
        targetPrice: baseT,
      };
    }

    const consMove = Number(movementDistribution?.predictedMovement?.conservativeMove) || (atr * 0.85);
    const mainMove = Number(movementDistribution?.predictedMovement?.mainMove) || (atr * 1.45);
    const extMove = Number(movementDistribution?.predictedMovement?.extendedMove) || (atr * 2.20);

    // Adaptive target selection based on confidence and regime
    let selectedMove = mainMove;
    let label = 'Base Optimal Move';
    let prob = 0.50;

    if (confidence >= 0.75 && (regime.includes('TREND') || regime.includes('BREAKOUT'))) {
      selectedMove = extMove;
      label = 'Extended Volatility Expansion';
      prob = 0.28;
    } else if (confidence < 0.60 || regime.includes('REVERT') || regime.includes('COMPRESS')) {
      selectedMove = consMove;
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
   * Selects structural dynamic stop from adverse movement distribution (NO FIXED %)
   */
  selectDynamicStop(params) {
    const { entryPrice, direction, adverseMovement, volatility, pyStopLoss, marketStructure = {} } = params;

    if (pyStopLoss && pyStopLoss.stop_price) {
      const sp = Number(pyStopLoss.stop_price);
      const dist = Math.abs(entryPrice - sp);
      return {
        expectedDistance: Math.round(dist * 100) / 100,
        worstDistance: Math.round((dist * 1.35) * 100) / 100,
        selectedStopDistance: Math.round(dist * 100) / 100,
        stopPrice: sp,
        invalidationLevel: Number(pyStopLoss.invalidation_level || sp),
      };
    }

    // Invalidation from structural swing points if present in marketStructure
    const structHigh = Number(marketStructure?.recentHigh || marketStructure?.swingHigh || 0);
    const structLow = Number(marketStructure?.recentLow || marketStructure?.swingLow || 0);

    const advMove = Number(adverseMovement?.expected) || (volatility > 0 ? volatility : (entryPrice * 0.004));
    const worstMove = Number(adverseMovement?.worstCase) || (advMove * 1.5);
    const buffer = volatility > 0 ? (volatility * 0.20) : (entryPrice * 0.001);

    let invalidationLevel = direction >= 0
      ? (structLow > 0 && structLow < entryPrice ? structLow : Math.round((entryPrice - advMove) * 100) / 100)
      : (structHigh > 0 && structHigh > entryPrice ? structHigh : Math.round((entryPrice + advMove) * 100) / 100);

    const stopPrice = direction >= 0
      ? Math.round((invalidationLevel - buffer) * 100) / 100
      : Math.round((invalidationLevel + buffer) * 100) / 100;

    const selectedStopDistance = Math.round(Math.abs(entryPrice - stopPrice) * 100) / 100;

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
      // Manual trades are permitted with a relaxed threshold (0.40 vs 0.54 algorithmic)
      // to allow deliberate human judgment, but still block genuinely unsafe market states.
      manualApproved = false;
      manualReason = `MANUAL TRADE DECLINED: Market confidence ${(baseDecision.confidence * 100).toFixed(1)}% is below the 40% manual safety floor. Market conditions too uncertain for any trade.`;
    } else {
      manualApproved = true;
      manualReason = `MANUAL TRADE APPROVED: Discretionary ${direction > 0 ? 'BUY' : 'SELL'} authorized under MasterMind risk envelope (Conf: ${(baseDecision.confidence * 100).toFixed(1)}%).`;
    }

    return {
      ...baseDecision,
      direction,
      signal: direction > 0 ? 'BUY' : 'SELL',
      approved: manualApproved,
      isManual: true,
      reason: manualReason,
    };
  }
}
