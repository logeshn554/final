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

function assertClose(actual, expected, tol = 0.05, message = '') {
  const diff = Math.abs(actual - expected);
  assert(diff <= tol, `${message} (actual: ${actual}, expected: ${expected})`);
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
    movementPrediction: {
      // The field expected by ingestSignals is adverseMovement (not adverseDistribution)
      predictedMovement: { mainMove: 12.0 },
      adverseMovement: { expected: 6.0 },
    },
  });

  const openTrade = perfEngine.openTrades['microstructure_deep'];
  assert(openTrade !== undefined, 'Microstructure trade opened');
  const initialStop = openTrade.predictedStop;

  // Price moves favorably towards target (+11 pts — exceeds 40% of any regime-scaled ATR target)
  perfEngine.updateMarketData(2511.0, 0.15, null, null, 'BREAKOUT');
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
  const perfEngine = new StrategyPerformanceEngine(2500.0);
  const perfState = perfEngine.getState('TREND_UP');

  // Provide strong directional signals so confidence >= 0.40
  const richSignals = {};
  for (let i = 0; i < 10; i++) {
    richSignals[`rl_algo_${i}`] = { direction: 1, signal: 'BUY', conf: 0.82 };
  }
  const richCtx = {
    price: 2500.0,
    signals: richSignals,
    strategyPerformance: { ...perfState, signals: richSignals, weights: {}, strategies: {} },
    pythonEngineDecision: { signal: 'BUY', confidence: 0.80 },
    killSwitch: false,
  };

  // Test normal authorized manual trade
  const approvedManual = mm.evaluateManual(1, richCtx);
  assert(approvedManual.approved === true, `Standard manual trade approved under safe market envelope (conf: ${(approvedManual.confidence * 100).toFixed(1)}%)`);
  assert(approvedManual.direction === 1, 'Manual BUY direction confirmed');

  // Test kill switch rejection
  const blockedManual = mm.evaluateManual(1, { ...richCtx, killSwitch: true });
  assert(blockedManual.approved === false, 'Manual trade blocked by Emergency Kill Switch');
  assert(blockedManual.reason.includes('Emergency Kill Switch'), 'Rejection reason documented');

  // Test Kyle toxicity rejection
  const toxicManual = mm.evaluateManual(-1, { ...richCtx, microstructure: { vpin: 0.52 } });
  assert(toxicManual.approved === false, 'Manual trade blocked by toxic informed flow');
  assert(toxicManual.reason.includes('VPIN'), 'Rejection reason identifies VPIN');

  // Test confidence floor gate
  const lowConfCtx = { price: 2500.0, signals: {}, strategyPerformance: { weights: {}, signals: {}, strategies: {} }, killSwitch: false };
  const lowConfManual = mm.evaluateManual(1, lowConfCtx);
  assert(lowConfManual.approved === false || lowConfManual.confidence >= 0.40, 'Manual trade either declined (low conf) or approved at adequate confidence');
}

// [7] Data Quality Gate: Requires priceFresh AND (depthFresh OR klinesFresh)
console.log('\n[7] TEST: Data Quality Gate Freshness Requirements');
{
  const mainCode = readFileSync('./src/main.js', 'utf-8');
  // Gate must require priceFresh (not just STATE.price > 0)
  assert(mainCode.includes('priceFresh &&'), 'Gate requires priceFresh condition');
  // Gate must combine depth or klines (not just presence)
  assert(mainCode.includes('depthFresh || klinesFresh'), 'Gate uses depthFresh OR klinesFresh disjunction');
  // No old loose guard (price !== null && STATE.prices.length >= 5) allowed as the sole gate
  assert(!mainCode.includes("STATE.price !== null && STATE.price > 0 && STATE.prices.length >= 5 && STATE.connection.status !== 'offline'"), 'Old loose gate condition replaced with fresh-data checks');
  // Gate must differentiate label between full vs. partial data
  assert(mainCode.includes('GATE_OPEN (LIVE PRICE + ORDER BOOK)'), 'Gate label correctly distinguishes full vs partial data availability');
}

// [8] masterTrade lifecycle: stays SCANNING when preTrade blocks
console.log('\n[8] TEST: masterTrade Does Not Activate Without Pre-Trade Risk Approval');
{
  const mainCode = readFileSync('./src/main.js', 'utf-8');
  // The new activation block must gate on BOTH masterDecision.approved AND preTrade.approved
  assert(mainCode.includes('masterDecision.approved && preTrade.approved && STATE.masterTrade.status === \'IDLE\''),
    'masterTrade ACTIVE status only set when masterDecision.approved AND preTrade.approved');
  // RISK_BLOCKED status must be set when MasterMind approved but risk gate failed
  assert(mainCode.includes('RISK_BLOCKED'), 'RISK_BLOCKED status set when pre-trade risk gate fails');
  // The premature early-block (before pre-trade) must no longer exist
  assert(!mainCode.includes('masterDecision.approved && STATE.masterTrade.status === \'IDLE\' && !preTrade'),
    'No premature masterTrade ACTIVE activation before pre-trade gate');
}

