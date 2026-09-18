// ═══════════════════════════════════════════════════════
// NEURAL NETWORK — Lightweight NN from scratch
// Supports: Dense layers, Adam optimizer, Experience Replay
// ═══════════════════════════════════════════════════════

import { randn, relu, sigmoid, tanh, softmax, clamp, argmax } from './math.js';

// ── Activation Functions with Derivatives ──
const ACTIVATIONS = {
  relu:    { fn: x => Math.max(0, x), dfn: x => x > 0 ? 1 : 0 },
  sigmoid: { fn: x => 1 / (1 + Math.exp(-clamp(x, -20, 20))), dfn: (x, y) => y * (1 - y) },
  tanh:    { fn: x => Math.tanh(x), dfn: (x, y) => 1 - y * y },
  linear:  { fn: x => x, dfn: () => 1 },
  leaky_relu: { fn: x => x > 0 ? x : 0.01 * x, dfn: x => x > 0 ? 1 : 0.01 },
};

/**
 * Dense (fully-connected) layer
 */
class DenseLayer {
  constructor(inputDim, outputDim, activation = 'relu') {
    this.inputDim = inputDim;
    this.outputDim = outputDim;
    this.act = ACTIVATIONS[activation] || ACTIVATIONS.relu;
    this.actName = activation;

    // Xavier initialization
    const scale = Math.sqrt(2.0 / (inputDim + outputDim));
    this.W = [];
    for (let i = 0; i < outputDim; i++) {
      this.W[i] = new Float64Array(inputDim);
      for (let j = 0; j < inputDim; j++) this.W[i][j] = randn() * scale;
    }
    this.b = new Float64Array(outputDim);

    // Adam state
    this.mW = []; this.vW = [];
    this.mb = new Float64Array(outputDim);
    this.vb = new Float64Array(outputDim);
    for (let i = 0; i < outputDim; i++) {
      this.mW[i] = new Float64Array(inputDim);
      this.vW[i] = new Float64Array(inputDim);
    }

    // Cache for backprop
    this.input = null;
    this.preAct = null;
    this.output = null;
  }

  forward(input) {
    this.input = input;
    const out = new Float64Array(this.outputDim);
    const pre = new Float64Array(this.outputDim);

    for (let i = 0; i < this.outputDim; i++) {
      let s = this.b[i];
      for (let j = 0; j < this.inputDim; j++) s += this.W[i][j] * input[j];
      pre[i] = s;
    }

    this.preAct = pre;

    // Apply activation
    if (this.actName === 'softmax') {
      const sm = softmax(Array.from(pre));
      for (let i = 0; i < this.outputDim; i++) out[i] = sm[i];
    } else {
      for (let i = 0; i < this.outputDim; i++) out[i] = this.act.fn(pre[i]);
    }

    this.output = out;
    return out;
  }

  backward(gradOutput) {
    const gradInput = new Float64Array(this.inputDim);
    const gradPre = new Float64Array(this.outputDim);

    // Gradient through activation
    if (this.actName === 'softmax') {
      // Simplified: assume used with cross-entropy, grad already correct
      for (let i = 0; i < this.outputDim; i++) gradPre[i] = gradOutput[i];
    } else {
      for (let i = 0; i < this.outputDim; i++) {
        gradPre[i] = gradOutput[i] * this.act.dfn(this.preAct[i], this.output[i]);
      }
    }

    this._gradW = [];
    for (let i = 0; i < this.outputDim; i++) {
      this._gradW[i] = new Float64Array(this.inputDim);
      for (let j = 0; j < this.inputDim; j++) {
        this._gradW[i][j] = gradPre[i] * this.input[j];
        gradInput[j] += this.W[i][j] * gradPre[i];
      }
    }
    this._gradB = gradPre;

    return gradInput;
  }

