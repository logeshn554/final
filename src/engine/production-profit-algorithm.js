// ═══════════════════════════════════════════════════════════════════════
// PRODUCTION PROFIT ALGORITHM — Expectancy-Maximizing Exit Engine
//
// Reality: no system can guarantee always-profit. This engine maximizes
// risk-adjusted expectancy via institutional exit mechanics:
//
//  1. Distribution + ATR hybrid TP ladder (TP1 / TP2 / runner)
//  2. P(hit TP before SL) gate — skip trades with weak hit odds
//  3. Delayed ATR trail (activates only after +1R)
//  4. Partial scale-out → breakeven → trail runner
//  5. Stops NEVER widen; volatility-spike blocks new risk
//  6. Risk-budget position sizing from stop distance
//
// References (industry practice): ATR initial stop 1.5–3×, trail after +1R,
// partial at +1R, never-widen ratchet, stale-ATR / vol-spike gates.
// ═══════════════════════════════════════════════════════════════════════

import { clamp } from '../utils/math.js';

const REGIME_EXIT_PROFILES = {
  TRENDING:      { tp1R: 1.0, tp2R: 2.2, runnerR: 3.5, trailAtr: 1.6, slAtr: 1.2, trailActivateR: 1.0, scaleOut1: 0.40, scaleOut2: 0.35 },
  BREAKOUT:      { tp1R: 1.1, tp2R: 2.5, runnerR: 4.0, trailAtr: 1.8, slAtr: 1.3, trailActivateR: 1.0, scaleOut1: 0.35, scaleOut2: 0.35 },
  MEAN_REVERTING:{ tp1R: 0.85, tp2R: 1.5, runnerR: 2.0, trailAtr: 1.2, slAtr: 1.0, trailActivateR: 0.85, scaleOut1: 0.50, scaleOut2: 0.30 },
  VOLATILE:      { tp1R: 1.2, tp2R: 2.0, runnerR: 2.8, trailAtr: 2.2, slAtr: 1.6, trailActivateR: 1.2, scaleOut1: 0.45, scaleOut2: 0.35 },
  COMPRESSION:   { tp1R: 0.9, tp2R: 1.8, runnerR: 2.6, trailAtr: 1.4, slAtr: 1.0, trailActivateR: 0.9, scaleOut1: 0.40, scaleOut2: 0.35 },
  UNKNOWN:       { tp1R: 1.0, tp2R: 1.8, runnerR: 2.5, trailAtr: 1.5, slAtr: 1.2, trailActivateR: 1.0, scaleOut1: 0.45, scaleOut2: 0.35 },
};

function resolveRegimeKey(regime = 'UNKNOWN') {
  const u = String(regime || 'UNKNOWN').toUpperCase();
  if (u.includes('TREND') || u.includes('BULL') || u.includes('BEAR')) return 'TRENDING';
  if (u.includes('BREAK')) return 'BREAKOUT';
  if (u.includes('MEAN') || u.includes('REVERT') || u.includes('RANGE')) return 'MEAN_REVERTING';
  if (u.includes('VOLAT')) return 'VOLATILE';
  if (u.includes('COMPRESS') || u.includes('SQUEEZE')) return 'COMPRESSION';
  return 'UNKNOWN';
}

function round2(n) {
  return Math.round(Number(n) * 100) / 100;
}

function round4(n) {
  return Math.round(Number(n) * 10000) / 10000;
}

/**
 * Approximate P(price reaches target before stop) under a simple
 * Brownian-with-drift model using gambler's-ruin / barrier formula.
 * mu = expected directional drift (fraction of R), sigma ~ 1 (unit R space).
 */
function hitProbability(targetR, stopR, edgeStrength = 0.55) {
  const a = Math.max(0.05, Math.abs(stopR));
  const b = Math.max(0.05, Math.abs(targetR));
  // Convert win-rate-like edge into drift λ
  const drift = clamp((edgeStrength - 0.5) * 4, -1.5, 1.5);
  if (Math.abs(drift) < 1e-6) return a / (a + b);
  const e = Math.exp(-2 * drift * a);
  const f = Math.exp(-2 * drift * (a + b));
  const p = (1 - e) / (1 - f);
  return clamp(p, 0.05, 0.95);
}

