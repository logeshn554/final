// ═══════════════════════════════════════════════════════
// MODEL-BASED ALGORITHMS (22-25)
// Model-Based RL, POMDP, Offline RL, Imitation Learning
// ═══════════════════════════════════════════════════════

import { BaseAlgorithm } from './base.js';
import { NeuralNet, ReplayBuffer } from '../utils/nn.js';
import {
  rnd, clamp, mean, std, softmax, argmax, randn, sampleCategorical
} from '../utils/math.js';
import { NUM_ACTIONS, HYPERPARAMS, FEATURE_DIM } from '../config.js';

const HP = HYPERPARAMS;

// ─────────────────────────────────────────────────────
// 22. MODEL-BASED RL — Learned dynamics + MPC planning
// ─────────────────────────────────────────────────────
export class ModelBasedRLAlgo extends BaseAlgorithm {
  constructor() {
    super(22);
    // Dynamics model: f(s, a) → s'
    this.dynamicsNet = new NeuralNet([
      { in: FEATURE_DIM + 1, out: HP.hiddenSize1, act: 'relu' },
      { in: HP.hiddenSize1, out: HP.hiddenSize2, act: 'relu' },
      { in: HP.hiddenSize2, out: FEATURE_DIM, act: 'linear' },
    ]);
    // Reward model: r(s, a) → R
    this.rewardNet = new NeuralNet([
      { in: FEATURE_DIM + 1, out: HP.hiddenSize1, act: 'relu' },
      { in: HP.hiddenSize1, out: 1, act: 'linear' },
    ]);
    this.buffer = new ReplayBuffer(HP.bufferSize);
    this.gamma = HP.gamma;
    this.planHorizon = 5;
    this.numRollouts = 8;
    this.prevFeatures = null;
    this.prevAction = 0;
    this.modelLoss = 0;
    this.trajectories = [];
  }

  _stateAction(features, action) {
    const sa = new Float64Array(FEATURE_DIM + 1);
    sa.set(features instanceof Float64Array ? features : Float64Array.from(features));
    sa[FEATURE_DIM] = (action - 1); // Normalize action to [-1, 0, 1]
    return sa;
  }

  update(features, reward) {
    if (this.prevFeatures) {
      this.buffer.add(
        Array.from(this.prevFeatures), this.prevAction, reward, Array.from(features), false
      );
    }

    // Train dynamics and reward models
    if (this.buffer.size >= HP.minBufferSize && this.trainSteps % 3 === 0) {
      const batch = this.buffer.sample(HP.batchSize);
      let totalLoss = 0;
      for (const exp of batch) {
        const sa = this._stateAction(exp.state, exp.action);
        totalLoss += this.dynamicsNet.trainMSE(sa, Float64Array.from(exp.nextState));
        this.rewardNet.trainMSE(sa, Float64Array.from([exp.reward]));
      }
      this.modelLoss = totalLoss / batch.length;
    }

    // MPC Planning: evaluate each action via model rollouts
    const actionReturns = [0, 0, 0]; // BUY, HOLD, SELL
    this.trajectories = [];

    for (let a = 0; a < NUM_ACTIONS; a++) {
      let totalReturn = 0;
      for (let r = 0; r < this.numRollouts; r++) {
        let state = new Float64Array(features);
        let cumReward = 0;
        let discount = 1;
        const traj = [state[0]]; // Track first feature for viz

        for (let t = 0; t < this.planHorizon; t++) {
          // Random shooting: random actions after first
          const actIdx = t === 0 ? a : Math.floor(Math.random() * NUM_ACTIONS);
          const sa = this._stateAction(state, actIdx);

          // Predict next state and reward
          const nextState = this.dynamicsNet.forward(sa);
          const reward = this.rewardNet.forward(sa)[0];

          cumReward += discount * reward;
          discount *= this.gamma;
          state = nextState;
          traj.push(state[0]);
        }
        totalReturn += cumReward;
        if (a === argmax(actionReturns.length > 0 ? actionReturns : [0])) {
          this.trajectories.push(traj);
        }
      }
      actionReturns[a] = totalReturn / this.numRollouts;
    }

    const bestAction = argmax(actionReturns);
    const buyAdv = actionReturns[0] - actionReturns[1];
    const sellAdv = actionReturns[2] - actionReturns[1];

    this.signal = clamp((buyAdv - sellAdv) * 5, -1, 1);
    this.confidence = clamp(0.4 + (1 - this.modelLoss) * 0.5, 0.3, 0.95);
    this.lastAction = bestAction;

    this.metrics = {
      modelLoss: this.modelLoss.toFixed(5),
      horizon: this.planHorizon,
      rollouts: this.numRollouts,
      bestAction: ['BUY', 'HOLD', 'SELL'][bestAction],
    };

    this.prevFeatures = new Float64Array(features);
    this.prevAction = bestAction;
    this.trainSteps++;
  }

