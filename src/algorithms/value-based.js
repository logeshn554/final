// ═══════════════════════════════════════════════════════
// VALUE-BASED ALGORITHMS (1-13)
// Markov Chain, MDP, Rewards, Value Fn, Bellman, DP,
// Monte Carlo, TD Learning, SARSA, Q-Learning,
// Exploration, DQN, Double/Dueling DQN
// ═══════════════════════════════════════════════════════

import { BaseAlgorithm } from './base.js';
import { NeuralNet, ReplayBuffer, PrioritizedReplayBuffer } from '../utils/nn.js';
import {
  rnd, clamp, mean, std, softmax, argmax, sigmoid, randn,
  sampleCategorical, ema, entropy
} from '../utils/math.js';
import { discretizeState } from '../engine/features.js';
import { NUM_ACTIONS, HYPERPARAMS, FEATURE_DIM } from '../config.js';

const HP = HYPERPARAMS;

// ─────────────────────────────────────────────────────
// 1. MARKOV CHAIN — Transition probability estimation
// ─────────────────────────────────────────────────────
export class MarkovChainAlgo extends BaseAlgorithm {
  constructor() {
    super(1);
    // States: 0=strong_down, 1=down, 2=flat, 3=up, 4=strong_up
    this.numStates = 5;
    this.transitionMatrix = [];
    for (let i = 0; i < this.numStates; i++) {
      this.transitionMatrix[i] = new Float64Array(this.numStates).fill(1 / this.numStates);
    }
    this.counts = [];
    for (let i = 0; i < this.numStates; i++) {
      this.counts[i] = new Float64Array(this.numStates).fill(1); // Laplace smoothing
    }
    this.prevState = 2;
    this.stationaryDist = new Float64Array(this.numStates).fill(0.2);
  }

  _priceToState(ret1) {
    if (ret1 < -0.3) return 0;
    if (ret1 < -0.05) return 1;
    if (ret1 < 0.05) return 2;
    if (ret1 < 0.3) return 3;
    return 4;
  }

  update(features) {
    const currentState = this._priceToState(features[0]);
    this.counts[this.prevState][currentState]++;

    // Update transition probabilities
    const rowSum = this.counts[this.prevState].reduce((a, b) => a + b, 0);
    for (let j = 0; j < this.numStates; j++) {
      this.transitionMatrix[this.prevState][j] = this.counts[this.prevState][j] / rowSum;
    }

    // Compute stationary distribution (power iteration, 1 step)
    const newDist = new Float64Array(this.numStates);
    for (let j = 0; j < this.numStates; j++) {
      for (let i = 0; i < this.numStates; i++) {
        newDist[j] += this.stationaryDist[i] * this.transitionMatrix[i][j];
      }
    }
    this.stationaryDist = newDist;

    // Expected next state
    const nextProbs = this.transitionMatrix[currentState];
    let expectedState = 0;
    for (let j = 0; j < this.numStates; j++) expectedState += j * nextProbs[j];

    // Signal: expected state mapped to [-1, 1]
    this.signal = clamp((expectedState - 2) / 2, -1, 1);
    this.confidence = 1 - entropy(Array.from(nextProbs)) / Math.log(this.numStates);
    this.confidence = clamp(this.confidence, 0.3, 0.95);

    this.metrics = {
      currentState,
      expectedNext: expectedState.toFixed(2),
      transEntropy: entropy(Array.from(nextProbs)).toFixed(3),
    };

    this.prevState = currentState;
    this.trainSteps++;
  }

  predict(features) {
    return { signal: this.signal, confidence: this.confidence, action: this.signal > 0.1 ? 0 : this.signal < -0.1 ? 2 : 1 };
  }
}


// ─────────────────────────────────────────────────────
// 2. MDP — Markov Decision Process with state-action values
// ─────────────────────────────────────────────────────
export class MDPAlgo extends BaseAlgorithm {
  constructor() {
    super(2);
    this.numStates = HP.numDiscreteStates;
    // R[s][a] and T[s][a][s'] estimated from experience
    this.rewardSum = {};
    this.rewardCount = {};
    this.transCount = {};
    this.V = {};
    this.policy = {};
    this.gamma = HP.gamma;
    this.prevStateIdx = 0;
    this.prevAction = 1;
  }