export class ProductionProfitAlgorithm {
  constructor(options = {}) {
    this.name = 'ProductionProfitAlgorithm';
    this.version = '1.0.0-PROD';
    this.minHitProbability = options.minHitProbability || 0.52;
    this.minRewardRisk = options.minRewardRisk || 1.35;
    this.maxRiskPerTrade = options.maxRiskPerTrade || 0.015;
    this.maxPositionETH = options.maxPositionETH || 5.0;
    this.volSpikeMultiplier = options.volSpikeMultiplier || 1.55;
    this.minTrailStepUSD = options.minTrailStepUSD || 0.50;

    this.activePlan = null;
    this.lastPlan = null;
    this.sessionStats = {
      plansBuilt: 0,
      tradesManaged: 0,
      tp1Hits: 0,
      tp2Hits: 0,
      trailExits: 0,
      stopExits: 0,
      blockedWeakHit: 0,
      blockedVolSpike: 0,
      realizedPnlUSD: 0,
    };
  }

  /**
   * Build a full profit / exit plan for a prospective trade.
   * Returns null-eligible plan when gates fail (still returns diagnostic object).
   */
  planExits(ctx = {}) {
    this.sessionStats.plansBuilt++;
    const price = Number(ctx.price || 0);
    const direction = Number(ctx.direction || 0);
    const atr = Math.max(0.5, Number(ctx.atr || price * 0.005 || 16));
    const equity = Math.max(100, Number(ctx.equity || 10000));
    const regimeKey = resolveRegimeKey(ctx.regime);
    const profile = REGIME_EXIT_PROFILES[regimeKey];
    const mp = ctx.movementPrediction || null;
    const edgeStrength = clamp(Number(ctx.probabilityOfProfit || ctx.confidence || 0.55), 0.45, 0.85);
    const sessionAtr = Number(ctx.sessionAtr || ctx.avgAtr || atr);

    const volSpike = sessionAtr > 0 && atr / sessionAtr >= this.volSpikeMultiplier;
    if (volSpike) {
      this.sessionStats.blockedVolSpike++;
      const blocked = this._emptyPlan(price, direction, regimeKey, atr, 'VOL_SPIKE_BLOCK');
      this.lastPlan = blocked;
      return blocked;
    }

    if (!price || !direction) {
      const blocked = this._emptyPlan(price, direction, regimeKey, atr, 'NO_DIRECTION');
      this.lastPlan = blocked;
      return blocked;
    }

    // ── Stop distance: ATR profile, optionally tightened by MAE distribution ──
    let stopDist = atr * profile.slAtr;
    if (mp?.adverseMovement?.expected > 0) {
      stopDist = clamp(mp.adverseMovement.expected, atr * 0.7, atr * 2.8);
    }

    // ── Target distances: blend distribution forecast with R-multiples ──
    let tp1Dist = stopDist * profile.tp1R;
    let tp2Dist = stopDist * profile.tp2R;
    let runnerDist = stopDist * profile.runnerR;

    if (mp?.predictedMovement) {
      const cons = Number(mp.predictedMovement.conservativeMove || mp.predictedMovement.conservative || 0);
      const main = Number(mp.predictedMovement.mainMove || mp.predictedMovement.expected || 0);
      const ext = Number(mp.predictedMovement.extendedMove || mp.predictedMovement.extended || 0);
      if (cons > 0) tp1Dist = clamp(0.55 * tp1Dist + 0.45 * cons, stopDist * 0.7, stopDist * 1.6);
      if (main > 0) tp2Dist = clamp(0.45 * tp2Dist + 0.55 * main, stopDist * 1.2, stopDist * 3.5);
      if (ext > 0) runnerDist = clamp(0.40 * runnerDist + 0.60 * ext, stopDist * 1.8, stopDist * 5.0);
    }

    // Ensure ladder ordering
    tp2Dist = Math.max(tp2Dist, tp1Dist * 1.15);
    runnerDist = Math.max(runnerDist, tp2Dist * 1.15);

    const rewardRisk = tp2Dist / stopDist;
    const pHitTp1 = hitProbability(tp1Dist / stopDist, 1.0, edgeStrength);
    const pHitTp2 = hitProbability(tp2Dist / stopDist, 1.0, edgeStrength);

    // Expectancy per unit risk (R-multiples), with partial scale-out
    const rem1 = 1 - profile.scaleOut1;
    const rem2 = rem1 - profile.scaleOut2;
    const expectancyR =
      (profile.scaleOut1 * profile.tp1R * pHitTp1) +
      (profile.scaleOut2 * profile.tp2R * pHitTp2) +
      (Math.max(0, rem2) * (runnerDist / stopDist) * (pHitTp2 * 0.75)) -
      ((1 - pHitTp1) * 1.0);

    const isLong = direction > 0;
    const stopLoss = round2(isLong ? price - stopDist : price + stopDist);
    const takeProfit1 = round2(isLong ? price + tp1Dist : price - tp1Dist);
    const takeProfit2 = round2(isLong ? price + tp2Dist : price - tp2Dist);
    const takeProfitRunner = round2(isLong ? price + runnerDist : price - runnerDist);

    const riskBudgetUSD = equity * this.maxRiskPerTrade;
    const rawQty = stopDist > 0 ? riskBudgetUSD / stopDist : 0.01;
    const positionETH = round4(clamp(rawQty, 0.01, this.maxPositionETH));

    const eligible =
      pHitTp2 >= this.minHitProbability &&
      rewardRisk >= this.minRewardRisk &&
      expectancyR > 0.05;

    if (!eligible) this.sessionStats.blockedWeakHit++;

    const plan = {
      eligible,
      algorithm: this.name,
      version: this.version,
      reason: eligible
        ? `PROFIT_PLAN_OK: E[R]=${expectancyR.toFixed(2)} P(TP2)=${(pHitTp2 * 100).toFixed(1)}% RR=${rewardRisk.toFixed(2)}`
        : `PROFIT_PLAN_BLOCK: E[R]=${expectancyR.toFixed(2)} P(TP2)=${(pHitTp2 * 100).toFixed(1)}% RR=${rewardRisk.toFixed(2)}`,
      regime: regimeKey,
      direction,
      entryPrice: round2(price),
      atr: round2(atr),
      stopDistanceUSD: round2(stopDist),
      targetDistanceUSD: round2(tp2Dist),
      stopLoss,
      takeProfit1,
      takeProfit2,
      takeProfitRunner,
      // Canonical single TP for exchange brackets = TP2 (main)
      takeProfit: takeProfit2,
      scaleOut1Pct: profile.scaleOut1,
      scaleOut2Pct: profile.scaleOut2,
      trailAtrMult: profile.trailAtr,
      trailActivateR: profile.trailActivateR,
      trailDistanceUSD: round2(atr * profile.trailAtr),
      positionETH,
      riskBudgetUSD: round2(riskBudgetUSD),
      rewardRisk: round2(rewardRisk),
      hitProbabilityTp1: round4(pHitTp1),
      hitProbabilityTp2: round4(pHitTp2),
      expectancyR: round4(expectancyR),
      edgeStrength: round4(edgeStrength),
      timestamps: { plannedAt: Date.now() },
    };

    this.lastPlan = plan;
    return plan;
  }