  predict(features) {
    return { signal: this.signal, confidence: this.confidence, action: this.lastAction };
  }
}


// ─────────────────────────────────────────────────────
// 23. POMDP — Partial Observability with belief tracking
// ─────────────────────────────────────────────────────
export class POMDPAlgo extends BaseAlgorithm {
  constructor() {
    super(23);
    // Hidden states: [accumulation, distribution, ranging, breakout]
    this.numHiddenStates = 4;
    this.belief = new Float64Array([0.3, 0.2, 0.35, 0.15]);

    // Transition model between hidden states
    this.T = [
      [0.85, 0.05, 0.07, 0.03], // From accumulation
      [0.04, 0.82, 0.08, 0.06], // From distribution
      [0.06, 0.06, 0.80, 0.08], // From ranging
      [0.10, 0.10, 0.15, 0.65], // From breakout
    ];

    // Action preferences per hidden state (BUY, HOLD, SELL)
    this.stateActionPrefs = [
      [0.7, 0.2, 0.1],  // Accumulation → BUY
      [0.1, 0.2, 0.7],  // Distribution → SELL
      [0.2, 0.6, 0.2],  // Ranging → HOLD
      [0.5, 0.1, 0.4],  // Breakout → momentum
    ];

    // Q-network conditioned on belief
    this.qNet = new NeuralNet([
      { in: FEATURE_DIM + this.numHiddenStates, out: HP.hiddenSize1, act: 'relu' },
      { in: HP.hiddenSize1, out: NUM_ACTIONS, act: 'linear' },
    ]);
    this.buffer = new ReplayBuffer(HP.bufferSize);
    this.gamma = HP.gamma;
    this.prevBeliefFeatures = null;
    this.prevAction = 1;
  }

  _observationLikelihood(features) {
    // P(observation | hidden state)
    const ret = features[0]; // 1-bar return
    const vol = features[4]; // volatility
    const rsi = features[5]; // RSI

    return [
      Math.exp(-0.5 * ((ret - 0.1) / 0.3) ** 2) * Math.exp(-0.5 * ((rsi + 0.3) / 0.4) ** 2), // Accumulation
      Math.exp(-0.5 * ((ret + 0.1) / 0.3) ** 2) * Math.exp(-0.5 * ((rsi - 0.3) / 0.4) ** 2), // Distribution
      Math.exp(-0.5 * (ret / 0.2) ** 2) * Math.exp(-0.5 * (vol / 0.3) ** 2),                    // Ranging
      Math.exp(-0.5 * ((Math.abs(ret) - 0.5) / 0.4) ** 2) * Math.exp(-0.5 * ((vol - 0.5) / 0.3) ** 2), // Breakout
    ];
  }

  update(features, reward) {
    // Bayesian belief update
    const likelihoods = this._observationLikelihood(features);

    // Predict step: b'(s') = Σ_s T(s'|s) · b(s)
    const predicted = new Float64Array(this.numHiddenStates);
    for (let sp = 0; sp < this.numHiddenStates; sp++) {
      for (let s = 0; s < this.numHiddenStates; s++) {
        predicted[sp] += this.T[s][sp] * this.belief[s];
      }
    }

    // Update step: b(s) ∝ O(o|s) · b'(s)
    let total = 0;
    for (let s = 0; s < this.numHiddenStates; s++) {
      this.belief[s] = predicted[s] * likelihoods[s];
      total += this.belief[s];
    }
    for (let s = 0; s < this.numHiddenStates; s++) {
      this.belief[s] = Math.max(0.01, this.belief[s] / (total || 1));
    }

    // Q-learning with belief-augmented state
    const beliefFeatures = new Float64Array(FEATURE_DIM + this.numHiddenStates);
    beliefFeatures.set(features);
    for (let i = 0; i < this.numHiddenStates; i++) {
      beliefFeatures[FEATURE_DIM + i] = this.belief[i];
    }

    if (this.prevBeliefFeatures) {
      this.buffer.add(
        Array.from(this.prevBeliefFeatures), this.prevAction, reward,
        Array.from(beliefFeatures), false
      );
    }

    // Train Q-net
    if (this.buffer.size >= HP.minBufferSize && this.trainSteps % 3 === 0) {
      const batch = this.buffer.sample(HP.batchSize);
      for (const exp of batch) {
        const qNext = this.qNet.forward(exp.nextState);
        const maxQ = Math.max(...qNext);
        const target = this.qNet.forward(exp.state);
        target[exp.action] = exp.reward + this.gamma * maxQ;
        this.qNet.trainHuber(exp.state, target);
      }
    }

    // Action from belief-weighted preferences + Q-values
    const qValues = this.qNet.forward(beliefFeatures);
    let action = argmax(Array.from(qValues));

    // Blend with belief-weighted action preferences
    const beliefAction = [0, 0, 0];
    for (let s = 0; s < this.numHiddenStates; s++) {
      for (let a = 0; a < NUM_ACTIONS; a++) {
        beliefAction[a] += this.belief[s] * this.stateActionPrefs[s][a];
      }
    }

    const blendedSignal = (beliefAction[0] - beliefAction[2]) * 0.4 + (qValues[0] - qValues[2]) * 0.6;
    this.signal = clamp(blendedSignal, -1, 1);
    this.confidence = clamp(0.5 + Math.max(...Array.from(this.belief)) * 0.4, 0.3, 0.95);
    this.lastAction = action;

    this.metrics = {
      belief: Array.from(this.belief).map(b => (b * 100).toFixed(0) + '%').join('/'),
      dominant: ['Accum', 'Dist', 'Range', 'Break'][argmax(Array.from(this.belief))],
    };

    this.prevBeliefFeatures = new Float64Array(beliefFeatures);
    this.prevAction = action;
    this.trainSteps++;
  }

