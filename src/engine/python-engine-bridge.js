// ═════════════════════════════════════════════════════════════════════
// PYTHON QUANTITATIVE ENGINE BRIDGE (ETHUSDT)
// Connects to Python FastAPI backend via WebSocket (ws://localhost:8000/ws/live)
// with REST polling fallback (http://localhost:8000/signal/ETHUSDT).
// Streams 100% dynamic take-profit, stop-loss, MFE/MAE, and 5-strategy ensemble.
// ═════════════════════════════════════════════════════════════════════

import { STATE, log } from '../state.js';

export class PythonEngineBridge {
  constructor(options = {}) {
    this.wsCandidates = [
      'ws://localhost:8000/ws/live',
      'ws://127.0.0.1:8000/ws/live',
      typeof window !== 'undefined' && window.location?.host ? `ws://${window.location.host}/ws/live` : null,
    ].filter(Boolean);

    this.restCandidates = [
      'http://localhost:8000/signal',
      'http://localhost:8000/signal/ETHUSD',
      'http://localhost:8000/signal/ETHUSDT',
      'http://127.0.0.1:8000/signal',
      'http://127.0.0.1:8000/signal/ETHUSD',
      'http://127.0.0.1:8000/signal/ETHUSDT',
      '/api/signal',
      '/api/signal/ETHUSD',
      '/api/signal/ETHUSDT',
    ];

    this.wsIndex = 0;
    this.restIndex = 0;
    this.ws = null;
    this.isConnected = false;
    this.latestDecision = null;
    this.reconnectTimer = null;
    this.pollTimer = null;
    this.lastLatencyMs = 0;
    this.tickCount = 0;
    this.onDecisionCallback = options.onDecision || null;
    this.authToken = options.authToken || 'delta_live_trade_2026_authorized';
  }

  connect() {
    this._connectWebSocket();
    // Start fallback REST polling if WebSocket is offline or hasn't connected
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = setInterval(() => {
      if (!this.isConnected) {
        this._pollRest();
      }
    }, 4000);

    // Initial immediate probe
    setTimeout(() => {
      if (!this.isConnected) this._pollRest();
    }, 500);
  }

  _connectWebSocket() {
    if (this.ws) {
      try { this.ws.close(); } catch (e) {}
      this.ws = null;
    }

    const currentUrl = this.wsCandidates[this.wsIndex % this.wsCandidates.length];

    try {
      this.ws = new WebSocket(currentUrl);

      this.ws.onopen = () => {
        this.isConnected = true;
        this.tickCount = 0;
        this._updateStateStatus('connected');
        log('Python Engine', `Connected to real-time Ethereum quantitative backend at ${currentUrl}`, 'success');
      };

      this.ws.onmessage = (event) => {
        try {
          const t0 = performance.now();
          const decision = JSON.parse(event.data);
          this.lastLatencyMs = Math.round(performance.now() - t0);
          this.tickCount++;
          this._handleDecision(decision);
        } catch (e) {
          // ignore parsing error
        }
      };

      this.ws.onclose = () => {
        this.isConnected = false;
        this._updateStateStatus('reconnecting');
        this.wsIndex = (this.wsIndex + 1) % this.wsCandidates.length;
        this._scheduleReconnect();
      };

      this.ws.onerror = () => {
        this.isConnected = false;
        this._updateStateStatus('offline');
      };
    } catch (e) {
      this.isConnected = false;
      this._updateStateStatus('offline');
      this._scheduleReconnect();
    }
  }

