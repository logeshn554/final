// ═══════════════════════════════════════════════════════════════════════
// Production Profit Algorithm — unit verification
// ═══════════════════════════════════════════════════════════════════════

import { ProductionProfitAlgorithm } from '../src/engine/production-profit-algorithm.js';
import { MastermindEngine } from '../src/engine/mastermind.js';

let passed = 0;
let failed = 0;

function assert(cond, name, details = '') {
  if (cond) {
    passed++;
    console.log(`✓ PASS: ${name}`);
  } else {
    failed++;
    console.error(`✗ FAIL: ${name} — ${details}`);
    throw new Error(`FAIL: ${name} (${details})`);
  }
}

export async function runProfitAlgoTests() {
  console.log('\n═══ PRODUCTION PROFIT ALGORITHM TESTS ═══\n');

  const algo = new ProductionProfitAlgorithm();

  // 1. Eligible plan with positive expectancy structure
  {
    const plan = algo.planExits({
      price: 2500,
      direction: 1,
      atr: 20,
      equity: 10000,
      regime: 'TRENDING',
      probabilityOfProfit: 0.62,
      sessionAtr: 18,
    });
    assert(plan.eligible === true, 'Builds eligible long plan in TRENDING', plan.reason);
    assert(plan.takeProfit2 > plan.takeProfit1, 'TP ladder ordered TP2 > TP1', `${plan.takeProfit1} / ${plan.takeProfit2}`);
    assert(plan.takeProfitRunner > plan.takeProfit2, 'Runner above TP2', `${plan.takeProfit2} / ${plan.takeProfitRunner}`);
    assert(plan.stopLoss < 2500, 'Long stop below entry', String(plan.stopLoss));
    assert(plan.positionETH > 0, 'Risk-budget size > 0', String(plan.positionETH));
    assert(plan.rewardRisk >= 1.35, 'Min reward/risk gate', String(plan.rewardRisk));
  }

  // 2. Vol spike blocks new risk
  {
    const plan = algo.planExits({
      price: 2500,
      direction: 1,
      atr: 40,
      sessionAtr: 20,
      equity: 10000,
      regime: 'VOLATILE',
      probabilityOfProfit: 0.7,
    });
    assert(plan.eligible === false, 'Vol spike blocks plan', plan.reason);
    assert(plan.reason === 'VOL_SPIKE_BLOCK', 'Reason is VOL_SPIKE_BLOCK', plan.reason);
  }

  // 3. Manage: TP1 scale-out + breakeven, stops never widen
  {
    const plan = algo.planExits({
      price: 2500,
      direction: 1,
      atr: 20,
      equity: 10000,
      regime: 'TRENDING',
      probabilityOfProfit: 0.60,
      sessionAtr: 20,
    });
    const trade = algo.applyPlanToTrade(plan);
    const beforeSL = trade.currentSLPrice;
    const size0 = trade.sizeETH;

    const atTp1 = algo.managePosition(trade, { price: plan.takeProfit1, atr: 20 });
    assert(trade.tp1Executed === true, 'TP1 marks executed', String(trade.tp1Executed));
    assert(trade.sizeETH < size0, 'TP1 reduces size', `${size0} → ${trade.sizeETH}`);
    assert(trade.breakevenSet === true, 'Breakeven set after TP1', String(trade.breakevenSet));
    assert(trade.currentSLPrice >= beforeSL, 'Stop never widens (long)', `${beforeSL} → ${trade.currentSLPrice}`);
    assert(atTp1.actions.some(a => a.type === 'PARTIAL_TP1'), 'Emits PARTIAL_TP1 action');
  }

  // 4. Trail only activates after +1R
  {
    const plan = algo.planExits({
      price: 2500,
      direction: 1,
      atr: 20,
      equity: 10000,
      regime: 'TRENDING',
      probabilityOfProfit: 0.60,
      sessionAtr: 20,
    });
    const trade = algo.applyPlanToTrade(plan);
    algo.managePosition(trade, { price: 2500 + plan.stopDistanceUSD * 0.4, atr: 20 });
    assert(trade.trailActive === false, 'Trail inactive before +1R', `R=${trade.rMultiple}`);

    algo.managePosition(trade, { price: 2500 + plan.stopDistanceUSD * 1.2, atr: 20 });
    assert(trade.trailActive === true, 'Trail active after +1R', `R=${trade.rMultiple}`);
  }

  // 5. MasterMind embeds profitPlan on approval path (or rejects via profit gate)
  {
    const mm = new MastermindEngine();
    const prices = Array.from({ length: 40 }, (_, i) => 2480 + i);
    const dec = mm.evaluate({
      price: 2500,
      prices,
      atr: 18,
      equity: 10000,
      dataFeedTimes: { priceTime: Date.now(), depthTime: Date.now() },
      layer1: {
        orderBook: {
          spread: 0.15,
          midPrice: 2500,
          totalBidVol: 50,
          totalAskVol: 50,
          bids: [{ price: 2499.9, size: 5 }],
          asks: [{ price: 2500.05, size: 5 }],
        },
      },
      signals: {},
      regime: 'TRENDING',
      movementPrediction: {
        predictedMovement: { conservativeMove: 25, mainMove: 45, extendedMove: 70 },
        adverseMovement: { expected: 18 },
      },
    });
    if (dec.approved) {
      assert(!!dec.profitPlan, 'Approved decision includes profitPlan');
      assert(dec.takeProfit1 > 0 && dec.takeProfit2 > 0, 'TP ladder on decision');
    } else {
      assert(dec.action === 'NO_TRADE', 'Unapproved path is NO_TRADE', dec.reason);
    }
  }

  console.log(`\n═══ RESULT: ${passed} passed, ${failed} failed ═══\n`);
  return { passed, failed };
}

runProfitAlgoTests().catch((e) => {
  console.error(e);
  process.exit(1);
});
