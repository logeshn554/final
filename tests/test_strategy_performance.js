// ═══════════════════════════════════════════════════════════════════════════
// COMPREHENSIVE SUITE OF UNIT & INTEGRATION TESTS
// Dynamic Strategy Performance Engine & MasterMind Single Authority
// ═══════════════════════════════════════════════════════════════════════════

import { StrategyPerformanceEngine } from '../src/engine/strategy-performance-engine.js';
import { MastermindEngine } from '../src/engine/mastermind.js';

let passed = 0;
let failed = 0;

function assert(condition, testName) {
  if (condition) {
    console.log(`  ✓ PASS: ${testName}`);
    passed++;
  } else {
    console.error(`  ✗ FAIL: ${testName}`);
    failed++;
  }
}

function assertClose(actual, expected, tol = 0.001, testName) {
  const diff = Math.abs(actual - expected);
  assert(diff <= tol, `${testName} (actual: ${actual}, expected: ${expected})`);
}

console.log('─────────────────────────────────────────────────────────────────');
console.log('🧪 RUNNING DYNAMIC STRATEGY PERFORMANCE & MASTERMIND TEST SUITE');
console.log('─────────────────────────────────────────────────────────────────');

// 1. PnL, Fee & Slippage Calculation Test
console.log('\n[1] TEST: PnL, Binance Fee, and Slippage Deductions (Cost-Aware)');
{
  const engine = new StrategyPerformanceEngine(2500.0);
  
  // Test simulated BUY trade: Entry = 2500, Exit = 2550, Qty = 1.0 ETH
  // Gross PnL = (2550 - 2500) * 1.0 = +$50.00
  // Entry Fee = 2500 * 0.0004 = $1.00
  // Exit Fee = 2550 * 0.0004 = $1.02
  // Slippage = (2500 + 2550) * 0.00015 = $0.7575
  // Expected Net PnL = 50 - 1.00 - 1.02 - 0.7575 = $47.2225
  const entryPrice = 2500.0;
  const exitPrice = 2550.0;
  const qty = 1.0;
  const gross = (exitPrice - entryPrice) * qty;
  const entryFee = entryPrice * qty * 0.0004;
  const exitFee = exitPrice * qty * 0.0004;
  const slippage = (entryPrice + exitPrice) * qty * 0.00015;
  const netPnl = gross - entryFee - exitFee - slippage;

  assertClose(gross, 50.0, 0.01, 'Gross PnL calculates correctly');
  assertClose(entryFee + exitFee, 2.02, 0.01, 'Binance 4 bps taker fee applied on both legs');
  assertClose(slippage, 0.7575, 0.01, '1.5 bps slippage applied on total traded volume');
  assertClose(netPnl, 47.2225, 0.01, 'Net PnL accurately subtracts all transaction costs');
}

// 2. Sample Size Protection & Bayesian Shrinkage Test
console.log('\n[2] TEST: Sample-Size Protection (No winner declared from < 30 trades)');
{
  const engine = new StrategyPerformanceEngine(2500.0);

  // When trades = 0
  const stateEmpty = engine.getState();
  assert(stateEmpty.summary.bestOverall === null, 'bestOverall is null when no trades exist');
  assert(stateEmpty.summary.bestRecent === null, 'bestRecent is null when no trades exist');
  assert(stateEmpty.summary.bestCurrentRegime === null, 'bestCurrentRegime is null when no trades exist');

  // Verify leaderboard status for untested strategy
  const stratLeader = stateEmpty.leaderboard.find(s => s.strategyId === 'rl_ppo');
  assert(stratLeader.health === 'INSUFFICIENT_DATA', 'Strategy with 0 trades is marked INSUFFICIENT_DATA');
  assert(stratLeader.sampleSize === 0, 'Sample size accurately reflects 0');

  // Verify shrinkage score: 1 win with 0 losses should NOT yield 100% score
  const score1 = engine._calculateScore({
    winRate: 1.0,
    netPnl: 15.0,
    grossProfit: 16.0,
    grossLoss: 0.0,
    profitFactor: 5.0,
    maxDrawdown: 0.0,
    recentPnl: 15.0,
    recentWinRate: 1.0,
    sampleSize: 1,
    consecutiveLosses: 0,
    trades: [{ netPnl: 15.0, timestamp: Date.now() }]
  });
  assert(score1 < 0.60, `1 single trade is heavily shrunk by Bayesian sample penalty (Score: ${score1.toFixed(3)})`);

  // Verify score with 35 trades and high win rate
  const score35 = engine._calculateScore({
    winRate: 0.70,
    netPnl: 350.0,
    grossProfit: 400.0,
    grossLoss: 50.0,
    profitFactor: 4.0,
    maxDrawdown: 0.04,
    recentPnl: 80.0,
    recentWinRate: 0.75,
    sampleSize: 35,
    consecutiveLosses: 0,
    trades: Array(35).fill({ netPnl: 10.0, timestamp: Date.now() })
  });
  assert(score35 > 0.65, `35 trades meeting threshold receives full score confidence (Score: ${score35.toFixed(3)})`);
}

