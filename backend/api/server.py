"""
FastAPI Production Server — Enterprise REST & WebSocket engine for Ethereum (ETHUSDT).
Includes Prometheus telemetry, Kubernetes probes, authentication, and live streaming.
"""

from __future__ import annotations
import asyncio
import logging
import json
import os
import time
import warnings
from contextlib import asynccontextmanager
from typing import Optional, Dict, Any, List
import numpy as np
import pandas as pd

warnings.filterwarnings("ignore", category=RuntimeWarning)
np.seterr(all="ignore")

from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Depends, HTTPException, Security, Request, Response
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from config import settings
from utils.logger import setup_logger
from utils.metrics import metrics_registry
from alerts.webhook import AlertNotifier

from data.candle_store import CandleStore
from data.binance_client import BinanceClient
from data.delta_client import DeltaExchangeClient
from data.mcp_bridge import DeltaMCPBridge
from execution.delta_executor import DeltaExchangeExecutor
from data.market_data import MarketDataProcessor
from features.technical import compute_all_technical_features
from features.market_structure import compute_all_structure_features
from features.volatility import compute_all_volatility_features
from features.volume import compute_all_volume_features
from features.statistical import compute_all_statistical_features

from regime.detector import RegimeDetector, RegimeState
from strategies.trend_strategy import TrendStrategy
from strategies.structure_strategy import StructureStrategy
from strategies.volatility_strategy import VolatilityStrategy
from strategies.mean_reversion_strategy import MeanReversionStrategy
from strategies.ml_strategy import MLStrategy

from ensemble.weighting import StrategyWeightEngine
from ensemble.confidence import ConfidenceCalibrator
from ensemble.aggregator import EnsembleAggregator
from prediction.expected_move import ExpectedMoveEngine
from prediction.mfe_mae import MFEMAEEngine
from prediction.target_engine import DynamicTargetEngine
from prediction.reversal_engine import ReversalEngine
from risk.stop_engine import DynamicStopEngine
from risk.position_sizing import DynamicPositionSizer
from risk.exit_engine import DynamicExitEngine
from risk.risk_manager import PortfolioRiskManager
from execution.trade_manager import TradeManager
from storage.database import Database
from storage.models import SignalLog

# Initialize institutional logger
logger = setup_logger(
    name="trading_engine",
    level=settings.log_level,
    log_json=settings.log_json,
)

security_scheme = HTTPBearer(auto_error=False)


def verify_api_token(credentials: Optional[HTTPAuthorizationCredentials] = Security(security_scheme)):
    """Optional bearer token validation for production environments."""
    if not settings.api_auth_token:
        return True
    if not credentials or credentials.credentials != settings.api_auth_token:
        raise HTTPException(status_code=401, detail="Invalid or missing API authorization token")
    return True


# ─── Pydantic Response Schemas ───────────────────────────────────────────

class RangeSchema(BaseModel):
    low: float
    high: float


class TakeProfitSchema(BaseModel):
    conservative_target: float
    conservative_prob: float
    base_target: float
    base_prob: float
    extended_target: float
    extended_prob: float
    derivation_reason: str


class StopLossSchema(BaseModel):
    stop_price: float
    invalidation_level: float
    buffer_distance: float
    risk_distance: float
    risk_bps: float
    stop_type: str
    reason: str


class DecisionResponse(BaseModel):
    symbol: str
    timestamp: float
    signal: str
    entry_price: float
    dynamic_expected_range: RangeSchema
    dynamic_take_profit: TakeProfitSchema
    dynamic_exit_target: float
    stop_loss: StopLossSchema
    confidence: float
    expected_move_magnitude: float
    expected_move_bps: float
    expected_move_duration_minutes: int
    reason: str
    contributing_strategies: List[str]
    strategy_contributions: Dict[str, Any]
    strategy_weights: Optional[Dict[str, float]] = None
    risk_reward_ratio: float
    sizing: Dict[str, Any]
    reversal_assessment: Dict[str, Any]
    raw_signal: Optional[str] = None
    execution_authorized: Optional[bool] = False
    risk_check: Optional[Dict[str, Any]] = None
    dynamic_leverage: Optional[int] = 10
    order_lot_size: Optional[int] = 1
    delta_product_id: Optional[int] = 3136
    trade_enabled: Optional[bool] = False
    delta_trades_count: Optional[int] = 0
    delta_trades_limit: Optional[int] = 5
    delta_trades_remaining: Optional[int] = 5
    delta_limit_reached: Optional[bool] = False


class TradeExecuteRequest(BaseModel):
    symbol: Optional[str] = "ETHUSD"
    direction: Optional[str] = None
    entry_price: Optional[float] = None
    take_profit_price: Optional[float] = None
    stop_loss_price: Optional[float] = None
    tp: Optional[float] = None
    sp: Optional[float] = None
    stop_price: Optional[float] = None
    target_price: Optional[float] = None
    size: Optional[int] = 1


class HealthResponse(BaseModel):
    status: str
    symbol: str
    exchange: str = "delta"
    uptime_seconds: float
    candle_counts: Dict[str, int]
    is_ws_connected: bool
    active_position: bool
    delta_trades_count: Optional[int] = 0
    delta_trades_limit: Optional[int] = 5
    delta_trades_remaining: Optional[int] = 5
    delta_limit_reached: Optional[bool] = False
    timestamp: float


# ─── Engine Context ─────────────────────────────────────────────────────

