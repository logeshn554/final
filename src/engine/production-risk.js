// ═══════════════════════════════════════════════════════
// LAYER 5: REAL-TIME RISK MANAGEMENT ENGINE
// Pre-Trade Gatekeeper, VaR/CVaR, Greeks, Autonomous Kill Switch & Circuit Breakers
// ═══════════════════════════════════════════════════════

import { clamp, std, mean } from '../utils/math.js';

export class ProductionRiskEngine {
  constructor() {
    // Limits
    this.maxPositionETH = 5.0;
    this.maxOrderNotionalUSD = 15000;
    this.maxLeverage = 3.0;
    this.killSwitchDrawdownPct = -5.0; // -5% triggers immediate emergency liquidation
    this.killSwitchZSigma = -3.0;      // -3 sigma daily loss triggers kill switch
    this.dailyLossLimitPct = -2.5;     // Tier 1 circuit breaker

    // State
    this.killSwitchArmed = true;
    this.killSwitchTriggered = false;
    this.killSwitchReason = '';
    this.killCooldownRemaining = 0; // seconds
    this.circuitBreakerLevel = 0;   // 0=Normal, 1=De-risked 50%, 2=Halted

    // Risk Metrics
    this.metrics = {
      var95USD: 0,
      var99USD: 0,
      cvar95USD: 0,
      portfolioBeta: 1.15,
      deltaETH: 0,
      gammaProxy: 0.04,
      vegaProxy: 18.5,
      currentDrawdownPct: 0,
      dailyPnLUSD: 0,
      dailyPnLSigma: 0,
      preTradePassed: true,
      lastPreTradeCheck: 'APPROVED',
    };
  }

  /**
   * Pre-trade validation gatekeeper
   * @param {number} proposedTargetETH Proposed position in ETH
   * @param {number} currentPrice Current ETH price
   * @param {number} equity Current account equity
   */
  checkPreTrade(proposedTargetETH, currentPrice, equity) {
    if (this.killSwitchTriggered) {
      this.metrics.preTradePassed = false;
      this.metrics.lastPreTradeCheck = 'REJECTED: KILL SWITCH ENGAGED';
      return { approved: false, reason: this.metrics.lastPreTradeCheck };
    }

    if (this.circuitBreakerLevel >= 2) {
      this.metrics.preTradePassed = false;
      this.metrics.lastPreTradeCheck = 'REJECTED: CIRCUIT BREAKER HALT';
      return { approved: false, reason: this.metrics.lastPreTradeCheck };
    }

    const maxAllowedETH = this.circuitBreakerLevel === 1 ? this.maxPositionETH * 0.5 : this.maxPositionETH;

    // 1. Position limit check
    if (Math.abs(proposedTargetETH) > maxAllowedETH) {
      this.metrics.preTradePassed = false;
      this.metrics.lastPreTradeCheck = `REJECTED: Max pos limit (${maxAllowedETH} ETH) exceeded`;
      return { approved: false, reason: this.metrics.lastPreTradeCheck };
    }

    // 2. Order notional check
    const orderNotionalUSD = Math.abs(proposedTargetETH) * currentPrice;
    if (orderNotionalUSD > this.maxOrderNotionalUSD) {
      this.metrics.preTradePassed = false;
      this.metrics.lastPreTradeCheck = `REJECTED: Notional $${orderNotionalUSD.toFixed(0)} > $${this.maxOrderNotionalUSD}`;
      return { approved: false, reason: this.metrics.lastPreTradeCheck };
    }

    // 3. Leverage check
    const leverage = orderNotionalUSD / Math.max(1, equity);
    if (leverage > this.maxLeverage) {
      this.metrics.preTradePassed = false;
      this.metrics.lastPreTradeCheck = `REJECTED: Leverage ${leverage.toFixed(1)}x > ${this.maxLeverage}x`;
      return { approved: false, reason: this.metrics.lastPreTradeCheck };
    }

    this.metrics.preTradePassed = true;
    this.metrics.lastPreTradeCheck = 'APPROVED: All pre-trade risk gates passed';
    return { approved: true, reason: 'APPROVED' };
  }

