// ═══════════════════════════════════════════════════════════════════════
// PRODUCTION INTEGRITY & ARCHITECTURAL VERIFICATION SUITE
// ═══════════════════════════════════════════════════════════════════════

import { MastermindEngine } from '../src/engine/mastermind.js';
import { StrategyPerformanceEngine } from '../src/engine/strategy-performance-engine.js';
import { HistoricalTrainer } from '../src/engine/historical-trainer.js';
import { AttributionFeedbackEngine } from '../src/engine/attribution-feedback.js';
import { readFileSync } from 'fs';

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
console.log('🧪 PRODUCTION INTEGRITY & ARCHITECTURAL VERIFICATION');
console.log('─────────────────────────────────────────────────────────────────');

// [1] MasterMind Granular Strategy Weighting (No Category Buckets, No 12% Tilt)
console.log('\n[1] TEST: MasterMind Granular Consensus Formulation');
{
  const mmCode = readFileSync('./src/engine/mastermind.js', 'utf-8');
  assert(!mmCode.includes('wRL = perfWeights'), 'No hardcoded wRL category bucket default');
  assert(!mmCode.includes('wPy = pyConnected'), 'No hardcoded wPy category bucket default');
  assert(!mmCode.includes('rawMasterScore * 0.88 + (bestSignalObj.direction * 0.85) * 0.12'), 'No arbitrary 12% winner tilt');
  assert(mmCode.includes('weightedDirectionSum += dirVal * strategyDynamicWeight'), 'Implements direct granular strategyDynamicWeight synthesis');

  const mm = new MastermindEngine();
  const perfEngine = new StrategyPerformanceEngine(2500.0);
  const perfState = perfEngine.getState('TREND_UP');

  // Provide heterogeneous signals across RL algorithms and quant models
  const signals = {
    'rl_ppo': { direction: 1, signal: 'BUY', conf: 0.85 },
    'rl_sac': { direction: 1, signal: 'BUY', conf: 0.80 },
    'rl_td3': { direction: -1, signal: 'SELL', conf: 0.40 },
    'institutional_hjb': { direction: 1, signal: 'BUY', conf: 0.75 },
    'microstructure_deep': { direction: 1, signal: 'BUY', conf: 0.60 },
  };

  const decision = mm.evaluate({
    price: 2500.0,
    signals,
    strategyPerformance: {
      ...perfState,
      signals,
      weights: {
        'rl_ppo': 0.30,
        'rl_sac': 0.25,
        'rl_td3': 0.10,
        'institutional_hjb': 0.20,
        'microstructure_deep': 0.15,
      },
    },
    pythonEngineDecision: { symbol: 'ETHUSDT', signal: 'BUY', confidence: 0.70 },
  });

  assert(decision.score > 0, `Consensus score correctly reflects weighted positive votes: ${decision.score}`);
  assert(decision.weightedAgreement > 0.70, `Weighted agreement calculated accurately: ${(decision.weightedAgreement * 100).toFixed(1)}%`);
  assert(decision.contributingStrategies.includes('rl_ppo'), 'rl_ppo is listed in contributing strategies');
  assert(decision.rejectedStrategies.includes('rl_td3'), 'rl_td3 is listed in rejected/conflicting strategies');
}

// [2] MasterMind Self-Evaluation Registration
console.log('\n[2] TEST: MasterMind Registered in Strategy Performance Engine');
{
  const perfEngine = new StrategyPerformanceEngine(2500.0);
  const strat = perfEngine.getStrategy('mastermind');
  assert(strat !== null, 'mastermind strategy definition exists in StrategyPerformanceEngine');
  assert(strat.id === 'mastermind', 'mastermind ID is correctly registered');
  assert(strat.category === 'Master', 'mastermind category is Master');

  // Verify main.js adds mastermind signal to allStrategySignals
  const mainCode = readFileSync('./src/main.js', 'utf-8');
  assert(mainCode.includes("allStrategySignals['mastermind']"), 'main.js injects allStrategySignals[\'mastermind\'] before evaluation');
}

