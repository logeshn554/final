// ═══════════════════════════════════════════════════════
// ADVANCED ALGORITHMS (26-34)
// Multi-Agent, Hierarchical, Distributional, Risk-Sensitive,
// Meta-RL, World Models, Multi-Objective, Safe RL, Transformer
// ═══════════════════════════════════════════════════════

import { BaseAlgorithm } from './base.js';
import { NeuralNet, ReplayBuffer } from '../utils/nn.js';
import {
  rnd, clamp, mean, std, softmax, argmax, randn, sigmoid,
  sampleCategorical, entropy, percentile, dot
} from '../utils/math.js';
import { NUM_ACTIONS, HYPERPARAMS, FEATURE_DIM } from '../config.js';

const HP = HYPERPARAMS;

// ─────────────────────────────────────────────────────
// 26. MULTI-AGENT RL — Multiple competing/cooperating agents
// ─────────────────────────────────────────────────────
export class MultiAgentRLAlgo extends BaseAlgorithm {
  constructor() {
    super(26);
    this.numAgents = 3;
    this.agents = [];
    for (let i = 0; i < this.numAgents; i++) {
      this.agents.push({
        net: new NeuralNet([
          { in: FEATURE_DIM + this.numAgents, out: HP.hiddenSize1, act: 'relu' },
          { in: HP.hiddenSize1, out: NUM_ACTIONS, act: 'linear' },
        ]),
        role: ['trend', 'reversal', 'momentum'][i],
        signal: 0,
        lastAction: 1,
      });
    }
    this.buffer = new ReplayBuffer(HP.bufferSize);
    this.gamma = HP.gamma;
    this.prevFeatures = null;
    this.communication = new Float64Array(this.numAgents);
  }

  update(features, reward) {
    // Each agent observes features + other agents' communications
    const augFeatures = new Float64Array(FEATURE_DIM + this.numAgents);
    augFeatures.set(features);
    for (let i = 0; i < this.numAgents; i++) {
      augFeatures[FEATURE_DIM + i] = this.communication[i];
    }

    // Reward shaping per agent role
    const rewards = [
      reward + features[11] * 0.3,   // Trend agent: bonus for momentum
      reward - features[11] * 0.2,   // Reversal: bonus for counter-trend
      reward + Math.abs(features[0]) * 0.4, // Momentum: bonus for big moves
    ];

    // Update each agent
    if (this.prevFeatures) {
      const prevAug = new Float64Array(FEATURE_DIM + this.numAgents);
      prevAug.set(this.prevFeatures);
      for (let i = 0; i < this.numAgents; i++) prevAug[FEATURE_DIM + i] = this.communication[i];

      for (let i = 0; i < this.numAgents; i++) {
        const qCurr = this.agents[i].net.forward(prevAug);
        const qNext = this.agents[i].net.forward(augFeatures);
        const maxQ = Math.max(...qNext);
        const target = new Float64Array(qCurr);
        target[this.agents[i].lastAction] = rewards[i] + this.gamma * maxQ;
        this.agents[i].net.trainHuber(prevAug, target);
      }
    }

    // Get actions and update communication
    let totalSignal = 0;
    for (let i = 0; i < this.numAgents; i++) {
      const qValues = this.agents[i].net.forward(augFeatures);
      const action = argmax(Array.from(qValues));
      const agentSignal = clamp((qValues[0] - qValues[2]) * 2, -1, 1);

      this.agents[i].signal = agentSignal;
      this.agents[i].lastAction = action;
      this.communication[i] = agentSignal;
      totalSignal += agentSignal;
    }

    // Consensus signal
    this.signal = clamp(totalSignal / this.numAgents, -1, 1);
    const agreement = 1 - std(this.agents.map(a => a.signal));
    this.confidence = clamp(0.4 + agreement * 0.5, 0.3, 0.95);
    this.lastAction = this.signal > 0.1 ? 0 : this.signal < -0.1 ? 2 : 1;

    this.metrics = {
      agents: this.agents.map(a => a.signal.toFixed(2)).join('/'),
      agreement: agreement.toFixed(2),
      roles: this.agents.map(a => a.role[0].toUpperCase()).join(','),
    };

    this.prevFeatures = new Float64Array(features);
    this.trainSteps++;
  }

  predict(features) {
    return { signal: this.signal, confidence: this.confidence, action: this.lastAction };
  }
}