  _getKey(s) { return `s${s}`; }

  update(features, reward) {
    const stateIdx = discretizeState(features);
    const key = this._getKey(this.prevStateIdx);
    const newKey = this._getKey(stateIdx);

    // Update reward estimates
    if (!this.rewardSum[key]) this.rewardSum[key] = [0, 0, 0];
    if (!this.rewardCount[key]) this.rewardCount[key] = [0, 0, 0];
    this.rewardSum[key][this.prevAction] += reward;
    this.rewardCount[key][this.prevAction]++;

    // Update transition counts
    if (!this.transCount[key]) this.transCount[key] = [{}, {}, {}];
    if (!this.transCount[key][this.prevAction][newKey]) this.transCount[key][this.prevAction][newKey] = 0;
    this.transCount[key][this.prevAction][newKey]++;

    // Value iteration (1 step, lazy)
    if (this.trainSteps % 5 === 0) {
      for (const sk of Object.keys(this.rewardSum)) {
        let bestV = -Infinity;
        let bestA = 1;
        for (let a = 0; a < NUM_ACTIONS; a++) {
          const count = this.rewardCount[sk]?.[a] || 0;
          if (count === 0) continue;
          const avgR = this.rewardSum[sk][a] / count;

          let expectedV = 0;
          const tc = this.transCount[sk]?.[a] || {};
          const totalTrans = Object.values(tc).reduce((s, v) => s + v, 0);
          for (const [ns, c] of Object.entries(tc)) {
            expectedV += (c / totalTrans) * (this.V[ns] || 0);
          }

          const qsa = avgR + this.gamma * expectedV;
          if (qsa > bestV) { bestV = qsa; bestA = a; }
        }
        this.V[sk] = bestV === -Infinity ? 0 : bestV;
        this.policy[sk] = bestA;
      }
    }

    // Generate signal from policy
    const action = this.policy[newKey] ?? 1;
    this.signal = action === 0 ? 0.6 : action === 2 ? -0.6 : 0;
    this.confidence = clamp(0.4 + Object.keys(this.V).length * 0.001, 0.3, 0.9);

    this.metrics = { states: Object.keys(this.V).length, action };

    this.prevStateIdx = stateIdx;
    this.prevAction = action;
    this.trainSteps++;
  }

  predict(features) {
    return { signal: this.signal, confidence: this.confidence, action: this.prevAction };
  }
}


// ─────────────────────────────────────────────────────
// 3. REWARDS & RETURNS — Discounted cumulative G_t tracking
// ─────────────────────────────────────────────────────
export class RewardsReturnsAlgo extends BaseAlgorithm {
  constructor() {
    super(3);
    this.gamma = HP.gamma;
    this.episodeRewards = [];
    this.returns = []; // G_t history
    this.actionReturns = [[],[],[]]; // Returns per action
    this.currentReturn = 0;
    this.bestAction = 1;
  }

  update(features, reward) {
    this.episodeRewards.push(reward);

    // Compute discounted return from recent rewards
    this.currentReturn = 0;
    const n = Math.min(this.episodeRewards.length, 20);
    let discount = 1;
    for (let i = this.episodeRewards.length - 1; i >= this.episodeRewards.length - n; i--) {
      this.currentReturn += discount * this.episodeRewards[i];
      discount *= this.gamma;
    }

    this.returns.push(this.currentReturn);
    if (this.returns.length > 200) this.returns.shift();
    if (this.episodeRewards.length > 200) this.episodeRewards.shift();

    // Track returns by action
    this.actionReturns[this.lastAction].push(this.currentReturn);
    for (let a = 0; a < 3; a++) {
      if (this.actionReturns[a].length > 100) this.actionReturns[a].shift();
    }

    // Signal based on which action has best average return
    const avgReturns = this.actionReturns.map(arr => arr.length > 0 ? mean(arr) : 0);
    this.bestAction = argmax(avgReturns);

    this.signal = this.bestAction === 0 ? 0.5 + avgReturns[0] * 2
               : this.bestAction === 2 ? -0.5 + avgReturns[2] * 2
               : avgReturns[1] * 2;
    this.signal = clamp(this.signal, -1, 1);
    this.confidence = clamp(0.4 + Math.abs(this.currentReturn) * 2, 0.3, 0.9);

    this.metrics = {
      G_t: this.currentReturn.toFixed(4),
      avgReturn: mean(this.returns).toFixed(4),
      bestAction: ['BUY', 'HOLD', 'SELL'][this.bestAction],
    };
    this.trainSteps++;
  }