  predict(features) {
    return { signal: this.signal, confidence: this.confidence, action: this.lastAction };
  }
}


// ─────────────────────────────────────────────────────
// 24. OFFLINE RL — Conservative Q-Learning (CQL)
// ─────────────────────────────────────────────────────
export class OfflineRLAlgo extends BaseAlgorithm {
  constructor() {
    super(24);
    this.qNet = new NeuralNet([
      { in: FEATURE_DIM, out: HP.hiddenSize1, act: 'relu' },
      { in: HP.hiddenSize1, out: HP.hiddenSize2, act: 'relu' },
      { in: HP.hiddenSize2, out: NUM_ACTIONS, act: 'linear' },
    ]);
    // Fixed dataset (historical experiences)
    this.offlineBuffer = new ReplayBuffer(5000);
    this.gamma = HP.gamma;
    this.cqlAlpha = 1.0; // CQL penalty coefficient
    this.prevFeatures = null;
    this.prevAction = 1;
    this.cqlPenalty = 0;
    this.isWarmingUp = true;
    this.warmupSteps = 50;
  }

  update(features, reward) {
    // Always collect data into offline buffer
    if (this.prevFeatures) {
      this.offlineBuffer.add(
        Array.from(this.prevFeatures), this.prevAction, reward, Array.from(features), false
      );
    }

    if (this.offlineBuffer.size < HP.minBufferSize) {
      this.prevFeatures = new Float64Array(features);
      this.prevAction = 1;
      this.trainSteps++;
      return;
    }

    this.isWarmingUp = this.trainSteps < this.warmupSteps;

    // CQL: train only from offline buffer, with conservative penalty
    if (this.trainSteps % 2 === 0) {
      const batch = this.offlineBuffer.sample(HP.batchSize);
      let totalPenalty = 0;

      for (const exp of batch) {
        const qCurrent = this.qNet.forward(exp.state);
        const qNext = this.qNet.forward(exp.nextState);
        const maxQNext = Math.max(...qNext);

        // Standard TD target
        const target = new Float64Array(qCurrent);
        target[exp.action] = exp.reward + this.gamma * maxQNext;

        // CQL penalty: push down Q for all actions, push up for data actions
        // L_CQL = α × [log(Σ_a exp(Q(s,a))) - Q(s, a_data)]
        const logSumExp = Math.log(
          Array.from(qCurrent).reduce((s, q) => s + Math.exp(q), 0)
        );
        const cqlLoss = this.cqlAlpha * (logSumExp - qCurrent[exp.action]);
        totalPenalty += cqlLoss;

        // Apply conservative penalty to target
        for (let a = 0; a < NUM_ACTIONS; a++) {
          if (a !== exp.action) {
            target[a] = qCurrent[a] - this.cqlAlpha * 0.1; // Push down OOD actions
          }
        }

        this.qNet.trainHuber(exp.state, target);
      }
      this.cqlPenalty = totalPenalty / batch.length;
    }

    // Conservative action selection
    const qValues = this.qNet.forward(features);
    const action = argmax(Array.from(qValues));

    this.signal = clamp((qValues[0] - qValues[2]) * 1.5, -1, 1);
    this.confidence = clamp(0.4 + (1 - Math.abs(this.cqlPenalty) * 0.1), 0.3, 0.9);
    this.lastAction = action;

    this.metrics = {
      cqlPenalty: this.cqlPenalty.toFixed(4),
      dataSize: this.offlineBuffer.size,
      warming: this.isWarmingUp ? 'YES' : 'NO',
    };

    this.prevFeatures = new Float64Array(features);
    this.prevAction = action;
    this.trainSteps++;
  }