// ─────────────────────────────────────────────────────
// 27. HIERARCHICAL RL — Options framework with goal hierarchy
// ─────────────────────────────────────────────────────
export class HierarchicalRLAlgo extends BaseAlgorithm {
  constructor() {
    super(27);
    // High-level policy: selects strategy/option
    this.numOptions = 3; // 0: trend_follow, 1: mean_revert, 2: breakout
    this.metaPolicy = new NeuralNet([
      { in: FEATURE_DIM, out: HP.hiddenSize1, act: 'relu' },
      { in: HP.hiddenSize1, out: this.numOptions, act: 'linear' },
    ]);

    // Low-level policies (one per option)
    this.subPolicies = [];
    for (let i = 0; i < this.numOptions; i++) {
      this.subPolicies.push(new NeuralNet([
        { in: FEATURE_DIM, out: HP.hiddenSize1, act: 'relu' },
        { in: HP.hiddenSize1, out: NUM_ACTIONS, act: 'linear' },
      ]));
    }

    this.currentOption = 0;
    this.optionDuration = 0;
    this.maxOptionDuration = 10;
    this.gamma = HP.gamma;
    this.prevFeatures = null;
    this.optionReward = 0;
  }

  update(features, reward) {
    this.optionReward += reward;
    this.optionDuration++;

    // Check option termination
    const shouldTerminate = this.optionDuration >= this.maxOptionDuration || Math.random() < 0.1;

    if (shouldTerminate) {
      // Update meta-policy
      if (this.prevFeatures) {
        const metaLogits = this.metaPolicy.forward(this.prevFeatures);
        const metaTarget = new Float64Array(metaLogits);
        metaTarget[this.currentOption] = this.optionReward;
        this.metaPolicy.trainMSE(this.prevFeatures, metaTarget);
      }

      // Select new option
      const metaLogits = this.metaPolicy.forward(features);
      const optionProbs = softmax(Array.from(metaLogits));
      this.currentOption = sampleCategorical(optionProbs);
      this.optionDuration = 0;
      this.optionReward = 0;
    }

    // Update current sub-policy
    if (this.prevFeatures) {
      const subPolicy = this.subPolicies[this.currentOption];
      const qCurr = subPolicy.forward(this.prevFeatures);
      const qNext = subPolicy.forward(features);
      const maxQ = Math.max(...qNext);
      const target = new Float64Array(qCurr);
      target[this.lastAction] = reward + this.gamma * maxQ;
      subPolicy.trainHuber(this.prevFeatures, target);
    }

    // Get action from current sub-policy
    const subLogits = this.subPolicies[this.currentOption].forward(features);
    const probs = softmax(Array.from(subLogits));
    const action = sampleCategorical(probs);

    this.signal = clamp((probs[0] - probs[2]) * 2, -1, 1);
    this.confidence = clamp(0.5 + Math.max(...probs) * 0.3, 0.3, 0.95);
    this.lastAction = action;

    this.metrics = {
      option: ['Trend', 'Revert', 'Break'][this.currentOption],
      duration: this.optionDuration,
      optReward: this.optionReward.toFixed(3),
    };

    this.prevFeatures = new Float64Array(features);
    this.trainSteps++;
  }

  predict(features) {
    return { signal: this.signal, confidence: this.confidence, action: this.lastAction };
  }
}


// ─────────────────────────────────────────────────────
// 28. DISTRIBUTIONAL RL — C51 (Categorical DQN)
// ─────────────────────────────────────────────────────
export class DistributionalRLAlgo extends BaseAlgorithm {
  constructor() {
    super(28);
    this.numAtoms = 21; // Smaller for efficiency
    this.vMin = -2;
    this.vMax = 2;
    this.deltaZ = (this.vMax - this.vMin) / (this.numAtoms - 1);
    this.supports = [];
    for (let i = 0; i < this.numAtoms; i++) {
      this.supports.push(this.vMin + i * this.deltaZ);
    }

    // One distribution net per action
    this.nets = [];
    for (let a = 0; a < NUM_ACTIONS; a++) {
      this.nets.push(new NeuralNet([
        { in: FEATURE_DIM, out: HP.hiddenSize1, act: 'relu' },
        { in: HP.hiddenSize1, out: this.numAtoms, act: 'linear' },
      ]));
    }

    this.buffer = new ReplayBuffer(HP.bufferSize);
    this.gamma = HP.gamma;
    this.prevFeatures = null;
    this.prevAction = 1;
    this.returnDist = [];
  }

  _getDistribution(features, actionIdx) {
    const logits = this.nets[actionIdx].forward(features);
    return softmax(Array.from(logits));
  }

  _expectedValue(dist) {
    let ev = 0;
    for (let i = 0; i < this.numAtoms; i++) ev += this.supports[i] * dist[i];
    return ev;
  }

