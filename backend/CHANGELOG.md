# Production Trading Engine Changelog

## Deep-Code Production Audit & Remediation (ETHUSDT Multi-Strategy Ensemble)

This changelog records the complete architectural, mathematical, and security remediation performed across the entire Python backend and integration layers.

---

### Phase 1 — Critical Correctness (C1–C6)

- **C1: ML Strategy Lookahead Bias Eliminated**
  - **File**: `backend/strategies/ml_strategy.py`
  - **Fix**: Dropped the currently forming, unclosed candle (`df.iloc[:-1]`) before building feature matrices and labels. Added assertion `assert len(X) == len(y_dir) == len(y_mag)`.
  - **Result**: Eliminates future close price leakage into training rows at decision time.

- **C2: Partial Close PnL Double-Counting Fixed**
  - **File**: `backend/execution/trade_manager.py`
  - **Fix**: Added `realized_pnl_usd` and `initial_size` fields to `ActivePosition`. In `PARTIAL_TP`, net partial PnL is accumulated into `pos.realized_pnl_usd` without prematurely altering `account_balance`. In `close_position()`, remaining size PnL is combined with `pos.realized_pnl_usd` in a single balance credit.
  - **Result**: Balance and PnL metrics reflect exact trading economics without distortion on reversals.

- **C3: Production CORS Whitelist & Mandatory API Token**
  - **Files**: `backend/config.py`, `backend/config.yaml`, `backend/api/server.py`, `backend/.env.example`
  - **Fix**: Default `cors_origins` changed from `["*"]` to `["http://localhost:5173", "http://localhost:3000"]`. Enforced strict startup validation raising `RuntimeError` if `"*"` exists in production origins or if `API_AUTH_TOKEN` is unset in production. Added Production Security Checklist to `backend/README.md`.

- **C4: Portfolio Risk Manager Daily Midnight Reset**
  - **File**: `backend/risk/risk_manager.py`
  - **Fix**: Added `self._current_day`, `_maybe_reset_day(current_balance)`, and `reset_for_session(balance)`. Automatically detects calendar rollover, resets `day_start_balance = current_balance`, and resets `consecutive_losses = 0`.
  - **Result**: Daily loss calculations remain strictly bounded to the current session.

- **C5: Explicit Keyword BinanceClient & Factory**
  - **Files**: `backend/data/binance_client.py`, `backend/api/server.py`, `backend/run.py`
  - **Fix**: Replaced brittle runtime duck-typing with explicit keyword arguments `(candle_store, *, symbol, timeframes, rest_urls, ws_urls, request_timeout, max_retries)`. Added `@classmethod from_settings(cls, store, settings)` factory method.

- **C6: Async SQLite WAL & Open Positions Persistence**
  - **Files**: `backend/storage/database.py`, `backend/api/server.py`
  - **Fix**: Added `idx_trades_closed_at` index, created `open_positions` SQLite table, added async helper methods (`init_async`, `record_trade_async`, `log_signal_async`) powered by `aiosqlite`, and added crash recovery position loading.

---

### Phase 2 — Risk & Strategy Accuracy (H1–H9)

- **H1: Calibrated Empirical Win Rate in Kelly Position Sizer**
  - **Files**: `backend/risk/position_sizing.py`, `backend/ensemble/weighting.py`, `backend/api/server.py`
  - **Fix**: Added `ConfidenceToWinRateMapper` table mapping confidence bins to empirical win rates. Position sizer defaults to a conservative prior $p=0.45$ clipped to $[0.30, 0.75]$. Reduced `max_risk_per_trade_pct` default to $1.0\%$. Added `get_empirical_win_rate(regime)` to `StrategyWeightEngine` and wired it into `api/server.py`.

- **H2: Regime-Adaptive Lookbacks and Risk Guards in Stop Engine**
  - **File**: `backend/risk/stop_engine.py`
  - **Fix**: Added `REGIME_LOOKBACK` dictionary dynamically selecting swing lookbacks (5 to 20 bars). Added max-risk cap ($2.5\times$ ATR if risk $> 3.0\times$ ATR) and min-risk floor ($0.5\times$ ATR to prevent noise stops).

- **H3: Soft Additive Ensemble Agreement & Correlation Penalty**
  - **File**: `backend/ensemble/aggregator.py`
  - **Fix**: Replaced multiplicative $1.25\times$ confidence boost with soft additive bonus: `(agreement_ratio - 0.8) * 0.10` capped at $+0.10$. Removed arbitrary $1.15\times$ direction multiplier. Added $-0.05$ correlation penalty for non-independent strategy agreement. Hard-capped confidence at $0.85$.

- **H4: Bidirectional Slippage Modeling in Backtester**
  - **File**: `backend/backtest/backtester.py`
  - **Fix**: Implemented `_apply_slippage(price, is_long, is_entry)`:
    - Entry BUY: $price + slippage$
    - Entry SELL: $price - slippage$
    - Exit BUY: $price - slippage$
    - Exit SELL: $price + slippage$
    Updated stop-out, target-hit, and market entry fills.