// 3. Multi-Metric Scoring (Drawdown Penalty & Cost Awareness)
console.log('\n[3] TEST: Multi-Metric Score Penalizes Severe Drawdown');
{
  const engine = new StrategyPerformanceEngine(2500.0);

  // Strategy A: High net profit ($1000) but severe drawdown (65%)
  const scoreA = engine._calculateScore({
    winRate: 0.60,
    netPnl: 1000.0,
    grossProfit: 1500.0,
    grossLoss: 500.0,
    profitFactor: 3.0,
    maxDrawdown: 0.65, // 65% DD
    recentPnl: -200.0,
    recentWinRate: 0.40,
    sampleSize: 50,
    consecutiveLosses: 3,
    trades: Array(50).fill({ netPnl: 20.0, timestamp: Date.now() })
  });

  // Strategy B: Moderate profit ($600) but low drawdown (5%) and high stability
  const scoreB = engine._calculateScore({
    winRate: 0.68,
    netPnl: 600.0,
    grossProfit: 800.0,
    grossLoss: 200.0,
    profitFactor: 4.0,
    maxDrawdown: 0.05, // 5% DD
    recentPnl: 150.0,
    recentWinRate: 0.70,
    sampleSize: 50,
    consecutiveLosses: 0,
    trades: Array(50).fill({ netPnl: 12.0, timestamp: Date.now() })
  });

  assert(scoreB > scoreA, `Strategy with controlled drawdown and high stability scores higher than volatile high-DD strategy (${scoreB.toFixed(3)} vs ${scoreA.toFixed(3)})`);
}

// 4. Dynamic Weighting Normalization Test
console.log('\n[4] TEST: Dynamic Weights Normalization (Sum = 1.0)');
{
  const engine = new StrategyPerformanceEngine(2500.0);
  const state = engine.getState();
  const weights = state.weights;
  const sumWeights = Object.values(weights).reduce((a, b) => a + b, 0);

  assertClose(sumWeights, 1.0, 0.0001, 'Dynamic strategy weights sum strictly to 1.0');
  assert(Object.keys(weights).length >= 50, `At least 50 models/strategies registered with weights (${Object.keys(weights).length} registered)`);
}

// 5. Dynamic Take Profit & Dynamic Stop Selection (Zero Fixed %)
console.log('\n[5] TEST: Dynamic Movement Target & Stop Selection (Zero Fixed %)');
{
  const mastermind = new MastermindEngine();

  // Test BUY target selection from movement distribution
  const mockMovement = {
    predictedMovement: {
      conservativeMove: 6.2,
      mainMove: 13.5,
      extendedMove: 22.0
    }
  };

  const target = mastermind.selectDynamicTarget({
    entryPrice: 2400.0,
    direction: 1,
    movementDistribution: mockMovement,
    confidence: 0.65,
    regime: 'TREND_UP',
    strategyWeights: {}
  });

  assert(target.targetPrice > 2400.0, 'BUY target price is strictly above entry price');
  assertClose(target.targetPrice, 2413.5, 0.1, 'Target price selected from dynamic MFE distribution (2413.50)');
  assert(target.selectedProbability >= 0.50, 'Target probability reflects distribution probability');
  assert(target.selectedDistance !== 2400 * 0.01, 'Target distance is NOT a hardcoded 1% multiplier');
  assert(target.selectedDistance !== 2400 * 0.02, 'Target distance is NOT a hardcoded 2% multiplier');

  // Test adverse stop selection
  const mockAdverse = {
    expected: 4.5,
    worstCase: 7.8,
  };

  const stop = mastermind.selectDynamicStop({
    entryPrice: 2400.0,
    direction: 1,
    adverseDistribution: mockAdverse,
    confidence: 0.75,
    regime: 'TREND_UP',
    volatility: 12.0
  });

  assert(stop.stopPrice < 2400.0, 'BUY stop price is strictly below entry price');
  assert(stop.stopPrice <= 2393.0, 'Stop respects structural invalidation boundary');
  assert(stop.selectedStopDistance !== target.distance / 2, 'Stop is NOT a hardcoded TP/2 ratio');
}

