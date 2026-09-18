// ═══════════════════════════════════════════════════════
// RISK ENGINE — Position sizing, drawdown, kill switch
// ═══════════════════════════════════════════════════════

import { STATE, log } from '../state.js';
import { clamp, mean, std, percentile } from '../utils/math.js';
import { HYPERPARAMS } from '../config.js';

const HP = HYPERPARAMS;

export class RiskEngine {
  constructor() {
    this.returnHistory = [];
    this.equityHistory = [10000];
    this.maxEquity = 10000;
    this.killSwitchActive = false;
    this.cooldownTicks = 0;
  }

  update() {
    const { price, prices, position, equity } = STATE;

    // Track returns
    if (prices.length >= 2) {
      const ret = prices[prices.length - 1] / prices[prices.length - 2] - 1;
      this.returnHistory.push(ret);
      if (this.returnHistory.length > 500) this.returnHistory.shift();
    }

    // Volatility (annualized-ish)
    const vol = this.returnHistory.length > 10
      ? std(this.returnHistory.slice(-20))
      : 0.01;

    // Sharpe ratio
    const avgRet = this.returnHistory.length > 10
      ? mean(this.returnHistory.slice(-50))
      : 0;
    const sharpe = vol > 0 ? (avgRet / vol) * Math.sqrt(252) : 0;

    // CVaR (5%)
    const cvar = this.returnHistory.length > 20
      ? mean(this.returnHistory.filter(r => r <= percentile(this.returnHistory, 5)))
      : 0;

    // Drawdown
    this.maxEquity = Math.max(this.maxEquity, equity);
    const drawdownPct = this.maxEquity > 0
      ? (equity - this.maxEquity) / this.maxEquity * 100
      : 0;

    // Kill switch check
    if (drawdownPct < -HP.maxDrawdownPct || vol > 0.05) {
      if (!this.killSwitchActive) {
        this.killSwitchActive = true;
        this.cooldownTicks = 30;
        log('🚨 KILL SWITCH ACTIVATED — Drawdown/Vol threshold breached', 'warn');
      }
    }

    if (this.cooldownTicks > 0) {
      this.cooldownTicks--;
      if (this.cooldownTicks === 0) {
        this.killSwitchActive = false;
        log('✓ Kill switch deactivated — resuming normal operations', 'info');
      }
    }

    // Position sizing (Kelly-inspired)
    const positionSize = Math.abs(STATE.ensemble) * HP.maxPositionETH;
    const riskAdjustedSize = this.killSwitchActive ? 0 : clamp(positionSize * (1 - vol * 10), 0, HP.maxPositionETH);

    // Update state
    STATE.risk = {
      positionSize: riskAdjustedSize,
      maxPosition: HP.maxPositionETH,
      currentDD: drawdownPct,
      maxDD: -HP.maxDrawdownPct,
      volatility: vol,
      sharpe: sharpe,
      cvar95: cvar * 100,
      killSwitch: this.killSwitchActive,
    };

    // UI flags
    const killEl = document.getElementById('killSwitch');
    const maxPosEl = document.getElementById('maxPosFlag');
    if (killEl) {
      killEl.className = `exec-badge ${this.killSwitchActive ? 'exec-active' : 'exec-idle'}`;
      killEl.textContent = this.killSwitchActive ? '⚠ KILL' : 'KILL SW';
    }
    if (maxPosEl) {
      const atMax = Math.abs(STATE.position) >= HP.maxPositionETH * 0.9;
      maxPosEl.className = `exec-badge ${atMax ? 'exec-active' : 'exec-idle'}`;
    }

    return { positionSize: riskAdjustedSize, killSwitch: this.killSwitchActive };
  }
}