  predict(features) {
    return { signal: this.signal, confidence: this.confidence, action: this.bestAction };
  }
}


// ─────────────────────────────────────────────────────
// 4. VALUE FUNCTION V(s) — Neural network state-value estimation
// ─────────────────────────────────────────────────────
export class ValueFunctionAlgo extends BaseAlgorithm {
  constructor() {
    super(4);
    this.net = new NeuralNet([
      { in: FEATURE_DIM, out: HP.hiddenSize1, act: 'relu' },
      { in: HP.hiddenSize1, out: HP.hiddenSize2, act: 'relu' },
      { in: HP.hiddenSize2, out: 1, act: 'linear' },
    ]);
    this.gamma = HP.gamma;
    this.prevFeatures = null;
    this.V_s = 0;
    this.tdError = 0;
  }

  update(features, reward) {
    if (this.prevFeatures) {
      // TD(0) target: r + γV(s')
      const V_next = this.net.forward(features)[0];
      const target = reward + this.gamma * V_next;
      this.tdError = target - this.V_s;

      // Train V(s) toward target
      this.net.trainMSE(this.prevFeatures, Float64Array.from([target]));
    }

    this.V_s = this.net.forward(features)[0];
    this.prevFeatures = new Float64Array(features);

    // Signal based on change in value
    this.signal = clamp(this.tdError * 5, -1, 1);
    this.confidence = clamp(0.5 + Math.abs(this.V_s) * 0.5, 0.3, 0.95);

    this.metrics = { V_s: this.V_s.toFixed(4), tdError: this.tdError.toFixed(4) };
    this.trainSteps++;
  }

  predict(features) {
    return { signal: this.signal, confidence: this.confidence, action: this.signal > 0.1 ? 0 : this.signal < -0.1 ? 2 : 1 };
  }
}


// ─────────────────────────────────────────────────────
// 5. BELLMAN EQUATION — Optimality check via Bellman residual
// ─────────────────────────────────────────────────────
export class BellmanAlgo extends BaseAlgorithm {
  constructor() {
    super(5);
    this.qNet = new NeuralNet([
      { in: FEATURE_DIM, out: HP.hiddenSize1, act: 'relu' },
      { in: HP.hiddenSize1, out: NUM_ACTIONS, act: 'linear' },
    ]);
    this.gamma = HP.gamma;
    this.prevFeatures = null;
    this.prevAction = 1;
    this.bellmanResidual = 0;
  }

  update(features, reward) {
    if (this.prevFeatures) {
      const qCurrent = this.qNet.forward(this.prevFeatures);
      const qNext = this.qNet.forward(features);
      const maxQNext = Math.max(...qNext);

      // Bellman residual: |Q(s,a) - [r + γ max Q(s',a')]|
      const bellmanTarget = reward + this.gamma * maxQNext;
      this.bellmanResidual = Math.abs(qCurrent[this.prevAction] - bellmanTarget);

      // Train to minimize Bellman error
      const target = new Float64Array(qCurrent);
      target[this.prevAction] = bellmanTarget;
      this.qNet.trainHuber(this.prevFeatures, target);
    }

    const qValues = this.qNet.forward(features);
    const bestAction = argmax(Array.from(qValues));

    this.signal = clamp((qValues[0] - qValues[2]) / (Math.abs(qValues[0]) + Math.abs(qValues[2]) + 0.01), -1, 1);
    this.confidence = clamp(0.5 - this.bellmanResidual * 2, 0.3, 0.95);

    this.metrics = {
      residual: this.bellmanResidual.toFixed(4),
      Q: Array.from(qValues).map(v => v.toFixed(3)).join('/'),
    };

    this.prevFeatures = new Float64Array(features);
    this.prevAction = bestAction;
    this.trainSteps++;
  }

  predict(features) {
    return { signal: this.signal, confidence: this.confidence, action: this.prevAction };
  }
}


