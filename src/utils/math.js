// ═══════════════════════════════════════════════════════
// MATH UTILITIES — Linear Algebra, Statistics, Activations
// ═══════════════════════════════════════════════════════

/** Random float in [a, b) */
export function rnd(a, b) { return a + Math.random() * (b - a); }

/** Clamp value between min and max */
export function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }

/** Format number to fixed decimals */
export function fmt(v, dec = 2) {
  if (v == null || isNaN(v)) return '--';
  return Number(v).toFixed(dec);
}

/** Format price with $ and commas */
export function fmtPrice(p) {
  if (p == null || isNaN(p)) return '$--';
  return '$' + Number(p).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** Standard normal random (Box-Muller) */
export function randn() {
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
}

/** Gaussian random with mean and standard deviation */
export function gaussian(mean = 0, std = 1) {
  return mean + randn() * std;
}

/** Softmax over array */
export function softmax(arr) {
  if (!arr || arr.length === 0) return [];
  const max = Math.max(...arr);
  const exps = arr.map(x => Math.exp(x - max));
  const sum = exps.reduce((a, b) => a + b, 0);
  return exps.map(e => e / (sum || 1));
}

/** Sigmoid */
export function sigmoid(x) { return 1 / (1 + Math.exp(-clamp(x, -20, 20))); }

/** Tanh */
export function tanh(x) { return Math.tanh(x); }

/** ReLU */
export function relu(x) { return Math.max(0, x); }

/** Leaky ReLU */
export function leakyRelu(x, alpha = 0.01) { return x > 0 ? x : alpha * x; }

/** Mean of array */
export function mean(arr) {
  if (!arr || arr.length === 0) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

/** Standard deviation */
export function std(arr) {
  if (!arr || arr.length < 2) return 0;
  const m = mean(arr);
  const variance = arr.reduce((sum, x) => sum + (x - m) ** 2, 0) / (arr.length - 1);
  return Math.sqrt(variance);
}

/** Min of array */
export function arrMin(arr) { return arr && arr.length > 0 ? Math.min(...arr) : 0; }

/** Max of array */
export function arrMax(arr) { return arr && arr.length > 0 ? Math.max(...arr) : 0; }

/** Dot product */
export function dot(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

/** Matrix-vector multiply: y = Ax */
export function matvec(A, x) {
  const rows = A.length;
  const y = new Float64Array(rows);
  for (let i = 0; i < rows; i++) {
    let s = 0;
    for (let j = 0; j < x.length; j++) s += A[i][j] * x[j];
    y[i] = s;
  }
  return y;
}

/** Outer product: C[i][j] = a[i] * b[j] */
export function outer(a, b) {
  const m = a.length, n = b.length;
  const C = [];
  for (let i = 0; i < m; i++) {
    C[i] = new Float64Array(n);
    for (let j = 0; j < n; j++) C[i][j] = a[i] * b[j];
  }
  return C;
}

/** Create zero matrix */
export function zeros(rows, cols) {
  const M = [];
  for (let i = 0; i < rows; i++) M[i] = new Float64Array(cols);
  return M;
}

/** Create matrix with random values ~ N(0, scale) */
export function randMatrix(rows, cols, scale = 0.1) {
  const M = [];
  for (let i = 0; i < rows; i++) {
    M[i] = new Float64Array(cols);
    for (let j = 0; j < cols; j++) M[i][j] = randn() * scale;
  }
  return M;
}

/** Create random vector ~ N(0, scale) */
export function randVec(n, scale = 0.1) {
  const v = new Float64Array(n);
  for (let i = 0; i < n; i++) v[i] = randn() * scale;
  return v;
}

/** Argmax of array */
export function argmax(arr) {
  let best = 0;
  for (let i = 1; i < arr.length; i++) {
    if (arr[i] > arr[best]) best = i;
  }
  return best;
}

/** Weighted sample from probability distribution */
export function sampleCategorical(probs) {
  const r = Math.random();
  let cumsum = 0;
  for (let i = 0; i < probs.length; i++) {
    cumsum += probs[i];
    if (r < cumsum) return i;
  }
  return probs.length - 1;
}

/** Exponential moving average update */
export function ema(prev, current, alpha) {
  return alpha * current + (1 - alpha) * prev;
}

/** Normalize array to [0, 1] */
export function normalize(arr) {
  const min = arrMin(arr);
  const max = arrMax(arr);
  const range = max - min || 1;
  return arr.map(x => (x - min) / range);
}

/** Z-score normalization */
export function zScore(arr) {
  const m = mean(arr);
  const s = std(arr) || 1;
  return arr.map(x => (x - m) / s);
}

/** Compute percentile */
export function percentile(arr, p) {
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = (p / 100) * (sorted.length - 1);
  const lower = Math.floor(idx);
  const upper = Math.ceil(idx);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (idx - lower);
}

/** Huber loss */
export function huberLoss(a, b, delta = 1.0) {
  const d = Math.abs(a - b);
  return d <= delta ? 0.5 * d * d : delta * (d - 0.5 * delta);
}

/** Clip value */
export function clip(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }

/** Log-sum-exp (numerically stable) */
export function logSumExp(arr) {
  const mx = Math.max(...arr);
  return mx + Math.log(arr.reduce((s, x) => s + Math.exp(x - mx), 0));
}

/** KL divergence between two discrete distributions */
export function klDivergence(p, q) {
  let kl = 0;
  for (let i = 0; i < p.length; i++) {
    if (p[i] > 1e-10 && q[i] > 1e-10) {
      kl += p[i] * Math.log(p[i] / q[i]);
    }
  }
  return kl;
}

/** Entropy of discrete distribution */
export function entropy(p) {
  let h = 0;
  for (let i = 0; i < p.length; i++) {
    if (p[i] > 1e-10) h -= p[i] * Math.log(p[i]);
  }
  return h;
}

/** Cosine similarity */
export function cosineSim(a, b) {
  const d = dot(a, b);
  const na = Math.sqrt(dot(a, a));
  const nb = Math.sqrt(dot(b, b));
  return d / (na * nb + 1e-8);
}
