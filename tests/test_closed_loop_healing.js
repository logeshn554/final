// ═══════════════════════════════════════════════════════════════════════
// CLOSED-LOOP SELF-HEALING & LOSS GOVERNANCE VERIFICATION SUITE
// ═══════════════════════════════════════════════════════════════════════

import { AutonomousHealingEngine } from '../src/engine/autonomous-healing.js';
import { MastermindEngine } from '../src/engine/mastermind.js';
import { BaseAlgorithm } from '../src/algorithms/base.js';
import { TradeSignalEngine } from '../src/engine/trade-signals.js';

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    passed++;
    console.log(`  ✓ PASS: ${message}`);
  } else {
    failed++;
    console.error(`  ✗ FAIL: ${message}`);
    throw new Error(`Assertion failed: ${message}`);
  }
}

console.log('─────────────────────────────────────────────────────────────────');
console.log('🧪 VERIFYING CLOSED-LOOP SELF-HEALING ARCHITECTURE');
console.log('─────────────────────────────────────────────────────────────────');

// ─────────────────────────────────────────────────────────────────
// [1] TEST: Loss Attribution to Actual Culprit Strategies
// ─────────────────────────────────────────────────────────────────
console.log('\n[1] TEST: Trade Loss Attribution to Contributing Strategies');
{
  const healing = new AutonomousHealingEngine();
  const tse = new TradeSignalEngine();
  tse.healingEngine = healing;

  const mockState = {
    price: 2500,
    atr: 16,
    regime: 'TRENDING',
    layer2: { microstructure: { vpin: 0.22, obi: 0.05 } },
    masterDecision: {
      contributingStrategies: ['rl_0', 'rl_1', 'institutional_hjb'],
    },
  };

  const mockMasterTrade = {
    status: 'ACTIVE',
    direction: 1,
    action: 'BUY',
    entryPrice: 2500,
    tpPrice: 2530,
    spPrice: 2480,
    tpDistance: 30,
    slDistance: 20,
    positionETH: 1.0,
    entryTime: Date.now() - 30000,
    contributingStrategies: ['rl_0', 'rl_1', 'institutional_hjb'],
    regime: 'TRENDING',
    atrValue: 16,
    stats: { totalTrades: 0, wins: 0, losses: 0, winRate: 0, history: [] },
  };

  // Resolve a losing trade (SP HIT)
  tse._resolveTrade(mockState, mockMasterTrade, 2480, 'SP HIT', false, 'SP HIT');

  // Verify that error reports were logged for the 3 actual contributing strategies
  assert(healing.totalErrorsCaught === 3, `Recorded exactly 3 errors for 3 contributing strategies (got ${healing.totalErrorsCaught})`);

  const reportedIds = healing.healingLog.map(i => i.algoId);
  assert(reportedIds.includes(0), 'Attributed loss to rl_0 (mapped to ID 0)');
  assert(reportedIds.includes(1), 'Attributed loss to rl_1 (mapped to ID 1)');
  assert(reportedIds.includes('institutional_hjb'), 'Attributed loss to institutional_hjb');
  assert(!reportedIds.includes(35), 'Did NOT use dummy ID 35');
}

// ─────────────────────────────────────────────────────────────────
// [2] TEST: Parameter Mutation in BaseAlgorithm (Confidence Hurdle & Dynamic Stops)
// ─────────────────────────────────────────────────────────────────
console.log('\n[2] TEST: Concrete Parameter Mutation in BaseAlgorithm');
{
  class TestAlgorithm extends BaseAlgorithm {
    constructor(id) {
      super(id);
      this.signal = 0.50; // BUY
      this.confidence = 0.45; // Below elevated hurdle
    }
    predict() {
      return { signal: this.signal, confidence: this.confidence };
    }
  }

  const alg = new TestAlgorithm(4);

  // Baseline: confidence 0.45 clears default hurdle 0.40
  let sig = alg.getSignal();
  assert(sig.signal > 0, `Baseline signal emits BUY (signal: ${sig.signal})`);
  assert(sig.direction === 1, 'Baseline direction is +1');

  // Inject self-healing adjustment with elevated confidence hurdle (e.g. 0.52 due to regime mismatch)
  alg.setHealingAdjustments({
    confidenceHurdle: 0.52,
    stopMultiplier: 1.30,
    targetMultiplier: 1.0,
    weightDampener: 0.85,
    quarantined: false,
  });

  // Now confidence 0.45 is BELOW hurdle 0.52 -> must suppress to neutral (0)
  sig = alg.getSignal();
  assert(sig.signal === 0, `Signal is suppressed to neutral 0 when conf (0.45) < hurdle (0.52) (got ${sig.signal})`);
  assert(sig.direction === 0, 'Direction is suppressed to 0');

  // If confidence increases above hurdle:
  alg.confidence = 0.60;
  sig = alg.getSignal();
  assert(sig.signal > 0, `Signal resumes when conf (0.60) >= hurdle (0.52) (got ${sig.signal})`);

  // Verify stopMultiplier expands dynamic stop loss
  const levels = alg.detectDynamicLevels({ price: 2500, atr: 20 });
  assert(levels.slDistance >= 26.0, `Stop distance widened by 1.30x multiplier (expected >= 26, got ${levels.slDistance})`);
}