// ─────────────────────────────────────────────────────
// 6. DYNAMIC PROGRAMMING — Policy Iteration on discretized state space
// ─────────────────────────────────────────────────────
export class DynamicProgAlgo extends BaseAlgorithm {
  constructor() {
    super(6);
    this.V = new Map();
    this.Q = new Map();
    this.policy = new Map();
    this.gamma = HP.gamma;
    this.transitions = new Map(); // (s,a) → [(s', r, count)]
    this.prevState = 0;
    this.prevAction = 1;
    this.iterCount = 0;
  }

  _key(s, a) { return `${s}_${a}`; }

  update(features, reward) {
    const state = discretizeState(features);
    const key = this._key(this.prevState, this.prevAction);

    // Record transition
    if (!this.transitions.has(key)) this.transitions.set(key, new Map());
    const trans = this.transitions.get(key);
    const sk = String(state);
    if (!trans.has(sk)) trans.set(sk, { r: 0, c: 0 });
    const t = trans.get(sk);
    t.r = (t.r * t.c + reward) / (t.c + 1);
    t.c++;

    // Policy iteration every 10 steps
    if (this.trainSteps % 10 === 0 && this.transitions.size > 5) {
      // Policy evaluation (1 sweep)
      for (const [sa, transMap] of this.transitions) {
        const totalCount = [...transMap.values()].reduce((s, t) => s + t.c, 0);
        let qVal = 0;
        for (const [ns, t] of transMap) {
          const prob = t.c / totalCount;
          qVal += prob * (t.r + this.gamma * (this.V.get(ns) || 0));
        }
        this.Q.set(sa, qVal);
      }

      // Policy improvement
      const states = new Set();
      for (const sa of this.transitions.keys()) states.add(sa.split('_')[0]);
      for (const s of states) {
        let bestA = 1, bestQ = -Infinity;
        for (let a = 0; a < NUM_ACTIONS; a++) {
          const q = this.Q.get(this._key(s, a)) || 0;
          if (q > bestQ) { bestQ = q; bestA = a; }
        }
        this.V.set(s, bestQ);
        this.policy.set(s, bestA);
      }
      this.iterCount++;
    }

    // Signal from current policy
    const action = this.policy.get(String(state)) ?? 1;
    this.signal = action === 0 ? 0.6 : action === 2 ? -0.6 : 0;
    this.confidence = clamp(0.4 + this.iterCount * 0.02, 0.3, 0.9);

    this.metrics = { states: this.V.size, iterations: this.iterCount };

    this.prevState = state;
    this.prevAction = action;
    this.trainSteps++;
  }

  predict(features) {
    return { signal: this.signal, confidence: this.confidence, action: this.prevAction };
  }
}


// ─────────────────────────────────────────────────────
// 7. MONTE CARLO — First-visit MC for Q(s,a) estimation
// ─────────────────────────────────────────────────────
export class MonteCarloAlgo extends BaseAlgorithm {
  constructor() {
    super(7);
    this.Q = new Map();
    this.returns = new Map();
    this.gamma = HP.gamma;
    this.epsilon = 0.3;
    this.episode = []; // (state, action, reward)
    this.episodeLen = 20; // Sliding window episodes
  }

  update(features, reward) {
    const state = discretizeState(features);
    const action = this.lastAction;
    this.episode.push({ state, action, reward });

    // Process episode when it reaches target length
    if (this.episode.length >= this.episodeLen) {
      // Compute returns backward
      let G = 0;
      const visited = new Set();
      for (let t = this.episode.length - 1; t >= 0; t--) {
        G = this.episode[t].reward + this.gamma * G;
        const key = `${this.episode[t].state}_${this.episode[t].action}`;

        // First-visit MC
        if (!visited.has(key)) {
          visited.add(key);
          if (!this.returns.has(key)) this.returns.set(key, []);
          this.returns.get(key).push(G);
          if (this.returns.get(key).length > 50) this.returns.get(key).shift();
          this.Q.set(key, mean(this.returns.get(key)));
        }
      }

      this.episode = this.episode.slice(-5); // Keep some context
    }

    // ε-greedy action selection
    let bestAction = 1;
    let bestQ = -Infinity;
    for (let a = 0; a < NUM_ACTIONS; a++) {
      const q = this.Q.get(`${state}_${a}`) || 0;
      if (q > bestQ) { bestQ = q; bestAction = a; }
    }

    if (Math.random() < this.epsilon) bestAction = Math.floor(Math.random() * NUM_ACTIONS);

    const qBuy = this.Q.get(`${state}_0`) || 0;
    const qSell = this.Q.get(`${state}_2`) || 0;
    this.signal = clamp((qBuy - qSell) * 3, -1, 1);
    this.confidence = clamp(0.4 + this.Q.size * 0.002, 0.3, 0.9);

    this.lastAction = bestAction;
    this.metrics = { episodes: this.returns.size, epsilon: this.epsilon.toFixed(2) };
    this.trainSteps++;
    this.epsilon = Math.max(0.05, this.epsilon * 0.999);
  }

