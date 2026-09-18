// ═══════════════════════════════════════════════════════
// POLICY-BASED ALGORITHMS (14-21)
// Policy Gradient, Actor-Critic, A2C/A3C, GAE,
// PPO, DDPG, TD3, SAC
// ═══════════════════════════════════════════════════════

import { BaseAlgorithm } from './base.js';
import { NeuralNet, ReplayBuffer, OUNoise } from '../utils/nn.js';
import {
  rnd, clamp, mean, std, softmax, argmax, sigmoid, randn,
  sampleCategorical, entropy, dot
} from '../utils/math.js';
import { NUM_ACTIONS, HYPERPARAMS, FEATURE_DIM } from '../config.js';

const HP = HYPERPARAMS;

// ─────────────────────────────────────────────────────
// 14. POLICY GRADIENT — REINFORCE with baseline
// ─────────────────────────────────────────────────────
export class PolicyGradientAlgo extends BaseAlgorithm {
  constructor() {
    super(14);
    this.policyNet = new NeuralNet([
      { in: FEATURE_DIM, out: HP.hiddenSize1, act: 'relu' },
      { in: HP.hiddenSize1, out: HP.hiddenSize2, act: 'relu' },
      { in: HP.hiddenSize2, out: NUM_ACTIONS, act: 'linear' },
    ]);
    this.baseline = 0; // Running average of returns
    this.trajectory = []; // {features, action, reward, logProb}
    this.gamma = HP.gamma;
    this.batchSize = 16;
    this.avgReturn = 0;
  }

  _getPolicy(features) {
    const logits = this.policyNet.forward(features);
    return softmax(Array.from(logits));
  }

  update(features, reward) {
    const probs = this._getPolicy(features);
    const action = sampleCategorical(probs);
    const logProb = Math.log(probs[action] + 1e-8);

    this.trajectory.push({ features: new Float64Array(features), action, reward, logProb });

    // REINFORCE update when batch is ready
    if (this.trajectory.length >= this.batchSize) {
      // Compute returns
      let G = 0;
      const returns = new Array(this.trajectory.length);
      for (let t = this.trajectory.length - 1; t >= 0; t--) {
        G = this.trajectory[t].reward + this.gamma * G;
        returns[t] = G;
      }

      this.baseline = mean(returns);

      // Policy gradient: ∇J = E[∇log π(a|s) · (G - b)]
      for (let t = 0; t < this.trajectory.length; t++) {
        const { features: f, action: a } = this.trajectory[t];
        const advantage = returns[t] - this.baseline;

        // Create gradient: for chosen action, -advantage (we want to maximize)
        const probs = this._getPolicy(f);
        const grad = new Float64Array(NUM_ACTIONS);
        for (let i = 0; i < NUM_ACTIONS; i++) {
          grad[i] = probs[i];
          if (i === a) grad[i] -= 1;
        }
        for (let i = 0; i < NUM_ACTIONS; i++) grad[i] *= advantage;

        this.policyNet.forward(f);
        this.policyNet.backward(grad);
        this.policyNet.update(HP.lr * 2);
      }

      this.avgReturn = this.baseline;
      this.trajectory = [];
    }

    this.signal = clamp((probs[0] - probs[2]) * 2, -1, 1);
    this.confidence = clamp(Math.max(...probs) * 1.2, 0.3, 0.95);
    this.lastAction = action;

    this.metrics = {
      baseline: this.baseline.toFixed(4),
      entropy: entropy(probs).toFixed(3),
      probs: probs.map(p => p.toFixed(2)).join('/'),
    };
    this.trainSteps++;
  }

  predict(features) {
    return { signal: this.signal, confidence: this.confidence, action: this.lastAction };
  }
}