// ─────────────────────────────────────────────────────────────────
// [3] TEST: Quarantine State & Strict Exclusion in MasterMind
// ─────────────────────────────────────────────────────────────────
console.log('\n[3] TEST: Quarantine State & Strict MasterMind Exclusion');
{
  const healing = new AutonomousHealingEngine();
  const mm = new MastermindEngine();

  // Manually simulate a model failing validation and being quarantined
  const culpritId = 2;
  const adj = healing.getAdjustment(culpritId);
  adj.quarantined = true;
  adj.weightDampener = 0.0;
  healing.quarantinedSet.add(culpritId);
  healing.quarantinedCount = healing.quarantinedSet.size;

  assert(healing.isQuarantined(culpritId) === true, 'Healing engine reports algorithm 2 is quarantined');
  assert(healing.getQuarantinedCount() === 1, 'Quarantined count is 1');

  // Also verify BaseAlgorithm respects quarantine
  class TestAlgo extends BaseAlgorithm {
    constructor(id) {
      super(id);
      this.signal = 0.8;
      this.confidence = 0.9;
    }
  }
  const testAlgo = new TestAlgo(culpritId);
  testAlgo.setHealingAdjustments(adj);
  const qSig = testAlgo.getSignal();
  assert(qSig.signal === 0 && qSig.quarantined === true, 'BaseAlgorithm returns zeroed signal and quarantined: true');

  // Provide signals to MasterMind where ONLY algorithm 2 has an extreme BUY signal
  const signals = {
    '2': { direction: 1, signal: 'BUY', conf: 0.95 },
  };

  const decision = mm.evaluate({
    price: 2500,
    signals,
    autoHealing: healing,
    strategyPerformance: { weights: { '2': 0.5 }, signals },
  });

  // Since algorithm 2 is quarantined, its vote is excluded from consensus
  assert(!decision.contributingStrategies.includes('2'), 'Quarantined algorithm 2 is NOT in contributingStrategies');
  assert(decision.score === 0, `Consensus score is 0 with only quarantined model active (got ${decision.score})`);
  assert(decision.modelHealth.quarantined === 1, `MasterMind modelHealth accurately reports 1 quarantined model`);
  assert(decision.modelHealth.quarantinedList.includes(2), 'MasterMind modelHealth lists algorithm 2');
}

// ─────────────────────────────────────────────────────────────────
// [4] TEST: Self-Healing Weight Dampening in MasterMind
// ─────────────────────────────────────────────────────────────────
console.log('\n[4] TEST: Self-Healing Weight Dampening in MasterMind Consensus');
{
  const healing = new AutonomousHealingEngine();
  const mm = new MastermindEngine();

  // Algorithm 0 has a normal weight, Algorithm 1 has a dampened weight (0.40)
  const adj1 = healing.getAdjustment(1);
  adj1.weightDampener = 0.40;

  const signals = {
    '0': { direction: 1, signal: 'BUY', conf: 0.8 },
    '1': { direction: -1, signal: 'SELL', conf: 0.8 },
  };

  const decision = mm.evaluate({
    price: 2500,
    signals,
    autoHealing: healing,
    strategyPerformance: {
      weights: { '0': 0.5, '1': 0.5 },
      signals,
    },
  });

  // Because algorithm 1 is dampened (0.40x) relative to algorithm 0 (1.0x), BUY must outweigh SELL
  assert(decision.score > 0, `BUY score outweighs dampened SELL score (score: ${decision.score})`);
}

// ─────────────────────────────────────────────────────────────────
// [5] TEST: Truthful Telemetry & Health Reporting
// ─────────────────────────────────────────────────────────────────
console.log('\n[5] TEST: Truthful Health & Telemetry Metrics');
{
  const healing = new AutonomousHealingEngine();

  // Initially 0 errors: 100% HEALTHY
  assert(healing.getSystemHealth().includes('Zero Errors'), 'Initial health reflects Zero Errors');

  // Trigger an error that gets quarantined
  healing.quarantinedSet.add(9);
  healing.totalErrorsCaught = 1;

  const degradedHealth = healing.getSystemHealth();
  assert(degradedHealth.includes('DEGRADED') && degradedHealth.includes('1 Quarantined'),
    `System health truthfully reports DEGRADED when models quarantined (got: "${degradedHealth}")`);

  const telemetry = healing.getTelemetry();
  assert(telemetry.quarantinedCount === 1, 'Telemetry includes quarantinedCount = 1');
  assert(telemetry.quarantinedList.includes(9), 'Telemetry includes algorithm 9 in quarantinedList');
}

console.log('\n─────────────────────────────────────────────────────────────────');
console.log(`✨ ALL ${passed} CLOSED-LOOP SELF-HEALING TESTS PASSED SUCCESSFULLY! (${failed} failed)`);
console.log('─────────────────────────────────────────────────────────────────\n');
