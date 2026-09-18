// ═══════════════════════════════════════════════════════
// MARKET SIMULATION — Realistic price feed with regimes
// ═══════════════════════════════════════════════════════

import { STATE, log } from '../state.js';
import { rnd, randn, clamp } from '../utils/math.js';

/** Regime-aware price simulation */
export function simPrice() {
  const { regime, regimeProbs } = STATE;

  // Base volatility depends on regime
  let vol, drift;
  switch (regime) {
    case 'bull':
      vol = 0.0004; drift = 0.00015;
      break;
    case 'bear':
      vol = 0.0005; drift = -0.00012;
      break;
    case 'volatile':
      vol = 0.0012; drift = 0;
      break;
    default: // ranging
      vol = 0.0003; drift = 0;
  }

  // Micro-structure noise
  const microNoise = randn() * vol;
  const meanRevert = -0.0001 * (STATE.price - 2600) / 2600; // Weak mean reversion

  const change = drift + microNoise + meanRevert;
  STATE.price = Math.max(1800, Math.min(6000, STATE.price * (1 + change)));
  STATE.prices.push(STATE.price);
  STATE.volumes.push(1000 + Math.abs(randn()) * 3000 + (regime === 'volatile' ? 4000 : 0));

  if (STATE.prices.length > 500) STATE.prices.shift();
  if (STATE.volumes.length > 500) STATE.volumes.shift();

  // 24h high/low
  const recent = STATE.prices.slice(-60);
  STATE.high24 = Math.max(...recent);
  STATE.low24 = Math.min(...recent);
  STATE.spread = 0.3 + Math.random() * 0.4;
}

/** HMM-inspired regime transitions */
export function simRegime() {
  // Transition matrix (simplified HMM)
  const T = {
    bull:     { bull: 0.92, bear: 0.02, ranging: 0.04, volatile: 0.02 },
    bear:     { bull: 0.03, bear: 0.90, ranging: 0.04, volatile: 0.03 },
    ranging:  { bull: 0.05, bear: 0.05, ranging: 0.85, volatile: 0.05 },
    volatile: { bull: 0.04, bear: 0.04, ranging: 0.07, volatile: 0.85 },
  };

  // Observation model: update probabilities based on recent price action
  const returns5 = STATE.prices.length >= 6
    ? (STATE.prices[STATE.prices.length - 1] / STATE.prices[STATE.prices.length - 6] - 1)
    : 0;
  const recentVol = (() => {
    if (STATE.prices.length < 10) return 0.001;
    const rets = [];
    for (let i = STATE.prices.length - 10; i < STATE.prices.length; i++) {
      if (i > 0) rets.push(STATE.prices[i] / STATE.prices[i-1] - 1);
    }
    let s = 0;
    const m = rets.reduce((a,b) => a+b, 0) / rets.length;
    for (const r of rets) s += (r - m) ** 2;
    return Math.sqrt(s / rets.length);
  })();

  // Update regime probabilities using Bayesian-like update
  const priors = STATE.regimeProbs;
  const likelihoods = {
    bull:     Math.exp(-0.5 * ((returns5 - 0.003) / 0.005) ** 2) * Math.exp(-0.5 * ((recentVol - 0.002) / 0.002) ** 2),
    bear:     Math.exp(-0.5 * ((returns5 + 0.003) / 0.005) ** 2) * Math.exp(-0.5 * ((recentVol - 0.003) / 0.002) ** 2),
    ranging:  Math.exp(-0.5 * ((returns5 - 0) / 0.003) ** 2) * Math.exp(-0.5 * ((recentVol - 0.001) / 0.001) ** 2),
    volatile: Math.exp(-0.5 * ((returns5 - 0) / 0.008) ** 2) * Math.exp(-0.5 * ((recentVol - 0.006) / 0.003) ** 2),
  };

  // Forward step: prior × transition × likelihood
  const newProbs = {};
  let total = 0;
  for (const state of ['bull', 'bear', 'ranging', 'volatile']) {
    let transProb = 0;
    for (const prev of ['bull', 'bear', 'ranging', 'volatile']) {
      transProb += priors[prev] * T[prev][state];
    }
    newProbs[state] = transProb * likelihoods[state];
    total += newProbs[state];
  }

  // Normalize
  for (const k of Object.keys(newProbs)) {
    newProbs[k] = Math.max(0.01, newProbs[k] / (total || 1));
  }
  const s = Object.values(newProbs).reduce((a, b) => a + b, 0);
  for (const k of Object.keys(newProbs)) newProbs[k] /= s;

  STATE.regimeProbs = newProbs;

  // Dominant regime
  STATE.regime = Object.entries(newProbs).sort((a, b) => b[1] - a[1])[0][0];
}