// ─────────────────────────────────────────────────────
// 15. ACTOR-CRITIC — Separate actor and critic networks
// ─────────────────────────────────────────────────────
export class ActorCriticAlgo extends BaseAlgorithm {
  constructor() {
    super(15);
    this.actor = new NeuralNet([
      { in: FEATURE_DIM, out: HP.hiddenSize1, act: 'relu' },
      { in: HP.hiddenSize1, out: NUM_ACTIONS, act: 'linear' },
    ]);
    this.critic = new NeuralNet([
      { in: FEATURE_DIM, out: HP.hiddenSize1, act: 'relu' },
      { in: HP.hiddenSize1, out: 1, act: 'linear' },
    ]);
    this.gamma = HP.gamma;
    this.prevFeatures = null;
    this.tdError = 0;
  }

  update(features, reward) {
    if (this.prevFeatures) {
      const V_s = this.critic.forward(this.prevFeatures)[0];
      const V_next = this.critic.forward(features)[0];

      // TD advantage
      this.tdError = reward + this.gamma * V_next - V_s;

      // Update critic
      this.critic.trainMSE(this.prevFeatures, Float64Array.from([reward + this.gamma * V_next]));

      // Update actor with advantage
      const logits = this.actor.forward(this.prevFeatures);
      const probs = softmax(Array.from(logits));
      const grad = new Float64Array(NUM_ACTIONS);
      for (let i = 0; i < NUM_ACTIONS; i++) {
        grad[i] = probs[i];
        if (i === this.lastAction) grad[i] -= 1;
      }
      for (let i = 0; i < NUM_ACTIONS; i++) grad[i] *= this.tdError;
      this.actor.backward(grad);
      this.actor.update(HP.lr);
    }

    const logits = this.actor.forward(features);
    const probs = softmax(Array.from(logits));
    const action = sampleCategorical(probs);
    const V_s = this.critic.forward(features)[0];

    this.signal = clamp((probs[0] - probs[2]) * 2, -1, 1);
    this.confidence = clamp(0.5 + Math.abs(this.tdError) * 2, 0.3, 0.95);

    this.metrics = {
      V_s: V_s.toFixed(3),
      tdError: this.tdError.toFixed(4),
      policy: probs.map(p => p.toFixed(2)).join('/'),
    };

    this.prevFeatures = new Float64Array(features);
    this.lastAction = action;
    this.trainSteps++;
  }

  predict(features) {
    return { signal: this.signal, confidence: this.confidence, action: this.lastAction };
  }
}


// ─────────────────────────────────────────────────────
// 16. A2C/A3C — Advantage Actor-Critic with parallel workers
// ─────────────────────────────────────────────────────
export class A2CA3CAlgo extends BaseAlgorithm {
  constructor() {
    super(16);
    this.numWorkers = 4;
    // Shared networks
    this.actor = new NeuralNet([
      { in: FEATURE_DIM, out: HP.hiddenSize1, act: 'relu' },
      { in: HP.hiddenSize1, out: NUM_ACTIONS, act: 'linear' },
    ]);
    this.critic = new NeuralNet([
      { in: FEATURE_DIM, out: HP.hiddenSize1, act: 'relu' },
      { in: HP.hiddenSize1, out: 1, act: 'linear' },
    ]);
    this.gamma = HP.gamma;
    this.nStepBuffer = []; // n-step returns
    this.nStep = 5;
    this.prevFeatures = null;
    this.workerSignals = new Float64Array(this.numWorkers);
    this.entropyCoeff = 0.01;
  }