- **H5: WebSocket Watchdog & Stale Data Gating**
  - **Files**: `backend/data/binance_client.py`, `backend/data/delta_client.py`, `backend/api/server.py`
  - **Fix**: Added concurrent 45s heartbeat watchdog coroutine forcing reconnect if websocket drops silently. Added `is_data_fresh(max_age_seconds=60)`. In `api/server.py`, signal generation gates execution and issues `HOLD` with `"STALE_DATA"` reason if feed is stale.

- **H6: Bounded Additive Low-Volume Exhaustion Bonus**
  - **File**: `backend/strategies/mean_reversion_strategy.py`
  - **Fix**: Intermediate scores clipped to $[-1.0, 1.0]$ after RSI, Bollinger, and Z-score blocks. Replaced $1.2\times$ volume multiplier with additive exhaustion bonus: $\text{sign}(score) \times 0.10$.

- **H7: Annualized Sharpe/Sortino & Calmar Ratio**
  - **File**: `backend/backtest/metrics.py`
  - **Fix**: Annualized Sharpe using trade frequency: `trades_per_year = 525_960 / avg_holding_mins`. Sortino calculates standard deviation strictly on negative excess returns. Added `calmar_ratio` and `trades_per_day` to `PerformanceMetrics`.

- **H8: Webhook & Telegram Rate Limiting with Direction Deduplication**
  - **File**: `backend/alerts/webhook.py`
  - **Fix**: Added 120-second alert cooldown guard, duplicate direction suppression (`_last_signal_sent`), and added `notify_trade_closed(trade)` for trade lifecycle notifications.

- **H9: Walk-Forward ML Validation & Sliding Training Window**
  - **File**: `backend/strategies/ml_strategy.py`
  - **Fix**: Retrain interval increased to 50 bars. Training uses a 500-bar sliding window. Retraining performs an 80/20 train/validation split and rejects updates if validation accuracy $< 0.52$. Exposes `_val_accuracy` in prediction telemetry.

---

### Phase 3 — Observability & Architecture (M1–M4)

- **M1: Structured Logging Context with Trade ID Correlation**
  - **Files**: `backend/utils/logger.py`, `backend/execution/trade_manager.py`, `backend/api/server.py`
  - **Fix**: Added `trade_ctx` ContextVar and `StructuredLogger` adapter. Set on `open_position()` and cleared on `close_position()`. Added `GET /api/v1/logs/recent` endpoint filtered by `trade_id`.

- **M2: 4h Macro Regime Context & Bias**
  - **Files**: `backend/regime/detector.py`, `backend/config.yaml`
  - **Fix**: Added `"4h"` timeframe. Evaluated 4h EMA alignment and ADX trend strength. Dynamically adjusts trend/breakout regime scores and records `macro_bias` (`"BULL"`, `"BEAR"`, `"NEUTRAL"`) in `RegimeState`.

- **M3: Ingest Data Validation (Candles & DataFrames)**
  - **Files**: `backend/data/candle_validator.py`, `backend/data/candle_store.py`
  - **Fix**: Validates OHLC integrity ($low \le close \le high$), positive pricing, positive volume, duplicate timestamps, and gap detection before storing candles in ring buffers.

- **M4: Position Crash Recovery Reconciliation**
  - **Files**: `backend/storage/database.py`, `backend/execution/trade_manager.py`, `backend/api/server.py`
  - **Fix**: Open positions are persisted to SQLite `open_positions` upon entry and deleted upon exit. During FastAPI lifespan startup, orphaned open positions are restored to `TradeManager`.

---

### Phase 4 — Production Hardening (L1–L5)

- **L1: Continuous Integration Pipeline**
  - **File**: `.github/workflows/ci.yml`
  - **Features**: Automated pytest execution, configuration validation, and Docker container build verification on push and pull requests.

- **L2: Pinned Dependencies & Reproducible Builds**
  - **Files**: `backend/requirements.txt`, `backend/requirements.lock`, `backend/Dockerfile`
  - **Features**: Exact version pins across all 18 core Python dependencies; Dockerfile uses `requirements.lock`.

- **L3: Prometheus Telemetry Instrumentation**
  - **Files**: `backend/utils/metrics.py`, `backend/execution/trade_manager.py`
  - **Features**: Exposes `trading_signals_total`, `trading_trades_total`, `trading_trade_pnl_usd`, `trading_account_balance_usd`, and `trading_ws_connected` via `/metrics`.

- **L4: Git Secrets Hardening & Template Environment**
  - **Files**: `backend/.gitignore`, `backend/.env.example`, `backend/config.yaml`
  - **Features**: Ignored `.env`, `*.db`, SQLite WAL files; documented `CORS_ORIGINS` and `API_AUTH_TOKEN`; no plain-text credentials in version control.

- **L5: Comprehensive Risk Engine Test Suite**
  - **File**: `backend/tests/test_risk_engine.py`
  - **Metrics**: 100% test pass rate across 37 pytest tests with **90% branch coverage** across all `backend/risk/` modules (`risk_manager`: 99%, `position_sizing`: 94%, `stop_engine`: 84%, `exit_engine`: 82%).
