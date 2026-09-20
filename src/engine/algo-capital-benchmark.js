// ═══════════════════════════════════════════════════════
// $10 CAPITAL BENCHMARK ENGINE — Real-Area Efficiency & Live Win Rate Arena
// Allocates $10.00 capital to all 34 algorithms and tracks real-world trading efficiency
// ═══════════════════════════════════════════════════════

import { ALGORITHMS } from '../config.js';
import { ALGO_PROFILES } from './algo-diagnostics.js';

const STORAGE_KEY = 'antigravity_algo_capital_benchmark_v3_dynamic';

export class AlgoCapitalBenchmarkEngine {
  constructor(initialPrice = 2608.50) {
    this.name = '34-Algorithm $10 Capital Efficiency & Real-Area Live Win Rate Engine';
    this.initialCapitalPerAlgo = 10.00;
    this.totalAllocatedCapital = 34 * 10.00; // $340.00 USD
    this.algoAccounts = {};
    this.historyTicks = 0;
    this.lastPrice = Number(initialPrice) || 2608.50;

    // Load existing progress so it continues; only resets when reset button clicked
    this.init(this.lastPrice, false);
  }

  /**
   * Load existing accounts state from persistent storage
   */
  loadFromStorage() {
    try {
      if (typeof localStorage === 'undefined') return false;
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return false;
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && Object.keys(parsed).length >= 30) {
        // Validate that data is not corrupted with NaN
        const sample = Object.values(parsed)[0];
        if (!sample || isNaN(sample.cash) || sample.cash === null || sample.cash <= 0) {
          localStorage.removeItem(STORAGE_KEY);
          return false;
        }
        this.algoAccounts = parsed;
        return true;
      }
    } catch (e) {}
    return false;
  }

  /**
   * Save accounts state to persistent storage
   */
  saveToStorage() {
    try {
      if (typeof localStorage === 'undefined') return;
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.algoAccounts));
    } catch (e) {}
  }

  /**
   * Initialize accounts. Continues existing state unless forceFresh is true
   * @param {number} currentPrice Initial asset price
   * @param {boolean} forceFresh Whether to wipe and force fresh $10 start
   */
  init(currentPrice = 2608.50, forceFresh = false) {
    const validPrice = Number(currentPrice) && !isNaN(currentPrice) && currentPrice > 100 ? Number(currentPrice) : (this.lastPrice || 2608.50);
    this.lastPrice = validPrice;

    if (!forceFresh && this.loadFromStorage()) {
      // Existing trading session found: continue running seamlessly
      return;
    }

    this.algoAccounts = {};
    this.historyTicks = 0;

    ALGORITHMS.forEach((def) => {
      const startingCapital = 10.00;
      this.algoAccounts[def.id] = {
        id: def.id,
        tag: def.tag,
        name: def.name,
        cat: def.cat || 'value',
        initialCapital: startingCapital,
        cash: startingCapital,
        equity: startingCapital,
        realizedPnL: 0.00,
        unrealizedPnL: 0.00,
        totalTrades: 0,
        wins: 0,
        losses: 0,
        realWinRate: 0.0,
        profitFactor: '0.00',
        grossProfit: 0,
        grossLoss: 0,
        totalBinanceFees: 0,
        roiPct: 0.0,
        efficiencyTier: 'STARTING ($10.00)',
        activeTrade: null,
        tradesHistory: [],
        sharpe: '0.00',
        maxDrawdownPct: '0.0%',
        lastUpdated: Date.now(),
      };
    });

    this.saveToStorage();
  }

  /**
   * Live tick update: evaluate all open $10 trades and open new setups
   * Every algorithm dynamically decides its OWN TP and SL distances based on its RL mechanics!
   * @param {number} currentPrice Live ETH/USDT price
   * @param {Object} signals Live signals dictionary
   * @param {Object} movementPrediction Dynamic movement prediction engine output
   */
  tick(currentPrice = 2608.50, signals = {}, movementPrediction = null) {
    const p = Number(currentPrice);
    if (!p || isNaN(p) || p <= 100) {
      currentPrice = this.lastPrice || 2608.50;
    } else {
      currentPrice = p;
    }
    this.lastPrice = currentPrice;
    this.historyTicks++;

    const atr = movementPrediction?.atr || (currentPrice * 0.0068);

    Object.keys(this.algoAccounts).forEach(id => {
      const acc = this.algoAccounts[id];
      const sig = signals[id] || { signal: 0, conf: 0.5 };
      const s = sig.signal !== undefined ? sig.signal : 0;
      const isBuySignal = sig.direction > 0 || s > 0.02 || (s === 0 && (acc.id % 2 === 0));

      if (acc.activeTrade) {
        const t = acc.activeTrade;
        t.ticksHeld = (t.ticksHeld || 0) + 1;

        // Upgrade legacy trades to autonomous dynamic profile if needed
        if (!t.tpDistance || t.tpPct === 0.20) {
          const profile = ALGO_PROFILES[acc.id] || ALGO_PROFILES[1];
          const { up, down } = profile.calc(t.entryPrice, atr, s, sig.conf || 0.5, sig.metrics || {});
          t.tpDistance = up;
          t.slDistance = down;
          t.tpPrice = +(t.isBuy ? t.entryPrice + up : t.entryPrice - up).toFixed(2);
          t.slPrice = +(t.isBuy ? t.entryPrice - down : t.entryPrice + down).toFixed(2);
          t.tpPct = +((up / t.entryPrice) * 100).toFixed(2);
          t.slPct = +((down / t.entryPrice) * 100).toFixed(2);
          t.horizon = profile.horizon;
          t.basis = profile.basis;
          t.tpAreaText = t.isBuy ? `BUY TP (+$${up.toFixed(1)} pts)` : `SELL TP (-$${up.toFixed(1)} pts)`;
          t.slAreaText = t.isBuy ? `BUY SL (-$${down.toFixed(1)} pts)` : `SELL SL (+$${down.toFixed(1)} pts)`;
        }

        let isClosed = false;
        let pnl = 0;
        let exitReason = '';

        if (t.isBuy) {
          // LONG / BUY $10 POSITION: STRICTLY holds until price reaches dynamic TP or dynamic SL
          if (currentPrice >= t.tpPrice) {
            // TAKE PROFIT HIT (Dynamic upside reached)
            pnl = +(t.sizeETH * (t.tpPrice - t.entryPrice)).toFixed(4);
            isClosed = true;
            exitReason = `BUY TP HIT (+${t.tpPct}% / $${t.tpPrice.toFixed(2)} [+$${(t.tpDistance || (t.tpPrice - t.entryPrice)).toFixed(1)} pts])`;
          } else if (currentPrice <= t.slPrice) {
            // STOP LOSS HIT
            pnl = +(t.sizeETH * (t.slPrice - t.entryPrice)).toFixed(4);
            isClosed = true;
            exitReason = `BUY SL HIT (-${t.slPct}% / $${t.slPrice.toFixed(2)} [-$${(t.slDistance || (t.entryPrice - t.slPrice)).toFixed(1)} pts])`;
          } else {
            // TP or SL NOT reached: MUST NOT CLOSE! Mark-to-market unrealized PnL
            acc.unrealizedPnL = +(t.sizeETH * (currentPrice - t.entryPrice)).toFixed(4);
            acc.equity = +(acc.cash + acc.unrealizedPnL).toFixed(3);
          }
        } else {
          // SHORT / SELL $10 POSITION: STRICTLY holds until price reaches dynamic TP or dynamic SL
          if (currentPrice <= t.tpPrice) {
            // TAKE PROFIT HIT (Dynamic downside reached)
            pnl = +(t.sizeETH * (t.entryPrice - t.tpPrice)).toFixed(4);
            isClosed = true;
            exitReason = `SELL TP HIT (-${t.tpPct}% / $${t.tpPrice.toFixed(2)} [-$${(t.tpDistance || (t.entryPrice - t.tpPrice)).toFixed(1)} pts])`;
          } else if (currentPrice >= t.slPrice) {
            // STOP LOSS HIT
            pnl = +(t.sizeETH * (t.entryPrice - t.slPrice)).toFixed(4);
            isClosed = true;
            exitReason = `SELL SL HIT (+${t.slPct}% / $${t.slPrice.toFixed(2)} [+$${(t.slDistance || (t.slPrice - t.entryPrice)).toFixed(1)} pts])`;
          } else {
            // TP or SL NOT reached: MUST NOT CLOSE! Mark-to-market unrealized PnL
            acc.unrealizedPnL = +(t.sizeETH * (t.entryPrice - currentPrice)).toFixed(4);
            acc.equity = +(acc.cash + acc.unrealizedPnL).toFixed(3);
          }
        }

        if (isClosed) {
          acc.totalTrades++;
          
          // Binance Perpetual Trading Fees: 0.040% Taker on entry + 0.040% on exit
          const entryFee = +(t.sizeETH * t.entryPrice * 0.0004).toFixed(4);
          const exitFee = +(t.sizeETH * currentPrice * 0.0004).toFixed(4);
          const roundTripFee = +(entryFee + exitFee).toFixed(4);
          acc.totalBinanceFees = +((acc.totalBinanceFees || 0) + roundTripFee).toFixed(4);

          // Net PnL after Binance Trading Fees
          const netPnl = +(pnl - roundTripFee).toFixed(4);

          if (netPnl > 0) {
            acc.wins++;
            acc.grossProfit = +(acc.grossProfit + netPnl).toFixed(4);
          } else {
            acc.losses++;
            acc.grossLoss = +(acc.grossLoss + Math.abs(netPnl)).toFixed(4);
          }
          acc.realizedPnL = +(acc.realizedPnL + netPnl).toFixed(3);
          acc.cash = +(acc.cash + netPnl).toFixed(3);
          acc.equity = acc.cash;
          acc.unrealizedPnL = 0;
          acc.realWinRate = acc.totalTrades > 0 ? +((acc.wins / acc.totalTrades) * 100).toFixed(1) : 0;
          acc.profitFactor = acc.grossLoss > 0 ? (acc.grossProfit / acc.grossLoss).toFixed(2) : (acc.grossProfit > 0 ? '4.50' : '0.00');
          acc.roiPct = +(((acc.equity - acc.initialCapital) / acc.initialCapital) * 100).toFixed(1);

          acc.tradesHistory.unshift({
            action: t.action,
            entryPrice: t.entryPrice,
            exitPrice: currentPrice,
            grossPnl: pnl,
            binanceFee: roundTripFee,
            pnl: netPnl,
            win: netPnl > 0,
            exitReason: `${exitReason} [Fee: -$${roundTripFee}]`,
            time: new Date().toLocaleTimeString(),
          });
          if (acc.tradesHistory.length > 10) acc.tradesHistory.pop();

          acc.activeTrade = null;
          this.saveToStorage();
        }

      } else {
        // FLAT: Open a new $10 position in the direction of the signal
        const isBuy = isBuySignal;
        const entryPrice = currentPrice;
        const sizeETH = +(10.00 / entryPrice).toFixed(6); // $10.00 worth of ETH

        // ═══════════════════════════════════════════════════════
        // AUTONOMOUS PER-ALGORITHM PREDICTED MOVEMENT
        // Every algorithm decides ON ITS OWN how much price can move UP or DOWN!
        // NO fixed percentage. No shared TP or SL.
        // ═══════════════════════════════════════════════════════
        const profile = ALGO_PROFILES[acc.id] || ALGO_PROFILES[1];
        const { up, down } = profile.calc(currentPrice, atr, s, sig.conf || 0.5, sig.metrics || {});
        
        const tpDistance = up;
        const slDistance = down;

        let tpPrice = 0;
        let slPrice = 0;

        if (isBuy) {
          tpPrice = +(entryPrice + tpDistance).toFixed(2);
          slPrice = +(entryPrice - slDistance).toFixed(2);
        } else {
          tpPrice = +(entryPrice - tpDistance).toFixed(2);
          slPrice = +(entryPrice + slDistance).toFixed(2);
        }

        const tpPct = +((tpDistance / entryPrice) * 100).toFixed(2);
        const slPct = +((slDistance / entryPrice) * 100).toFixed(2);

        acc.activeTrade = {
          action: isBuy ? 'BUY' : 'SELL',
          isBuy,
          entryPrice,
          tpPrice,
          slPrice,
          tpDistance,
          slDistance,
          tpPct,
          slPct,
          horizon: profile.horizon,
          basis: profile.basis,
          tpAreaText: isBuy ? `BUY TP (+$${tpDistance.toFixed(1)} pts)` : `SELL TP (-$${tpDistance.toFixed(1)} pts)`,
          slAreaText: isBuy ? `BUY SL (-$${slDistance.toFixed(1)} pts)` : `SELL SL (+$${slDistance.toFixed(1)} pts)`,
          sizeETH,
          capitalUSD: 10.00,
          ticksHeld: 0,
          entryTime: new Date().toLocaleTimeString(),
        };
      }
    });

    // Periodically persist running positions and mark-to-market equity
    if (this.historyTicks % 5 === 0) {
      this.saveToStorage();
    }
  }

  /**
   * Fast micro-simulate ticks for immediate testing (+10T button)
   * @param {number} steps Number of ticks to step forward
   * @param {number} currentPrice Starting ETH price
   */
  fastSimulate(steps = 10, currentPrice = 2608.50, movementPrediction = null) {
    let p = Number(currentPrice) || this.lastPrice || 2608.50;
    for (let i = 0; i < steps; i++) {
      // Micro realistic fluctuation between -0.06% and +0.06%
      const delta = (Math.random() - 0.485) * 0.0006;
      p = +(p * (1 + delta)).toFixed(2);
      const signals = {};
      Object.keys(this.algoAccounts).forEach(id => {
        const dir = Math.random() > 0.46 ? 1 : -1;
        signals[id] = { signal: dir * 0.5, direction: dir, conf: 0.75 };
      });
      this.tick(p, signals, movementPrediction);
    }
    this.saveToStorage();
    return this.getReport();
  }

  /**
   * Reset all $10 accounts back to fresh $10.00 starting state.
   * Triggered ONLY when the user explicitly clicks the Reset button.
   * @param {number} currentPrice Current asset price
   */
  reset(currentPrice = 2608.50) {
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.removeItem(STORAGE_KEY);
      }
    } catch (e) {}
    this.init(currentPrice, true);
  }

  /**
   * Get sorted benchmark report ranked by Capital Efficiency and Real Win Rate
   */
  getReport() {
    const list = Object.values(this.algoAccounts);
    let totalInitial = 0;
    let totalEquity = 0;
    let totalWins = 0;
    let totalTrades = 0;
    let totalRealizedPnL = 0;
    let totalBinanceFees = 0;

    list.forEach(a => {
      totalInitial += (Number(a.initialCapital) || 10.00);
      totalEquity += (Number(a.equity) || 10.00);
      totalWins += (Number(a.wins) || 0);
      totalTrades += (Number(a.totalTrades) || 0);
      totalRealizedPnL += (Number(a.realizedPnL) || 0);
      totalBinanceFees += (Number(a.totalBinanceFees) || 0);
    });

    // Rank algorithms descending by equity / ROI
    const sorted = [...list].sort((x, y) => {
      const eqDiff = (Number(y.equity) || 0) - (Number(x.equity) || 0);
      if (Math.abs(eqDiff) > 0.001) return eqDiff;
      return (Number(y.realWinRate) || 0) - (Number(x.realWinRate) || 0);
    });

    sorted.forEach((a, idx) => {
      a.rank = idx + 1;
      a.isChampion = (idx === 0);
      a.isTopThree = (idx < 3);
      a.totalBinanceFees = +(Number(a.totalBinanceFees) || 0).toFixed(4);
    });

    const champion = sorted[0];
    const topThree = sorted.slice(0, 3);
    const aggregateWinRate = totalTrades > 0 ? ((totalWins / totalTrades) * 100).toFixed(1) : '0.0';
    const totalReturnPct = totalInitial > 0 ? (((totalEquity - totalInitial) / totalInitial) * 100).toFixed(2) : '0.00';

    return {
      totalAlgos: list.length,
      totalInitialCapitalUSD: totalInitial.toFixed(2),
      totalEquityUSD: totalEquity.toFixed(2),
      totalProfitUSD: totalRealizedPnL.toFixed(2),
      totalBinanceFeesUSD: totalBinanceFees.toFixed(4),
      binanceFeeTier: 'VIP 0: 0.040% Taker / 0.020% Maker',
      totalReturnPct: `${totalReturnPct}%`,
      aggregateWinRate: `${aggregateWinRate}%`,
      totalTrades,
      totalWins,
      champion,
      topThree,
      algos: sorted,
    };
  }
}
