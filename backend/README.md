# Ethereum (ETHUSDT) Dynamic Quantitative Trading Engine

Production-level quantitative trading engine connected real-time for **Ethereum (ETHUSDT)** with **5 complementary strategies**, multi-timeframe regime detection, continuous MFE/MAE empirical analysis, and **100% dynamic take-profit and stop-loss targets** (strictly zero hardcoded percentages or fixed ratios).

---

## Core Objectives Addressed

1. **BUY / SELL / HOLD Signal**: Weighted ensemble decision with conflict resolution.
2. **Entry Price**: Exact fill level with simulated execution slippage and taker fee accounting.
3. **Dynamic Expected Price Range**: Computed from empirical move distribution and volatility percentiles.
4. **Dynamic Take-Profit Targets**:
   - **Conservative Target**: High probability (~75%), anchored to S/R and analog p25 move.
   - **Base Target**: Expected value optimal, anchored to median MFE and p50 move.
   - **Extended Target**: Breakout runner, anchored to p75 MFE and structural liquidity pools.
   - **ZERO hardcoded percentages** (no `entry * 1.02`, no `+2%`, no fixed ratios).
5. **Dynamic Exit / Sell Target**: Real-time evaluation of momentum decay, volume absorption, and reversal probability.
6. **Structure & Volatility Stop-Loss**: Anchored to structural swing highs/lows with ATR noise buffer and MAE invalidation boundary.
7. **Calibrated Confidence**: Platt-scaled score factoring in strategy consensus, dispersion, and regime clarity.
8. **Expected Move Magnitude**: Expressed in price points ($) and basis points (bps) based on current volatility state.
9. **Expected Move Duration**: Estimated in minutes from multi-timeframe historical analogues.
10. **Human-Readable Reason**: Complete institutional explanation detailing indicators, regime, and divergence.
11. **Contributing Strategies Breakdown**: Explicit vote, direction score, and dynamic weight for each strategy.
12. **Current Market Risk/Reward Ratio**: Calculated directly from actual price levels (`|target - entry| / |entry - stop|`).

---

## Architecture & File Structure

```
backend/
├── config.yaml                    # System configuration (no fixed TP/SL percentages)
├── requirements.txt               # Dependencies
├── README.md                      # Documentation & Guide
├── run.py                         # Unified entry point (api, signal, backtest)
│
├── data/
│   ├── candle_store.py            # Thread-safe multi-TF OHLCV ring buffers
│   ├── binance_client.py          # Async REST + WebSocket connector with reconnect
│   └── market_data.py             # Validation, gap checks, derived fields
│
├── features/
│   ├── technical.py               # EMA(9,21,50,200), MACD, RSI, ADX, ROC, Stoch, CCI
│   ├── market_structure.py        # Swing H/L, HH/HL/LH/LL, S/R zones, BoS, ChoCh
│   ├── volatility.py              # ATR, realized vol, Parkinson, expansion/contraction
│   ├── volume.py                  # VWAP, OBV, cumulative delta proxy, volume momentum
│   └── statistical.py            # Z-score, Bollinger Bands, distance from VWAP/EMA
│
├── strategies/
│   ├── base.py                    # Standardized StrategyPrediction dataclass
│   ├── trend_strategy.py          # Strategy 1: Multi-TF Trend & Momentum
│   ├── structure_strategy.py      # Strategy 2: Market Structure & S/R Zones
│   ├── volatility_strategy.py     # Strategy 3: Volatility Expansion & Move Distribution
│   ├── mean_reversion_strategy.py # Strategy 4: Statistical Extremes & Reversal
│   └── ml_strategy.py             # Strategy 5: Gradient-Boosted Model (XGBoost / HistGB)
│
├── regime/
│   └── detector.py                # 11-class regime classifier with persistence tracking
│
├── ensemble/
│   ├── weighting.py               # Dynamic strategy weighting (regime affinity + accuracy)
│   ├── confidence.py              # Consensus calibration & dispersion penalty
│   └── aggregator.py              # Signal aggregator & conflict resolution
│
├── prediction/
│   ├── expected_move.py           # Empirical move distribution (p10, p25, p50, p75, p90)
│   ├── mfe_mae.py                 # Maximum Favorable / Adverse Excursion empirical CDF
│   ├── target_engine.py           # Dynamic TP target zones (conservative, base, extended)
│   └── reversal_engine.py         # Continuous P(reversal), momentum decay, and exhaustion
│
├── risk/
│   ├── stop_engine.py             # Structure invalidation + MAE buffer stops
│   ├── position_sizing.py         # Fractional Kelly criterion + volatility scaling
│   ├── exit_engine.py             # Continuous exit scoring & trailing stop logic
│   └── risk_manager.py            # Circuit breakers, max drawdown, loss cool-down
│
├── execution/
│   └── trade_manager.py           # Simulated trade lifecycle & feedback loop updates
│
├── storage/
│   ├── models.py                  # Dataclass schemas for trades and signal logs
│   └── database.py                # SQLite persistence layer
│
├── backtest/
│   ├── backtester.py              # Walk-forward, no-lookahead backtesting framework
│   ├── metrics.py                 # Sharpe, Sortino, MDD, Profit Factor, Expectancy
│   └── failure_analysis.py        # Post-loss diagnosis and strategy culpability
│
├── api/
│   └── server.py                  # FastAPI REST endpoints + live WebSocket stream
│
└── tests/
    ├── test_features.py
    ├── test_strategies.py
    ├── test_ensemble.py
    ├── test_prediction.py
    └── test_backtest.py
```

---

## Quick Start

### 1. Install Dependencies

```bash
cd backend
pip install -r requirements.txt
```

### 2. Run Tests

Verify feature calculation, all 5 strategies, dynamic target engine, and backtester:

```bash
pytest tests/
```

### 3. Generate a Live Ethereum (ETHUSDT) Decision

Fetch current Binance candles and compute the full dynamic decision:

```bash
python run.py signal
```

### 4. Run Historical Backtest

Execute a walk-forward simulation across multi-timeframe data for Ethereum:

```bash
python run.py backtest
```

### 5. Launch FastAPI & WebSocket Server

```bash
python run.py api
```

API documentation will be available at: `http://localhost:8000/docs`.

---

## API Endpoints

- `GET /signal` or `GET /signal/ETHUSDT` — Returns full 12-point decision object for Ethereum.
- `GET /market` or `GET /market/ETHUSDT` — Current price, OHLCV, indicators, detected regime.
- `GET /prediction` or `GET /prediction/ETHUSDT` — Expected move distribution, MFE/MAE profile, reversal score.
- `GET /strategies` or `GET /strategies/ETHUSDT` — Individual outputs and dynamic weights for all 5 strategies.
- `GET /risk` or `GET /risk/ETHUSDT` — Portfolio risk status, sizing recommendations, open positions.
- `GET /performance` — Win rate, PnL, aggregate institutional metrics.
- `WS /ws/live` — Real-time continuous WebSocket stream of Ethereum signals and price updates.
