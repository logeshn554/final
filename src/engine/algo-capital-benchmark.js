// ═══════════════════════════════════════════════════════
// $10 CAPITAL BENCHMARK ENGINE — Real-Area Efficiency & Live Win Rate Arena
// Allocates $10.00 capital to all 34 algorithms and tracks real-world trading efficiency
// ═══════════════════════════════════════════════════════

import { ALGORITHMS } from '../config.js';
import { ALGO_PROFILES } from './algo-diagnostics.js';

const STORAGE_KEY = 'antigravity_algo_capital_benchmark_v3_dynamic';

export class AlgoCapitalBenchmarkEngine {
  constructor(initialPrice = 0) {
    this.name = '43-Algorithm $10 Capital Efficiency & Real-Area Live Win Rate Engine';
    this.initialCapitalPerAlgo = 10.00;
    this.totalAllocatedCapital = ALGORITHMS.length * 10.00; // $430.00 USD
    this.algoAccounts = {};
    this.historyTicks = 0;
    this.lastPrice = Number(initialPrice) || 0;

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
  init(currentPrice = 0, forceFresh = false) {
    const validPrice = Number(currentPrice) && !isNaN(currentPrice) && currentPrice > 100 ? Number(currentPrice) : (this.lastPrice || 0);
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
  tick(currentPrice = 0, signals = {}, movementPrediction = null) {
    const p = Number(currentPrice);
    if (!p || isNaN(p) || p <= 100) {
      currentPrice = this.lastPrice || 0;
    } else {
      currentPrice = p;
    }
    if (!currentPrice || currentPrice <= 0) return;
    this.lastPrice = currentPrice;
    this.historyTicks++;

    const atr = movementPrediction?.atr || 0;
    this.lastSignals = signals;

    Object.keys(this.algoAccounts).forEach(id => {
      const acc = this.algoAccounts[id];
      const sig = signals[id] || { signal: 0, conf: 0.5 };
      const s = sig.signal !== undefined ? sig.signal : 0;
      const isBuy = sig.direction > 0 || s > 0.05;
      const isSell = sig.direction < 0 || s < -0.05;
      const hasDirection = isBuy || isSell;

      if (acc.activeTrade) {
        const t = acc.activeTrade;
        t.ticksHeld = (t.ticksHeld || 0) + 1;

        // Dynamic trailing stop ratcheting on active paper trade (ratchets stop as trade moves towards TP)
        const favorableDelta = t.isBuy ? (currentPrice - t.entryPrice) : (t.entryPrice - currentPrice);
        if (t.tpDistance > 0 && favorableDelta > t.tpDistance * 0.40) {
          const lockedGain = favorableDelta * 0.35;
          const trailingStop = t.isBuy ? +(t.entryPrice + lockedGain).toFixed(2) : +(t.entryPrice - lockedGain).toFixed(2);
          if (t.isBuy && trailingStop > t.slPrice) {
            t.slPrice = trailingStop;
          } else if (!t.isBuy && trailingStop < t.slPrice) {
            t.slPrice = trailingStop;
          }
        }

        // Ensure active trade has autonomous dynamic excursion levels (ZERO fixed ratios)
        if (!t.tpDistance) {
          if (sig.tpPrice && sig.slPrice && sig.tpDistance > 0 && sig.slDistance > 0) {
            t.tpDistance = sig.tpDistance;
            t.slDistance = sig.slDistance;
            t.tpPrice = sig.tpPrice;
            t.slPrice = sig.slPrice;
          } else {
            const profile = ALGO_PROFILES[acc.id] || ALGO_PROFILES[1];
            const { up, down } = profile.calc(t.entryPrice, atr, s, sig.conf || 0.5, sig.metrics || {}, movementPrediction);
            t.tpDistance = up;
            t.slDistance = down;
            t.tpPrice = +(t.isBuy ? t.entryPrice + up : t.entryPrice - up).toFixed(2);
            t.slPrice = +(t.isBuy ? t.entryPrice - down : t.entryPrice + down).toFixed(2);
          }
          t.tpPct = +((t.tpDistance / t.entryPrice) * 100).toFixed(2);
          t.slPct = +((t.slDistance / t.entryPrice) * 100).toFixed(2);
          t.tpAreaText = t.isBuy ? `BUY TP (+$${t.tpDistance.toFixed(1)} pts)` : `SELL TP (-$${t.tpDistance.toFixed(1)} pts)`;
          t.slAreaText = t.isBuy ? `BUY SL (-$${t.slDistance.toFixed(1)} pts)` : `SELL SL (+$${t.slDistance.toFixed(1)} pts)`;
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

          const exitTimeStr = new Date().toLocaleTimeString();
          const boughtTime = t.isBuy ? (t.entryTime || exitTimeStr) : exitTimeStr;
          const soldTime = t.isBuy ? exitTimeStr : (t.entryTime || exitTimeStr);

          acc.tradesHistory.unshift({
            action: t.action,
            isBuy: t.isBuy,
            boughtTime,
            soldTime,
            entryPrice: t.entryPrice,
            exitPrice: currentPrice,
            grossPnl: pnl,
            binanceFee: roundTripFee,
            pnl: netPnl,
            win: netPnl > 0,
            exitReason: `${exitReason} [Fee: -$${roundTripFee}]`,
            time: exitTimeStr,
          });
          if (acc.tradesHistory.length > 10) acc.tradesHistory.pop();

          acc.activeTrade = null;
          this.saveToStorage();
        }

      } else {
        // FLAT: Only enter a new $10 position if the algorithm emits genuine directional conviction.
        // ZERO arbitrary BUY fallback: neutral/flat algorithms MUST remain flat.
        if (!hasDirection) {
          return;
        }
        const entryPrice = currentPrice;
        const sizeETH = +(10.00 / entryPrice).toFixed(6); // $10.00 worth of ETH

        // ═══════════════════════════════════════════════════════
        // AUTONOMOUS PER-ALGORITHM AUTOMATIC TP & SL DETECTION
        // Prioritizes algorithm's own dynamic detection — ZERO FIXED RATIOS
        // ═══════════════════════════════════════════════════════
        let tpDistance = 0;
        let slDistance = 0;
        let tpPrice = 0;
        let slPrice = 0;
        const profile = ALGO_PROFILES[acc.id] || ALGO_PROFILES[1];

        if (sig.tpPrice && sig.slPrice && sig.tpDistance > 0 && sig.slDistance > 0) {
          tpDistance = sig.tpDistance;
          slDistance = sig.slDistance;
          tpPrice = sig.tpPrice;
          slPrice = sig.slPrice;
        } else {
          const { up, down } = profile.calc(currentPrice, atr, s, sig.conf || 0.5, sig.metrics || {}, movementPrediction);
          tpDistance = up;
          slDistance = down;
          if (isBuy) {
            tpPrice = +(entryPrice + tpDistance).toFixed(2);
            slPrice = +(entryPrice - slDistance).toFixed(2);
          } else {
            tpPrice = +(entryPrice - tpDistance).toFixed(2);
            slPrice = +(entryPrice + slDistance).toFixed(2);
          }
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
   * Prioritizes real historical prices and real algorithm signals over synthetic simulation
   * @param {number} steps Number of ticks to step forward
   * @param {number} currentPrice Starting ETH price
   * @param {Object} [movementPrediction] Live movement prediction distribution
   * @param {Array<number>} [priceHistory] Real market price history array
   * @param {Object} [algorithmSignals] Genuine live signals from all algorithms
   */
  fastSimulate(steps = 10, currentPrice = 0, movementPrediction = null, priceHistory = null, algorithmSignals = null) {
    let p = Number(currentPrice) || this.lastPrice || 0;
    if (p <= 0) return this.getReport();

    const sigs = algorithmSignals || this.lastSignals || {};

    if (Array.isArray(priceHistory) && priceHistory.length >= 2) {
      // Replay real observed historical prices
      const slice = priceHistory.slice(-Math.min(priceHistory.length, steps + 1));
      for (let i = 1; i < slice.length; i++) {
        const histPrice = Number(slice[i]);
        if (histPrice > 0) {
          this.tick(histPrice, sigs, movementPrediction);
        }
      }
    } else {
      // Deterministic tick replay using movement prediction distribution without synthetic random direction flips
      const stepDelta = movementPrediction?.predictedMovement?.mainMove
        ? (movementPrediction.predictedMovement.mainMove / Math.max(1, steps * 4))
        : (p * 0.0002);
      for (let i = 0; i < steps; i++) {
        p = +(p + (i % 2 === 0 ? stepDelta : -stepDelta)).toFixed(2);
        this.tick(p, sigs, movementPrediction);
      }
    }
    this.saveToStorage();
    return this.getReport();
  }

  /**
   * Reset all $10 accounts back to fresh $10.00 starting state.
   * Triggered ONLY when the user explicitly clicks the Reset button.
   * @param {number} currentPrice Current asset price
   */
  reset(currentPrice = 0) {
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.removeItem(STORAGE_KEY);
      }
    } catch (e) {}
    this.init(currentPrice || this.lastPrice || 0, true);
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