  /**
   * Real-time risk evaluation loop
   * @param {number} position Currently held position in ETH
   * @param {number} currentPrice Current price
   * @param {number} equity Current equity
   * @param {number} peakEquity High water mark
   * @param {Array<number>} returnHistory Recent returns
   */
  evaluate(position, currentPrice, equity, peakEquity, returnHistory) {
    // 1. Drawdown calculation
    const ddPct = peakEquity > 0 ? ((equity - peakEquity) / peakEquity) * 100 : 0;
    this.metrics.currentDrawdownPct = Math.round(ddPct * 100) / 100;

    // 2. Volatility & VaR / CVaR
    const vol = returnHistory.length >= 10 ? std(returnHistory.slice(-25)) : 0.015;
    const notionalUSD = Math.abs(position) * currentPrice;

    // Parametric VaR (1-day scale)
    const var95 = 1.645 * vol * notionalUSD;
    const var99 = 2.326 * vol * notionalUSD;
    const cvar95 = var95 * 1.25; // Expected Shortfall approximation

    this.metrics.var95USD = Math.round(var95 * 100) / 100;
    this.metrics.var99USD = Math.round(var99 * 100) / 100;
    this.metrics.cvar95USD = Math.round(cvar95 * 100) / 100;

    // 3. Risk Proxies & Factor Exposures
    this.metrics.deltaETH = Math.round(position * 1000) / 1000;
    this.metrics.gammaProxy = Math.round((Math.abs(position) * 0.012) * 1000) / 1000;
    this.metrics.vegaProxy = Math.round((notionalUSD * 0.002) * 10) / 10;
    this.metrics.portfolioBeta = Math.round((1.15 * (position / (this.maxPositionETH || 1))) * 100) / 100;

    // 4. Daily PnL Sigma
    const dailyPnLUSD = equity - 10000; // relative to initial $10k
    this.metrics.dailyPnLUSD = Math.round(dailyPnLUSD * 100) / 100;
    const expectedDailyVolUSD = 10000 * vol;
    const pnlZSigma = expectedDailyVolUSD > 0 ? dailyPnLUSD / expectedDailyVolUSD : 0;
    this.metrics.dailyPnLSigma = Math.round(pnlZSigma * 10) / 10;

    // 5. Autonomous Kill Switch Trigger Checks
    if (this.killCooldownRemaining > 0) {
      this.killCooldownRemaining--;
      if (this.killCooldownRemaining === 0) {
        this.killSwitchTriggered = false;
        this.circuitBreakerLevel = 0;
        this.killSwitchReason = '';
      }
    } else if (this.killSwitchArmed) {
      if (ddPct <= this.killSwitchDrawdownPct) {
        this.triggerKillSwitch(`MAX DRAWDOWN BREACHED: ${ddPct.toFixed(2)}% <= ${this.killSwitchDrawdownPct}%`);
      } else if (pnlZSigma <= this.killSwitchZSigma) {
        this.triggerKillSwitch(`LOSS EXCEEDED 3-SIGMA: ${pnlZSigma.toFixed(1)}σ <= ${this.killSwitchZSigma}σ`);
      } else if (ddPct <= this.dailyLossLimitPct) {
        // Tier 1 Circuit Breaker (reduce position size limit by 50%)
        this.circuitBreakerLevel = 1;
      } else {
        this.circuitBreakerLevel = 0;
      }
    }

    return {
      metrics: this.metrics,
      killSwitchTriggered: this.killSwitchTriggered,
      killSwitchReason: this.killSwitchReason,
      circuitBreakerLevel: this.circuitBreakerLevel,
      mustLiquidate: this.killSwitchTriggered,
    };
  }

  /**
   * Autonomous Kill Switch invocation
   */
  triggerKillSwitch(reason) {
    this.killSwitchTriggered = true;
    this.killSwitchReason = reason;
    this.circuitBreakerLevel = 2;
    this.killCooldownRemaining = 60; // 60-second cooldown
  }

  /**
   * Manual Kill Switch toggle
   */
  toggleKillSwitch() {
    if (this.killSwitchTriggered) {
      this.killSwitchTriggered = false;
      this.circuitBreakerLevel = 0;
      this.killCooldownRemaining = 0;
    } else {
      this.triggerKillSwitch('MANUAL OVERRIDE EMERGENCY KILL SWITCH ENGAGED');
    }
  }
}