// [3] Market-Driven Exits (Trailing Stop & Signal Reversal)
console.log('\n[3] TEST: Market-Driven Exits (Trailing Stop & Signal Reversal)');
{
  const perfEngine = new StrategyPerformanceEngine(2500.0);

  // Open a BUY trade for microstructure strategy
  perfEngine.ingestSignals({
    signals: {
      'microstructure_deep': { direction: 1, signal: 'BUY', conf: 0.80 },
    },
    currentPrice: 2500.0,
    atr: 10.0,
    regime: 'BREAKOUT',
    movementDistribution: {
      predictedMovement: { mainMove: 12.0 },
      adverseMovement: { expected: 6.0 },
    },
  });

  const openTrade = perfEngine.openTrades['microstructure_deep'];
  assert(openTrade !== undefined, 'Microstructure trade opened');
  const initialStop = openTrade.predictedStop;

  // Price moves favorably towards target (+6 pts)
  perfEngine.updateMarketData(2506.0, 0.15, null, null, 'BREAKOUT');
  assert(openTrade.predictedStop > initialStop, `Stop dynamically trailed upward from $${initialStop} to $${openTrade.predictedStop}`);

  // Strategy reverses signal to SELL: dynamic early exit trigger
  perfEngine.ingestSignals({
    signals: {
      'microstructure_deep': { direction: -1, signal: 'SELL', conf: 0.75 },
    },
    currentPrice: 2506.0,
    atr: 10.0,
  });

  const closedTrade = perfEngine.paperTrades[0];
  assert(closedTrade !== undefined && closedTrade.exitReason === 'SIGNAL_REVERSAL', `Trade cleanly closed on market signal reversal: ${closedTrade?.exitReason}`);
}

// [4] Data Integrity (No Math.random price series, No Fake Metrics)
console.log('\n[4] TEST: Data Integrity & Real Metrics Verification');
{
  const trainerCode = readFileSync('./src/engine/historical-trainer.js', 'utf-8');
  assert(!trainerCode.includes('Math.random()'), 'Zero Math.random() calls executed in historical-trainer.js');
  assert(!trainerCode.includes("algorithms[a].winRate = '68.8%'"), 'No hardcoded 68.8% algorithm winRate');
  assert(!trainerCode.includes("algorithms[a].sharpe = '2.52'"), 'No hardcoded 2.52 algorithm sharpe');

  const trainer = new HistoricalTrainer();
  const mockAlgos = [{ id: 1, name: 'PPO' }];
  trainer.calibrateBaseline(mockAlgos);
  assert(mockAlgos[0].winRate === '--', 'Initial calibrated winRate is honest standby indicator (--)');
  assert(mockAlgos[0].sharpe === '--', 'Initial calibrated sharpe is honest standby indicator (--)');
}

// [5] AttributionFeedbackEngine Real Empirical Calculation
console.log('\n[5] TEST: Attribution Feedback Engine (Zero rnd, Real Variance)');
{
  const feedbackCode = readFileSync('./src/engine/attribution-feedback.js', 'utf-8');
  assert(!feedbackCode.includes('rnd('), 'Zero rnd() calls in attribution-feedback.js');

  const feedback = new AttributionFeedbackEngine();
  const res = feedback.update(2510.0, 2500.0, 1.0, 10.0, { sliceETH: 1.0, slippageBps: 1.2 }, 0.45);
  assert(typeof res.attribution.alphaPnLUSD === 'number', 'Alpha PnL is computed numerically');
  assert(typeof res.modelDrift.driftIndex === 'number', 'Model drift index is computed numerically');
  assert(typeof res.abTesting.leader === 'string', 'A/B Leader is tracked without synthetic random bias');
}

// [6] Manual Execution Passes Exclusively Through MasterMind
console.log('\n[6] TEST: Manual Execution MasterMind Single Authority');
{
  const mm = new MastermindEngine();

  // Test normal authorized manual trade
  const approvedManual = mm.evaluateManual(1, { price: 2500.0, killSwitch: false });
  assert(approvedManual.approved === true, 'Standard manual trade approved under safe market envelope');
  assert(approvedManual.direction === 1, 'Manual BUY direction confirmed');

  // Test kill switch rejection
  const blockedManual = mm.evaluateManual(1, { price: 2500.0, killSwitch: true });
  assert(blockedManual.approved === false, 'Manual trade blocked by Emergency Kill Switch');
  assert(blockedManual.reason.includes('Emergency Kill Switch'), 'Rejection reason documented');

  // Test Kyle toxicity rejection
  const toxicManual = mm.evaluateManual(-1, { price: 2500.0, microstructure: { vpin: 0.52 } });
  assert(toxicManual.approved === false, 'Manual trade blocked by toxic informed flow');
  assert(toxicManual.reason.includes('VPIN'), 'Rejection reason identifies VPIN');
}

console.log('─────────────────────────────────────────────────────────────────');
console.log(`🏁 PRODUCTION INTEGRITY RESULTS: ${passed} PASSED, ${failed} FAILED`);
console.log('─────────────────────────────────────────────────────────────────');
if (failed > 0) {
  process.exit(1);
}