  update(features, reward) {
    this.nStepBuffer.push({ features: new Float64Array(features), reward });

    if (this.nStepBuffer.length >= this.nStep) {
      // Compute n-step return
      let G = this.critic.forward(features)[0]; // Bootstrap
      for (let t = this.nStepBuffer.length - 1; t >= 0; t--) {
        G = this.nStepBuffer[t].reward + this.gamma * G;
      }

      const firstFeatures = this.nStepBuffer[0].features;
      const V_s = this.critic.forward(firstFeatures)[0];
      const advantage = G - V_s;

      // Update critic
      this.critic.trainMSE(firstFeatures, Float64Array.from([G]));

      // Update actor
      const logits = this.actor.forward(firstFeatures);
      const probs = softmax(Array.from(logits));
      const grad = new Float64Array(NUM_ACTIONS);
      for (let i = 0; i < NUM_ACTIONS; i++) {
        grad[i] = probs[i] * advantage;
        // Entropy bonus
        grad[i] -= this.entropyCoeff * (Math.log(probs[i] + 1e-8) + 1);
      }
      this.actor.backward(grad);
      this.actor.update(HP.lr);

      this.nStepBuffer.shift();
    }

    // Simulate multiple workers with different feature perturbations
    for (let w = 0; w < this.numWorkers; w++) {
      const pertFeatures = new Float64Array(features.length);
      for (let i = 0; i < features.length; i++) {
        pertFeatures[i] = features[i] + randn() * 0.05;
      }
      const logits = this.actor.forward(pertFeatures);
      const probs = softmax(Array.from(logits));
      this.workerSignals[w] = (probs[0] - probs[2]) * 2;
    }

    const consensusSignal = mean(Array.from(this.workerSignals));
    const probs = softmax(Array.from(this.actor.forward(features)));

    this.signal = clamp(consensusSignal, -1, 1);
    this.confidence = clamp(0.5 + (1 - std(Array.from(this.workerSignals))) * 0.3, 0.3, 0.95);
    this.lastAction = sampleCategorical(probs);

    this.metrics = {
      workers: this.numWorkers,
      consensus: consensusSignal.toFixed(3),
      workerAgreement: (1 - std(Array.from(this.workerSignals))).toFixed(2),
    };
    this.trainSteps++;
  }

  predict(features) {
    return { signal: this.signal, confidence: this.confidence, action: this.lastAction };
  }
}


// ─────────────────────────────────────────────────────
// 17. GAE — Generalized Advantage Estimation
// ─────────────────────────────────────────────────────
export class GAEAlgo extends BaseAlgorithm {
  constructor() {
    super(17);
    this.actor = new NeuralNet([
      { in: FEATURE_DIM, out: HP.hiddenSize1, act: 'relu' },
      { in: HP.hiddenSize1, out: NUM_ACTIONS, act: 'linear' },
    ]);
    this.critic = new NeuralNet([
      { in: FEATURE_DIM, out: HP.hiddenSize1, act: 'relu' },
      { in: HP.hiddenSize1, out: 1, act: 'linear' },
    ]);
    this.gamma = HP.gamma;
    this.lambda = HP.lambda;
    this.trajectory = [];
    this.batchSize = 16;
    this.gaeAdvantage = 0;
  }

  update(features, reward) {
    const V_s = this.critic.forward(features)[0];
    this.trajectory.push({
      features: new Float64Array(features),
      reward,
      value: V_s,
      action: this.lastAction,
    });

    if (this.trajectory.length >= this.batchSize) {
      const T = this.trajectory.length;
      const advantages = new Float64Array(T);
      const returns = new Float64Array(T);

      // GAE: A^GAE_t = Σ_{l=0}^{T-t-1} (γλ)^l · δ_{t+l}
      let gae = 0;
      for (let t = T - 1; t >= 0; t--) {
        const nextVal = t < T - 1 ? this.trajectory[t + 1].value : V_s;
        const delta = this.trajectory[t].reward + this.gamma * nextVal - this.trajectory[t].value;
        gae = delta + this.gamma * this.lambda * gae;
        advantages[t] = gae;
        returns[t] = gae + this.trajectory[t].value;
      }

      // Normalize advantages
      const advMean = mean(Array.from(advantages));
      const advStd = std(Array.from(advantages)) || 1;

      // Update actor and critic
      for (let t = 0; t < T; t++) {
        const normAdv = (advantages[t] - advMean) / advStd;

        // Critic update
        this.critic.trainMSE(this.trajectory[t].features, Float64Array.from([returns[t]]));

        // Actor update
        const logits = this.actor.forward(this.trajectory[t].features);
        const probs = softmax(Array.from(logits));
        const grad = new Float64Array(NUM_ACTIONS);
        for (let i = 0; i < NUM_ACTIONS; i++) {
          grad[i] = probs[i];
          if (i === this.trajectory[t].action) grad[i] -= 1;
        }
        for (let i = 0; i < NUM_ACTIONS; i++) grad[i] *= normAdv;
        this.actor.backward(grad);
        this.actor.update(HP.lr);
      }

      this.gaeAdvantage = advantages[T - 1];
      this.trajectory = [];
    }

    const probs = softmax(Array.from(this.actor.forward(features)));
    this.signal = clamp((probs[0] - probs[2]) * 2, -1, 1);
    this.confidence = clamp(0.5 + Math.abs(this.gaeAdvantage) * 2, 0.3, 0.95);
    this.lastAction = sampleCategorical(probs);

    this.metrics = {
      gaeAdv: this.gaeAdvantage.toFixed(4),
      lambda: this.lambda,
      V_s: V_s.toFixed(3),
    };
    this.trainSteps++;
  }