  predict(features) {
    return { signal: this.signal, confidence: this.confidence, action: this.lastAction };
  }
}


// ─────────────────────────────────────────────────────
// 8. TD LEARNING — TD(0) with eligibility traces
// ─────────────────────────────────────────────────────
export class TDLearningAlgo extends BaseAlgorithm {
  constructor() {
    super(8);
    this.V = new Map();
    this.eligibility = new Map();
    this.gamma = HP.gamma;
    this.lambda = HP.lambda;
    this.alpha = 0.1;
    this.prevState = 0;
    this.tdError = 0;
  }

  update(features, reward) {
    const state = discretizeState(features);

    // TD(λ) update
    const V_s = this.V.get(this.prevState) || 0;
    const V_next = this.V.get(state) || 0;
    this.tdError = reward + this.gamma * V_next - V_s;

    // Update eligibility traces and values
    this.eligibility.set(this.prevState, (this.eligibility.get(this.prevState) || 0) + 1);

    for (const [s, e] of this.eligibility) {
      const v = this.V.get(s) || 0;
      this.V.set(s, v + this.alpha * this.tdError * e);
      const newE = this.gamma * this.lambda * e;
      if (newE < 0.001) this.eligibility.delete(s);
      else this.eligibility.set(s, newE);
    }

    // Signal from TD error direction
    this.signal = clamp(this.tdError * 8, -1, 1);
    this.confidence = clamp(0.5 + Math.abs(this.tdError) * 3, 0.3, 0.95);

    this.metrics = {
      tdError: this.tdError.toFixed(4),
      V_s: (this.V.get(state) || 0).toFixed(4),
      traces: this.eligibility.size,
    };

    this.prevState = state;
    this.trainSteps++;
  }

  predict(features) {
    return { signal: this.signal, confidence: this.confidence, action: this.signal > 0.1 ? 0 : this.signal < -0.1 ? 2 : 1 };
  }
}


// ─────────────────────────────────────────────────────
// 9. SARSA — On-policy TD control
// ─────────────────────────────────────────────────────
export class SARSAAlgo extends BaseAlgorithm {
  constructor() {
    super(9);
    this.Q = new Map();
    this.gamma = HP.gamma;
    this.alpha = 0.1;
    this.epsilon = HP.epsilonStart;
    this.prevState = 0;
    this.prevAction = 1;
  }

  _getQ(s, a) { return this.Q.get(`${s}_${a}`) || 0; }
  _setQ(s, a, v) { this.Q.set(`${s}_${a}`, v); }

  _epsilonGreedy(state) {
    if (Math.random() < this.epsilon) return Math.floor(Math.random() * NUM_ACTIONS);
    let bestA = 1, bestQ = -Infinity;
    for (let a = 0; a < NUM_ACTIONS; a++) {
      const q = this._getQ(state, a);
      if (q > bestQ) { bestQ = q; bestA = a; }
    }
    return bestA;
  }

  update(features, reward) {
    const state = discretizeState(features);
    const action = this._epsilonGreedy(state);

    // SARSA update: Q(s,a) += α[r + γQ(s',a') - Q(s,a)]
    const qCurrent = this._getQ(this.prevState, this.prevAction);
    const qNext = this._getQ(state, action);
    const tdError = reward + this.gamma * qNext - qCurrent;
    this._setQ(this.prevState, this.prevAction, qCurrent + this.alpha * tdError);

    // Signal
    const qBuy = this._getQ(state, 0);
    const qSell = this._getQ(state, 2);
    this.signal = clamp((qBuy - qSell) * 3, -1, 1);
    this.confidence = clamp(0.4 + this.Q.size * 0.001, 0.3, 0.9);

    this.metrics = { tdError: tdError.toFixed(4), epsilon: this.epsilon.toFixed(3), entries: this.Q.size };

    this.prevState = state;
    this.prevAction = action;
    this.lastAction = action;
    this.epsilon = Math.max(HP.epsilonEnd, this.epsilon * HP.epsilonDecay);
    this.trainSteps++;
  }

