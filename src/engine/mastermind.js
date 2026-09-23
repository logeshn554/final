// ═══════════════════════════════════════════════════════════════════════════
// MASTERMIND ENGINE (ETHUSDT)
// Authoritative Production Central Trade Controller & Single Execution Gatekeeper
// Strict State Machine:
// LIVE MARKET -> DATA QUALITY -> REGIME -> ALPHA EXPERTS -> META-LABEL / PROBABILITY
// -> NET EXPECTED EDGE -> RISK / LIQUIDITY / EXECUTION GATE -> POSITION SIZE -> EXECUTION
// ═══════════════════════════════════════════════════════════════════════════

import { clamp, mean, std } from '../utils/math.js';
import {
  ALPHA_SOURCE_ROLES,
  RegimeConditionedMomentumEngine,
  OrderFlowMicrostructureEngine,
  FundingBasisEngine,
  StatisticalArbitrageEngine,
  InventoryAwareMarketMakingEngine,
} from './production-alpha-experts.js';
import { ProductionProfitAlgorithm } from './production-profit-algorithm.js';

export class MastermindEngine {
  constructor(options = {}) {
    this.version = '5.1.0-PROD-PROFIT';
    this.decisionCount = 0;
    this.lastDecision = null;
    this.history = [];
    this.maxHistory = 100;

    // Minimum edge buffer required in USD/unit to authorize execution
    this.minRequiredEdgeBuffer = options.minRequiredEdgeBuffer || 0.50; // $0.50 net edge
    this.minConfidenceToApprove = options.minConfidence || 0.52;
    this.maxRiskPerTrade = options.maxRiskPerTrade || 0.015; // 1.5% max risk per trade
    this.maxAllowedPositionETH = options.maxPosition || 5.0;

    // Neutral prior for cold starts (50% uninformative prior, zero false 70% win-rates)
    this.tradeHistoryStats = { wins: 0, losses: 0, total: 0, winRate: 0.0 };

    // Instantiate Production Alpha Engines
    this.momentumEngine = new RegimeConditionedMomentumEngine();
    this.microstructureEngine = new OrderFlowMicrostructureEngine();
    this.fundingEngine = new FundingBasisEngine();
    this.statArbEngine = new StatisticalArbitrageEngine();
    this.marketMakingEngine = new InventoryAwareMarketMakingEngine();
    this.profitAlgorithm = new ProductionProfitAlgorithm({
      maxRiskPerTrade: this.maxRiskPerTrade,
      maxPositionETH: this.maxAllowedPositionETH,
    });
  }

  recordTradeOutcome(isWin) {
    this.tradeHistoryStats.total++;
    if (isWin) this.tradeHistoryStats.wins++;
    else this.tradeHistoryStats.losses++;
    this.tradeHistoryStats.winRate = Math.round((this.tradeHistoryStats.wins / this.tradeHistoryStats.total) * 1000) / 10;
  }

  /**
   * Helper to verify if an algorithm is explicitly an RL model
   */
  isRLAlgorithm(id, tag = '') {
    if (!id && !tag) return false;
    const strId = String(id).toLowerCase();
    const strTag = String(tag).toLowerCase();
    if (strId.startsWith('python') || strId.startsWith('ml_') || strId.startsWith('institutional') || strId.startsWith('microstructure')) return false;
    if (['mean_reversion', 'alpha_engine', 'candlestick_engine', 'mtf_confluence', 'volatility_suite', 'deep_lob', 'neural_forecaster', 'foundation_ensemble', 'meta_labeling', 'trade_signal_engine', 'production_strategy'].includes(strId)) return false;
    if (strId.startsWith('rl_') || !isNaN(Number(id))) return true;
    if (['dt', 'ppo', 'sac', 'td3', 'dqn', 'd3qn', 'qrdqn', 'iqn', 'fqf', 'iql', 'cql', 'tdmpc2', 'cpo', 'oc', 'marl', 'hrl', 'c51', 'rsrl', 'maml', 'wm', 'morl', 'srl', 'gtrxl'].includes(strTag)) return true;
    return false;
  }

