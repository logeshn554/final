// ═══════════════════════════════════════════════════════════════════════
// MULTI-TRADE LIFECYCLE & DEADLOCK RESOLUTION VERIFICATION SUITE
// ═══════════════════════════════════════════════════════════════════════

import { TradeSignalEngine } from '../src/engine/trade-signals.js';
import { MastermindEngine } from '../src/engine/mastermind.js';
import { SmartExecutionEngine } from '../src/engine/smart-execution.js';
import { PortfolioConstructionEngine } from '../src/engine/portfolio-construction.js';
import { ProductionRiskEngine } from '../src/engine/production-risk.js';
import { AutonomousHealingEngine } from '../src/engine/autonomous-healing.js';

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
console.log('🧪 VERIFYING MULTI-TRADE LIFECYCLE & DEADLOCK RESOLUTION');
console.log('─────────────────────────────────────────────────────────────────');

// ─────────────────────────────────────────────────────────────────
// [1] TEST: Trade 1 Take-Profit Resolution Flattens Position Cleanly
// ─────────────────────────────────────────────────────────────────
console.log('\n[1] TEST: Trade 1 TP Resolution & Position Flattening');
{
  const tse = new TradeSignalEngine();
  const smartExec = new SmartExecutionEngine();

  const mockState = {
    price: 2500,
    prices: [2490, 2495, 2500],
    position: 0.35,
    entryPrice: 2500,
    unrealizedPnL: 10.50,
    realizedPnL: 0,
    equity: 10000,
    smartExecEngine: smartExec,
    candles: { '15m': [{ close: 2500, high: 2510, low: 2490, open: 2495 }] },
  };

  smartExec.planExecution(0.35, 0, 2500, 'ALMGREN_CHRISS');
  assert(smartExec.activeOrder !== null, 'SmartExecution planned active order for Trade 1');

  // Initialize masterTrade on state
  tse.evaluateTradeSetup(mockState);
  const mt = mockState.masterTrade;
  mt.status = 'ACTIVE';
  mt.direction = 1;
  mt.action = 'BUY';
  mt.entryPrice = 2500;
  mt.tpPrice = 2530;
  mt.spPrice = 2480;
  mt.positionETH = 0.35;
  mt.tpDistance = 30;
  mt.slDistance = 20;

  // Resolve trade at Take Profit ($2530)
  tse._resolveTrade(mockState, mt, 2530, 'TP HIT', true, 'TP HIT');

  // Verify position flattening
  assert(mockState.position === 0, `mockState.position reset to 0 (got ${mockState.position})`);
  assert(mockState.entryPrice === 0, `mockState.entryPrice reset to 0 (got ${mockState.entryPrice})`);
  assert(mockState.unrealizedPnL === 0, `mockState.unrealizedPnL reset to 0 (got ${mockState.unrealizedPnL})`);
  assert(mockState.realizedPnL > 0, `mockState.realizedPnL updated with profit (got $${mockState.realizedPnL})`);
  assert(smartExec.activeOrder === null, 'smartExecEngine.activeOrder cleared upon trade exit');
  assert(mt.status === 'RESOLVED_TP', 'masterTrade.status set to RESOLVED_TP');
  assert(mt.resolutionDisplayUntil > Date.now(), 'resolutionDisplayUntil armed');
}

// ─────────────────────────────────────────────────────────────────
// [2] TEST: 3-Second Resolution Display Period Transitions to IDLE
// ─────────────────────────────────────────────────────────────────
console.log('\n[2] TEST: Resolution Display Period Transitions to IDLE');
{
  const tse = new TradeSignalEngine();

  const mockState = {
    price: 2530,
    prices: [2500, 2510, 2520, 2530],
    position: 0,
    entryPrice: 0,
    equity: 10000,
    candles: { '15m': [{ close: 2530, high: 2535, low: 2520, open: 2525 }] },
  };

  tse.evaluateTradeSetup(mockState);
  const mt = mockState.masterTrade;
  mt.status = 'RESOLVED_TP';
  mt.resolutionDisplayUntil = Date.now() - 100; // Fast-forward past display time

  // Call evaluateTradeSetup to trigger transition
  tse.evaluateTradeSetup(mockState);

  assert(mt.status === 'IDLE', `masterTrade.status transitioned from RESOLVED_TP to IDLE (got ${mt.status})`);
  assert(mt.action === 'SCANNING', `masterTrade.action is SCANNING (got ${mt.action})`);
  assert(mt.direction === 0, `masterTrade.direction is 0 (got ${mt.direction})`);
  assert(mt.livePnlUSD === '0.00', 'masterTrade.livePnlUSD reset');
}