// [9] Manual Trade Confidence Gate
console.log('\n[9] TEST: evaluateManual() Confidence Gate (>= 0.40 floor)');
{
  const mmCode = readFileSync('./src/engine/mastermind.js', 'utf-8');
  // evaluateManual must check confidence threshold (not just kill switch + VPIN)
  assert(mmCode.includes('baseDecision.confidence < 0.40'),
    'evaluateManual applies minimum confidence threshold of 0.40');
  assert(mmCode.includes('manual safety floor'),
    'evaluateManual rejection message explains the safety floor requirement');
}

// [10] Attribution Engine: No Hardcoded Beta
console.log('\n[10] TEST: Attribution Engine Empirical Beta (No 0.35 Fixed Coefficient)');
{
  const attrCode = readFileSync('./src/engine/attribution-feedback.js', 'utf-8');
  // Old hardcoded beta line must be gone
  assert(!attrCode.includes('priceDelta * 0.35'), 'Old hardcoded beta 0.35 removed from attribution');
  // Old hardcoded execution coefficient must be gone
  assert(!attrCode.includes('execResult.sliceETH * 0.15'), 'Old hardcoded execution savings coefficient 0.15 removed');
  // Old synthetic drift line must be gone
  assert(!attrCode.includes('alphaDrift * 0.25'), 'Old synthetic drift heuristic |alpha|*0.25 replaced');
  // New empirical beta must be present
  assert(attrCode.includes('_betaEstimate'), 'Rolling empirical beta estimation field present');
  // New z-score drift must be present
  assert(attrCode.includes('zScore / 3.0'), 'Rolling z-score drift detection present');

  const feedback = new AttributionFeedbackEngine();
  // Pump 25 ticks with a varying price series (non-constant delta) so OLS variance is non-zero
  const testPrices = [2500, 2502, 2499, 2504, 2501, 2507, 2503, 2509, 2505, 2511,
                      2507, 2513, 2510, 2515, 2512, 2518, 2514, 2520, 2516, 2522,
                      2518, 2524, 2521, 2526, 2523, 2529];
  for (let i = 1; i < testPrices.length; i++) {
    feedback.update(testPrices[i], testPrices[i - 1], 1.0, (i - 1) * 0.5, null, 0.1 + Math.sin(i) * 0.05);
  }
  assert(feedback._betaEstimate !== null, 'Empirical beta estimated after 20+ ticks (not stuck at prior)');
  assert(typeof feedback._betaEstimate === 'number', 'Empirical beta is a number');
  assert(isFinite(feedback._betaEstimate), 'Empirical beta is finite');
  assert(feedback.modelDrift.driftIndex >= 0 && feedback.modelDrift.driftIndex <= 1,
    `Drift index in [0,1] range: ${feedback.modelDrift.driftIndex}`);
}