  /**
   * Live position manager — call every tick while in a trade.
   * Mutates and returns management actions (never widens stops).
   */
  managePosition(trade, ctx = {}) {
    if (!trade || !trade.entryPrice || !trade.direction) return { action: 'NONE', trade };
    this.sessionStats.tradesManaged++;

    const price = Number(ctx.price || trade.currentPrice || 0);
    const atr = Math.max(0.5, Number(ctx.atr || trade.atrAtEntry || 16));
    const isLong = trade.direction > 0;
    const entry = Number(trade.entryPrice);
    const stopDist = Math.abs(entry - Number(trade.initialSLPrice || trade.stopLoss || entry));
    const rMove = stopDist > 0
      ? (isLong ? (price - entry) : (entry - price)) / stopDist
      : 0;

    trade.currentPrice = price;
    trade.rMultiple = round4(rMove);
    trade.unrealizedPnlUSD = round2(
      (isLong ? (price - entry) : (entry - price)) * Number(trade.sizeETH || 0)
    );

    const actions = [];

    // Initialize management fields
    if (trade.tp1Executed === undefined) trade.tp1Executed = false;
    if (trade.tp2Executed === undefined) trade.tp2Executed = false;
    if (trade.trailActive === undefined) trade.trailActive = false;
    if (trade.breakevenSet === undefined) trade.breakevenSet = false;
    if (trade.currentSLPrice === undefined) {
      trade.currentSLPrice = Number(trade.initialSLPrice || trade.stopLoss);
    }
    if (trade.realizedPartialPnl === undefined) trade.realizedPartialPnl = 0;

    const tp1 = Number(trade.tp1Price || trade.takeProfit1 || 0);
    const tp2 = Number(trade.tp2Price || trade.takeProfit2 || trade.takeProfit || 0);
    const trailActivateR = Number(trade.trailActivateR || 1.0);
    const trailDist = Number(trade.trailDistanceUSD || atr * (trade.trailAtrMult || 1.5));
    const scale1 = Number(trade.scaleOut1Pct || 0.40);
    const scale2 = Number(trade.scaleOut2Pct || 0.35);

    // ── TP1: scale out + move stop to breakeven ──
    if (!trade.tp1Executed && tp1 > 0) {
      const hit = isLong ? price >= tp1 : price <= tp1;
      if (hit && trade.sizeETH > 0.02) {
        const closeSize = round4(Math.max(0.01, trade.sizeETH * scale1));
        const pnl = round2(closeSize * (isLong ? (price - entry) : (entry - price)));
        trade.sizeETH = round4(Math.max(0.01, trade.sizeETH - closeSize));
        trade.realizedPartialPnl = round2(trade.realizedPartialPnl + pnl);
        trade.tp1Executed = true;
        this.sessionStats.tp1Hits++;
        actions.push({ type: 'PARTIAL_TP1', sizeETH: closeSize, pnlUSD: pnl, price });

        // Breakeven (+ tiny buffer)
        const be = round2(isLong ? entry + Math.max(0.25, atr * 0.05) : entry - Math.max(0.25, atr * 0.05));
        if (isLong && be > trade.currentSLPrice) {
          trade.currentSLPrice = be;
          trade.breakevenSet = true;
          actions.push({ type: 'MOVE_BREAKEVEN', stop: be });
        } else if (!isLong && be < trade.currentSLPrice) {
          trade.currentSLPrice = be;
          trade.breakevenSet = true;
          actions.push({ type: 'MOVE_BREAKEVEN', stop: be });
        }
      }
    }

    // ── TP2: second scale-out ──
    if (trade.tp1Executed && !trade.tp2Executed && tp2 > 0) {
      const hit = isLong ? price >= tp2 : price <= tp2;
      if (hit && trade.sizeETH > 0.02) {
        const closeSize = round4(Math.max(0.01, trade.sizeETH * (scale2 / Math.max(0.01, 1 - scale1))));
        const capped = round4(Math.min(closeSize, trade.sizeETH * 0.9));
        const pnl = round2(capped * (isLong ? (price - entry) : (entry - price)));
        trade.sizeETH = round4(Math.max(0.01, trade.sizeETH - capped));
        trade.realizedPartialPnl = round2(trade.realizedPartialPnl + pnl);
        trade.tp2Executed = true;
        this.sessionStats.tp2Hits++;
        actions.push({ type: 'PARTIAL_TP2', sizeETH: capped, pnlUSD: pnl, price });
      }
    }

    // ── Delayed ATR trail (only after +trailActivateR) ──
    if (rMove >= trailActivateR) {
      trade.trailActive = true;
      const candidate = round2(isLong ? price - trailDist : price + trailDist);
      const stepOk = Math.abs(candidate - trade.currentSLPrice) >= this.minTrailStepUSD;
      if (stepOk) {
        if (isLong && candidate > trade.currentSLPrice) {
          trade.currentSLPrice = candidate;
          actions.push({ type: 'TRAIL_UP', stop: candidate });
        } else if (!isLong && candidate < trade.currentSLPrice) {
          trade.currentSLPrice = candidate;
          actions.push({ type: 'TRAIL_DOWN', stop: candidate });
        }
      }
    }

    // ── Exit checks ──
    const hitSL = isLong
      ? price <= trade.currentSLPrice
      : price >= trade.currentSLPrice;

    if (hitSL) {
      const exitReason = trade.trailActive ? 'TRAILING_STOP' : (trade.breakevenSet ? 'BREAKEVEN_STOP' : 'INITIAL_STOP');
      if (trade.trailActive) this.sessionStats.trailExits++;
      else this.sessionStats.stopExits++;
      const finalPnl = round2(
        trade.realizedPartialPnl +
        trade.sizeETH * (isLong ? (price - entry) : (entry - price))
      );
      this.sessionStats.realizedPnlUSD = round2(this.sessionStats.realizedPnlUSD + finalPnl);
      trade.status = 'CLOSED';
      trade.exitReason = exitReason;
      trade.exitPrice = price;
      trade.finalPnlUSD = finalPnl;
      actions.push({ type: 'CLOSE', reason: exitReason, pnlUSD: finalPnl, price });
      return { action: 'CLOSE', reason: exitReason, actions, trade, pnlUSD: finalPnl };
    }

    // Runner hard target (optional full exit)
    const runner = Number(trade.tpRunnerPrice || trade.takeProfitRunner || 0);
    if (runner > 0) {
      const hitRunner = isLong ? price >= runner : price <= runner;
      if (hitRunner) {
        const finalPnl = round2(
          trade.realizedPartialPnl +
          trade.sizeETH * (isLong ? (price - entry) : (entry - price))
        );
        this.sessionStats.realizedPnlUSD = round2(this.sessionStats.realizedPnlUSD + finalPnl);
        trade.status = 'CLOSED';
        trade.exitReason = 'RUNNER_TP';
        trade.exitPrice = price;
        trade.finalPnlUSD = finalPnl;
        actions.push({ type: 'CLOSE', reason: 'RUNNER_TP', pnlUSD: finalPnl, price });
        return { action: 'CLOSE', reason: 'RUNNER_TP', actions, trade, pnlUSD: finalPnl };
      }
    }

    this.activePlan = trade;
    return {
      action: actions.length ? 'MANAGE' : 'HOLD',
      actions,
      trade,
      rMultiple: trade.rMultiple,
      currentSL: trade.currentSLPrice,
    };
  }