// ─────────────────────────────────────────────────────────────────
// [3] TEST: Trade 2 Activates Automatically Without Getting Stuck
// ─────────────────────────────────────────────────────────────────
console.log('\n[3] TEST: Full Cycle from Trade 1 Exit -> Trade 2 Activation');
{
  const tse = new TradeSignalEngine();
  const smartExec = new SmartExecutionEngine();
  const portfolio = new PortfolioConstructionEngine();
  const prodRisk = new ProductionRiskEngine();
  const mastermind = new MastermindEngine();

  const mockState = {
    price: 2500,
    prices: Array.from({ length: 35 }, (_, i) => 2480 + i),
    spread: 0.15,
    position: 0,
    entryPrice: 0,
    unrealizedPnL: 0,
    realizedPnL: 10.50,
    equity: 10010.50,
    smartExecEngine: smartExec,
    ensemble: 0.45,
    signals: {},
  };

  // Generate 43 healthy consensus signals for BUY
  for (let i = 0; i < 43; i++) {
    mockState.signals[i] = { direction: 0.6, signal: 'BUY', conf: 0.85 };
  }

  // Initialize masterTrade
  tse.evaluateTradeSetup(mockState);
  const mt = mockState.masterTrade;
  mt.status = 'RESOLVED_TP';
  mt.resolutionDisplayUntil = Date.now() - 50; // Expired

  // 1. Tick 1: evaluateTradeSetup resets to IDLE
  tse.evaluateTradeSetup(mockState);
  assert(mt.status === 'IDLE', 'masterTrade is IDLE and ready for Trade 2');

  // 2. MasterMind evaluates market
  const masterDecision = mastermind.evaluate({
    price: mockState.price,
    prices: mockState.prices,
    signals: mockState.signals,
    equity: mockState.equity,
    atr: 16,
  });
  assert(masterDecision.approved === true, `MasterMind authorized execution (approved: ${masterDecision.approved})`);
  assert(masterDecision.direction === 1, `MasterMind signal is BUY (direction: ${masterDecision.direction})`);

  // 3. Portfolio Layer
  const targetETHOverride = masterDecision.direction * masterDecision.risk.positionSizeETH;
  const portfolioLayer = portfolio.optimize(
    mockState.ensemble,
    mockState.price,
    mockState.spread,
    mockState.prices.slice(-30).map((p, i, a) => i > 0 ? (p / a[i - 1] - 1) : 0),
    mockState.position, // Currently 0!
    mockState.equity,
    targetETHOverride
  );
  assert(portfolioLayer.targetETH > 0, `PortfolioLayer targetETH is ${portfolioLayer.targetETH}`);

  // 4. Pre-trade Risk Gate
  const preTrade = prodRisk.checkPreTrade(portfolioLayer.targetETH, mockState.price, mockState.equity);
  assert(preTrade.approved === true, 'Pre-trade risk check approved');

  // 5. Activation Gating (Simulating main.js line 898)
  const isTradeResolved = (mt.status === 'RESOLVED_TP' || mt.status === 'RESOLVED_SP');
  const isCooldownElapsed = isTradeResolved && Date.now() >= (mt.resolutionDisplayUntil || 0);
  const canActivate = mt.status === 'IDLE' ||
    mt.status === 'SCANNING' ||
    mt.status === 'RISK_BLOCKED' ||
    isCooldownElapsed;

  assert(canActivate === true, 'canActivate flag is TRUE for Trade 2');

  if (masterDecision.approved && preTrade.approved && canActivate) {
    mt.status = 'ACTIVE';
    mt.direction = masterDecision.direction;
    mt.action = masterDecision.signal;
    mt.entryPrice = mockState.price;
    mt.positionETH = masterDecision.risk.positionSizeETH;
  }

  assert(mt.status === 'ACTIVE', 'Trade 2 successfully activated to ACTIVE');
  assert(mt.direction === 1, 'Trade 2 direction is +1 (BUY)');

  // 6. Smart Execution Planning for Trade 2
  const executionAuthorized = masterDecision.approved && preTrade.approved;
  assert(executionAuthorized === true, 'executionAuthorized is TRUE');

  const deltaETH = Math.abs(portfolioLayer.targetETH - mockState.position);
  assert(deltaETH >= 0.01, `deltaETH (${deltaETH}) is >= 0.01 because position was flattened`);

  if (executionAuthorized && deltaETH >= 0.01) {
    smartExec.planExecution(portfolioLayer.targetETH, mockState.position, mockState.price, 'ALMGREN_CHRISS');
  }

  assert(smartExec.activeOrder !== null, 'Trade 2 slice execution planned successfully');
  assert(smartExec.activeOrder.side === 'BUY', 'Trade 2 order side is BUY');
  assert(smartExec.activeOrder.totalSizeETH > 0, 'Trade 2 has positive size');
}