  predict(features) {
    return { signal: this.signal, confidence: this.confidence, action: this.lastAction };
  }
}


// ─────────────────────────────────────────────────────
// 10. Q-LEARNING — Off-policy TD control
// ─────────────────────────────────────────────────────
export class QLearningAlgo extends BaseAlgorithm {
  constructor() {
    super(10);
    this.Q = new Map();
    this.gamma = HP.gamma;
    this.alpha = 0.1;
    this.epsilon = HP.epsilonStart;
    this.prevState = 0;
    this.prevAction = 1;
  }

  _getQ(s, a) { return this.Q.get(`${s}_${a}`) || 0; }
  _setQ(s, a, v) { this.Q.set(`${s}_${a}`, v); }

  update(features, reward) {
    const state = discretizeState(features);

    // Q-Learning: Q(s,a) += α[r + γ max_a' Q(s',a') - Q(s,a)]
    const qCurrent = this._getQ(this.prevState, this.prevAction);
    let maxQNext = -Infinity;
    for (let a = 0; a < NUM_ACTIONS; a++) {
      maxQNext = Math.max(maxQNext, this._getQ(state, a));
    }
    if (!isFinite(maxQNext)) maxQNext = 0;

    const tdError = reward + this.gamma * maxQNext - qCurrent;
    this._setQ(this.prevState, this.prevAction, qCurrent + this.alpha * tdError);

    // ε-greedy behavior policy
    let action;
    if (Math.random() < this.epsilon) {
      action = Math.floor(Math.random() * NUM_ACTIONS);
    } else {
      action = 1; let bestQ = -Infinity;
      for (let a = 0; a < NUM_ACTIONS; a++) {
        const q = this._getQ(state, a);
        if (q > bestQ) { bestQ = q; action = a; }
      }
    }

    const qBuy = this._getQ(state, 0);
    const qSell = this._getQ(state, 2);
    this.signal = clamp((qBuy - qSell) * 3, -1, 1);
    this.confidence = clamp(0.4 + this.Q.size * 0.001, 0.3, 0.9);

    this.metrics = { tdError: tdError.toFixed(4), maxQ: maxQNext.toFixed(3), entries: this.Q.size };

    this.prevState = state;
    this.prevAction = action;
    this.lastAction = action;
    this.epsilon = Math.max(HP.epsilonEnd, this.epsilon * HP.epsilonDecay);
    this.trainSteps++;
  }

  predict(features) {
    return { signal: this.signal, confidence: this.confidence, action: this.lastAction };
  }
}


// ─────────────────────────────────────────────────────
// 11. EXPLORATION — UCB + Boltzmann + Noisy strategies
// ─────────────────────────────────────────────────────
export class ExplorationAlgo extends BaseAlgorithm {
  constructor() {
    super(11);
    this.actionCounts = [1, 1, 1];
    this.actionRewards = [0, 0, 0];
    this.totalCount = 3;
    this.temperature = 1.0;
    this.ucbC = 2.0;
  }

  update(features, reward) {
    this.actionRewards[this.lastAction] += reward;
    this.actionCounts[this.lastAction]++;
    this.totalCount++;

    const means = this.actionRewards.map((r, i) => r / this.actionCounts[i]);

    // UCB scores
    const ucbScores = means.map((m, i) =>
      m + this.ucbC * Math.sqrt(Math.log(this.totalCount) / this.actionCounts[i])
    );

    // Boltzmann probabilities
    const boltzProbs = softmax(means.map(m => m / this.temperature));

    // Combined: UCB for exploration, Boltzmann for soft action
    const ucbAction = argmax(ucbScores);
    const boltzAction = sampleCategorical(boltzProbs);

    // Blend signals
    const ucbSignal = ucbAction === 0 ? 0.6 : ucbAction === 2 ? -0.6 : 0;
    const boltzSignal = boltzProbs[0] - boltzProbs[2];

    this.signal = clamp((ucbSignal + boltzSignal) / 2, -1, 1);
    this.confidence = clamp(1 - this.temperature * 0.3, 0.3, 0.9);

    this.lastAction = Math.random() < 0.5 ? ucbAction : boltzAction;
    this.temperature = Math.max(0.1, this.temperature * 0.998);

    this.metrics = {
      temp: this.temperature.toFixed(3),
      ucbAction: ['BUY', 'HOLD', 'SELL'][ucbAction],
      exploration: (1 / this.totalCount * 100).toFixed(2) + '%',
    };
    this.trainSteps++;
  }