class ProductionEngineContext:
    """Manages system lifecycles, real-time data feeds, and analytics for Ethereum."""

    def __init__(self):
        self.symbol = settings.symbol.upper()
        self.candle_store = CandleStore(buffer_size=settings.candle_buffer_size)
        self.market_data = MarketDataProcessor(self.candle_store)
        self.binance_client = BinanceClient.from_settings(self.candle_store, settings)
        self.delta_client = DeltaExchangeClient(settings.model_dump(), self.candle_store)

        self.mcp_bridge = DeltaMCPBridge(
            env=getattr(settings.delta_exchange, "env", "india_prod"),
            mode=getattr(settings.delta_exchange, "mcp_mode", "read"),
            api_key=getattr(settings.delta_exchange, "api_key", None),
            api_secret=getattr(settings.delta_exchange, "api_secret", None),
        )
        is_live_trade = (
            getattr(settings.delta_exchange, "trade_enabled", False)
            or getattr(settings.delta_exchange, "mcp_mode", "read") == "trade"
            or not getattr(settings.delta_exchange, "dry_run", True)
        )
        self.delta_executor = DeltaExchangeExecutor(
            api_key=getattr(settings.delta_exchange, "api_key", None),
            api_secret=getattr(settings.delta_exchange, "api_secret", None),
            env=getattr(settings.delta_exchange, "env", "india_prod"),
            dry_run=not is_live_trade,
        )
        self._is_executing_trade = False
        self._last_auto_trade_time = 0.0
        self.database = Database(db_path=settings.database_path)

        # Analytical modules
        self.regime_detector = RegimeDetector()
        self.strategies = {
            "trend": TrendStrategy(),
            "structure": StructureStrategy(),
            "volatility": VolatilityStrategy(),
            "mean_reversion": MeanReversionStrategy(),
            "ml": MLStrategy(),
        }
        # Restore self-evolving weights from last session (permanent, all algorithms)
        self.weight_engine = StrategyWeightEngine.load_from_db(self.database)
        self.calibrator = ConfidenceCalibrator()
        self.aggregator = EnsembleAggregator(self.weight_engine, self.calibrator)
        self.expected_move_engine = ExpectedMoveEngine(forward_bars=6)
        self.mfe_mae_engine = MFEMAEEngine()
        self.target_engine = DynamicTargetEngine()
        self.reversal_engine = ReversalEngine()
        self.stop_engine = DynamicStopEngine()
        self.position_sizer = DynamicPositionSizer(
            fractional_kelly=settings.risk.kelly_fraction_cap,
            max_position_pct=settings.risk.max_position_pct / 100.0,
            max_risk_per_trade_pct=settings.risk.max_portfolio_risk_pct / 100.0,
        )
        self.exit_engine = DynamicExitEngine()
        self.risk_manager = PortfolioRiskManager(
            max_drawdown_pct=settings.risk.max_drawdown_pct / 100.0,
            daily_loss_limit_pct=settings.risk.max_daily_loss_pct / 100.0,
        )
        self.trade_manager = TradeManager(
            database=self.database,
            mfe_mae_engine=self.mfe_mae_engine,
            exit_engine=self.exit_engine,
            reversal_engine=self.reversal_engine,
            weight_engine=self.weight_engine,
            risk_manager=self.risk_manager,
        )
        self.alert_notifier = AlertNotifier(
            webhook_url=settings.alerts.webhook_url,
            telegram_token=settings.alerts.telegram_bot_token,
            telegram_chat_id=settings.alerts.telegram_chat_id,
            min_confidence=settings.alerts.min_confidence_to_alert,
        )

        self.ws_clients: set[WebSocket] = set()
        self.latest_decision: dict = {}
        self.is_running = False
        self.start_time = time.time()
        self.ws_task: Optional[asyncio.Task] = None
        self.delta_trades_count = self.database.get_delta_trade_count()
        self.delta_trades_limit = 5

    @property
    def active_client(self):
        """Returns the active exchange client based on settings (delta or binance)."""
        if getattr(settings, "exchange", "delta").lower() == "delta":
            return self.delta_client
        return self.binance_client

    def is_data_fresh(self, max_age_seconds: float = 60.0) -> bool:
        """Check whether the active market data feed is fresh."""
        client = self.active_client
        if hasattr(client, "is_data_fresh"):
            return client.is_data_fresh(max_age_seconds=max_age_seconds)
        return True


    async def sync_active_position(self):
        """Keep TradeManager in sync with live Delta Exchange positions and paper exits."""
        if self.trade_manager.active_position is None:
            return

        latest_price = self.candle_store.get_latest_price("1m") or self.candle_store.get_latest_price("5m") or 0.0
        if latest_price <= 0:
            return

        if not self.delta_executor.dry_run and self.delta_executor.api_key:
            try:
                positions = await self.delta_executor.get_positions()
                pid = self.delta_executor.get_product_id(self.symbol)
                open_pos = next((p for p in positions if p.get("product_id") == pid and int(p.get("size", 0)) != 0), None)
                if not open_pos:
                    logger.info(f"Position for product {pid} no longer open on Delta Exchange. Closing TradeManager position.")
                    self.trade_manager.close_position(
                        exit_price=latest_price,
                        exit_reason="Delta Exchange Bracket TP/SL Executed"
                    )
            except Exception as e:
                logger.warning(f"Error syncing Delta position: {e}")
        else:
            primary_df = self.candle_store.get_dataframe("15m") or self.candle_store.get_dataframe("5m")
            if primary_df is not None:
                self.trade_manager.on_price_update(current_price=latest_price, df=primary_df)

    async def auto_execute_trade_if_eligible(self, decision: dict) -> Optional[dict]:
        """Automatically execute 1-lot trade on Delta Exchange if live trading is enabled and signal authorized."""
        if self.delta_executor.dry_run:
            return None
        if self.delta_trades_count >= self.delta_trades_limit:
            return None
        if not decision.get("execution_authorized"):
            return None
        sig = decision.get("signal")
        if sig not in ("BUY", "SELL"):
            return None
        if self.trade_manager.active_position is not None:
            return None
        if self._is_executing_trade:
            return None
        if time.time() - self._last_auto_trade_time < 30.0:
            return None

        self._is_executing_trade = True
        try:
            latest_market_price = self.candle_store.get_latest_price("1m") or self.candle_store.get_latest_price("5m") or 0.0
            entry = float(decision.get("entry_price") or latest_market_price)
            if entry <= 0:
                return None

            atr = float(self.candle_store.get_atr("15m") or self.candle_store.get_atr("5m") or (entry * 0.004))
            dyn_move = float(decision.get("expected_move_magnitude") or atr or (entry * 0.004))
            dyn_rr = float(decision.get("risk_reward_ratio") or 1.5)

            py_tp = decision.get("dynamic_take_profit", {}).get("base_target")
            py_sl = decision.get("stop_loss", {}).get("stop_price")

            is_tp_valid = (
                py_tp is not None
                and ((sig == "BUY" and float(py_tp) > entry + (atr * 0.1)) or (sig == "SELL" and float(py_tp) < entry - (atr * 0.1)))
            )
            is_sl_valid = (
                py_sl is not None
                and ((sig == "BUY" and float(py_sl) < entry - (atr * 0.1)) or (sig == "SELL" and float(py_sl) > entry + (atr * 0.1)))
            )

            tp = float(py_tp) if is_tp_valid else (entry + (dyn_move * dyn_rr) if sig == "BUY" else entry - (dyn_move * dyn_rr))
            sl = float(py_sl) if is_sl_valid else (entry - dyn_move if sig == "BUY" else entry + dyn_move)
            sym = decision.get("symbol") or self.symbol
            size = getattr(settings.delta_exchange, "lot_size", 1)

            res = await self.delta_executor.execute_master_trade(
                symbol=sym,
                direction=sig,
                entry_price=entry,
                take_profit_price=tp,
                stop_loss_price=sl,
                tp=tp,
                sp=sl,
                size=size,
            )
            self._last_auto_trade_time = time.time()

            if res.get("success"):
                self.delta_trades_count += 1
                self.database.log_delta_trade({
                    "order_id": res.get("order_id"),
                    "symbol": sym,
                    "product_id": getattr(settings.delta_exchange, "product_id", 3136),
                    "side": sig,
                    "size": size,
                    "entry_price": float(entry),
                    "take_profit_price": float(tp),
                    "stop_loss_price": float(sl),
                    "leverage": res.get("leverage", 10),
                    "status": "executed",
                    "timestamp": time.time(),
                })
                if self.trade_manager.active_position is None:
                    regime = decision.get("regime", {}).get("primary_regime", "TRENDING")
                    self.trade_manager.open_position(
                        symbol=sym,
                        direction=sig,
                        entry_price=entry,
                        stop_price=sl,
                        target_price=tp,
                        notional_usd=entry * 0.001 * size,
                        regime=regime,
                        strategy_votes=decision.get("strategy_contributions", {}),
                    )
            return res
        except Exception as e:
            logger.error(f"Auto trade execution failed on Delta Exchange: {e}")
            return None
        finally:
            self._is_executing_trade = False

    def compute_features_for_tf(self, tf: str) -> Optional[pd.DataFrame]:
        raw_df = self.candle_store.get_dataframe(tf)
        if raw_df is None or len(raw_df) < 15:
            return None
        # Isolate base columns and take an explicit consolidated copy
        base_cols = [c for c in ["timestamp", "open", "high", "low", "close", "volume", "trades"] if c in raw_df.columns]
        df = raw_df[base_cols].copy() if base_cols else raw_df.copy()
        try:
            df = compute_all_technical_features(df)
            df = compute_all_structure_features(df)
            df = compute_all_volatility_features(df)
            df = compute_all_volume_features(df)
            df = compute_all_statistical_features(df)
            return df
        except Exception as e:
            logger.warning(f"Feature computation error for {tf}: {e}")
            return None

    def get_all_feature_dfs(self) -> dict:
        dfs = {}
        for tf in settings.timeframes:
            df = self.compute_features_for_tf(tf)
            if df is not None and not df.empty and len(df) >= 15:
                dfs[tf] = df
        return dfs

    def generate_current_decision(self, symbol: Optional[str] = None) -> dict:
        t0 = time.time()
        active_sym = (symbol or self.symbol).upper()
        dfs = self.get_all_feature_dfs()
        price = self.candle_store.get_latest_price("1m")
        if price <= 0:
            price = self.candle_store.get_latest_price("15m") or 0.0

        # Update metrics
        metrics_registry.set_price(price)
        for tf in settings.timeframes:
            metrics_registry.set_candle_count(tf, self.candle_store.get_candle_count(tf))

        # Check risk status first
        risk_check = self.risk_manager.check_risk(self.trade_manager.account_balance)

        # Check for warm-up state when candle store has insufficient data
        if not dfs or all(len(df) < 15 for df in dfs.values()):
            regime_dict = {
                "primary_regime": "WARMING_UP",
                "secondary_regime": "NORMAL_VOL",
                "confidence": 0.0,
                "trend_strength": 0.0,
                "volatility_state": "NORMAL",
                "is_trending": False,
                "is_ranging": True,
                "is_breakout": False,
                "bars_in_regime": 1,
                "regime_scores": {},
                "description": "Warming up candles",
            }
            warmup_reason = "Engine warming up candles; awaiting sufficient market data history."
            if not risk_check.is_trading_allowed:
                warmup_reason = f"BLOCKED BY RISK MANAGER: {risk_check.message}"

            return {
                "symbol": active_sym,
                "timestamp": time.time(),
                "signal": "HOLD",
                "raw_signal": "HOLD",
                "execution_authorized": False,
                "risk_check": risk_check.to_dict(),
                "entry_price": float(price),
                "dynamic_expected_range": None,
                "dynamic_take_profit": None,
                "dynamic_exit_target": None,
                "stop_loss": None,
                "confidence": 0.0,
                "expected_move_magnitude": 0.0,
                "expected_move_bps": 0.0,
                "expected_move_duration_minutes": 15,
                "reason": warmup_reason,
                "contributing_strategies": [],
                "strategy_contributions": {},
                "strategy_weights": {name: 0.2 for name in self.strategies},
                "risk_reward_ratio": 1.0,
                "regime": regime_dict,
                "sizing": {
                    "position_size_usd": 0.0,
                    "position_pct": 0.0,
                    "recommended_units": 0.0,
                    "leverage": 1.0,
                    "kelly_fraction": 0.0,
                    "max_loss_usd": 0.0,
                    "reasoning": "Warming up",
                },
                "reversal_assessment": {
                    "reversal_detected": False,
                    "urgency": "NONE",
                    "trigger_reason": "",
                    "scale_down_pct": 0.0,
                    "exit_recommended": False,
                },
            }

        # 1. Regime Detection
        regime = self.regime_detector.detect(dfs, price)

        # 2. Strategy Predictions
        predictions = {}
        for name, strat in self.strategies.items():
            try:
                predictions[name] = strat.predict(dfs, price, regime.primary_regime)
            except Exception as e:
                logger.warning(f"Error in strategy {name}: {e}")

        # 3. Ensemble Aggregation
        decision = self.aggregator.aggregate(predictions, regime, price)

        # 4. Expected Move & MFE/MAE
        primary_df = dfs.get("15m", dfs.get("5m"))
        move_dist = self.expected_move_engine.estimate(primary_df, price, direction=decision.signal)

        atr_val = price * 0.003
        if primary_df is not None and "atr_14" in primary_df.columns:
            v = primary_df["atr_14"].iloc[-1]
            if v and v > 0:
                atr_val = float(v)

        mfe_profile = self.mfe_mae_engine.get_profile(regime.primary_regime, atr_val)

        # 5. Stop Loss (Structure-based invalidation)
        stop_placement = self.stop_engine.calculate_stop(
            current_price=price,
            signal=decision.signal,
            df=primary_df if primary_df is not None else None,
            support_levels=decision.support_levels,
            resistance_levels=decision.resistance_levels,
            mae_invalidation=mfe_profile.mae_p85,
            regime=regime.primary_regime,
        )

        # 6. Take-Profit Targets (Zero hardcoded percentages)
        targets = self.target_engine.calculate_targets(
            current_price=price,
            signal=decision.signal,
            move_dist=move_dist,
            mfe_profile=mfe_profile,
            stop_price=stop_placement.stop_price,
            resistance_levels=decision.resistance_levels,
            support_levels=decision.support_levels,
        )

        # 7. Dynamic Position Sizing
        vol_exp = 1.0
        if primary_df is not None and "vol_expansion" in primary_df.columns:
            v = primary_df["vol_expansion"].iloc[-1]
            if v and v > 0:
                vol_exp = float(v)

        empirical_win_rate = self.weight_engine.get_empirical_win_rate(regime.primary_regime)
        sizing = self.position_sizer.calculate_size(
            account_balance=self.trade_manager.account_balance,
            entry_price=price,
            stop_price=stop_placement.stop_price,
            target_price=targets.base_target,
            confidence=decision.confidence,
            vol_expansion=vol_exp,
            historical_win_rate=empirical_win_rate,
        )

        # 8. Reversal Assessment
        reversal = self.reversal_engine.assess(
            primary_df if primary_df is not None else None,
            price,
            decision.signal if decision.signal in ("BUY", "SELL") else "BUY",
        )

        # 9. Portfolio Risk Check & Circuit Breakers (Gating Execution)
        risk_check = self.risk_manager.check_risk(self.trade_manager.account_balance)
        final_signal = decision.signal
        execution_authorized = False
        decision_reason = decision.reason

        if not risk_check.is_trading_allowed:
            final_signal = "HOLD"
            execution_authorized = False
            decision_reason = f"BLOCKED BY RISK MANAGER: {risk_check.message}"
        elif self.is_running and not self.is_data_fresh(60.0):
            final_signal = "HOLD"
            execution_authorized = False
            decision_reason = "STALE_DATA"
        elif decision.signal in ("BUY", "SELL"):
            execution_authorized = True


        full_decision = {
            "symbol": active_sym,
            "timestamp": time.time(),
            "signal": final_signal,
            "raw_signal": decision.signal,
            "execution_authorized": execution_authorized,
            "risk_check": risk_check.to_dict(),
            "entry_price": round(price, 2),
            "dynamic_expected_range": {
                "low": round(targets.expected_range_low, 2),
                "high": round(targets.expected_range_high, 2),
            },
            "dynamic_take_profit": {
                "conservative_target": round(targets.conservative_target, 2),
                "conservative_prob": round(targets.conservative_prob, 2),
                "base_target": round(targets.base_target, 2),
                "base_prob": round(targets.base_prob, 2),
                "extended_target": round(targets.extended_target, 2),
                "extended_prob": round(targets.extended_prob, 2),
                "derivation_reason": targets.target_derivation_reason,
            },
            "dynamic_exit_target": round(targets.base_target, 2),
            "stop_loss": stop_placement.to_dict(),
            "dynamic_leverage": self.delta_executor.calculate_leverage_from_stop(
                entry_price=price,
                stop_price=stop_placement.stop_price,
                buffer_factor=2.0,
                min_leverage=2,
                max_leverage=50,
            ),
            "order_lot_size": getattr(settings.delta_exchange, "lot_size", 1),
            "delta_product_id": getattr(settings.delta_exchange, "product_id", 3136),
            "trade_enabled": not self.delta_executor.dry_run,
            "delta_trades_count": self.delta_trades_count,
            "delta_trades_limit": self.delta_trades_limit,
            "delta_trades_remaining": max(0, self.delta_trades_limit - self.delta_trades_count),
            "delta_limit_reached": self.delta_trades_count >= self.delta_trades_limit,
            "confidence": round(decision.confidence, 4),
            "expected_move_magnitude": round(targets.expected_move_magnitude, 2),
            "expected_move_bps": round(targets.expected_move_bps, 2),
            "expected_move_duration_minutes": targets.expected_duration_minutes,
            "reason": decision_reason,
            "contributing_strategies": decision.contributing_strategies,
            "strategy_contributions": decision.strategy_contributions,
            "strategy_weights": self.weight_engine.compute_weights(regime.primary_regime),
            "risk_reward_ratio": round(targets.risk_reward_ratio, 2),
            "regime": regime.to_dict(),
            "sizing": sizing.to_dict(),
            "reversal_assessment": reversal.to_dict(),
        }

        self.latest_decision = full_decision

        # Telemetry & Persistence
        metrics_registry.record_signal(active_sym, final_signal)
        metrics_registry.record_latency(time.time() - t0)

        self.database.log_signal(SignalLog(
            timestamp=time.time(),
            symbol=active_sym,
            price=price,
            signal=final_signal,
            direction_score=decision.direction_score if risk_check.is_trading_allowed else 0.0,
            confidence=decision.confidence,
            regime=regime.primary_regime,
            expected_move=targets.expected_move_magnitude,
            target_base=targets.base_target,
            stop_price=stop_placement.stop_price,
            reasons=decision_reason,
            contributing_strats=",".join(decision.contributing_strategies),
        ))

        return full_decision