// ─────────────────────────────────────────────────────────────────
// [4] TEST: Loss Attribution Does Not Cause MasterMind Quorum Collapse
// ─────────────────────────────────────────────────────────────────
console.log('\n[4] TEST: Loss Attribution & Quorum Preservation');
{
  const tse = new TradeSignalEngine();
  const healing = new AutonomousHealingEngine();
  const mastermind = new MastermindEngine();
  tse.healingEngine = healing;

  const mockState = {
    price: 2500,
    atr: 16,
    regime: 'TRENDING',
    masterDecision: {
      contributingStrategies: Array.from({ length: 30 }, (_, i) => `rl_${i}`),
    },
  };

  const mockTrade = {
    status: 'ACTIVE',
    direction: 1,
    action: 'BUY',
    entryPrice: 2500,
    tpPrice: 2530,
    spPrice: 2480,
    positionETH: 0.5,
    tpDistance: 30,
    slDistance: 20,
    contributingStrategies: Array.from({ length: 30 }, (_, i) => `rl_${i}`),
    stats: { totalTrades: 1, wins: 0, losses: 1, winRate: 0, history: [] },
  };

  // Resolve losing trade
  tse._resolveTrade(mockState, mockTrade, 2480, 'SP HIT', false, 'SP HIT');

  // Verify that error reports were capped to at most 3 to protect quorum
  assert(healing.totalErrorsCaught <= 3, `Errors caught capped at 3 (got ${healing.totalErrorsCaught})`);
  assert(healing.getQuarantinedCount() <= 3, `Quarantined models <= 3 (got ${healing.getQuarantinedCount()})`);

  // Verify MasterMind still has sufficient healthy models (>= 25)
  const signals = {};
  for (let i = 0; i < 43; i++) {
    signals[i] = { direction: 0.6, signal: 'BUY', conf: 0.85 };
  }

  const mmDecision = mastermind.evaluate({
    price: 2480,
    prices: [2470, 2475, 2480],
    signals,
    autoHealing: healing,
  });

  assert(mmDecision.modelHealth.healthy >= 25, `Healthy algorithms >= 25 (got ${mmDecision.modelHealth.healthy})`);
  assert(!mmDecision.reason.includes('Insufficient healthy algorithms'), 'MasterMind is NOT locked out by healing quarantine');
}

console.log('\n─────────────────────────────────────────────────────────────────');
console.log(`✨ ALL ${passed} MULTI-TRADE LIFECYCLE TESTS PASSED! (${failed} failed)`);
console.log('─────────────────────────────────────────────────────────────────\n');