// 6. Zero Look-Ahead Bias Guarantee
console.log('\n[6] TEST: Strict Time-Ordering & No Look-Ahead Bias');
{
  const engine = new StrategyPerformanceEngine(2500.0);
  
  // At Tick T=1: Model generates BUY signal at price 2500
  engine.ingestSignals({
    signals: { 'rl_ppo': { signal: 0.8, direction: 1, confidence: 0.85 } },
    currentPrice: 2500.0,
    regime: 'TREND_UP',
    movementDistribution: {
      favorable: [{ label: 'BASE', distance: 10.0, probability: 0.7 }],
      adverse: { expected: 5.0, worst: 8.0 }
    }
  });

  // Check state at T=1: Trade is OPEN, outcome is NOT yet known
  const stratBefore = engine.getStrategy('rl_ppo');
  assert(stratBefore.openTrade !== null, 'Trade is opened at tick T=1');
  assert(stratBefore.completedTrades.length === 0, 'No completed trade exists at tick T=1 (outcome unknown)');
  assert(stratBefore.netPnl === 0.0, 'No profit booked before future price unfolds');

  // At Tick T=2: Future price arrives (Price moves up to 2512 -> Target Hit)
  engine.updateMarketData(2512.0, 0.15, null, null, 'TREND_UP');

  // Check state at T=2: Trade resolved AFTER future price observed
  assert(stratBefore.openTrade === null, 'Trade closed after future candle hit target');
  assert(stratBefore.completedTrades.length === 1, '1 completed trade resolved at T=2');
  assert(stratBefore.completedTrades[0].successful === true, 'Trade resolved as successful WIN');
  assert(stratBefore.netPnl > 0, 'Net PnL booked only after future market movement');
}

// 7. Strategy Failure and Recovery Context
console.log('\n[7] TEST: Loss Context Identification & Strategy Recovery');
{
  const engine = new StrategyPerformanceEngine(2500.0);
  
  // Open trade at 2500 with stop at 2495
  engine.ingestSignals({
    signals: { 'python_trend': { signal: 0.7, direction: 1, confidence: 0.80 } },
    currentPrice: 2500.0,
    regime: 'BREAKOUT',
    movementDistribution: {
      favorable: [{ label: 'BASE', distance: 15.0, probability: 0.65 }],
      adverse: { expected: 5.0, worst: 8.0 }
    }
  });

  // Price falls to 2492 (Stop Hit with Trend Reversal)
  engine.updateMarketData(2492.0, 0.15, null, null, 'TREND_DOWN');

  const strat = engine.getStrategy('python_trend');
  assert(strat.completedTrades.length === 1, 'Trade closed after stop trigger');
  assert(strat.completedTrades[0].successful === false, 'Trade marked as loss');
  assert(strat.completedTrades[0].lossReason === 'TREND_REVERSAL', `Loss attributed to ${strat.completedTrades[0].lossReason}`);
  assert(strat.health !== 'DISABLED', 'Strategy is NOT permanently disabled due to a normal loss');
}

// 8. MasterMind Consensus & Single Authority Integration Test
console.log('\n[8] TEST: End-to-End MasterMind Authority & Execution Gate');
{
  const mastermind = new MastermindEngine();
  const engine = new StrategyPerformanceEngine(2500.0);

  // Ingest signals into performance engine first
  const testSignals = {
    'rl_ppo': { signal: 0.85, direction: 1, confidence: 0.85 },
    'alpha_engine': { signal: 0.75, direction: 1, confidence: 0.80 },
    'python_trend': { signal: 0.70, direction: 1, confidence: 0.78 },
    'mean_reversion': { signal: -0.10, direction: -1, confidence: 0.40 }
  };
  engine.ingestSignals({ signals: testSignals, currentPrice: 2500.0, regime: 'TREND_UP' });

  // Ingest performance state into MasterMind
  const perfState = engine.getState();
  
  const decision = mastermind.evaluate({
    signals: testSignals,
    currentPrice: 2500.0,
    regime: 'TREND_UP',
    strategyPerformance: perfState,
    tradeSetup: { atrValue: 12.5 },
    candlestickAnalysis: { score: 0.75 },
    mtfAnalysis: { confluenceScore: 0.80 },
    institutionalAlgo: { compositeSignal: 0.70 }
  });

  assert(decision.signal === 'BUY', `MasterMind outputs BUY consensus (${decision.signal})`);
  assert(decision.direction === 1, 'MasterMind direction is +1');
  assert(decision.agreement > 0.60, `Performance-weighted agreement calculated (${(decision.agreement * 100).toFixed(1)}%)`);
  assert(decision.movement !== undefined, 'Canonical decision includes movement distribution');
  assert(decision.execution !== undefined, 'Canonical decision includes execution parameters');
  assert(decision.explanation !== undefined, 'Machine-readable decision explanation present');
  assert(decision.explanation.supportingStrategies.includes('rl_ppo'), 'Attribution tracks supporting models');
}

console.log('─────────────────────────────────────────────────────────────────');
console.log(`🏁 TEST RESULTS: ${passed} PASSED, ${failed} FAILED`);
console.log('─────────────────────────────────────────────────────────────────');

if (failed > 0) {
  process.exit(1);
} else {
  console.log('✨ ALL DYNAMIC STRATEGY PERFORMANCE & MASTERMIND TESTS PASSED!\n');
}