// [11] Autonomous Dynamic TP & SL Detection for all 43 RL Algorithms (Zero Fixed Ratios)
console.log('\n[11] TEST: All 43 RL Algorithms Autonomous Dynamic TP & SL Detection (Paper Trading)');
{
  const { createAlgorithms } = await import('../src/algorithms/index.js');
  const { StrategyPerformanceEngine } = await import('../src/engine/strategy-performance-engine.js');
  const { AlgoCapitalBenchmarkEngine } = await import('../src/engine/algo-capital-benchmark.js');

  const algos = createAlgorithms();
  assert(algos.length === 43, `All 43 RL algorithms loaded (found: ${algos.length})`);

  // Verify source code is free of hardcoded multipliers and fixed ratios
  const baseCode = readFileSync('./src/algorithms/base.js', 'utf-8');
  assert(!baseCode.includes('0.85 + Math.min'), 'BaseAlgorithm has NO hardcoded 0.85 multiplier');
  assert(!baseCode.includes('1.05 - Math.min'), 'BaseAlgorithm has NO hardcoded 1.05 multiplier');
  assert(!baseCode.includes('atr * 0.75'), 'BaseAlgorithm has NO hardcoded atr * 0.75 fallback');

  const diagCode = readFileSync('./src/engine/algo-diagnostics.js', 'utf-8');
  assert(!diagCode.includes('horizonMultiplier = 1.0'), 'algo-diagnostics has NO horizonMultiplier parameter');
  assert(!diagCode.includes('fav * (0.85'), 'algo-diagnostics has NO fav * 0.85 multiplier');

  const benchCode = readFileSync('./src/engine/algo-capital-benchmark.js', 'utf-8');
  assert(!benchCode.includes('acc.id % 2 === 0'), 'AlgoCapitalBenchmarkEngine has NO arbitrary even-ID BUY fallback');
  assert(!benchCode.includes('Math.random() - 0.485'), 'AlgoCapitalBenchmarkEngine has NO random tick generator');

  const mockFeatures = new Float64Array(20).fill(0.05);
  const mockContext = {
    price: 2500.0,
    atr: 16.0,
    movementPrediction: {
      predictedMovement: { conservativeMove: 14.0, mainMove: 22.0, extendedMove: 32.0 },
      adverseMovement: { expected: 11.0, worst: 19.0 },
    },
  };

  const detectedDistances = new Set();
  let allEmittedLevels = true;
  let allCorrectDirection = true;

  for (const algo of algos) {
    algo.signal = (algo.id % 2 === 0) ? 0.75 : -0.75;
    algo.confidence = 0.80;
    const sig = algo.getSignal(mockFeatures, mockContext);

    if (!sig.tpPrice || !sig.slPrice || !sig.tpDistance || !sig.slDistance) {
      allEmittedLevels = false;
    }

    detectedDistances.add(sig.tpDistance);

    if (sig.direction > 0) {
      if (sig.tpPrice <= 2500.0 || sig.slPrice >= 2500.0) allCorrectDirection = false;
    } else if (sig.direction < 0) {
      if (sig.tpPrice >= 2500.0 || sig.slPrice <= 2500.0) allCorrectDirection = false;
    }
  }

  assert(allEmittedLevels, 'All 43 RL algorithms automatically emit dynamic TP & SL levels');
  assert(allCorrectDirection, 'All 43 RL algorithms set TP in favorable direction and SL in adverse direction');
  assert(detectedDistances.size > 1, `TP distances vary dynamically based on algorithm mechanics (found ${detectedDistances.size} distinct distances, NO fixed ratio)`);

  // Verify StrategyPerformanceEngine paper trading across multiple diverse RL algorithms
  const perfEngine = new StrategyPerformanceEngine(2500.0);
  const sampleAlgos = [
    { key: 'rl_ppo', algo: algos[17], sigVal: 0.85, conf: 0.90 },
    { key: 'rl_dqn', algo: algos[11], sigVal: -0.80, conf: 0.85 },
    { key: 'rl_sac', algo: algos[20], sigVal: 0.75, conf: 0.80 },
    { key: 'rl_qrdqn', algo: algos[34], sigVal: 0.70, conf: 0.75 },
    { key: 'rl_cpo', algo: algos[41], sigVal: -0.65, conf: 0.70 },
  ];

  const ingestBatch = {};
  const expectedSignals = {};
  for (const item of sampleAlgos) {
    item.algo.signal = item.sigVal;
    item.algo.confidence = item.conf;
    const sig = item.algo.getSignal(null, mockContext);
    ingestBatch[item.key] = sig;
    expectedSignals[item.key] = sig;
  }

  perfEngine.ingestSignals({
    signals: ingestBatch,
    currentPrice: 2500.0,
    atr: 16.0,
    movementPrediction: mockContext.movementPrediction,
  });

  for (const item of sampleAlgos) {
    const trade = perfEngine.openTrades[item.key];
    const expSig = expectedSignals[item.key];
    assert(trade !== undefined, `${item.key} paper trade successfully opened in StrategyPerformanceEngine`);
    assertClose(trade.predictedTarget, expSig.tpPrice, 0.05, `${item.key} target strictly matches self-detected dynamic TP`);
    assertClose(trade.predictedStop, expSig.slPrice, 0.05, `${item.key} stop strictly matches self-detected dynamic SL`);
  }

  // Verify AlgoCapitalBenchmarkEngine: directional algorithms enter trades, neutral algorithms remain flat
  const benchmark = new AlgoCapitalBenchmarkEngine(2500.0);
  const signalsMap = {};
  for (const a of algos) {
    signalsMap[a.id] = a.getSignal(mockFeatures, mockContext);
  }
  // Explicitly set an even-ID algorithm to completely neutral
  signalsMap[10] = { signal: 0, direction: 0, conf: 0.5 };

  benchmark.tick(2500.0, signalsMap, mockContext.movementPrediction);

  const acc18 = benchmark.algoAccounts[18];
  assert(acc18 && acc18.activeTrade !== null, 'Algo 18 opened paper trade in $10 capital arena');
  assert(acc18.activeTrade.tpPrice > 0, 'Arena paper trade has dynamic TP price');
  assert(acc18.activeTrade.slPrice > 0, 'Arena paper trade has dynamic SL price');
  assert(acc18.activeTrade.tpPct !== 0.20, 'Arena paper trade does NOT use legacy fixed 0.20% ratio');

  // Verify neutral algorithm ID 10 did NOT open a trade (arbitrary even-ID BUY fallback eliminated)
  const acc10 = benchmark.algoAccounts[10];
  assert(acc10 && acc10.activeTrade === null, 'Neutral algorithm (ID 10) remained FLAT without arbitrary BUY entry');
}

console.log('─────────────────────────────────────────────────────────────────');
console.log(`🏁 PRODUCTION INTEGRITY RESULTS: ${passed} PASSED, ${failed} FAILED`);
console.log('─────────────────────────────────────────────────────────────────');
if (failed > 0) {
  process.exit(1);
}
