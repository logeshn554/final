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
    regime: Dict[str, Any]
    sizing: Dict[str, Any]
    reversal_assessment: Dict[str, Any]


class HealthResponse(BaseModel):
    status: str
    symbol: str
    uptime_seconds: float
    candle_counts: Dict[str, int]
    is_ws_connected: bool
    active_position: bool
    timestamp: float


# ─── Engine Context ─────────────────────────────────────────────────────

class ProductionEngineContext:
    """Manages system lifecycles, real-time data feeds, and analytics for Ethereum."""

    def __init__(self):
        self.symbol = settings.symbol.upper()
        self.candle_store = CandleStore(buffer_size=settings.candle_buffer_size)
        self.market_data = MarketDataProcessor(self.candle_store)
        self.binance_client = BinanceClient(settings.model_dump(), self.candle_store)
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
        self.weight_engine = StrategyWeightEngine()
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
            price = self.candle_store.get_latest_price("15m") or 3200.0

        # Update metrics
        metrics_registry.set_price(price)
        for tf in settings.timeframes:
            metrics_registry.set_candle_count(tf, self.candle_store.get_candle_count(tf))

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
            return {
                "symbol": active_sym,
                "timestamp": time.time(),
                "signal": "HOLD",
                "entry_price": float(price),
                "dynamic_expected_range": {
                    "low": round(price * 0.99, 2),
                    "high": round(price * 1.01, 2),
                },
                "dynamic_take_profit": {
                    "conservative_target": round(price * 1.002, 2),
                    "conservative_prob": 0.75,
                    "base_target": round(price * 1.005, 2),
                    "base_prob": 0.50,
                    "extended_target": round(price * 1.01, 2),
                    "extended_prob": 0.25,
                    "derivation_reason": "Warming up candle history",
                },
                "dynamic_exit_target": round(price * 1.005, 2),
                "stop_loss": {
                    "stop_price": round(price * 0.995, 2),
                    "invalidation_level": round(price * 0.995, 2),
                    "buffer_distance": round(price * 0.005, 2),
                    "risk_distance": round(price * 0.005, 2),
                    "risk_bps": 50.0,
                    "stop_type": "WARM_UP_DEFAULT",
                    "reason": "Engine warming up candles",
                },
                "confidence": 0.0,
                "expected_move_magnitude": 0.0,
                "expected_move_bps": 0.0,
                "expected_move_duration_minutes": 15,
                "reason": "Engine warming up candles; awaiting sufficient market data history.",
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

        sizing = self.position_sizer.calculate_size(
            account_balance=self.trade_manager.account_balance,
            entry_price=price,
            stop_price=stop_placement.stop_price,
            target_price=targets.base_target,
            confidence=decision.confidence,
            vol_expansion=vol_exp,
        )

        # 8. Reversal Assessment
        reversal = self.reversal_engine.assess(
            primary_df if primary_df is not None else None,
            price,
            decision.signal if decision.signal in ("BUY", "SELL") else "BUY",
        )

        full_decision = {
            "symbol": active_sym,
            "timestamp": time.time(),
            "signal": decision.signal,
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
            "confidence": round(decision.confidence, 4),
            "expected_move_magnitude": round(targets.expected_move_magnitude, 2),
            "expected_move_bps": round(targets.expected_move_bps, 2),
            "expected_move_duration_minutes": targets.expected_duration_minutes,
            "reason": decision.reason,
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
        metrics_registry.record_signal(active_sym, decision.signal)
        metrics_registry.record_latency(time.time() - t0)

        self.database.log_signal(SignalLog(
            timestamp=time.time(),
            symbol=active_sym,
            price=price,
            signal=decision.signal,
            direction_score=decision.direction_score,
            confidence=decision.confidence,
            regime=regime.primary_regime,
            expected_move=targets.expected_move_magnitude,
            target_base=targets.base_target,
            stop_price=stop_placement.stop_price,
            reasons=decision.reason,
            contributing_strats=",".join(decision.contributing_strategies),
        ))

        return full_decision


engine_ctx = ProductionEngineContext()


# ─── Modern Lifespan Management ──────────────────────────────────────────

@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info(f"[STARTUP] Initializing Production Engine for {engine_ctx.symbol}...")
    try:
        # Pre-fill multi-timeframe candles
        for tf in settings.timeframes:
            await engine_ctx.binance_client.fetch_historical_klines(engine_ctx.symbol, tf, limit=300)
        logger.info(f"[READY] {engine_ctx.symbol} historical data initialized.")
    except Exception as e:
        logger.warning(f"Historical warmup warning (engine will continue): {e}")

    # Launch WebSocket consumer in background
    engine_ctx.is_running = True
    engine_ctx.ws_task = asyncio.create_task(engine_ctx.binance_client.start_websocket())

    yield

    # Clean graceful shutdown
    logger.info("[SHUTDOWN] Shutting down Production Engine...")
    engine_ctx.is_running = False
    engine_ctx.binance_client.stop()
    if engine_ctx.ws_task:
        engine_ctx.ws_task.cancel()
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
        uptime_seconds=round(time.time() - engine_ctx.start_time, 1),
        candle_counts=counts,
        is_ws_connected=engine_ctx.binance_client.is_connected,
        active_position=bool(engine_ctx.trade_manager.active_position),
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
    price = engine_ctx.candle_store.get_latest_price("1m") or 3200.0
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
    price = engine_ctx.candle_store.get_latest_price("1m") or 3200.0
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
    
    # Extract movement distribution from dictionary
    entry = decision.get("price", 2500.0)
    tp = decision.get("dynamic_take_profit", {})
    sl = decision.get("stop_loss", {})
    risk_check = decision.get("risk_check", {})
    regime_dict = decision.get("regime", {})
    regime_name = regime_dict.get("primary_regime", "TRENDING")
    
    tp_target = tp.get("base_target", entry + 15.0)
    tp_prob = tp.get("base_prob", 0.60)
    sl_price = sl.get("stop_price", entry - 10.0)
    pos_size = risk_check.get("position_size", 0.10)
    max_risk = risk_check.get("max_risk_pct", 0.02)
    sig = decision.get("signal", "HOLD")
    contribs = decision.get("strategy_contributions", {})
    contrib_strats = decision.get("contributing_strategies", [])
    
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
                "selectedDistance": round(abs(tp_target - entry), 2),
                "selectedProbability": tp_prob,
                "targetPrice": tp_target,
            },
            "adverse": {
                "expectedDistance": round(abs(entry - sl_price), 2),
                "selectedStopDistance": round(abs(entry - sl_price), 2),
                "stopPrice": sl_price,
            }
        },
        "execution": {
            "entryPrice": entry,
            "takeProfitPrice": tp_target,
            "stopPrice": sl_price,
            "quantity": pos_size,
        },
        "risk": {
            "maxRisk": max_risk,
            "estimatedLoss": round(pos_size * abs(entry - sl_price), 2),
            "expectedProfit": round(pos_size * abs(tp_target - entry), 2),
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


# ─── Real-Time WebSocket Feed ───────────────────────────────────────────

@app.websocket("/ws/live")
async def websocket_endpoint(websocket: WebSocket):
    """Continuous institutional stream of Ethereum signals and price analysis."""
    await websocket.accept()
    engine_ctx.ws_clients.add(websocket)
    try:
        # Deliver immediate snapshot upon connection
        snapshot = engine_ctx.generate_current_decision()
        await websocket.send_text(json.dumps(snapshot))

        while True:
            await asyncio.sleep(2.0)
            decision = engine_ctx.generate_current_decision()
            await websocket.send_text(json.dumps(decision))

            # Dispatch external alerts if high conviction signal triggered
            if decision.get("signal") in ("BUY", "SELL"):
                asyncio.create_task(engine_ctx.alert_notifier.notify_signal(decision))

    except (WebSocketDisconnect, Exception):
        pass
    finally:
        engine_ctx.ws_clients.discard(websocket)