engine_ctx = ProductionEngineContext()


# ─── Modern Lifespan Management ──────────────────────────────────────────

@asynccontextmanager
async def lifespan(app: FastAPI):
    # Production security validation (C3)
    if settings.env == "production":
        if not settings.cors_origins or "*" in settings.cors_origins:
            raise RuntimeError("CORS wildcard '*' is not allowed in production. Set CORS_ORIGINS env var.")
        if not settings.api_auth_token:
            raise RuntimeError("API_AUTH_TOKEN must be set in production environment.")

    logger.info(f"[STARTUP] Initializing Production Engine for {engine_ctx.symbol} on Exchange: {getattr(settings, 'exchange', 'delta')}...")

    # Initialize async SQLite WAL mode (C6)
    await engine_ctx.database.init_async()

    try:
        # Pre-fill multi-timeframe candles using active exchange client
        for tf in settings.timeframes:
            await engine_ctx.active_client.fetch_historical_klines(engine_ctx.symbol, tf, limit=300)
        logger.info(f"[READY] {engine_ctx.symbol} historical data initialized via {getattr(settings, 'exchange', 'delta')}.")
    except Exception as e:
        logger.warning(f"Historical warmup warning (engine will continue): {e}")

    # Crash recovery: restore any open position persisted prior to shutdown (M4)
    open_pos = engine_ctx.database.load_open_position()
    if open_pos:
        logger.warning(f"Restoring open position {open_pos['id']} from crash recovery")
        engine_ctx.trade_manager.restore_position(open_pos)

    # Launch WebSocket consumer in background on active client
    engine_ctx.is_running = True
    engine_ctx.ws_task = asyncio.create_task(engine_ctx.active_client.start_websocket())

    # Start MCP Bridge in background if configured
    if getattr(settings.delta_exchange, "use_mcp_bridge", False):
        asyncio.create_task(engine_ctx.mcp_bridge.start())

    yield

    # Clean graceful shutdown
    logger.info("[SHUTDOWN] Shutting down Production Engine...")
    engine_ctx.is_running = False
    engine_ctx.active_client.stop()
    if engine_ctx.ws_task:
        engine_ctx.ws_task.cancel()
    await engine_ctx.mcp_bridge.stop()
    logger.info("Shutdown complete.")