  predict(features) {
    return { signal: this.signal, confidence: this.confidence, action: this.lastAction };
  }
}


// ─────────────────────────────────────────────────────
// 12. DQN — Deep Q-Network with experience replay
// ─────────────────────────────────────────────────────
export class DQNAlgo extends BaseAlgorithm {
  constructor() {
    super(12);
    this.qNet = new NeuralNet([
      { in: FEATURE_DIM, out: HP.hiddenSize1, act: 'relu' },
      { in: HP.hiddenSize1, out: HP.hiddenSize2, act: 'relu' },
      { in: HP.hiddenSize2, out: NUM_ACTIONS, act: 'linear' },
    ]);
    this.targetNet = new NeuralNet([
      { in: FEATURE_DIM, out: HP.hiddenSize1, act: 'relu' },
      { in: HP.hiddenSize1, out: HP.hiddenSize2, act: 'relu' },
      { in: HP.hiddenSize2, out: NUM_ACTIONS, act: 'linear' },
    ]);
    this.targetNet.copyFrom(this.qNet);

    this.buffer = new ReplayBuffer(HP.bufferSize);
    this.gamma = HP.gamma;
    this.epsilon = HP.epsilonStart;
    this.prevFeatures = null;
    this.prevAction = 1;
    this.loss = 0;
  }

  update(features, reward) {
    if (this.prevFeatures) {
      this.buffer.add(
        Array.from(this.prevFeatures),
        this.prevAction,
        reward,
        Array.from(features),
        false
      );
    }

    // Train from replay buffer
    if (this.buffer.size >= HP.minBufferSize && this.trainSteps % 2 === 0) {
      const batch = this.buffer.sample(HP.batchSize);
      let totalLoss = 0;

      for (const exp of batch) {
        const qCurrent = this.qNet.forward(exp.state);
        const qNext = this.targetNet.forward(exp.nextState);
        const maxQNext = Math.max(...qNext);

        const target = new Float64Array(qCurrent);
        target[exp.action] = exp.reward + this.gamma * maxQNext;

        totalLoss += this.qNet.trainHuber(exp.state, target);
      }
      this.loss = totalLoss / batch.length;
    }

    // Update target network
    if (this.trainSteps % 50 === 0) {
      this.targetNet.copyFrom(this.qNet);
    }

    // ε-greedy action
    const qValues = this.qNet.forward(features);
    let action;
    if (Math.random() < this.epsilon) {
      action = Math.floor(Math.random() * NUM_ACTIONS);
    } else {
      action = argmax(Array.from(qValues));
    }

    this.signal = clamp((qValues[0] - qValues[2]) * 2, -1, 1);
    this.confidence = clamp(0.5 + (1 - this.epsilon) * 0.4, 0.3, 0.95);

    this.metrics = {
      loss: this.loss.toFixed(5),
      epsilon: this.epsilon.toFixed(3),
      buffer: this.buffer.size,
    };

    this.prevFeatures = new Float64Array(features);
    this.prevAction = action;
    this.lastAction = action;
    this.epsilon = Math.max(HP.epsilonEnd, this.epsilon * HP.epsilonDecay);
    this.trainSteps++;
  }

  predict(features) {
    return { signal: this.signal, confidence: this.confidence, action: this.lastAction };
  }
}