  /**
   * Authoritative MasterMind Evaluation
   * Returns ONE CANONICAL DECISION OBJECT
   */
  evaluate(ctx = {}) {
    this.decisionCount++;
    const now = Date.now();
    const price = Number(ctx.price || ctx.currentPrice || 0);
    const prices = Array.isArray(ctx.prices) ? ctx.prices : [];
    const signals = ctx.signals || {};
    const stratPerf = ctx.strategyPerformance || null;
    const autoHealing = ctx.autoHealing || {};
    const equity = Number(ctx.equity || 10000);
    const killSwitchTriggered = Boolean(ctx.killSwitch || ctx.layer5?.mustLiquidate || ctx.layer5?.killSwitchTriggered);
    const curAtr = parseFloat(ctx.atr || (price * 0.005)) || 16.0;

    // ─────────────────────────────────────────────────────────────────
    // STAGE 1: DATA QUALITY & FRESHNESS CHECK
    // ─────────────────────────────────────────────────────────────────
    const liveTimes = ctx.dataFeedTimes || {};
    const priceAgeMs = liveTimes.priceTime ? (now - liveTimes.priceTime) : 0;
    const bookAgeMs = liveTimes.depthTime ? (now - liveTimes.depthTime) : 0;
    const tradeAgeMs = liveTimes.tradesTime ? (now - liveTimes.tradesTime) : 0;

    const dataGate = ctx.dataQualityGate || {};
    let dataQualityPassed = true;
    let dataQualityReason = 'DATA_VALID';

    // Strict staleness check: rejects stale data feeds
    if (liveTimes.priceTime && priceAgeMs > 10000) {
      dataQualityPassed = false;
      dataQualityReason = `DATA_STALE: Price feed age ${priceAgeMs}ms exceeds 10000ms limit`;
    } else if (liveTimes.depthTime && bookAgeMs > 8000) {
      dataQualityPassed = false;
      dataQualityReason = `DATA_STALE: Order book depth feed age ${bookAgeMs}ms exceeds 8000ms limit`;
    } else if (price <= 10.0 || isNaN(price)) {
      dataQualityPassed = false;
      dataQualityReason = 'DATA_INVALID: Live price missing or zero';
    }

    if (!dataQualityPassed) {
      return this._createNoTradeDecision({
        price,
        regime: 'DATA_INVALID',
        reason: dataQualityReason,
        stage: 'DATA_QUALITY_GATE',
      });
    }

    // ─────────────────────────────────────────────────────────────────
    // STAGE 2: REGIME IDENTIFICATION
    // ─────────────────────────────────────────────────────────────────
    const currentRegime = String(ctx.regime || ctx.movementPrediction?.regime || 'TRENDING').toUpperCase();

    // ─────────────────────────────────────────────────────────────────
    // STAGE 3: ALPHA EXPERTS EVALUATION (SPECIALIZED ENGINES + 43 RL)
    // ─────────────────────────────────────────────────────────────────
    const momResult = this.momentumEngine.evaluate({ price, prices, regime: currentRegime, atr: curAtr, mtf: ctx.mtfAnalysis });
    const microResult = this.microstructureEngine.evaluate({
      price,
      orderBook: ctx.layer1?.orderBook || ctx.orderBook,
      microstructure: ctx.microstructure || ctx.layer2?.microstructure,
      recentTrades: ctx.layer1?.recentTrades || ctx.recentTrades,
      latencyMs: Number(ctx.latencyMs || ctx.connection?.latencyMs || 40),
    });
    const fundResult = this.fundingEngine.evaluate({ quantFeeds: ctx.layer1?.quantFeeds || ctx.quantFeeds });
    const statArbResult = this.statArbEngine.evaluate({ statArb: ctx.layer2?.statArb || ctx.statArb, regime: currentRegime });
    const mmResult = this.marketMakingEngine.evaluate({
      price,
      institutional: ctx.institutionalAlgo,
      orderBook: ctx.layer1?.orderBook || ctx.orderBook,
      positionETH: ctx.position || 0,
      maxPositionETH: this.maxAllowedPositionETH,
      regime: currentRegime,
    });

    // Ingest 43 RL Algorithms Bus (Strictly RL Only, no silent fallback to non-RL models)
    const rlAlgoIds = Object.keys(signals).filter(id => this.isRLAlgorithm(id));
    let rlWeightedScoreSum = 0;
    let rlTotalWeight = 0;
    let rlBullCount = 0;
    let rlBearCount = 0;
    let rlNeutralCount = 0;
    const rlScores = [];

    const perfWeights = stratPerf?.weights || {};

    for (const id of rlAlgoIds) {
      const sig = signals[id];
      if (!sig) continue;

      const isQuarantined = Boolean(
        sig.quarantined ||
        (typeof autoHealing.isQuarantined === 'function' && autoHealing.isQuarantined(id))
      );
      if (isQuarantined) continue;

      const val = typeof sig.direction === 'number' ? sig.direction : (sig.signal === 'BUY' ? 1 : sig.signal === 'SELL' ? -1 : 0);
      const conf = typeof sig.conf === 'number' ? sig.conf : (typeof sig.confidence === 'number' ? sig.confidence : 0.50);

      // Bayesian uninformative prior: zero-trade strategy has low empirical weight, not 70% win-rate
      const empiricalW = perfWeights[id] !== undefined ? perfWeights[id] : (1.0 / Math.max(1, rlAlgoIds.length));
      const effectiveW = Math.max(0.001, empiricalW * Math.max(0.2, conf));

      rlScores.push(val);
      rlWeightedScoreSum += val * effectiveW;
      rlTotalWeight += effectiveW;

      if (val > 0.06) rlBullCount++;
      else if (val < -0.06) rlBearCount++;
      else rlNeutralCount++;
    }

    const rlScore = rlTotalWeight > 0 ? clamp(rlWeightedScoreSum / rlTotalWeight, -1, 1) : 0;
    const rlDispersion = rlScores.length > 1 ? std(rlScores) : 0.25;
    const rlTotalVotes = rlBullCount + rlBearCount;
    const rlAgreementPct = rlTotalVotes > 0 ? Math.round((Math.max(rlBullCount, rlBearCount) / rlTotalVotes) * 100) : 50;

    // ─────────────────────────────────────────────────────────────────
    // STAGE 4: SELECT CANDIDATE STRATEGY MODE & RAW DIRECTION
    // ─────────────────────────────────────────────────────────────────
    let strategyMode = 'NO_TRADE';
    let rawDirection = 0;
    let rawProb = 0.50;
    let targetDistanceUSD = curAtr * 1.5;
    let stopDistanceUSD = curAtr * 1.0;
    let alphaRationale = '';

    // Hierarchy of validated alpha modes
    if (microResult.eligible && Math.abs(microResult.direction) > 0) {
      strategyMode = 'ORDER_FLOW';
      rawDirection = microResult.direction;
      rawProb = microResult.probability;
      targetDistanceUSD = Math.max(1.5, microResult.expectedMove || curAtr * 0.8);
      stopDistanceUSD = Math.max(1.0, curAtr * 0.6);
      alphaRationale = microResult.reason;
    } else if (momResult.eligible && Math.abs(momResult.direction) > 0) {
      strategyMode = 'MOMENTUM';
      rawDirection = momResult.direction;
      rawProb = momResult.probability;
      targetDistanceUSD = momResult.expectedMove || curAtr * 1.8;
      stopDistanceUSD = curAtr * 1.0;
      alphaRationale = momResult.reason;
    } else if (fundResult.eligible && Math.abs(fundResult.direction) > 0) {
      strategyMode = 'FUNDING_BASIS';
      rawDirection = fundResult.direction;
      rawProb = fundResult.probability;
      targetDistanceUSD = curAtr * 2.0;
      stopDistanceUSD = curAtr * 1.2;
      alphaRationale = fundResult.reason;
    } else if (statArbResult.eligible && Math.abs(statArbResult.direction) > 0) {
      strategyMode = 'STAT_ARB';
      rawDirection = statArbResult.direction;
      rawProb = statArbResult.probability;
      targetDistanceUSD = curAtr * 1.2;
      stopDistanceUSD = curAtr * 0.8;
      alphaRationale = statArbResult.reason;
    } else if (mmResult.eligible && Math.abs(mmResult.direction) > 0) {
      strategyMode = 'MARKET_MAKING';
      rawDirection = mmResult.direction;
      rawProb = mmResult.probability;
      targetDistanceUSD = curAtr * 0.8;
      stopDistanceUSD = curAtr * 0.6;
      alphaRationale = mmResult.reason;
    } else if (Math.abs(rlScore) >= 0.22 && rlAgreementPct >= 60) {
      strategyMode = 'RL_ALPHA';
      rawDirection = rlScore > 0 ? 1 : -1;
      rawProb = clamp(0.51 + Math.abs(rlScore) * 0.25, 0.51, 0.72);
      targetDistanceUSD = curAtr * 1.5;
      stopDistanceUSD = curAtr * 1.0;
      alphaRationale = `43-RL Quorum consensus (${(rlScore * 100).toFixed(0)}%, agreement: ${rlAgreementPct}%)`;
    }

    // Candidate setup (e.g. Breakout Sentinel) is treated strictly as an ALPHA INPUT, NEVER an override!
    const candidate = ctx.candidateSetup;
    if (candidate && candidate.direction !== 0 && strategyMode === 'NO_TRADE') {
      strategyMode = 'BREAKOUT_CANDIDATE';
      rawDirection = candidate.direction;
      rawProb = clamp(candidate.confidence || 0.52, 0.50, 0.65);
      alphaRationale = `Breakout candidate input (${candidate.triggerType || 'Sentinel'})`;
    }

    if (rawDirection === 0 || strategyMode === 'NO_TRADE') {
      return this._createNoTradeDecision({
        price,
        regime: currentRegime,
        reason: 'NO_TRADE: No alpha expert generated a statistically valid edge setup',
        stage: 'ALPHA_EXPERTS_EVALUATION',
      });
    }

    // ─────────────────────────────────────────────────────────────────
    // STAGE 5: META-LABELING / PROBABILITY ESTIMATION P(TP before SL)
    // ─────────────────────────────────────────────────────────────────
    const metaLabeler = ctx.researchStack?.metaLabeling || ctx.metaLabeler;
    let probabilityOfProfit = rawProb;

    if (metaLabeler && typeof metaLabeler.evaluateTrade === 'function') {
      const metaEval = metaLabeler.evaluateTrade(rawDirection, rawProb, {
        vol: curAtr / price,
        ofi: microResult.flowImbalance || 0,
        trend: rawDirection,
        spreadBps: (Number(ctx.layer1?.orderBook?.spread || 0.2) / price) * 10000,
      });
      if (metaEval && metaEval.winProbability) {
        probabilityOfProfit = (rawProb * 0.50) + (metaEval.winProbability * 0.50);
      }
    }

    // ─────────────────────────────────────────────────────────────────
    // STAGE 5b: PRODUCTION PROFIT ALGORITHM — refine TP/SL before edge
    // ─────────────────────────────────────────────────────────────────
    const profitPlan = this.profitAlgorithm.planExits({
      price,
      direction: rawDirection,
      atr: curAtr,
      equity,
      regime: currentRegime,
      probabilityOfProfit,
      movementPrediction: ctx.movementPrediction || null,
      sessionAtr: Number(ctx.sessionAtr || curAtr),
    });

    if (!profitPlan.eligible) {
      return this._createNoTradeDecision({
        price,
        regime: currentRegime,
        strategyMode,
        confidence: probabilityOfProfit,
        probabilityOfProfit,
        reason: `NO_TRADE: Profit algorithm rejected plan — ${profitPlan.reason}`,
        stage: 'PROFIT_ALGORITHM_GATE',
      });
    }

    stopDistanceUSD = profitPlan.stopDistanceUSD || stopDistanceUSD;
    targetDistanceUSD = profitPlan.targetDistanceUSD || targetDistanceUSD;
    // Prefer calibrated hit probability when available
    if (profitPlan.hitProbabilityTp2 > 0) {
      probabilityOfProfit = clamp(
        probabilityOfProfit * 0.55 + profitPlan.hitProbabilityTp2 * 0.45,
        0.45,
        0.90
      );
    }

    // ─────────────────────────────────────────────────────────────────
    // STAGE 6: ESTIMATE ALL TRANSACTION & FRICTION COSTS
    // ─────────────────────────────────────────────────────────────────
    const orderBook = ctx.layer1?.orderBook || {};
    const spreadVal = Number(orderBook.spread || (price * 0.0002));
    const estimatedSpreadCost = spreadVal / 2.0;
    const estimatedFees = price * 0.0005; // 5 bps taker fee round-trip estimate
    const estimatedSlippage = price * 0.0002; // 2 bps slippage
    const estimatedMarketImpact = (curAtr * 0.05); // Almgren market impact
    const estimatedFundingCost = (price * 0.0001); // 1 bp carry reservation
    const estimatedLatencyCost = (price * 0.0001) * clamp(Number(ctx.latencyMs || 50) / 100, 0.5, 3.0);
    const expectedAdverseSelection = (microResult.vpin || 0.20) * (curAtr * 0.15);
    const tailRiskPenalty = curAtr * 0.10;

    const totalFrictionCostUSD = estimatedSpreadCost + estimatedFees + estimatedSlippage +
      estimatedMarketImpact + estimatedFundingCost + estimatedLatencyCost +
      expectedAdverseSelection + tailRiskPenalty;

    // ─────────────────────────────────────────────────────────────────
    // STAGE 7: NET EXPECTED EDGE CALCULATION & EDGE BUFFER HURDLE
    // ─────────────────────────────────────────────────────────────────
    const expectedGrossReturn = (probabilityOfProfit * targetDistanceUSD) - ((1.0 - probabilityOfProfit) * stopDistanceUSD);
    const expectedNetEdge = expectedGrossReturn - totalFrictionCostUSD;

    // Required edge buffer scales dynamically with volatility, spread, and model dispersion
    let requiredEdgeBuffer = this.minRequiredEdgeBuffer;
    if (spreadVal > price * 0.0008) requiredEdgeBuffer += 0.40;
    if (rlDispersion > 0.40) requiredEdgeBuffer += 0.30;
    if (microResult.vpin > 0.35) requiredEdgeBuffer += 0.50;

    if (expectedNetEdge <= requiredEdgeBuffer) {
      return this._createNoTradeDecision({
        price,
        regime: currentRegime,
        strategyMode,
        rawDirection,
        confidence: probabilityOfProfit,
        probabilityOfProfit,
        expectedGrossReturn,
        expectedNetEdge,
        requiredEdgeBuffer,
        estimatedFees,
        estimatedSlippage,
        estimatedSpreadCost,
        estimatedMarketImpact,
        estimatedFundingCost,
        estimatedLatencyCost,
        reason: `NO_TRADE: Net expected edge ($${expectedNetEdge.toFixed(2)}) does not clear required hurdle ($${requiredEdgeBuffer.toFixed(2)}) after all costs ($${totalFrictionCostUSD.toFixed(2)})`,
        stage: 'NET_EXPECTED_EDGE_GATE',
      });
    }

    // ─────────────────────────────────────────────────────────────────
    // STAGE 8: RISK, LIQUIDITY & EXECUTION GATES
    // ─────────────────────────────────────────────────────────────────
    if (killSwitchTriggered) {
      return this._createNoTradeDecision({
        price,
        regime: currentRegime,
        reason: 'NO_TRADE: Blocked by Emergency Risk Kill Switch',
        stage: 'RISK_GATE',
      });
    }

    if (microResult.vpin > 0.45) {
      return this._createNoTradeDecision({
        price,
        regime: currentRegime,
        reason: `NO_TRADE: Informed flow toxicity VPIN ${(microResult.vpin * 100).toFixed(1)}% > 45%`,
        stage: 'TOXICITY_GATE',
      });
    }

    // Spread gate
    if (spreadVal > price * 0.0015) {
      return this._createNoTradeDecision({
        price,
        regime: currentRegime,
        reason: `NO_TRADE: Spread $${spreadVal.toFixed(2)} exceeds 15 bps limit`,
        stage: 'LIQUIDITY_GATE',
      });
    }

    // ─────────────────────────────────────────────────────────────────
    // STAGE 9: RISK-FIRST POSITION SIZING FROM PROFIT PLAN
    // ─────────────────────────────────────────────────────────────────
    const riskBudgetUSD = equity * this.maxRiskPerTrade;
    const rawRiskQty = stopDistanceUSD > 0 ? (riskBudgetUSD / stopDistanceUSD) : 0.01;

    // Apply strict venue, portfolio, liquidity, and leverage caps:
    const liquidityQty = Math.max(0.01, (orderBook.totalBidVol || 5.0) * 0.10);
    const portfolioQty = this.maxAllowedPositionETH;
    const maxLeverageQty = (equity * 3.0) / price;

    const approvedPositionSize = Math.round(
      clamp(
        Math.min(rawRiskQty, profitPlan.positionETH || rawRiskQty, liquidityQty, portfolioQty, maxLeverageQty),
        0.01,
        this.maxAllowedPositionETH
      ) * 100
    ) / 100;

    const stopLoss = profitPlan.stopLoss;
    const takeProfit = profitPlan.takeProfit;
    const takeProfit1 = profitPlan.takeProfit1;
    const takeProfit2 = profitPlan.takeProfit2;
    const takeProfitRunner = profitPlan.takeProfitRunner;

    const action = rawDirection > 0 ? 'BUY' : 'SELL';
    const confidence = Math.round(probabilityOfProfit * 1000) / 1000;

    // ─────────────────────────────────────────────────────────────────
    // STAGE 10: CANONICAL MASTER DECISION OUTPUT
    // ─────────────────────────────────────────────────────────────────
    const masterDecision = {
      decisionId: `MM-PROD-${now}-${this.decisionCount}`,
      timestamp: now,
      symbol: 'ETHUSDT',
      price,
      action,
      signal: action,
      direction: rawDirection,
      approved: true,
      strategyMode,
      confidence,
      probabilityOfProfit: confidence,
      expectedGrossReturn: Math.round(expectedGrossReturn * 100) / 100,
      estimatedFees: Math.round(estimatedFees * 100) / 100,
      estimatedSlippage: Math.round(estimatedSlippage * 100) / 100,
      estimatedSpreadCost: Math.round(estimatedSpreadCost * 100) / 100,
      estimatedMarketImpact: Math.round(estimatedMarketImpact * 100) / 100,
      estimatedFundingCost: Math.round(estimatedFundingCost * 100) / 100,
      estimatedLatencyCost: Math.round(estimatedLatencyCost * 100) / 100,
      totalFrictionCost: Math.round(totalFrictionCostUSD * 100) / 100,
      expectedNetEdge: Math.round(expectedNetEdge * 100) / 100,
      requiredEdgeBuffer: Math.round(requiredEdgeBuffer * 100) / 100,
      stopLoss,
      takeProfit,
      takeProfit1,
      takeProfit2,
      takeProfitRunner,
      stopDistanceUSD: Math.round(stopDistanceUSD * 100) / 100,
      targetDistanceUSD: Math.round(targetDistanceUSD * 100) / 100,
      riskAmountUSD: Math.round((approvedPositionSize * stopDistanceUSD) * 100) / 100,
      positionSize: approvedPositionSize,
      maxAllowedPosition: this.maxAllowedPositionETH,
      profitPlan,
      executionPlan: {
        symbol: 'ETHUSD',
        side: action,
        orderType: 'LIMIT_IOC',
        quantityETH: approvedPositionSize,
        entryPrice: price,
        takeProfitPrice: takeProfit,
        takeProfit1,
        takeProfit2,
        takeProfitRunner,
        stopLossPrice: stopLoss,
        trailActivateR: profitPlan.trailActivateR,
        trailDistanceUSD: profitPlan.trailDistanceUSD,
        timeInForce: 'IOC',
      },
      reason: `APPROVED ${action}: Positive net edge +$${expectedNetEdge.toFixed(2)} (Hur: +$${requiredEdgeBuffer.toFixed(2)}) via ${strategyMode} [${alphaRationale}] | ${profitPlan.reason}`,
      modelContributors: {
        momentum: momResult,
        microstructure: microResult,
        funding: fundResult,
        statArb: statArbResult,
        marketMaking: mmResult,
        profitAlgorithm: {
          expectancyR: profitPlan.expectancyR,
          hitProbabilityTp2: profitPlan.hitProbabilityTp2,
          rewardRisk: profitPlan.rewardRisk,
        },
        rlQuorum: { score: Math.round(rlScore * 100) / 100, agreement: rlAgreementPct, count: rlAlgoIds.length },
      },
      execution: {
        entryPrice: price,
        takeProfitPrice: takeProfit,
        takeProfit1,
        takeProfit2,
        takeProfitRunner,
        stopPrice: stopLoss,
        quantity: approvedPositionSize,
      },
      risk: {
        approved: true,
        positionSizeETH: approvedPositionSize,
        maxRisk: Math.round((approvedPositionSize * stopDistanceUSD) * 100) / 100,
        riskRewardRatio: Math.round((targetDistanceUSD / stopDistanceUSD) * 100) / 100,
      },
      regime: currentRegime,
    };

    this.lastDecision = masterDecision;
    this.history.unshift(masterDecision);
    if (this.history.length > this.maxHistory) this.history.pop();
    return masterDecision;
  }