  _scheduleReconnect() {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this._connectWebSocket();
    }, 3000);
  }

  async _pollRest() {
    for (let i = 0; i < this.restCandidates.length; i++) {
      const url = this.restCandidates[(this.restIndex + i) % this.restCandidates.length];
      try {
        const t0 = performance.now();
        const headers = {};
        if (this.authToken) {
          headers['Authorization'] = `Bearer ${this.authToken}`;
        }
        const resp = await fetch(url, {
          headers,
          signal: AbortSignal.timeout(2500)
        });
        if (resp.ok) {
          const decision = await resp.json();
          this.restIndex = (this.restIndex + i) % this.restCandidates.length;
          this.lastLatencyMs = Math.round(performance.now() - t0);
          this.tickCount++;
          this._updateStateStatus('rest_active');
          this._handleDecision(decision);
          return;
        }
      } catch (e) {
        // Continue to next fallback
      }
    }
    this._updateStateStatus('offline');
  }

  async executeMasterTrade(params = {}) {
    const endpoints = [
      'http://localhost:8000/api/v1/trade/execute',
      'http://127.0.0.1:8000/api/v1/trade/execute',
      '/api/v1/trade/execute',
    ];
    for (const url of endpoints) {
      try {
        const headers = { 'Content-Type': 'application/json' };
        if (this.authToken) headers['Authorization'] = `Bearer ${this.authToken}`;
        const resp = await fetch(url, {
          method: 'POST',
          headers,
          body: JSON.stringify(params),
          signal: AbortSignal.timeout(6000),
        });
        if (resp.ok) {
          const data = await resp.json();
          log('Delta Live Execution', `Master trade executed on Delta: ${JSON.stringify(data.trade)}`, 'success');
          if (data.delta_trades_count !== undefined) {
            STATE.deltaTradesCount = data.delta_trades_count;
            STATE.deltaTradesLimit = data.delta_trades_limit || 5;
            STATE.deltaTradesRemaining = data.delta_trades_remaining ?? Math.max(0, 5 - data.delta_trades_count);
            STATE.deltaLimitReached = Boolean(data.delta_limit_reached || data.delta_trades_count >= 5);
          }
          return data;
        }
      } catch (e) {
        // try next endpoint
      }
    }
    return null;
  }

  async closeMasterTrade() {
    const endpoints = [
      'http://localhost:8000/api/v1/trade/close',
      'http://127.0.0.1:8000/api/v1/trade/close',
      '/api/v1/trade/close',
    ];
    for (const url of endpoints) {
      try {
        const headers = { 'Content-Type': 'application/json' };
        if (this.authToken) headers['Authorization'] = `Bearer ${this.authToken}`;
        const resp = await fetch(url, {
          method: 'POST',
          headers,
          signal: AbortSignal.timeout(6000),
        });
        if (resp.ok) {
          const data = await resp.json();
          log('Delta Live Execution', `Position closed on Delta Exchange & TradeManager: ${JSON.stringify(data)}`, 'info');
          return data;
        }
      } catch (e) {
        // try next endpoint
      }
    }
    return null;
  }

  async refresh() {
    return this._pollRest();
  }

  _updateStateStatus(status) {
    if (!STATE.pythonEngine) {
      STATE.pythonEngine = {
        connected: status === 'connected' || status === 'rest_active',
        status: status,
        lastUpdate: Date.now(),
        latencyMs: this.lastLatencyMs,
        tickCount: this.tickCount,
        decision: null,
      };
    } else {
      STATE.pythonEngine.connected = status === 'connected' || status === 'rest_active';
      STATE.pythonEngine.status = status;
      STATE.pythonEngine.latencyMs = this.lastLatencyMs;
      STATE.pythonEngine.tickCount = this.tickCount;
    }
  }

  _handleDecision(decision) {
    if (!decision || (decision.symbol !== 'ETHUSDT' && decision.symbol !== 'ETHUSD')) return;
    this.latestDecision = decision;

    if (!STATE.pythonEngine) {
      STATE.pythonEngine = {
        connected: true,
        status: this.isConnected ? 'ws_live' : 'rest_live',
        lastUpdate: Date.now(),
        latencyMs: this.lastLatencyMs,
        tickCount: this.tickCount,
        decision: decision,
      };
    } else {
      STATE.pythonEngine.connected = true;
      STATE.pythonEngine.status = this.isConnected ? 'ws_live' : 'rest_live';
      STATE.pythonEngine.lastUpdate = Date.now();
      STATE.pythonEngine.latencyMs = this.lastLatencyMs;
      STATE.pythonEngine.tickCount = this.tickCount;
      STATE.pythonEngine.decision = decision;
    }

    if (decision.delta_trades_count !== undefined) {
      STATE.deltaTradesCount = decision.delta_trades_count;
      STATE.deltaTradesLimit = decision.delta_trades_limit || 5;
      STATE.deltaTradesRemaining = decision.delta_trades_remaining ?? Math.max(0, 5 - decision.delta_trades_count);
      STATE.deltaLimitReached = Boolean(decision.delta_limit_reached || decision.delta_trades_count >= 5);
    }

    if (this.onDecisionCallback) {
      try {
        this.onDecisionCallback(decision);
      } catch (err) {
        console.warn('onDecisionCallback error:', err);
      }
    }
  }

  disconnect() {
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.ws) {
      try { this.ws.close(); } catch (e) {}
      this.ws = null;
    }
    this.isConnected = false;
    this._updateStateStatus('disconnected');
  }
}