  updateAdam(lr, beta1 = 0.9, beta2 = 0.999, eps = 1e-8, t = 1) {
    const bc1 = 1 - Math.pow(beta1, t);
    const bc2 = 1 - Math.pow(beta2, t);

    for (let i = 0; i < this.outputDim; i++) {
      for (let j = 0; j < this.inputDim; j++) {
        const g = this._gradW[i][j];
        this.mW[i][j] = beta1 * this.mW[i][j] + (1 - beta1) * g;
        this.vW[i][j] = beta2 * this.vW[i][j] + (1 - beta2) * g * g;
        const mHat = this.mW[i][j] / bc1;
        const vHat = this.vW[i][j] / bc2;
        this.W[i][j] -= lr * mHat / (Math.sqrt(vHat) + eps);
      }

      const gb = this._gradB[i];
      this.mb[i] = beta1 * this.mb[i] + (1 - beta1) * gb;
      this.vb[i] = beta2 * this.vb[i] + (1 - beta2) * gb * gb;
      const mbH = this.mb[i] / bc1;
      const vbH = this.vb[i] / bc2;
      this.b[i] -= lr * mbH / (Math.sqrt(vbH) + eps);
    }
  }

  /** Copy weights from another layer */
  copyFrom(other) {
    for (let i = 0; i < this.outputDim; i++) {
      this.W[i].set(other.W[i]);
    }
    this.b.set(other.b);
  }

  /** Soft copy (Polyak averaging): τ * src + (1-τ) * self */
  softCopyFrom(other, tau = 0.005) {
    for (let i = 0; i < this.outputDim; i++) {
      for (let j = 0; j < this.inputDim; j++) {
        this.W[i][j] = tau * other.W[i][j] + (1 - tau) * this.W[i][j];
      }
    }
    for (let i = 0; i < this.outputDim; i++) {
      this.b[i] = tau * other.b[i] + (1 - tau) * this.b[i];
    }
  }
}

/**
 * Neural Network — sequential model
 * @example
 * const net = new NeuralNet([
 *   { in: 20, out: 64, act: 'relu' },
 *   { in: 64, out: 32, act: 'relu' },
 *   { in: 32, out: 3, act: 'linear' }
 * ]);
 */
export class NeuralNet {
  constructor(layerDefs) {
    this.layers = layerDefs.map(d => new DenseLayer(d.in, d.out, d.act || 'relu'));
    this.step = 0;
  }

  forward(input) {
    let x = input instanceof Float64Array ? input : Float64Array.from(input);
    for (const layer of this.layers) x = layer.forward(x);
    return x;
  }

  backward(gradOutput) {
    let grad = gradOutput instanceof Float64Array ? gradOutput : Float64Array.from(gradOutput);
    for (let i = this.layers.length - 1; i >= 0; i--) {
      grad = this.layers[i].backward(grad);
    }
    return grad;
  }

  update(lr = 0.001) {
    this.step++;
    for (const layer of this.layers) {
      layer.updateAdam(lr, 0.9, 0.999, 1e-8, this.step);
    }
  }

  /** Train on single (input, target) with MSE loss. Returns loss. */
  trainMSE(input, target) {
    const output = this.forward(input);
    const grad = new Float64Array(output.length);
    let loss = 0;
    for (let i = 0; i < output.length; i++) {
      const diff = output[i] - target[i];
      grad[i] = 2 * diff / output.length;
      loss += diff * diff;
    }
    loss /= output.length;
    this.backward(grad);
    this.update();
    return loss;
  }

  /** Train with Huber loss (more robust to outliers) */
  trainHuber(input, target, delta = 1.0) {
    const output = this.forward(input);
    const grad = new Float64Array(output.length);
    let loss = 0;
    for (let i = 0; i < output.length; i++) {
      const diff = output[i] - target[i];
      const absDiff = Math.abs(diff);
      if (absDiff <= delta) {
        grad[i] = diff / output.length;
        loss += 0.5 * diff * diff;
      } else {
        grad[i] = (delta * Math.sign(diff)) / output.length;
        loss += delta * (absDiff - 0.5 * delta);
      }
    }
    loss /= output.length;
    this.backward(grad);
    this.update();
    return loss;
  }

  /** Copy all weights from another network */
  copyFrom(other) {
    for (let i = 0; i < this.layers.length; i++) {
      this.layers[i].copyFrom(other.layers[i]);
    }
  }

  /** Soft (Polyak) update from another network */
  softCopyFrom(other, tau = 0.005) {
    for (let i = 0; i < this.layers.length; i++) {
      this.layers[i].softCopyFrom(other.layers[i], tau);
    }
  }