  update(features, reward) {
    if (this.prevFeatures) {
      this.buffer.add(
        Array.from(this.prevFeatures), this.prevAction, reward, Array.from(features), false
      );
    }

    if (this.buffer.size >= HP.minBufferSize && this.trainSteps % 3 === 0) {
      const batch = this.buffer.sample(Math.min(HP.batchSize, 16));
      for (const exp of batch) {
        // Find best next action by expected value
        let bestNextAction = 0, bestEV = -Infinity;
        for (let a = 0; a < NUM_ACTIONS; a++) {
          const dist = this._getDistribution(exp.nextState, a);
          const ev = this._expectedValue(dist);
          if (ev > bestEV) { bestEV = ev; bestNextAction = a; }
        }

        // Project Bellman update onto support
        const nextDist = this._getDistribution(exp.nextState, bestNextAction);
        const projDist = new Float64Array(this.numAtoms);
        for (let j = 0; j < this.numAtoms; j++) {
          const tz = clamp(exp.reward + this.gamma * this.supports[j], this.vMin, this.vMax);
          const b = (tz - this.vMin) / this.deltaZ;
          const l = Math.floor(b);
          const u = Math.min(l + 1, this.numAtoms - 1);
          projDist[l] += nextDist[j] * (u - b);
          if (u < this.numAtoms) projDist[u] += nextDist[j] * (b - l);
        }

        // Cross-entropy loss to project distribution
        this.nets[exp.action].trainMSE(exp.state, projDist);
      }
    }

    // Get Q-distributions and expected values
    const evs = [];
    const dists = [];
    for (let a = 0; a < NUM_ACTIONS; a++) {
      const dist = this._getDistribution(features, a);
      dists.push(dist);
      evs.push(this._expectedValue(dist));
    }

    this.returnDist = dists[argmax(evs)]; // Store best action's distribution
    const action = argmax(evs);

    // Risk-aware signal: consider distribution shape
    const buyDist = dists[0];
    const sellDist = dists[2];
    const buyEV = evs[0], sellEV = evs[2];

    // Compute variance/skew of best distribution
    const bestDist = dists[action];
    const bestEV = evs[action];
    let variance = 0;
    for (let i = 0; i < this.numAtoms; i++) {
      variance += bestDist[i] * (this.supports[i] - bestEV) ** 2;
    }

    this.signal = clamp((buyEV - sellEV) * 2, -1, 1);
    this.confidence = clamp(0.5 + (1 / (1 + Math.sqrt(variance))) * 0.4, 0.3, 0.95);
    this.lastAction = action;

    this.metrics = {
      atoms: this.numAtoms,
      variance: variance.toFixed(4),
      EVs: evs.map(v => v.toFixed(3)).join('/'),
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
// 29. RISK-SENSITIVE RL — CVaR / Mean-Variance optimization
// ─────────────────────────────────────────────────────
export class RiskSensitiveRLAlgo extends BaseAlgorithm {
  constructor() {
    super(29);
    this.qNet = new NeuralNet([
      { in: FEATURE_DIM, out: HP.hiddenSize1, act: 'relu' },
      { in: HP.hiddenSize1, out: HP.hiddenSize2, act: 'relu' },
      { in: HP.hiddenSize2, out: NUM_ACTIONS, act: 'linear' },
    ]);
    this.buffer = new ReplayBuffer(HP.bufferSize);
    this.gamma = HP.gamma;
    this.riskAversion = 0.5; // λ in mean-variance
    this.cvarAlpha = 0.05;   // CVaR at 5%
    this.returnHistory = [[], [], []]; // Per-action return history
    this.prevFeatures = null;
    this.prevAction = 1;
    this.cvar = 0;
    this.var95 = 0;
  }

  update(features, reward) {
    // Track returns per action
    this.returnHistory[this.prevAction].push(reward);
    for (let a = 0; a < NUM_ACTIONS; a++) {
      if (this.returnHistory[a].length > 200) this.returnHistory[a].shift();
    }

    if (this.prevFeatures) {
      this.buffer.add(Array.from(this.prevFeatures), this.prevAction, reward, Array.from(features), false);
    }

    // Train Q-network with risk-adjusted targets
    if (this.buffer.size >= HP.minBufferSize && this.trainSteps % 2 === 0) {
      const batch = this.buffer.sample(HP.batchSize);
      for (const exp of batch) {
        const qNext = this.qNet.forward(exp.nextState);
        const maxQ = Math.max(...qNext);
        const target = this.qNet.forward(exp.state);

        // Risk-adjusted target: r - λ * variance_penalty
        const actionHistory = this.returnHistory[exp.action];
        const variancePenalty = actionHistory.length > 5 ? std(actionHistory) : 0;
        const riskAdjReward = exp.reward - this.riskAversion * variancePenalty;

        target[exp.action] = riskAdjReward + this.gamma * maxQ;
        this.qNet.trainHuber(exp.state, target);
      }
    }

    // Compute risk metrics
    const allReturns = this.returnHistory.flat();
    if (allReturns.length >= 10) {
      const sorted = [...allReturns].sort((a, b) => a - b);
      const cvarIdx = Math.ceil(allReturns.length * this.cvarAlpha);
      this.cvar = mean(sorted.slice(0, Math.max(1, cvarIdx)));
      this.var95 = percentile(allReturns, 5);
    }

    // Risk-aware action selection
    const qValues = this.qNet.forward(features);
    const riskAdjQ = Array.from(qValues).map((q, a) => {
      const hist = this.returnHistory[a];
      const vol = hist.length > 5 ? std(hist) : 0;
      return q - this.riskAversion * vol;
    });

    const action = argmax(riskAdjQ);

    this.signal = clamp((riskAdjQ[0] - riskAdjQ[2]) * 2, -1, 1);
    this.confidence = clamp(0.5 + (1 / (1 + Math.abs(this.cvar) * 5)) * 0.4, 0.3, 0.95);
    this.lastAction = action;

    this.metrics = {
      CVaR: this.cvar.toFixed(4),
      VaR95: this.var95.toFixed(4),
      riskAversion: this.riskAversion.toFixed(2),
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
// 30. META-RL — MAML-style fast adaptation
// ─────────────────────────────────────────────────────
export class MetaRLAlgo extends BaseAlgorithm {
  constructor() {
    super(30);
    this.metaNet = new NeuralNet([
      { in: FEATURE_DIM, out: HP.hiddenSize1, act: 'relu' },
      { in: HP.hiddenSize1, out: HP.hiddenSize2, act: 'relu' },
      { in: HP.hiddenSize2, out: NUM_ACTIONS, act: 'linear' },
    ]);
    this.fastNet = new NeuralNet([
      { in: FEATURE_DIM, out: HP.hiddenSize1, act: 'relu' },
      { in: HP.hiddenSize1, out: HP.hiddenSize2, act: 'relu' },
      { in: HP.hiddenSize2, out: NUM_ACTIONS, act: 'linear' },
    ]);
    this.fastNet.copyFrom(this.metaNet);

    this.innerLR = 0.01;
    this.outerLR = 0.001;
    this.innerSteps = 3;
    this.taskBuffer = []; // Current task experiences
    this.metaBuffer = []; // Cross-task buffer
    this.taskLength = 30;
    this.prevFeatures = null;
    this.prevAction = 1;
    this.adaptScore = 0;
  }

  update(features, reward) {
    this.taskBuffer.push({
      features: Array.from(features), action: this.prevAction, reward
    });

    // Inner loop: fast adaptation on current task
    if (this.taskBuffer.length >= 5 && this.trainSteps % 3 === 0) {
      // Reset fast net to meta parameters
      this.fastNet.copyFrom(this.metaNet);

      // Take innerSteps gradient steps on task data
      for (let step = 0; step < this.innerSteps; step++) {
        const idx = Math.floor(Math.random() * this.taskBuffer.length);
        const exp = this.taskBuffer[idx];

        const qValues = this.fastNet.forward(exp.features);
        const target = new Float64Array(qValues);
        target[exp.action] = exp.reward; // Simplified target
        this.fastNet.trainMSE(exp.features, target);
      }

      // Track adaptation quality
      const preFast = this.metaNet.forward(features);
      const postFast = this.fastNet.forward(features);
      this.adaptScore = Math.abs(postFast[argmax(Array.from(postFast))] - preFast[argmax(Array.from(preFast))]);
    }

    // Outer loop: update meta parameters
    if (this.taskBuffer.length >= this.taskLength) {
      // Meta-gradient: how well does adapted policy perform on held-out data?
      const heldOut = this.taskBuffer.slice(-5);
      for (const exp of heldOut) {
        const qFast = this.fastNet.forward(exp.features);
        const target = new Float64Array(qFast);
        target[exp.action] = exp.reward;
        // Update meta network toward adapted parameters
        this.metaNet.trainMSE(exp.features, target);
      }

      // Start new "task"
      this.metaBuffer.push(...this.taskBuffer);
      if (this.metaBuffer.length > 3000) this.metaBuffer.splice(0, this.metaBuffer.length - 3000);
      this.taskBuffer = [];
    }

    const qValues = this.fastNet.forward(features);
    const action = argmax(Array.from(qValues));

    this.signal = clamp((qValues[0] - qValues[2]) * 2, -1, 1);
    this.confidence = clamp(0.4 + this.adaptScore * 5, 0.3, 0.95);
    this.lastAction = action;

    this.metrics = {
      adaptScore: (this.adaptScore * 100).toFixed(0) + '%',
      innerSteps: this.innerSteps,
      taskProgress: `${this.taskBuffer.length}/${this.taskLength}`,
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
// 31. WORLD MODELS — Dreamer-style VAE + RNN + Controller
// ─────────────────────────────────────────────────────
export class WorldModelsAlgo extends BaseAlgorithm {
  constructor() {
    super(31);
    // Encoder: features → latent
    this.encoder = new NeuralNet([
      { in: FEATURE_DIM, out: HP.hiddenSize1, act: 'relu' },
      { in: HP.hiddenSize1, out: 8, act: 'linear' }, // latent dim = 8
    ]);
    // Dynamics: (latent, action) → next_latent
    this.dynamics = new NeuralNet([
      { in: 8 + 1, out: HP.hiddenSize1, act: 'relu' },
      { in: HP.hiddenSize1, out: 8, act: 'linear' },
    ]);
    // Reward predictor: latent → reward
    this.rewardPredictor = new NeuralNet([
      { in: 8, out: HP.hiddenSize2, act: 'relu' },
      { in: HP.hiddenSize2, out: 1, act: 'linear' },
    ]);
    // Controller: latent → action
    this.controller = new NeuralNet([
      { in: 8, out: HP.hiddenSize2, act: 'relu' },
      { in: HP.hiddenSize2, out: NUM_ACTIONS, act: 'linear' },
    ]);

    this.buffer = new ReplayBuffer(HP.bufferSize);
    this.gamma = HP.gamma;
    this.planHorizon = 5;
    this.numRollouts = 8;
    this.prevFeatures = null;
    this.prevAction = 0;
    this.trajectories = [];
    this.dreamReward = 0;
  }

  update(features, reward) {
    if (this.prevFeatures) {
      this.buffer.add(Array.from(this.prevFeatures), this.prevAction, reward, Array.from(features), false);
    }

    // Train world model components
    if (this.buffer.size >= HP.minBufferSize && this.trainSteps % 3 === 0) {
      const batch = this.buffer.sample(Math.min(HP.batchSize, 16));
      for (const exp of batch) {
        // Train encoder (auto-encoding objective, simplified)
        const latent = this.encoder.forward(exp.state);
        const nextLatent = this.encoder.forward(exp.nextState);

        // Train dynamics
        const latentAction = new Float64Array(9);
        latentAction.set(latent);
        latentAction[8] = (exp.action - 1); // Normalize
        this.dynamics.trainMSE(latentAction, nextLatent);

        // Train reward predictor
        this.rewardPredictor.trainMSE(latent, Float64Array.from([exp.reward]));
      }
    }

    // DREAMING: plan in latent space
    const currentLatent = this.encoder.forward(features);
    let bestAction = 1;
    let bestReturn = -Infinity;
    this.trajectories = [];

    for (let a = 0; a < NUM_ACTIONS; a++) {
      let totalReturn = 0;
      for (let r = 0; r < this.numRollouts; r++) {
        let latent = new Float64Array(currentLatent);
        let cumReward = 0;
        let discount = 1;

        for (let t = 0; t < this.planHorizon; t++) {
          const actionIdx = t === 0 ? a : argmax(Array.from(this.controller.forward(latent)));
          const latentAction = new Float64Array(9);
          latentAction.set(latent);
          latentAction[8] = (actionIdx - 1);

          latent = this.dynamics.forward(latentAction);
          const predictedReward = this.rewardPredictor.forward(latent)[0];
          cumReward += discount * predictedReward;
          discount *= this.gamma;
        }
        totalReturn += cumReward;
      }
      totalReturn /= this.numRollouts;
      if (totalReturn > bestReturn) { bestReturn = totalReturn; bestAction = a; }
    }

    this.dreamReward = bestReturn;

    // Update controller from dreamed experiences
    const controllerLogits = this.controller.forward(currentLatent);
    const target = new Float64Array(controllerLogits);
    target[bestAction] = bestReturn;
    this.controller.trainMSE(currentLatent, target);

    this.signal = bestAction === 0 ? clamp(bestReturn * 3, 0.1, 1)
               : bestAction === 2 ? clamp(-bestReturn * 3, -1, -0.1)
               : 0;
    this.confidence = clamp(0.4 + Math.abs(bestReturn) * 2, 0.3, 0.95);
    this.lastAction = bestAction;

    this.metrics = {
      dreamReward: this.dreamReward.toFixed(4),
      horizon: this.planHorizon,
      latentDim: 8,
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
// 32. MULTI-OBJECTIVE RL — Pareto-optimal policy selection
// ─────────────────────────────────────────────────────
export class MultiObjectiveRLAlgo extends BaseAlgorithm {
  constructor() {
    super(32);
    this.numObjectives = 4; // return, risk, sharpe, turnover
    // One Q-network per objective
    this.qNets = [];
    for (let i = 0; i < this.numObjectives; i++) {
      this.qNets.push(new NeuralNet([
        { in: FEATURE_DIM, out: HP.hiddenSize1, act: 'relu' },
        { in: HP.hiddenSize1, out: NUM_ACTIONS, act: 'linear' },
      ]));
    }
    this.weights = [0.4, 0.2, 0.3, 0.1]; // Preference weights
    this.gamma = HP.gamma;
    this.buffer = new ReplayBuffer(HP.bufferSize);
    this.prevFeatures = null;
    this.prevAction = 1;
    this.objectiveScores = [0, 0, 0, 0];
    this.returnHistory = [];
  }

  _computeObjectiveRewards(reward, features) {
    this.returnHistory.push(reward);
    if (this.returnHistory.length > 100) this.returnHistory.shift();

    const vol = this.returnHistory.length > 5 ? std(this.returnHistory) : 0.01;
    const avgRet = mean(this.returnHistory);
    const sharpe = vol > 0 ? avgRet / vol : 0;

    return [
      reward,                           // Return objective
      -Math.abs(reward) * vol,          // Risk objective (minimize)
      sharpe * 0.1,                     // Sharpe objective
      this.prevAction !== this.lastAction ? -0.05 : 0, // Turnover penalty
    ];
  }

  update(features, reward) {
    const objRewards = this._computeObjectiveRewards(reward, features);

    if (this.prevFeatures) {
      this.buffer.add(
        Array.from(this.prevFeatures), this.prevAction, reward, Array.from(features), false
      );

      // Train each objective Q-network
      if (this.buffer.size >= HP.minBufferSize && this.trainSteps % 3 === 0) {
        const batch = this.buffer.sample(Math.min(HP.batchSize, 16));
        for (let obj = 0; obj < this.numObjectives; obj++) {
          for (const exp of batch) {
            const qCurr = this.qNets[obj].forward(exp.state);
            const qNext = this.qNets[obj].forward(exp.nextState);
            const maxQ = Math.max(...qNext);
            const target = new Float64Array(qCurr);
            const objR = this._computeObjectiveRewards(exp.reward, exp.state)[obj];
            target[exp.action] = objR + this.gamma * maxQ;
            this.qNets[obj].trainMSE(exp.state, target);
          }
        }
      }
    }

    // Scalarized Q-values with preference weights
    const scalarizedQ = new Float64Array(NUM_ACTIONS);
    for (let a = 0; a < NUM_ACTIONS; a++) {
      for (let obj = 0; obj < this.numObjectives; obj++) {
        const q = this.qNets[obj].forward(features)[a];
        scalarizedQ[a] += this.weights[obj] * q;
        if (a === 0) this.objectiveScores[obj] = q;
      }
    }

    const action = argmax(Array.from(scalarizedQ));

    this.signal = clamp((scalarizedQ[0] - scalarizedQ[2]) * 3, -1, 1);
    this.confidence = clamp(0.5 + Math.abs(scalarizedQ[action]) * 0.3, 0.3, 0.95);
    this.lastAction = action;

    this.metrics = {
      objectives: this.objectiveScores.map(s => s.toFixed(3)).join('/'),
      weights: this.weights.map(w => w.toFixed(1)).join('/'),
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
// 33. SAFE RL — Constrained MDP with Lagrangian relaxation
// ─────────────────────────────────────────────────────
export class SafeRLAlgo extends BaseAlgorithm {
  constructor() {
    super(33);
    this.policyNet = new NeuralNet([
      { in: FEATURE_DIM, out: HP.hiddenSize1, act: 'relu' },
      { in: HP.hiddenSize1, out: HP.hiddenSize2, act: 'relu' },
      { in: HP.hiddenSize2, out: NUM_ACTIONS, act: 'linear' },
    ]);
    this.safetyNet = new NeuralNet([
      { in: FEATURE_DIM, out: HP.hiddenSize1, act: 'relu' },
      { in: HP.hiddenSize1, out: NUM_ACTIONS, act: 'linear' }, // Cost Q-values
    ]);
    this.gamma = HP.gamma;
    this.lagrangian = 0.3;  // Lagrange multiplier
    this.lagrangianLR = 0.005;
    this.costThreshold = 0.1; // Maximum allowed average cost
    this.costBuffer = [];
    this.buffer = new ReplayBuffer(HP.bufferSize);
    this.prevFeatures = null;
    this.prevAction = 1;
    this.safetyScore = 0.95;
    this.constraintViolated = false;
  }

  _computeCost(features, action) {
    // Cost = 1 if constraint violated, 0 otherwise
    const position = features[14]; // Normalized position
    const drawdown = features[15]; // Unrealized PnL
    const volatility = features[4]; // Volatility

    let cost = 0;
    if (Math.abs(position) > 0.8) cost += 0.3;        // Position too large
    if (drawdown < -0.3) cost += 0.4;                  // Drawdown too deep
    if (volatility > 0.3 && action !== 1) cost += 0.3; // Trading in high vol
    return clamp(cost, 0, 1);
  }

  update(features, reward) {
    const cost = this._computeCost(features, this.prevAction);
    this.costBuffer.push(cost);
    if (this.costBuffer.length > 200) this.costBuffer.shift();

    if (this.prevFeatures) {
      this.buffer.add(Array.from(this.prevFeatures), this.prevAction, reward, Array.from(features), false);
    }

    // Train policy and safety critic
    if (this.buffer.size >= HP.minBufferSize && this.trainSteps % 2 === 0) {
      const batch = this.buffer.sample(HP.batchSize);
      for (const exp of batch) {
        const expCost = this._computeCost(exp.nextState, exp.action);

        // Safety critic update
        const costQ = this.safetyNet.forward(exp.state);
        const costQNext = this.safetyNet.forward(exp.nextState);
        const costTarget = new Float64Array(costQ);
        costTarget[exp.action] = expCost + this.gamma * Math.max(...costQNext);
        this.safetyNet.trainMSE(exp.state, costTarget);

        // Lagrangian-augmented reward: r - λ * cost
        const augReward = exp.reward - this.lagrangian * expCost;
        const qCurr = this.policyNet.forward(exp.state);
        const qNext = this.policyNet.forward(exp.nextState);
        const target = new Float64Array(qCurr);
        target[exp.action] = augReward + this.gamma * Math.max(...qNext);
        this.policyNet.trainHuber(exp.state, target);
      }
    }

    // Update Lagrange multiplier (dual ascent)
    const avgCost = this.costBuffer.length > 0 ? mean(this.costBuffer) : 0;
    this.lagrangian = Math.max(0, this.lagrangian + this.lagrangianLR * (avgCost - this.costThreshold));
    this.constraintViolated = avgCost > this.costThreshold;
    this.safetyScore = clamp(1 - avgCost, 0, 1);

    // Safe action selection: reject unsafe actions
    const qValues = this.policyNet.forward(features);
    const costQValues = this.safetyNet.forward(features);
    const safeQ = Array.from(qValues).map((q, a) => q - this.lagrangian * costQValues[a]);
    const action = argmax(safeQ);

    this.signal = clamp((safeQ[0] - safeQ[2]) * 2, -1, 1);
    // Reduce signal if constraint violated
    if (this.constraintViolated) this.signal *= 0.3;
    this.confidence = clamp(this.safetyScore, 0.3, 0.95);
    this.lastAction = action;

    this.metrics = {
      safetyScore: (this.safetyScore * 100).toFixed(1) + '%',
      lagrangian: this.lagrangian.toFixed(3),
      constraint: this.constraintViolated ? 'VIOLATED' : 'OK',
      avgCost: avgCost.toFixed(3),
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
// 34. TRANSFORMER RL — Self-attention Decision Transformer
// ─────────────────────────────────────────────────────
export class TransformerRLAlgo extends BaseAlgorithm {
  constructor() {
    super(34);
    this.seqLen = 10; // Context window
    this.dModel = 16; // Embedding dimension
    this.numHeads = 2;

    // Input embedding: (features, action, reward) → dModel
    this.stateEmbed = new NeuralNet([
      { in: FEATURE_DIM, out: this.dModel, act: 'relu' },
    ]);
    this.actionEmbed = new NeuralNet([
      { in: NUM_ACTIONS, out: this.dModel, act: 'relu' },
    ]);
    this.returnEmbed = new NeuralNet([
      { in: 1, out: this.dModel, act: 'relu' },
    ]);

    // Simplified transformer: single attention layer + output
    this.queryNet = new NeuralNet([
      { in: this.dModel, out: this.dModel, act: 'linear' },
    ]);
    this.keyNet = new NeuralNet([
      { in: this.dModel, out: this.dModel, act: 'linear' },
    ]);
    this.valueNet = new NeuralNet([
      { in: this.dModel, out: this.dModel, act: 'linear' },
    ]);

    // Output head
    this.outputNet = new NeuralNet([
      { in: this.dModel, out: HP.hiddenSize2, act: 'relu' },
      { in: HP.hiddenSize2, out: NUM_ACTIONS, act: 'linear' },
    ]);

    this.context = []; // Sequence of (state_embed, action_one_hot, return_to_go)
    this.targetReturn = 0.5; // Desired return to condition on
    this.buffer = new ReplayBuffer(HP.bufferSize);
    this.prevFeatures = null;
    this.prevAction = 1;
    this.attentionWeights = [];
  }

  _oneHot(action) {
    const oh = new Float64Array(NUM_ACTIONS);
    oh[action] = 1;
    return oh;
  }

  _selfAttention(embeddings) {
    // Simplified multi-head self-attention
    const n = embeddings.length;
    if (n === 0) return new Float64Array(this.dModel);

    // Compute Q, K, V for last position (we only need output for current step)
    const lastEmbed = embeddings[n - 1];
    const query = this.queryNet.forward(lastEmbed);

    let weightedSum = new Float64Array(this.dModel);
    let totalWeight = 0;
    this.attentionWeights = [];

    for (let i = 0; i < n; i++) {
      const key = this.keyNet.forward(embeddings[i]);
      const value = this.valueNet.forward(embeddings[i]);

      // Scaled dot-product attention
      let score = 0;
      for (let d = 0; d < this.dModel; d++) score += query[d] * key[d];
      score /= Math.sqrt(this.dModel);

      // Causal mask (already satisfied since we use sequence order)
      const weight = Math.exp(score);
      totalWeight += weight;
      this.attentionWeights.push(weight);

      for (let d = 0; d < this.dModel; d++) {
        weightedSum[d] += weight * value[d];
      }
    }

    // Normalize
    if (totalWeight > 0) {
      for (let d = 0; d < this.dModel; d++) weightedSum[d] /= totalWeight;
    }

    // Normalize attention weights for display
    this.attentionWeights = this.attentionWeights.map(w => w / totalWeight);

    return weightedSum;
  }

  update(features, reward) {
    // Embed current state
    const stateE = this.stateEmbed.forward(features);
    const actionE = this.actionEmbed.forward(this._oneHot(this.prevAction));
    const returnE = this.returnEmbed.forward(Float64Array.from([this.targetReturn]));

    // Combined embedding (simplified: sum)
    const combined = new Float64Array(this.dModel);
    for (let d = 0; d < this.dModel; d++) {
      combined[d] = stateE[d] + actionE[d] + returnE[d];
    }

    this.context.push(combined);
    if (this.context.length > this.seqLen) this.context.shift();

    // Self-attention over context
    const attended = this._selfAttention(this.context);

    // Predict action
    const actionLogits = this.outputNet.forward(attended);
    const probs = softmax(Array.from(actionLogits));
    const action = sampleCategorical(probs);

    // Update target return (adaptive)
    this.targetReturn = clamp(this.targetReturn * 0.99 + reward * 0.01, -1, 2);

    // Train output head
    if (this.prevFeatures && this.context.length >= 3) {
      const attended2 = this._selfAttention(this.context.slice(0, -1));
      const target = new Float64Array(NUM_ACTIONS);
      target[this.prevAction] = reward > 0 ? 1 : 0;
      this.outputNet.trainMSE(attended2, target);
    }

    this.signal = clamp((probs[0] - probs[2]) * 2, -1, 1);
    this.confidence = clamp(Math.max(...probs) * 1.2, 0.3, 0.95);
    this.lastAction = action;

    this.metrics = {
      seqLen: this.context.length,
      targetReturn: this.targetReturn.toFixed(3),
      attention: this.attentionWeights.length > 0
        ? this.attentionWeights.slice(-3).map(w => w.toFixed(2)).join('/')
        : 'N/A',
    };

    this.prevFeatures = new Float64Array(features);
    this.prevAction = action;
    this.trainSteps++;
  }

  predict(features) {
    return { signal: this.signal, confidence: this.confidence, action: this.lastAction };
  }
}