// ─────────────────────────────────────────────────────
// 13. DOUBLE / DUELING DQN — Overestimation fix + advantage stream
// ─────────────────────────────────────────────────────
export class DoubleDuelingDQNAlgo extends BaseAlgorithm {
  constructor() {
    super(13);
    // Dueling architecture: V(s) + A(s,a) streams
    this.valueNet = new NeuralNet([
      { in: FEATURE_DIM, out: HP.hiddenSize1, act: 'relu' },
      { in: HP.hiddenSize1, out: 1, act: 'linear' },
    ]);
    this.advNet = new NeuralNet([
      { in: FEATURE_DIM, out: HP.hiddenSize1, act: 'relu' },
      { in: HP.hiddenSize1, out: NUM_ACTIONS, act: 'linear' },
    ]);
    this.targetValueNet = new NeuralNet([
      { in: FEATURE_DIM, out: HP.hiddenSize1, act: 'relu' },
      { in: HP.hiddenSize1, out: 1, act: 'linear' },
    ]);
    this.targetAdvNet = new NeuralNet([
      { in: FEATURE_DIM, out: HP.hiddenSize1, act: 'relu' },
      { in: HP.hiddenSize1, out: NUM_ACTIONS, act: 'linear' },
    ]);
    this.targetValueNet.copyFrom(this.valueNet);
    this.targetAdvNet.copyFrom(this.advNet);

    this.buffer = new PrioritizedReplayBuffer(HP.bufferSize);
    this.gamma = HP.gamma;
    this.epsilon = HP.epsilonStart;
    this.prevFeatures = null;
    this.prevAction = 1;
  }

  _getQ(features, vNet, aNet) {
    const V = vNet.forward(features)[0];
    const A = aNet.forward(features);
    const meanA = Array.from(A).reduce((s, v) => s + v, 0) / NUM_ACTIONS;
    return Array.from(A).map(a => V + a - meanA);
  }

  update(features, reward) {
    if (this.prevFeatures) {
      this.buffer.add(Array.from(this.prevFeatures), this.prevAction, reward, Array.from(features), false);
    }

    if (this.buffer.size >= HP.minBufferSize && this.trainSteps % 2 === 0) {
      const { batch, indices, weights } = this.buffer.sample(HP.batchSize);
      const tdErrors = [];

      for (let b = 0; b < batch.length; b++) {
        const exp = batch[b];
        const qCurrent = this._getQ(exp.state, this.valueNet, this.advNet);

        // DOUBLE DQN: use online net to select action, target net to evaluate
        const qOnlineNext = this._getQ(exp.nextState, this.valueNet, this.advNet);
        const bestAction = argmax(qOnlineNext);
        const qTargetNext = this._getQ(exp.nextState, this.targetValueNet, this.targetAdvNet);

        const target = exp.reward + this.gamma * qTargetNext[bestAction];
        const tdError = target - qCurrent[exp.action];
        tdErrors.push(tdError);

        // Train both streams
        const vTarget = Float64Array.from([target - (qCurrent[exp.action] - this.valueNet.forward(exp.state)[0])]);
        this.valueNet.trainMSE(exp.state, vTarget);

        const advTarget = this.advNet.forward(exp.state);
        advTarget[exp.action] += HP.lr * tdError * weights[b];
        this.advNet.trainMSE(exp.state, advTarget);
      }

      this.buffer.updatePriorities(indices, tdErrors);
    }

    // Soft update target
    if (this.trainSteps % 20 === 0) {
      this.targetValueNet.softCopyFrom(this.valueNet, HP.tau);
      this.targetAdvNet.softCopyFrom(this.advNet, HP.tau);
    }

    const qValues = this._getQ(features, this.valueNet, this.advNet);
    let action;
    if (Math.random() < this.epsilon) {
      action = Math.floor(Math.random() * NUM_ACTIONS);
    } else {
      action = argmax(qValues);
    }

    this.signal = clamp((qValues[0] - qValues[2]) * 2, -1, 1);
    this.confidence = clamp(0.5 + (1 - this.epsilon) * 0.45, 0.3, 0.95);

    this.metrics = {
      V_s: this.valueNet.forward(features)[0].toFixed(3),
      advantage: (qValues[action] - qValues[1]).toFixed(3),
    };

    this.prevFeatures = new Float64Array(features);
    this.prevAction = action;
    this.lastAction = action;
    this.epsilon = Math.max(HP.epsilonEnd, this.epsilon * HP.epsilonDecay);
    this.trainSteps++;
  }

  predict(features) {
    return { signal: this.signal, confidence: this.confidence, action: this.lastAction };
  }
}