  /** Get all parameters as flat array (for meta-learning) */
  getParams() {
    const params = [];
    for (const layer of this.layers) {
      for (let i = 0; i < layer.outputDim; i++) {
        for (let j = 0; j < layer.inputDim; j++) params.push(layer.W[i][j]);
      }
      for (let i = 0; i < layer.outputDim; i++) params.push(layer.b[i]);
    }
    return params;
  }

  /** Set parameters from flat array */
  setParams(params) {
    let idx = 0;
    for (const layer of this.layers) {
      for (let i = 0; i < layer.outputDim; i++) {
        for (let j = 0; j < layer.inputDim; j++) layer.W[i][j] = params[idx++];
      }
      for (let i = 0; i < layer.outputDim; i++) layer.b[i] = params[idx++];
    }
  }
}

/**
 * Experience Replay Buffer — circular buffer with uniform sampling
 */
export class ReplayBuffer {
  constructor(capacity = 10000) {
    this.capacity = capacity;
    this.buffer = [];
    this.pos = 0;
  }

  add(state, action, reward, nextState, done) {
    const exp = { state, action, reward, nextState, done };
    if (this.buffer.length < this.capacity) {
      this.buffer.push(exp);
    } else {
      this.buffer[this.pos] = exp;
    }
    this.pos = (this.pos + 1) % this.capacity;
  }

  sample(batchSize) {
    const batch = [];
    const len = this.buffer.length;
    for (let i = 0; i < batchSize && i < len; i++) {
      const idx = Math.floor(Math.random() * len);
      batch.push(this.buffer[idx]);
    }
    return batch;
  }

  get size() { return this.buffer.length; }
}

/**
 * Prioritized Experience Replay Buffer
 */
export class PrioritizedReplayBuffer {
  constructor(capacity = 10000, alpha = 0.6) {
    this.capacity = capacity;
    this.alpha = alpha;
    this.buffer = [];
    this.priorities = [];
    this.pos = 0;
    this.maxPriority = 1.0;
  }

  add(state, action, reward, nextState, done) {
    const exp = { state, action, reward, nextState, done };
    if (this.buffer.length < this.capacity) {
      this.buffer.push(exp);
      this.priorities.push(this.maxPriority);
    } else {
      this.buffer[this.pos] = exp;
      this.priorities[this.pos] = this.maxPriority;
    }
    this.pos = (this.pos + 1) % this.capacity;
  }

  sample(batchSize, beta = 0.4) {
    const len = this.buffer.length;
    const probs = this.priorities.slice(0, len).map(p => Math.pow(p, this.alpha));
    const sum = probs.reduce((a, b) => a + b, 0);
    const normalized = probs.map(p => p / sum);

    const batch = [];
    const indices = [];
    const weights = [];
    const maxW = Math.pow(len * Math.min(...normalized), -beta);

    for (let i = 0; i < Math.min(batchSize, len); i++) {
      let r = Math.random();
      let cumsum = 0;
      let idx = 0;
      for (let j = 0; j < len; j++) {
        cumsum += normalized[j];
        if (r <= cumsum) { idx = j; break; }
      }
      batch.push(this.buffer[idx]);
      indices.push(idx);
      weights.push(Math.pow(len * normalized[idx], -beta) / maxW);
    }

    return { batch, indices, weights };
  }

  updatePriorities(indices, tdErrors) {
    for (let i = 0; i < indices.length; i++) {
      this.priorities[indices[i]] = Math.abs(tdErrors[i]) + 1e-6;
      this.maxPriority = Math.max(this.maxPriority, this.priorities[indices[i]]);
    }
  }

  get size() { return this.buffer.length; }
}

/**
 * Ornstein-Uhlenbeck Process — for continuous action exploration (DDPG)
 */
export class OUNoise {
  constructor(dim, mu = 0, theta = 0.15, sigma = 0.2) {
    this.dim = dim;
    this.mu = mu;
    this.theta = theta;
    this.sigma = sigma;
    this.state = new Float64Array(dim);
  }

  reset() { this.state.fill(this.mu); }

  sample() {
    for (let i = 0; i < this.dim; i++) {
      this.state[i] += this.theta * (this.mu - this.state[i]) + this.sigma * randn();
    }
    return this.state;
  }
}