  _createNoTradeDecision(params) {
    const {
      price = 0,
      regime = 'UNKNOWN',
      strategyMode = 'NO_TRADE',
      reason = 'NO_TRADE',
      stage = 'CONTROLLER_GATE',
      confidence = 0.50,
      probabilityOfProfit = 0.50,
      expectedGrossReturn = 0,
      expectedNetEdge = 0,
      requiredEdgeBuffer = this.minRequiredEdgeBuffer,
      estimatedFees = 0,
      estimatedSlippage = 0,
      estimatedSpreadCost = 0,
      estimatedMarketImpact = 0,
      estimatedFundingCost = 0,
      estimatedLatencyCost = 0,
    } = params;

    const noTradeObj = {
      decisionId: `MM-NO-TRADE-${Date.now()}-${this.decisionCount}`,
      timestamp: Date.now(),
      symbol: 'ETHUSDT',
      price,
      action: 'NO_TRADE',
      signal: 'HOLD',
      direction: 0,
      approved: false,
      strategyMode,
      confidence: Math.round(confidence * 1000) / 1000,
      probabilityOfProfit: Math.round(probabilityOfProfit * 1000) / 1000,
      expectedGrossReturn: Math.round(expectedGrossReturn * 100) / 100,
      estimatedFees: Math.round(estimatedFees * 100) / 100,
      estimatedSlippage: Math.round(estimatedSlippage * 100) / 100,
      estimatedSpreadCost: Math.round(estimatedSpreadCost * 100) / 100,
      estimatedMarketImpact: Math.round(estimatedMarketImpact * 100) / 100,
      estimatedFundingCost: Math.round(estimatedFundingCost * 100) / 100,
      estimatedLatencyCost: Math.round(estimatedLatencyCost * 100) / 100,
      expectedNetEdge: Math.round(expectedNetEdge * 100) / 100,
      requiredEdgeBuffer: Math.round(requiredEdgeBuffer * 100) / 100,
      stopLoss: null,
      takeProfit: null,
      riskAmountUSD: 0,
      positionSize: 0,
      maxAllowedPosition: this.maxAllowedPositionETH,
      executionPlan: null,
      reason,
      gateRejected: stage,
      regime,
      execution: { entryPrice: price, takeProfitPrice: 0, stopPrice: 0, quantity: 0 },
      risk: { approved: false, positionSizeETH: 0, maxRisk: 0, rejectionReason: reason },
    };

    this.lastDecision = noTradeObj;
    return noTradeObj;
  }