  predict(features) {
    return { signal: this.signal, confidence: this.confidence, action: this.lastAction };
  }
}


// ─────────────────────────────────────────────────────
// 18. PPO — Proximal Policy Optimization (Clipped)
// ─────────────────────────────────────────────────────
export class PPOAlgo extends BaseAlgorithm {
  constructor() {
    super(18);
    this.actor = new NeuralNet([
      { in: FEATURE_DIM, out: HP.hiddenSize1, act: 'relu' },
      { in: HP.hiddenSize1, out: HP.hiddenSize2, act: 'relu' },
      { in: HP.hiddenSize2, out: NUM_ACTIONS, act: 'linear' },
    ]);
    this.critic = new NeuralNet([
      { in: FEATURE_DIM, out: HP.hiddenSize1, act: 'relu' },
      { in: HP.hiddenSize1, out: HP.hiddenSize2, act: 'relu' },
      { in: HP.hiddenSize2, out: 1, act: 'linear' },
    ]);
    this.gamma = HP.gamma;
    this.lambda = HP.lambda;
    this.clipRatio = HP.ppoClipRatio;
    this.epochs = HP.ppoEpochs;
    this.trajectory = [];
    this.batchSize = 20;
    this.clipFraction = 0;
  }

  update(features, reward) {
    const logits = this.actor.forward(features);
    const probs = softmax(Array.from(logits));
    const action = sampleCategorical(probs);
    const V_s = this.critic.forward(features)[0];

    this.trajectory.push({
      features: new Float64Array(features),
      action,
      reward,
      value: V_s,
      logProb: Math.log(probs[action] + 1e-8),
      oldProbs: [...probs],
    });

    if (this.trajectory.length >= this.batchSize) {
      const T = this.trajectory.length;

      // Compute GAE advantages
      const advantages = new Float64Array(T);
      const returns = new Float64Array(T);
      let gae = 0;
      for (let t = T - 1; t >= 0; t--) {
        const nextVal = t < T - 1 ? this.trajectory[t + 1].value : V_s;
        const delta = this.trajectory[t].reward + this.gamma * nextVal - this.trajectory[t].value;
        gae = delta + this.gamma * this.lambda * gae;
        advantages[t] = gae;
        returns[t] = gae + this.trajectory[t].value;
      }

      const advMean = mean(Array.from(advantages));
      const advStd = std(Array.from(advantages)) || 1;

      // Multiple epochs on same data (PPO key feature)
      let clippedCount = 0;
      for (let epoch = 0; epoch < this.epochs; epoch++) {
        for (let t = 0; t < T; t++) {
          const entry = this.trajectory[t];
          const normAdv = (advantages[t] - advMean) / advStd;

          // New policy
          const newLogits = this.actor.forward(entry.features);
          const newProbs = softmax(Array.from(newLogits));
          const ratio = newProbs[entry.action] / (entry.oldProbs[entry.action] + 1e-8);

          // Clipped surrogate objective
          const surr1 = ratio * normAdv;
          const surr2 = clamp(ratio, 1 - this.clipRatio, 1 + this.clipRatio) * normAdv;
          const ppoLoss = -Math.min(surr1, surr2);

          if (Math.abs(ratio - 1) > this.clipRatio) clippedCount++;

          // Update actor
          const grad = new Float64Array(NUM_ACTIONS);
          for (let i = 0; i < NUM_ACTIONS; i++) {
            grad[i] = newProbs[i];
            if (i === entry.action) grad[i] -= 1;
          }
          const scale = ratio <= 1 + this.clipRatio && ratio >= 1 - this.clipRatio ? normAdv : 0;
          for (let i = 0; i < NUM_ACTIONS; i++) grad[i] *= scale;
          this.actor.backward(grad);
          this.actor.update(HP.lr * 0.5);

          // Update critic
          this.critic.trainMSE(entry.features, Float64Array.from([returns[t]]));
        }
      }
      this.clipFraction = clippedCount / (T * this.epochs);
      this.trajectory = [];
    }

    const finalProbs = softmax(Array.from(this.actor.forward(features)));
    this.signal = clamp((finalProbs[0] - finalProbs[2]) * 2, -1, 1);
    this.confidence = clamp(Math.max(...finalProbs) * 1.3, 0.3, 0.95);
    this.lastAction = action;

    this.metrics = {
      clipFrac: this.clipFraction.toFixed(3),
      clipRatio: this.clipRatio,
      entropy: entropy(finalProbs).toFixed(3),
    };
    this.trainSteps++;
  }