  /**
   * Attach plan fields onto a masterTrade / activeTrade object.
   */
  applyPlanToTrade(plan, extra = {}) {
    if (!plan || !plan.eligible) return null;
    return {
      status: 'ACTIVE',
      direction: plan.direction,
      entryPrice: plan.entryPrice,
      initialSLPrice: plan.stopLoss,
      currentSLPrice: plan.stopLoss,
      stopLoss: plan.stopLoss,
      tp1Price: plan.takeProfit1,
      tp2Price: plan.takeProfit2,
      tpRunnerPrice: plan.takeProfitRunner,
      takeProfit: plan.takeProfit,
      takeProfit1: plan.takeProfit1,
      takeProfit2: plan.takeProfit2,
      takeProfitRunner: plan.takeProfitRunner,
      sizeETH: plan.positionETH,
      atrAtEntry: plan.atr,
      trailAtrMult: plan.trailAtrMult,
      trailActivateR: plan.trailActivateR,
      trailDistanceUSD: plan.trailDistanceUSD,
      scaleOut1Pct: plan.scaleOut1Pct,
      scaleOut2Pct: plan.scaleOut2Pct,
      trailActive: false,
      tp1Executed: false,
      tp2Executed: false,
      breakevenSet: false,
      realizedPartialPnl: 0,
      regime: plan.regime,
      expectancyR: plan.expectancyR,
      hitProbabilityTp2: plan.hitProbabilityTp2,
      algorithm: this.name,
      ...extra,
    };
  }

  getStats() {
    return { ...this.sessionStats, lastPlan: this.lastPlan };
  }

  _emptyPlan(price, direction, regime, atr, reason) {
    return {
      eligible: false,
      algorithm: this.name,
      version: this.version,
      reason,
      regime,
      direction,
      entryPrice: round2(price),
      atr: round2(atr),
      stopDistanceUSD: 0,
      targetDistanceUSD: 0,
      stopLoss: 0,
      takeProfit1: 0,
      takeProfit2: 0,
      takeProfitRunner: 0,
      takeProfit: 0,
      positionETH: 0,
      rewardRisk: 0,
      hitProbabilityTp1: 0,
      hitProbabilityTp2: 0,
      expectancyR: 0,
    };
  }
}