/** POMDP belief state update (particle filter approximation) */
export function simPOMDP() {
  const price = STATE.price;
  const prices = STATE.prices;

  if (prices.length < 20) return;

  const ret5 = prices[prices.length - 1] / prices[prices.length - 6] - 1;
  const momentum = prices[prices.length - 1] / prices[prices.length - 11] - 1;

  // Likelihood of observations given hidden states
  const likelihoods = {
    'Accum.':   Math.exp(-0.5 * ((ret5 - 0.002) / 0.004) ** 2) * (momentum > 0 ? 1.3 : 0.7),
    'Dist.':    Math.exp(-0.5 * ((ret5 + 0.002) / 0.004) ** 2) * (momentum < 0 ? 1.3 : 0.7),
    'Ranging':  Math.exp(-0.5 * (ret5 / 0.002) ** 2),
    'Breakout': Math.exp(-0.5 * ((Math.abs(ret5) - 0.008) / 0.005) ** 2),
  };

  let total = 0;
  for (const k of Object.keys(STATE.pomdpBelief)) {
    STATE.pomdpBelief[k] *= likelihoods[k];
    STATE.pomdpBelief[k] = Math.max(0.01, STATE.pomdpBelief[k]);
    total += STATE.pomdpBelief[k];
  }
  for (const k of Object.keys(STATE.pomdpBelief)) {
    STATE.pomdpBelief[k] /= total;
  }
}

/** Update position and PnL tracking */
export function updatePosition(action, ensembleSignal) {
  const prevPosition = STATE.position;
  const price = STATE.price;

  // Simple position management based on ensemble signal
  if (Math.abs(ensembleSignal) > 0.3) {
    const targetPosition = clamp(ensembleSignal * 3.0, -STATE.risk.maxPosition, STATE.risk.maxPosition);
    const posChange = (targetPosition - STATE.position) * 0.1; // Gradual
    STATE.position = clamp(STATE.position + posChange, -STATE.risk.maxPosition, STATE.risk.maxPosition);

    if (Math.abs(posChange) > 0.01) {
      if (STATE.entryPrice === 0) STATE.entryPrice = price;
    }
  }

  // Update PnL
  if (STATE.position !== 0 && STATE.entryPrice !== 0) {
    STATE.unrealizedPnL = (price - STATE.entryPrice) * STATE.position;
  } else {
    STATE.unrealizedPnL = 0;
  }

  // Update equity
  STATE.equity = 10000 + STATE.realizedPnL + STATE.unrealizedPnL;
  STATE.equityHistory.push(STATE.equity);
  if (STATE.equityHistory.length > 500) STATE.equityHistory.shift();

  STATE.maxEquity = Math.max(STATE.maxEquity, STATE.equity);
  STATE.drawdown = STATE.maxEquity > 0 ? (STATE.equity - STATE.maxEquity) / STATE.maxEquity * 100 : 0;
}

/** Generate system logs */
export function simLogs() {
  const n = Math.random();
  if (n < 0.08) {
    const dir = STATE.ensemble > 0.3 ? 'BUY' : STATE.ensemble < -0.3 ? 'SELL' : 'HOLD';
    if (dir !== 'HOLD') {
      const sz = Math.abs(STATE.ensemble * 3.2).toFixed(3);
      log(`${dir} ${sz} ETH @ $${STATE.price.toFixed(2)} · ens=${STATE.ensemble.toFixed(2)}`, dir.toLowerCase());
    }
  } else if (n < 0.12) {
    log(`HMM regime: ${STATE.regime.toUpperCase()} (${(STATE.regimeProbs[STATE.regime] * 100).toFixed(1)}%)`, 'info');
  } else if (n < 0.15) {
    const algoId = (Math.random() * 34 | 0) + 1;
    const sig = STATE.signals[algoId];
    if (sig) log(`Algo #${algoId} signal: ${sig.signal.toFixed(3)} (${(sig.conf * 100).toFixed(0)}% conf)`, 'info');
  } else if (n < 0.17 && STATE.risk.volatility > 0.04) {
    log(`⚠ Volatility spike — ${(STATE.risk.volatility * 100).toFixed(2)}%`, 'warn');
  }
}