  predict(features) {
    return { signal: this.signal, confidence: this.confidence, action: this.lastAction };
  }
}


// ─────────────────────────────────────────────────────
// 19. DDPG — Deep Deterministic Policy Gradient
// ─────────────────────────────────────────────────────
export class DDPGAlgo extends BaseAlgorithm {
  constructor() {
    super(19);
    // Actor outputs continuous action in [-1, 1]
    this.actor = new NeuralNet([
      { in: FEATURE_DIM, out: HP.hiddenSize1, act: 'relu' },
      { in: HP.hiddenSize1, out: HP.hiddenSize2, act: 'relu' },
      { in: HP.hiddenSize2, out: 1, act: 'tanh' },
    ]);
    this.critic = new NeuralNet([
      { in: FEATURE_DIM + 1, out: HP.hiddenSize1, act: 'relu' },
      { in: HP.hiddenSize1, out: HP.hiddenSize2, act: 'relu' },
      { in: HP.hiddenSize2, out: 1, act: 'linear' },
    ]);
    this.targetActor = new NeuralNet([
      { in: FEATURE_DIM, out: HP.hiddenSize1, act: 'relu' },
      { in: HP.hiddenSize1, out: HP.hiddenSize2, act: 'relu' },
      { in: HP.hiddenSize2, out: 1, act: 'tanh' },
    ]);
    this.targetCritic = new NeuralNet([
      { in: FEATURE_DIM + 1, out: HP.hiddenSize1, act: 'relu' },
      { in: HP.hiddenSize1, out: HP.hiddenSize2, act: 'relu' },
      { in: HP.hiddenSize2, out: 1, act: 'linear' },
    ]);
    this.targetActor.copyFrom(this.actor);
    this.targetCritic.copyFrom(this.critic);

    this.buffer = new ReplayBuffer(HP.bufferSize);
    this.ouNoise = new OUNoise(1);
    this.gamma = HP.gamma;
    this.prevFeatures = null;
    this.prevAction = 0;
  }

  _stateAction(features, action) {
    const sa = new Float64Array(FEATURE_DIM + 1);
    sa.set(features);
    sa[FEATURE_DIM] = action;
    return sa;
  }

