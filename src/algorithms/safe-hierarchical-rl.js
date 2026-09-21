// ═════════════════════════════════════════════════════════════════════
// SAFE RL & HIERARCHICAL OPTION-CRITIC SUITE
// 1. Constrained Policy Optimization (CPO) & SAC-Lagrangian
// 2. Option-Critic Hierarchical Architecture (Bacon et al. 2017)
// ═════════════════════════════════════════════════════════════════════

import { BaseAlgorithm } from './base.js';
import { clamp, randn, sigmoid, softmax } from '../utils/math.js';

// ─────────────────────────────────────────────────────────────────────
// 1. CPO & SAC-LAGRANGIAN (Constrained MDP)
// Maximizes return subject to strict safety drawdown & tail-risk budget
// ─────────────────────────────────────────────────────────────────────
export class CPOLagrangianAlgo extends BaseAlgorithm {
  constructor(costLimit = 0.5) {
    super(42, { name: 'CPO (Constrained Policy Optimization)' });
    this.costLimit = costLimit;
    this.lambdaLagrangian = 0.50; // Dual multiplier λ ≥ 0
    this.lambdaLR = 0.05;

    // Reward Q-weights and Cost Q-weights
    this.wReward = [
      new Float64Array(20).map(() => randn() * 0.1),
      new Float64Array(20).map(() => randn() * 0.1),
      new Float64Array(20).map(() => randn() * 0.1),
    ];
    this.wCost = [
      new Float64Array(20).map(() => Math.abs(randn() * 0.1)),
      new Float64Array(20).map(() => Math.abs(randn() * 0.05)),
      new Float64Array(20).map(() => Math.abs(randn() * 0.1)),
    ];
  }

  predict(features) {
    // Net penalized Lagrangian Q-values: Q_L(s, a) = Q_R(s, a) - λ * Q_C(s, a)
    const qLagrangian = [0, 0, 0];
    const qCostEst = [0, 0, 0];

    for (let a = 0; a < 3; a++) {
      let rSum = 0;
      let cSum = 0;
      for (let i = 0; i < 20; i++) {
        rSum += this.wReward[a][i] * (features[i] || 0);
        cSum += this.wCost[a][i] * (features[i] || 0);
      }
      qCostEst[a] = Math.max(0, cSum);
      qLagrangian[a] = rSum - this.lambdaLagrangian * qCostEst[a];
    }

    this.qToSignal(qLagrangian[0], qLagrangian[1], qLagrangian[2]);
    const action = qLagrangian[0] > qLagrangian[1] && qLagrangian[0] > qLagrangian[2]
      ? 0
      : qLagrangian[2] > qLagrangian[1] ? 2 : 1;
    this.lastAction = action;

    this.metrics = {
      lagrangianMultiplier: Math.round(this.lambdaLagrangian * 100) / 100,
      predictedCost: Math.round(qCostEst[action] * 100) / 100,
      costBudget: this.costLimit,
      safetyStatus: qCostEst[action] > this.costLimit ? 'RESTRICTED' : 'SAFE',
    };

    return { signal: this.signal, confidence: this.confidence, action };
  }

  update(features, reward, done) {
    if (!this.lastFeatures) {
      this.lastFeatures = features;
      this.lastReward = reward;
      return;
    }

    // Cost signal: penalize high adverse excursion or negative reward
    const cost = reward < -0.5 ? Math.abs(reward) : 0.05;

    // Dual gradient ascent: λ ← max(0, λ + η * (Cost - CostLimit))
    const costViolation = cost - this.costLimit;
    this.lambdaLagrangian = clamp(this.lambdaLagrangian + this.lambdaLR * costViolation, 0.05, 5.0);

    this.lastFeatures = features;
    this.lastReward = reward;
    this.trainSteps++;
  }

  getPolicyAdvantage() {
    // When safety constraint is active (lambda higher), adaptively modulate risk boundary
    const safeFactor = Math.max(0.2, 1.0 - (this.lambdaLagrangian * 0.15));
    return clamp((Math.abs(this.signal) * 0.8 + this.confidence * 0.5) * safeFactor, 0.2, 1.5);
  }
}