  predict(features) {
    return { signal: this.signal, confidence: this.confidence, action: this.lastAction };
  }
}


// ─────────────────────────────────────────────────────
// 25. IMITATION LEARNING — Behavioral Cloning + DAgger
// ─────────────────────────────────────────────────────
export class ImitationLearningAlgo extends BaseAlgorithm {
  constructor() {
    super(25);
    this.policyNet = new NeuralNet([
      { in: FEATURE_DIM, out: HP.hiddenSize1, act: 'relu' },
      { in: HP.hiddenSize1, out: HP.hiddenSize2, act: 'relu' },
      { in: HP.hiddenSize2, out: NUM_ACTIONS, act: 'linear' },
    ]);
    this.expertBuffer = []; // Expert demonstrations
    this.daggerBuffer = []; // DAgger corrections
    this.daggerBeta = 1.0;  // Expert mixing ratio
    this.prevFeatures = null;
    this.imitationLoss = 0;
  }

  /** Simple expert policy: trend-following + mean reversion */
  _expertPolicy(features) {
    const momentum = features[11];  // 10-bar momentum
    const rsi = features[5];        // RSI
    const bbPos = features[8];      // Bollinger %B
    const trendStr = features[13];  // Trend strength

    // Trend-following expert
    let score = 0;
    score += momentum * 1.5;      // Follow momentum
    score += trendStr * 1.0;       // Follow trend
    score -= rsi * 0.5;           // Overbought/oversold correction
    score -= bbPos * 0.3;         // Mean reversion component

    if (score > 0.3) return 0;     // BUY
    if (score < -0.3) return 2;    // SELL
    return 1;                       // HOLD
  }

  update(features, reward) {
    // Get expert action
    const expertAction = this._expertPolicy(features);

    // Collect expert demonstrations
    if (this.expertBuffer.length < 2000) {
      this.expertBuffer.push({
        features: Array.from(features),
        action: expertAction,
      });
    }

    // DAgger: collect corrected labels
    if (this.prevFeatures && Math.random() < this.daggerBeta) {
      this.daggerBuffer.push({
        features: Array.from(this.prevFeatures),
        action: expertAction, // Expert correction
      });
      if (this.daggerBuffer.length > 3000) this.daggerBuffer.shift();
    }

    // Train from combined dataset
    if (this.trainSteps % 2 === 0 && this.expertBuffer.length >= 30) {
      const dataset = [...this.expertBuffer.slice(-100), ...this.daggerBuffer.slice(-50)];
      let totalLoss = 0;
      const numSamples = Math.min(16, dataset.length);

      for (let i = 0; i < numSamples; i++) {
        const idx = Math.floor(Math.random() * dataset.length);
        const sample = dataset[idx];

        // Cross-entropy loss (behavioral cloning)
        const target = new Float64Array(NUM_ACTIONS);
        target[sample.action] = 1;
        totalLoss += this.policyNet.trainMSE(sample.features, target);
      }
      this.imitationLoss = totalLoss / numSamples;
    }

    // Get imitation policy action
    const logits = this.policyNet.forward(features);
    const probs = softmax(Array.from(logits));

    // Mix expert and learned policy (DAgger)
    let action;
    if (Math.random() < this.daggerBeta) {
      action = expertAction;
    } else {
      action = sampleCategorical(probs);
    }

    this.signal = clamp((probs[0] - probs[2]) * 2, -1, 1);
    this.confidence = clamp(0.5 + (1 - this.daggerBeta) * 0.4, 0.3, 0.9);
    this.lastAction = action;

    // Decay DAgger mixing ratio
    this.daggerBeta = Math.max(0.05, this.daggerBeta * 0.998);

    this.metrics = {
      expertMix: (this.daggerBeta * 100).toFixed(0) + '%',
      loss: this.imitationLoss.toFixed(5),
      demos: this.expertBuffer.length,
    };

    this.prevFeatures = new Float64Array(features);
    this.trainSteps++;
  }

  predict(features) {
    return { signal: this.signal, confidence: this.confidence, action: this.lastAction };
  }
}