  update(features, reward) {
    if (this.prevFeatures) {
      this.buffer.add(
        Array.from(this.prevFeatures), this.prevAction, reward, Array.from(features), false
      );
    }

    // Train from buffer
    if (this.buffer.size >= HP.minBufferSize && this.trainSteps % 2 === 0) {
      const batch = this.buffer.sample(HP.batchSize);
      for (const exp of batch) {
        // Target action
        const targetAction = this.targetActor.forward(exp.nextState)[0];
        const saNext = this._stateAction(exp.nextState, targetAction);
        const targetQ = exp.reward + this.gamma * this.targetCritic.forward(saNext)[0];

        // Update critic
        const saCurr = this._stateAction(exp.state, exp.action);
        this.critic.trainMSE(saCurr, Float64Array.from([targetQ]));

        // Update actor (maximize Q)
        const currentAction = this.actor.forward(exp.state)[0];
        const saForGrad = this._stateAction(exp.state, currentAction);
        const qVal = this.critic.forward(saForGrad)[0];

        // Actor gradient: push action toward higher Q
        const pertAction = currentAction + 0.01;
        const saPlus = this._stateAction(exp.state, pertAction);
        const qPlus = this.critic.forward(saPlus)[0];
        const dQ_da = (qPlus - qVal) / 0.01;

        this.actor.forward(exp.state);
        this.actor.backward(Float64Array.from([-dQ_da * 0.1]));
        this.actor.update(HP.lr * 0.5);
      }

      // Soft update targets
      this.targetActor.softCopyFrom(this.actor, HP.tau);
      this.targetCritic.softCopyFrom(this.critic, HP.tau);
    }

    // Get action with OU noise
    const cleanAction = this.actor.forward(features)[0];
    const noise = this.ouNoise.sample()[0];
    const action = clamp(cleanAction + noise * 0.3, -1, 1);

    this.signal = clamp(action, -1, 1);
    this.confidence = clamp(0.5 + Math.abs(cleanAction) * 0.4, 0.3, 0.95);
    this.lastAction = action > 0.3 ? 0 : action < -0.3 ? 2 : 1;

    this.metrics = {
      action: action.toFixed(3),
      noise: noise.toFixed(3),
      buffer: this.buffer.size,
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
// 20. TD3 — Twin Delayed Deep Deterministic Policy Gradient
// ─────────────────────────────────────────────────────
export class TD3Algo extends BaseAlgorithm {
  constructor() {
    super(20);
    // Twin critics
    this.actor = new NeuralNet([
      { in: FEATURE_DIM, out: HP.hiddenSize1, act: 'relu' },
      { in: HP.hiddenSize1, out: 1, act: 'tanh' },
    ]);
    this.critic1 = new NeuralNet([
      { in: FEATURE_DIM + 1, out: HP.hiddenSize1, act: 'relu' },
      { in: HP.hiddenSize1, out: 1, act: 'linear' },
    ]);
    this.critic2 = new NeuralNet([
      { in: FEATURE_DIM + 1, out: HP.hiddenSize1, act: 'relu' },
      { in: HP.hiddenSize1, out: 1, act: 'linear' },
    ]);
    this.targetActor = new NeuralNet([
      { in: FEATURE_DIM, out: HP.hiddenSize1, act: 'relu' },
      { in: HP.hiddenSize1, out: 1, act: 'tanh' },
    ]);
    this.targetCritic1 = new NeuralNet([
      { in: FEATURE_DIM + 1, out: HP.hiddenSize1, act: 'relu' },
      { in: HP.hiddenSize1, out: 1, act: 'linear' },
    ]);
    this.targetCritic2 = new NeuralNet([
      { in: FEATURE_DIM + 1, out: HP.hiddenSize1, act: 'relu' },
      { in: HP.hiddenSize1, out: 1, act: 'linear' },
    ]);
    this.targetActor.copyFrom(this.actor);
    this.targetCritic1.copyFrom(this.critic1);
    this.targetCritic2.copyFrom(this.critic2);

    this.buffer = new ReplayBuffer(HP.bufferSize);
    this.gamma = HP.gamma;
    this.policyDelay = 2;
    this.targetNoise = 0.2;
    this.noiseClip = 0.5;
    this.prevFeatures = null;
    this.prevAction = 0;
  }

  _sa(f, a) {
    const sa = new Float64Array(FEATURE_DIM + 1);
    sa.set(f instanceof Float64Array ? f : Float64Array.from(f));
    sa[FEATURE_DIM] = a;
    return sa;
  }

  update(features, reward) {
    if (this.prevFeatures) {
      this.buffer.add(Array.from(this.prevFeatures), this.prevAction, reward, Array.from(features), false);
    }

    if (this.buffer.size >= HP.minBufferSize && this.trainSteps % 2 === 0) {
      const batch = this.buffer.sample(Math.min(HP.batchSize, 16));
      for (const exp of batch) {
        // Target policy smoothing
        const targetAction = clamp(
          this.targetActor.forward(exp.nextState)[0] + clamp(randn() * this.targetNoise, -this.noiseClip, this.noiseClip),
          -1, 1
        );

        // Twin Q targets (take min)
        const q1Next = this.targetCritic1.forward(this._sa(exp.nextState, targetAction))[0];
        const q2Next = this.targetCritic2.forward(this._sa(exp.nextState, targetAction))[0];
        const targetQ = exp.reward + this.gamma * Math.min(q1Next, q2Next);

        // Update both critics
        this.critic1.trainMSE(this._sa(exp.state, exp.action), Float64Array.from([targetQ]));
        this.critic2.trainMSE(this._sa(exp.state, exp.action), Float64Array.from([targetQ]));

        // Delayed policy update
        if (this.trainSteps % this.policyDelay === 0) {
          const a = this.actor.forward(exp.state)[0];
          const q = this.critic1.forward(this._sa(exp.state, a))[0];
          const aPlus = a + 0.01;
          const qPlus = this.critic1.forward(this._sa(exp.state, aPlus))[0];
          const dQda = (qPlus - q) / 0.01;
          this.actor.forward(exp.state);
          this.actor.backward(Float64Array.from([-dQda * 0.1]));
          this.actor.update(HP.lr * 0.3);

          this.targetActor.softCopyFrom(this.actor, HP.tau);
          this.targetCritic1.softCopyFrom(this.critic1, HP.tau);
          this.targetCritic2.softCopyFrom(this.critic2, HP.tau);
        }
      }
    }

    const action = clamp(this.actor.forward(features)[0] + randn() * 0.15, -1, 1);

    this.signal = clamp(action, -1, 1);
    this.confidence = clamp(0.5 + Math.abs(action) * 0.4, 0.3, 0.95);
    this.lastAction = action > 0.3 ? 0 : action < -0.3 ? 2 : 1;

    this.metrics = { action: action.toFixed(3), delay: this.policyDelay, buffer: this.buffer.size };

    this.prevFeatures = new Float64Array(features);
    this.prevAction = action;
    this.trainSteps++;
  }

  predict(features) {
    return { signal: this.signal, confidence: this.confidence, action: this.lastAction };
  }
}


// ─────────────────────────────────────────────────────
// 21. SAC — Soft Actor-Critic (Maximum Entropy)
// ─────────────────────────────────────────────────────
export class SACAlgo extends BaseAlgorithm {
  constructor() {
    super(21);
    this.actor = new NeuralNet([
      { in: FEATURE_DIM, out: HP.hiddenSize1, act: 'relu' },
      { in: HP.hiddenSize1, out: HP.hiddenSize2, act: 'relu' },
      { in: HP.hiddenSize2, out: NUM_ACTIONS * 2, act: 'linear' }, // mean + log_std
    ]);
    this.critic1 = new NeuralNet([
      { in: FEATURE_DIM, out: HP.hiddenSize1, act: 'relu' },
      { in: HP.hiddenSize1, out: NUM_ACTIONS, act: 'linear' },
    ]);
    this.critic2 = new NeuralNet([
      { in: FEATURE_DIM, out: HP.hiddenSize1, act: 'relu' },
      { in: HP.hiddenSize1, out: NUM_ACTIONS, act: 'linear' },
    ]);
    this.targetCritic1 = new NeuralNet([
      { in: FEATURE_DIM, out: HP.hiddenSize1, act: 'relu' },
      { in: HP.hiddenSize1, out: NUM_ACTIONS, act: 'linear' },
    ]);
    this.targetCritic2 = new NeuralNet([
      { in: FEATURE_DIM, out: HP.hiddenSize1, act: 'relu' },
      { in: HP.hiddenSize1, out: NUM_ACTIONS, act: 'linear' },
    ]);
    this.targetCritic1.copyFrom(this.critic1);
    this.targetCritic2.copyFrom(this.critic2);

    this.buffer = new ReplayBuffer(HP.bufferSize);
    this.gamma = HP.gamma;
    this.alpha = HP.sacAlpha; // Entropy coefficient
    this.logAlpha = Math.log(this.alpha);
    this.targetEntropy = -Math.log(1 / NUM_ACTIONS);
    this.prevFeatures = null;
    this.prevAction = 1;
    this.currentEntropy = 0;
  }

  _getPolicy(features) {
    const out = this.actor.forward(features);
    const logits = Array.from(out).slice(0, NUM_ACTIONS);
    return softmax(logits);
  }

  update(features, reward) {
    if (this.prevFeatures) {
      this.buffer.add(Array.from(this.prevFeatures), this.prevAction, reward, Array.from(features), false);
    }

    if (this.buffer.size >= HP.minBufferSize && this.trainSteps % 2 === 0) {
      const batch = this.buffer.sample(Math.min(HP.batchSize, 16));
      for (const exp of batch) {
        const nextProbs = this._getPolicy(exp.nextState);
        const nextLogProbs = nextProbs.map(p => Math.log(p + 1e-8));

        // Target Q = r + γ (Σ π(a'|s') [min Q(s',a') - α log π(a'|s')])
        const q1Next = this.targetCritic1.forward(exp.nextState);
        const q2Next = this.targetCritic2.forward(exp.nextState);
        let targetV = 0;
        for (let a = 0; a < NUM_ACTIONS; a++) {
          const minQ = Math.min(q1Next[a], q2Next[a]);
          targetV += nextProbs[a] * (minQ - this.alpha * nextLogProbs[a]);
        }
        const targetQ = exp.reward + this.gamma * targetV;

        // Update critics
        const target1 = this.critic1.forward(exp.state);
        const target2 = this.critic2.forward(exp.state);
        target1[exp.action] = targetQ;
        target2[exp.action] = targetQ;
        this.critic1.trainMSE(exp.state, target1);
        this.critic2.trainMSE(exp.state, target2);

        // Update actor: minimize E[α log π - Q]
        const probs = this._getPolicy(exp.state);
        const q1 = this.critic1.forward(exp.state);
        const q2 = this.critic2.forward(exp.state);
        const grad = new Float64Array(NUM_ACTIONS * 2);
        for (let a = 0; a < NUM_ACTIONS; a++) {
          const minQ = Math.min(q1[a], q2[a]);
          grad[a] = probs[a] * (this.alpha * (Math.log(probs[a] + 1e-8) + 1) - minQ);
        }
        this.actor.forward(exp.state);
        this.actor.backward(grad);
        this.actor.update(HP.lr * 0.5);

        // Adaptive alpha
        this.currentEntropy = entropy(probs);
        const alphaLoss = -(this.logAlpha * (this.currentEntropy - this.targetEntropy));
        this.logAlpha -= HP.lr * alphaLoss * 0.1;
        this.alpha = Math.exp(clamp(this.logAlpha, -5, 2));
      }

      this.targetCritic1.softCopyFrom(this.critic1, HP.tau);
      this.targetCritic2.softCopyFrom(this.critic2, HP.tau);
    }

    const probs = this._getPolicy(features);
    const action = sampleCategorical(probs);

    this.signal = clamp((probs[0] - probs[2]) * 2, -1, 1);
    this.confidence = clamp(0.5 + Math.abs(this.signal) * 0.4, 0.3, 0.95);
    this.lastAction = action;

    this.metrics = {
      alpha: this.alpha.toFixed(4),
      entropy: this.currentEntropy.toFixed(3),
      probs: probs.map(p => p.toFixed(2)).join('/'),
    };

    this.prevFeatures = new Float64Array(features);
    this.prevAction = action;
    this.trainSteps++;
  }

  predict(features) {
    return { signal: this.signal, confidence: this.confidence, action: this.lastAction };
  }
}