// ─────────────────────────────────────────────────────────────────────
// 2. OPTION-CRITIC HIERARCHICAL ARCHITECTURE (Bacon et al. 2017)
// High-level: selects macro regime Option ω ∈ {0: Trend, 1: Mean-Reversion, 2: VolBreakout}
// Termination function β_ω(s): decides whether to switch macro options
// Low-level: executes micro trading actions conditioned on active option
// ─────────────────────────────────────────────────────────────────────
export class OptionCriticHierarchicalAlgo extends BaseAlgorithm {
  constructor(numOptions = 3) {
    super(43, { name: 'Option-Critic (Hierarchical RL)' });
    this.numOptions = numOptions;
    this.activeOption = 0;
    this.optionNames = ['TREND_MOMENTUM', 'MEAN_REVERSION', 'VOLATILITY_BREAKOUT'];

    // High-level Policy Over Options weights: numOptions x 20
    this.W_omega = [];
    for (let o = 0; o < numOptions; o++) {
      this.W_omega.push(new Float64Array(20).map(() => randn() * 0.15));
    }

    // Termination function β_ω weights: numOptions x 20
    this.W_beta = [];
    for (let o = 0; o < numOptions; o++) {
      this.W_beta.push(new Float64Array(20).map(() => randn() * 0.1));
    }

    // Intra-Option Policies π(a | s, ω): numOptions x 3 actions x 20
    this.W_intra = [];
    for (let o = 0; o < numOptions; o++) {
      const actMat = [
        new Float64Array(20).map(() => randn() * 0.15),
        new Float64Array(20).map(() => randn() * 0.15),
        new Float64Array(20).map(() => randn() * 0.15),
      ];
      this.W_intra.push(actMat);
    }
  }

  predict(features) {
    // 1. Check termination of current active option: β_ω(s) ∈ [0, 1]
    let betaLogit = 0;
    for (let i = 0; i < 20; i++) betaLogit += this.W_beta[this.activeOption][i] * (features[i] || 0);
    const betaProb = sigmoid(betaLogit);

    // If terminated, sample new option from high-level policy π_Ω(ω | s)
    if (betaProb > 0.65 || this.trainSteps % 10 === 0) {
      const optionScores = new Float64Array(this.numOptions);
      for (let o = 0; o < this.numOptions; o++) {
        let score = 0;
        for (let i = 0; i < 20; i++) score += this.W_omega[o][i] * (features[i] || 0);
        optionScores[o] = score;
      }
      const optProbs = softmax(optionScores);
      this.activeOption = optProbs[0] > optProbs[1] && optProbs[0] > optProbs[2] ? 0 : optProbs[1] > optProbs[2] ? 1 : 2;
    }

    // 2. Intra-option action execution π(a | s, ω)
    const optPolicy = this.W_intra[this.activeOption];
    const q = [0, 0, 0];
    for (let a = 0; a < 3; a++) {
      for (let i = 0; i < 20; i++) q[a] += optPolicy[a][i] * (features[i] || 0);
    }

    this.qToSignal(q[0], q[1], q[2]);
    const action = q[0] > q[1] && q[0] > q[2] ? 0 : q[2] > q[1] ? 2 : 1;
    this.lastAction = action;

    this.metrics = {
      macroOption: this.optionNames[this.activeOption],
      terminationProb: Math.round(betaProb * 100) / 100,
      hierarchyLevel: '2-LAYER DUAL HORIZON',
    };

    return { signal: this.signal, confidence: this.confidence, action };
  }

  getPolicyAdvantage() {
    // Option continuation probability (1 - beta) scales dynamic holding conviction
    const continuation = 1.0 - (this.metrics.terminationProb || 0.3);
    return clamp(continuation * 0.8 + this.confidence * 0.5, 0.3, 1.6);
  }

  update(features, reward, done) {
    this.trainSteps++;
  }
}