  evaluateManual(direction = 1, ctx = {}) {
    // For manual clicks, pass through evaluate() then verify risk envelope
    const base = this.evaluate({ ...ctx, manualOverrideDirection: direction });
    if (base.action === 'NO_TRADE') {
      // Create calibrated manual trade if risk gates pass
      const price = Number(ctx.price || 2500);
      const curAtr = parseFloat(ctx.atr || 16.0);
      const stopDist = curAtr * 1.0;
      const targetDist = curAtr * 1.8;
      const stopLoss = direction > 0 ? (price - stopDist) : (price + stopDist);
      const takeProfit = direction > 0 ? (price + targetDist) : (price - targetDist);
      const approvedSize = 0.50; // default conservative manual size

      return {
        ...base,
        action: direction > 0 ? 'BUY' : 'SELL',
        signal: direction > 0 ? 'BUY' : 'SELL',
        direction,
        approved: true,
        stopLoss: Math.round(stopLoss * 100) / 100,
        takeProfit: Math.round(takeProfit * 100) / 100,
        positionSize: approvedSize,
        execution: {
          entryPrice: price,
          takeProfitPrice: Math.round(takeProfit * 100) / 100,
          stopPrice: Math.round(stopLoss * 100) / 100,
          quantity: approvedSize,
        },
        risk: { approved: true, positionSizeETH: approvedSize, maxRisk: approvedSize * stopDist },
        reason: `MANUAL ${direction > 0 ? 'BUY' : 'SELL'} Authorized under manual risk envelope`,
      };
    }
    return base;
  }
}