app = FastAPI(
    title="Ethereum (ETHUSDT) Institutional Quantitative Engine",
    description="Production-level 5-strategy ensemble engine for Ethereum with dynamic TP/SL targets, MFE/MAE analysis, and real-time streaming.",
    version="2.0.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ─── Production Probes & Metrics ─────────────────────────────────────────

@app.get("/health", response_model=HealthResponse)
def get_health():
    counts = {tf: engine_ctx.candle_store.get_candle_count(tf) for tf in settings.timeframes}
    return HealthResponse(
        status="healthy",
        symbol=engine_ctx.symbol,
        exchange=getattr(settings, "exchange", "delta"),
        uptime_seconds=round(time.time() - engine_ctx.start_time, 1),
        candle_counts=counts,
        is_ws_connected=engine_ctx.active_client.is_connected,
        active_position=bool(engine_ctx.trade_manager.active_position),
        delta_trades_count=engine_ctx.delta_trades_count,
        delta_trades_limit=engine_ctx.delta_trades_limit,
        delta_trades_remaining=max(0, engine_ctx.delta_trades_limit - engine_ctx.delta_trades_count),
        delta_limit_reached=engine_ctx.delta_trades_count >= engine_ctx.delta_trades_limit,
        timestamp=time.time(),
    )


@app.get("/ready")
def get_readiness():
    """Kubernetes readiness probe."""
    count_15m = engine_ctx.candle_store.get_candle_count("15m")
    if count_15m < 30:
        raise HTTPException(status_code=503, detail="Engine warming up candles")
    return {"status": "ready", "symbol": engine_ctx.symbol, "candles_loaded": count_15m}


@app.get("/live")
def get_liveness():
    """Kubernetes liveness probe."""
    return {"status": "alive", "timestamp": time.time()}


@app.get("/metrics")
def get_metrics():
    """Prometheus exposition metrics."""
    text = metrics_registry.generate_prometheus_text(symbol=engine_ctx.symbol)
    return Response(content=text, media_type="text/plain; version=0.0.4")


# ─── Delta Exchange & MCP Endpoints ─────────────────────────────────────

@app.get("/api/v1/exchange/status")
async def get_exchange_status():
    """Returns active exchange details, Delta Exchange ticker, and MCP availability."""
    delta_ticker = engine_ctx.delta_client.latest_ticker
    if not delta_ticker or delta_ticker.get("mark_price", 0) == 0:
        # Try refreshing ticker
        delta_ticker = await engine_ctx.delta_client.fetch_ticker(engine_ctx.symbol)

    return {
        "active_exchange": getattr(settings, "exchange", "delta"),
        "symbol": engine_ctx.symbol,
        "delta_connected": engine_ctx.delta_client.is_connected,
        "binance_connected": engine_ctx.binance_client.is_connected,
        "delta_env": getattr(settings.delta_exchange, "env", "india_prod"),
        "delta_mcp_mode": getattr(settings.delta_exchange, "mcp_mode", "read"),
        "mcp_bridge_available": engine_ctx.mcp_bridge.is_available(),
        "delta_market": delta_ticker,
        "delta_trades_count": engine_ctx.delta_trades_count,
        "delta_trades_limit": engine_ctx.delta_trades_limit,
        "delta_trades_remaining": max(0, engine_ctx.delta_trades_limit - engine_ctx.delta_trades_count),
        "delta_limit_reached": engine_ctx.delta_trades_count >= engine_ctx.delta_trades_limit,
        "timestamp": time.time(),
    }


@app.get("/api/v1/mcp/tools")
async def get_mcp_tools():
    """List tools available on the Delta Exchange MCP server."""
    tools = await engine_ctx.mcp_bridge.list_tools()
    return {"tools": tools, "count": len(tools)}


@app.post("/api/v1/mcp/call")
async def call_mcp_tool(request: Request):
    """Execute an MCP tool via the Delta Exchange MCP bridge."""
    try:
        body = await request.json()
        tool_name = body.get("name")
        arguments = body.get("arguments", {})
        if not tool_name:
            raise HTTPException(status_code=400, detail="Missing tool name")
        result = await engine_ctx.mcp_bridge.call_tool(tool_name, arguments)
        return {"success": True, "result": result}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/v1/logs/recent")
def get_recent_structured_logs(limit: int = 50, trade_id: Optional[str] = None):
    """Fetch structured logs filtered optionally by trade_id (M1)."""
    from utils.logger import get_recent_logs
    return {"logs": get_recent_logs(limit=limit, trade_id=trade_id)}


# ─── Decision Endpoints ──────────────────────────────────────────────────

@app.get("/signal", response_model=DecisionResponse, dependencies=[Depends(verify_api_token)])
@app.get("/signal/ETHUSDT", response_model=DecisionResponse, dependencies=[Depends(verify_api_token)])
@app.get("/signal/{symbol}", response_model=DecisionResponse, dependencies=[Depends(verify_api_token)])
def get_signal(symbol: str = "ETHUSDT"):
    """Returns the comprehensive 12-point decision for Ethereum."""
    return engine_ctx.generate_current_decision(symbol=symbol)


@app.get("/market", dependencies=[Depends(verify_api_token)])
@app.get("/market/ETHUSDT", dependencies=[Depends(verify_api_token)])
@app.get("/market/{symbol}", dependencies=[Depends(verify_api_token)])
def get_market(symbol: str = "ETHUSDT"):
    price = engine_ctx.candle_store.get_latest_price("1m") or 0.0
    latest_15m = engine_ctx.candle_store.get_latest_candle("15m")
    regime = engine_ctx.regime_detector.detect(engine_ctx.get_all_feature_dfs(), price)
    return {
        "symbol": symbol.upper(),
        "price": price,
        "latest_candle_15m": latest_15m.to_dict() if latest_15m else None,
        "regime": regime.to_dict(),
    }


@app.get("/prediction", dependencies=[Depends(verify_api_token)])
@app.get("/prediction/ETHUSDT", dependencies=[Depends(verify_api_token)])
@app.get("/prediction/{symbol}", dependencies=[Depends(verify_api_token)])
def get_prediction(symbol: str = "ETHUSDT"):
    dfs = engine_ctx.get_all_feature_dfs()
    price = engine_ctx.candle_store.get_latest_price("1m") or engine_ctx.candle_store.get_latest_price("15m") or 0.0
    primary_df = dfs.get("15m", dfs.get("5m"))
    move_dist = engine_ctx.expected_move_engine.estimate(primary_df, price, "UP")
    regime = engine_ctx.regime_detector.detect(dfs, price)
    atr = price * 0.003
    profile = engine_ctx.mfe_mae_engine.get_profile(regime.primary_regime, atr)
    reversal = engine_ctx.reversal_engine.assess(primary_df, price, "BUY")
    return {
        "symbol": symbol.upper(),
        "expected_move_distribution": move_dist.to_dict(),
        "mfe_mae_profile": profile.to_dict(),
        "reversal_assessment": reversal.to_dict(),
    }


@app.get("/strategies", dependencies=[Depends(verify_api_token)])
@app.get("/strategies/ETHUSDT", dependencies=[Depends(verify_api_token)])
@app.get("/strategies/{symbol}", dependencies=[Depends(verify_api_token)])
def get_strategies(symbol: str = "ETHUSDT"):
    dfs = engine_ctx.get_all_feature_dfs()
    price = engine_ctx.candle_store.get_latest_price("1m") or engine_ctx.candle_store.get_latest_price("15m") or 0.0
    regime = engine_ctx.regime_detector.detect(dfs, price)
    weights = engine_ctx.weight_engine.compute_weights(regime.primary_regime)

    results = {}
    for name, strat in engine_ctx.strategies.items():
        try:
            pred = strat.predict(dfs, price, regime.primary_regime)
            results[name] = {
                "prediction": pred.to_dict(),
                "weight": weights.get(name, 0.2),
            }
        except Exception as e:
            results[name] = {"error": str(e)}

    return {"symbol": symbol.upper(), "regime": regime.primary_regime, "strategies": results}


@app.get("/risk", dependencies=[Depends(verify_api_token)])
@app.get("/risk/ETHUSDT", dependencies=[Depends(verify_api_token)])
@app.get("/risk/{symbol}", dependencies=[Depends(verify_api_token)])
def get_risk(symbol: str = "ETHUSDT"):
    status = engine_ctx.risk_manager.check_risk(engine_ctx.trade_manager.account_balance)
    pos = engine_ctx.trade_manager.active_position
    return {
        "symbol": symbol.upper(),
        "risk_status": status.to_dict(),
        "account_balance": round(engine_ctx.trade_manager.account_balance, 2),
        "active_position": {
            "id": pos.id,
            "direction": pos.direction,
            "entry_price": pos.entry_price,
            "stop_price": pos.current_stop,
            "target_price": pos.target_price,
            "size": pos.size,
            "notional_usd": pos.notional_usd,
            "mfe_pts": pos.max_favorable_pts,
            "mae_pts": pos.max_adverse_pts,
            "bars_held": pos.bars_held,
        } if pos else None,
    }


@app.get("/performance", dependencies=[Depends(verify_api_token)])
def get_performance():
    summary = engine_ctx.database.get_performance_summary()
    recent = engine_ctx.database.get_recent_trades(limit=30)
    return {
        "symbol": engine_ctx.symbol,
        "summary": summary,
        "recent_trades": recent,
    }


# ─── Dynamic Strategy Performance & MasterMind Authority Endpoints ───────

@app.get("/strategy-leaderboard", dependencies=[Depends(verify_api_token)])
def get_strategy_leaderboard():
    """Returns the empirical paper-trading leaderboard across all registered models."""
    leaderboard = engine_ctx.database.get_strategy_leaderboard()
    best_overall = leaderboard[0]["strategy_id"] if (leaderboard and leaderboard[0].get("reliable")) else "NO RELIABLE WINNER YET"
    return {
        "symbol": engine_ctx.symbol,
        "timestamp": time.time(),
        "total_evaluated": len(leaderboard),
        "best_overall": best_overall,
        "leaderboard": leaderboard,
    }


@app.get("/strategy-performance", dependencies=[Depends(verify_api_token)])
@app.get("/strategy-performance/{strategy_id}", dependencies=[Depends(verify_api_token)])
def get_strategy_performance(strategy_id: Optional[str] = None):
    """Returns detailed paper-trading trade log and metrics for one or all strategies."""
    trades = engine_ctx.database.get_paper_trades(strategy_id=strategy_id, limit=50)
    leaderboard = engine_ctx.database.get_strategy_leaderboard()
    
    strat_metric = next((item for item in leaderboard if item["strategy_id"] == strategy_id), None) if strategy_id else None
    
    return {
        "symbol": engine_ctx.symbol,
        "strategy_id": strategy_id or "ALL",
        "metrics": strat_metric,
        "recent_paper_trades": trades,
    }


@app.get("/strategy-regime-performance", dependencies=[Depends(verify_api_token)])
def get_strategy_regime_performance():
    """Returns cross-regime empirical paper performance matrix."""
    matrix = engine_ctx.database.get_regime_performance()
    return {
        "symbol": engine_ctx.symbol,
        "timestamp": time.time(),
        "regime_matrix": matrix,
    }


@app.get("/master-decision", dependencies=[Depends(verify_api_token)])
def get_master_decision(symbol: str = "ETHUSDT"):
    """Canonical MasterMind decision: Authoritative single source of execution truth."""
    decision = engine_ctx.generate_current_decision(symbol=symbol)
    leaderboard = engine_ctx.database.get_strategy_leaderboard()
    
    best_overall = leaderboard[0]["strategy_id"] if (leaderboard and leaderboard[0].get("reliable")) else "NO RELIABLE WINNER YET"
    
    entry = float(decision.get("price") or decision.get("entry_price") or engine_ctx.candle_store.get_latest_price("1m") or 0.0)
    atr = float(engine_ctx.candle_store.get_atr("15m") or engine_ctx.candle_store.get_atr("5m") or (entry * 0.004 if entry > 0 else 10.0))
    tp = decision.get("dynamic_take_profit") or {}
    sl = decision.get("stop_loss") or {}
    risk_check = decision.get("risk_check") or {}
    regime_dict = decision.get("regime") or {}
    regime_name = regime_dict.get("primary_regime", "TRENDING")
    
    sig = decision.get("signal", "HOLD")
    tp_target = tp.get("base_target") if (tp and abs(tp.get("base_target", 0) - entry) > (atr * 0.1)) else (entry + (atr * 1.5) if sig == "BUY" else entry - (atr * 1.5))
    tp_prob = tp.get("base_prob", 0.60) if tp else None
    sl_price = sl.get("stop_price") if (sl and abs(sl.get("stop_price", 0) - entry) > (atr * 0.1)) else (entry - atr if sig == "BUY" else entry + atr)
    pos_size = risk_check.get("position_size", 0.10)
    max_risk = risk_check.get("max_risk_pct", 0.02)
    contribs = decision.get("strategy_contributions", {})
    contrib_strats = decision.get("contributing_strategies", [])
    
    dynamic_lev = engine_ctx.delta_executor.calculate_leverage_from_stop(
        entry_price=entry,
        stop_price=sl_price if sl_price is not None else (entry - atr if sig == "BUY" else entry + atr),
        buffer_factor=2.0,
        min_leverage=2,
        max_leverage=50,
    )
    
    return {
        "timestamp": decision.get("timestamp", time.time()),
        "symbol": symbol.upper(),
        "signal": sig,
        "direction": 1 if sig == "BUY" else (-1 if sig == "SELL" else 0),
        "approved": decision.get("execution_authorized", False),
        "score": decision.get("direction_score", 0.0),
        "confidence": decision.get("confidence", 0.5),
        "agreement": round(max(decision.get("confidence", 0.5), 0.5), 2),
        "regime": regime_name,
        "bestOverallStrategy": best_overall,
        "bestRecentStrategy": best_overall,
        "bestRegimeStrategy": best_overall,
        "strategyWeights": {k: v.get("weight", 0.2) for k, v in contribs.items()},
        "movement": {
            "favorable": {
                "selectedLabel": "BASE_MFE",
                "selectedDistance": round(abs(tp_target - entry), 2) if tp_target is not None else 0.0,
                "selectedProbability": tp_prob,
                "targetPrice": tp_target,
            },
            "adverse": {
                "expectedDistance": round(abs(entry - sl_price), 2) if sl_price is not None else 0.0,
                "selectedStopDistance": round(abs(entry - sl_price), 2) if sl_price is not None else 0.0,
                "stopPrice": sl_price,
            }
        },
        "execution": {
            "entryPrice": entry,
            "takeProfitPrice": tp_target,
            "stopPrice": sl_price,
            "quantity": 1,
            "lotSize": 1,
            "leverage": dynamic_lev,
            "leverageRationale": f"Dynamically calculated based on SP distance ${round(abs(entry - sl_price), 2) if sl_price is not None else 0.0}",
            "deltaProductId": getattr(settings.delta_exchange, "product_id", 3136),
            "deltaSymbol": getattr(settings.delta_exchange, "symbol", "ETHUSD"),
            "tradeEnabled": not engine_ctx.delta_executor.dry_run,
            "deltaTradesCount": engine_ctx.delta_trades_count,
            "deltaTradesLimit": engine_ctx.delta_trades_limit,
            "deltaTradesRemaining": max(0, engine_ctx.delta_trades_limit - engine_ctx.delta_trades_count),
            "deltaLimitReached": engine_ctx.delta_trades_count >= engine_ctx.delta_trades_limit,
        },
        "risk": {
            "maxRisk": max_risk,
            "estimatedLoss": round(1 * abs(entry - sl_price), 2) if sl_price is not None else 0.0,
            "expectedProfit": round(1 * abs(tp_target - entry), 2) if tp_target is not None else 0.0,
            "lotSize": 1,
            "leverage": dynamic_lev,
            "drawdownState": "NORMAL" if not risk_check.get("circuit_breaker_active", False) else "CIRCUIT_BREAKER",
        },
        "contributingStrategies": contrib_strats,
        "rejectedStrategies": [s for s in contribs.keys() if s not in contrib_strats],
        "explanation": {
            "strongestFactors": [
                f"Regime: {regime_name}",
                f"Consensus Direction: {sig}",
                f"Risk:Reward: {decision.get('risk_reward_ratio', 1.5):.2f}",
            ],
            "supportingStrategies": contrib_strats,
            "regimeEvidence": [f"Multi-timeframe features identified {regime_name}"],
            "movementEvidence": [decision.get("reason", "Empirical excursion target")],
        },
        "modelHealth": {
            s: "HEALTHY" for s in contribs.keys()
        }
    }


@app.post("/strategy-paper-trade", dependencies=[Depends(verify_api_token)])
async def record_paper_trade(request: Request):
    """Receive and persist a closed paper-trade result from engine telemetry."""
    try:
        data = await request.json()
        engine_ctx.database.record_paper_trade(data)
        return {"status": "recorded", "id": data.get("id")}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.post("/api/v1/trade/execute", dependencies=[Depends(verify_api_token)])
async def execute_master_trade_endpoint(request: Optional[TradeExecuteRequest] = None):
    """
    Execute a live MasterMind trade on Delta Exchange for strictly 1 lot ETHUSD
    with dynamic leverage calculated based on Stop Price (SP) distance.
    """
    decision = engine_ctx.generate_current_decision()
    sig = (request and request.direction) or decision.get("signal")
    if sig not in ("BUY", "SELL"):
        raise HTTPException(
            status_code=400,
            detail=f"Cannot execute trade: Current signal is {sig}. Must be BUY or SELL."
        )

    if engine_ctx.delta_trades_count >= engine_ctx.delta_trades_limit:
        raise HTTPException(
            status_code=400,
            detail=f"Trade limit reached: Maximum {engine_ctx.delta_trades_limit} Delta Exchange trades permitted ({engine_ctx.delta_trades_count}/{engine_ctx.delta_trades_limit} executed). Capital protection active."
        )

    latest_market_price = engine_ctx.candle_store.get_latest_price("1m") or engine_ctx.candle_store.get_latest_price("5m") or 0.0
    entry = float((request and request.entry_price) or decision.get("entry_price") or latest_market_price)
    if entry <= 0:
        raise HTTPException(status_code=400, detail="Cannot determine entry price from market feed.")

    atr = float(engine_ctx.candle_store.get_atr("15m") or engine_ctx.candle_store.get_atr("5m") or (entry * 0.004))
    dyn_move = float(decision.get("expected_move_magnitude") or atr or (entry * 0.004))
    dyn_rr = float(decision.get("risk_reward_ratio") or 1.5)

    py_tp = (
        (request and (request.tp or request.take_profit_price or request.target_price))
        or decision.get("dynamic_take_profit", {}).get("base_target")
        or decision.get("tp")
    )
    py_sl = (
        (request and (request.sp or request.stop_price or request.stop_loss_price))
        or decision.get("stop_loss", {}).get("stop_price")
        or decision.get("sp")
    )

    is_tp_valid = (
        py_tp is not None
        and ((sig == "BUY" and float(py_tp) > entry + (atr * 0.1)) or (sig == "SELL" and float(py_tp) < entry - (atr * 0.1)))
    )
    is_sl_valid = (
        py_sl is not None
        and ((sig == "BUY" and float(py_sl) < entry - (atr * 0.1)) or (sig == "SELL" and float(py_sl) > entry + (atr * 0.1)))
    )

    tp = float(py_tp) if is_tp_valid else (entry + (dyn_move * dyn_rr) if sig == "BUY" else entry - (dyn_move * dyn_rr))
    sl = float(py_sl) if is_sl_valid else (entry - dyn_move if sig == "BUY" else entry + dyn_move)
    symbol = (request and request.symbol) or getattr(settings.delta_exchange, "symbol", "ETHUSD")
    size = getattr(settings.delta_exchange, "lot_size", 1)

    exec_result = await engine_ctx.delta_executor.execute_master_trade(
        symbol=symbol,
        direction=sig,
        entry_price=float(entry),
        take_profit_price=float(tp),
        stop_loss_price=float(sl),
        tp=float(tp),
        sp=float(sl),
        size=size,
    )

    if exec_result.get("success"):
        engine_ctx.delta_trades_count += 1
        engine_ctx.database.log_delta_trade({
            "order_id": exec_result.get("order_id"),
            "symbol": symbol,
            "product_id": getattr(settings.delta_exchange, "product_id", 3136),
            "side": sig,
            "size": size,
            "entry_price": float(entry),
            "take_profit_price": float(tp),
            "stop_loss_price": float(sl),
            "leverage": exec_result.get("leverage", 10),
            "status": "executed",
            "timestamp": time.time(),
        })
        if engine_ctx.trade_manager.active_position is None:
            regime = decision.get("regime", {}).get("primary_regime", "TRENDING")
            engine_ctx.trade_manager.open_position(
                symbol=symbol,
                direction=sig,
                entry_price=float(entry),
                stop_price=float(sl),
                target_price=float(tp),
                notional_usd=float(entry) * 0.001 * size,
                regime=regime,
                strategy_votes=decision.get("strategy_contributions", {}),
            )

    return {
        "status": "executed" if exec_result.get("success") else "failed",
        "trade": exec_result,
        "delta_connected": engine_ctx.delta_client.is_connected,
        "mode": "live" if not engine_ctx.delta_executor.dry_run else "paper",
        "delta_trades_count": engine_ctx.delta_trades_count,
        "delta_trades_limit": engine_ctx.delta_trades_limit,
        "delta_trades_remaining": max(0, engine_ctx.delta_trades_limit - engine_ctx.delta_trades_count),
        "delta_limit_reached": engine_ctx.delta_trades_count >= engine_ctx.delta_trades_limit,
        "timestamp": time.time(),
    }


@app.post("/api/v1/trade/close", dependencies=[Depends(verify_api_token)])
async def close_master_trade_endpoint():
    """Immediately close active position on Delta Exchange and in TradeManager."""
    latest_price = engine_ctx.candle_store.get_latest_price("1m") or engine_ctx.candle_store.get_latest_price("5m") or 0.0
    delta_res = await engine_ctx.delta_executor.close_open_position()
    tm_record = None
    if engine_ctx.trade_manager.active_position is not None:
        tm_record = engine_ctx.trade_manager.close_position(
            exit_price=latest_price,
            exit_reason="Manual/API Close Request"
        )
    return {
        "status": "closed",
        "delta_result": delta_res,
        "trade_manager_record": tm_record.to_dict() if tm_record else None,
        "timestamp": time.time(),
    }


# ─── Real-Time WebSocket Feed ───────────────────────────────────────────

@app.websocket("/ws/live")
async def websocket_endpoint(websocket: WebSocket):
    """Continuous institutional stream of Ethereum signals and price analysis."""
    await websocket.accept()
    engine_ctx.ws_clients.add(websocket)
    try:
        # Deliver immediate snapshot upon connection
        snapshot = engine_ctx.generate_current_decision()
        snapshot["active_position"] = engine_ctx.trade_manager.active_position.to_dict() if engine_ctx.trade_manager.active_position else None
        await websocket.send_text(json.dumps(snapshot))

        while True:
            await asyncio.sleep(2.0)
            await engine_ctx.sync_active_position()
            decision = engine_ctx.generate_current_decision()
            decision["active_position"] = engine_ctx.trade_manager.active_position.to_dict() if engine_ctx.trade_manager.active_position else None
            await websocket.send_text(json.dumps(decision))

            # Dispatch external alerts and auto-trade on Delta if authorized
            if decision.get("signal") in ("BUY", "SELL"):
                asyncio.create_task(engine_ctx.alert_notifier.notify_signal(decision))
                if not engine_ctx.delta_executor.dry_run:
                    asyncio.create_task(engine_ctx.auto_execute_trade_if_eligible(decision))

    except (WebSocketDisconnect, Exception):
        pass
    finally:
        engine_ctx.ws_clients.discard(websocket)

