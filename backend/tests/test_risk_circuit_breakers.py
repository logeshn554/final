"""
Unit & Integration Test for PortfolioRiskManager Circuit Breakers and TradeManager Integration.
"""

import pytest
import time
from unittest.mock import MagicMock

from storage.database import Database
from prediction.mfe_mae import MFEMAEEngine
from risk.exit_engine import DynamicExitEngine
from prediction.reversal_engine import ReversalEngine
from ensemble.weighting import StrategyWeightEngine
from risk.risk_manager import PortfolioRiskManager
from execution.trade_manager import TradeManager
from api.server import ProductionEngineContext


def test_trade_manager_calls_record_trade_result(tmp_path):
    """Verify Bug #2 fix: close_position() must call risk_manager.record_trade_result()."""
    db = Database(db_path=str(tmp_path / "test.db"))
    mfe_mae = MFEMAEEngine()
    exit_engine = DynamicExitEngine()
    reversal_engine = ReversalEngine()
    weight_engine = StrategyWeightEngine()
    risk_manager = PortfolioRiskManager(max_consecutive_losses=4)

    tm = TradeManager(
        database=db,
        mfe_mae_engine=mfe_mae,
        exit_engine=exit_engine,
        reversal_engine=reversal_engine,
        weight_engine=weight_engine,
        risk_manager=risk_manager,
        initial_balance=10000.0,
    )

    # 1. Open a position
    tm.open_position(
        symbol="ETHUSDT",
        direction="BUY",
        entry_price=2500.0,
        stop_price=2480.0,
        target_price=2540.0,
        notional_usd=2500.0,
        regime="TRENDING",
        strategy_votes={"trend": "BUY"},
    )
    assert tm.active_position is not None

    # 2. Close with loss
    tm.close_position(exit_price=2480.0, exit_reason="STOP_HIT")
    assert risk_manager.consecutive_losses == 1
    assert tm.account_balance < 10000.0

    # 3. Simulate subsequent losses to verify consecutive loss counter incrementing
    for i in range(2, 5):
        tm.open_position(
            symbol="ETHUSDT",
            direction="BUY",
            entry_price=2500.0,
            stop_price=2480.0,
            target_price=2540.0,
            notional_usd=2500.0,
            regime="TRENDING",
            strategy_votes={"trend": "BUY"},
        )
        tm.close_position(exit_price=2480.0, exit_reason="STOP_HIT")
        assert risk_manager.consecutive_losses == i

    # 4. Now 4 consecutive losses: trading cool-down MUST be active
    status = risk_manager.check_risk(tm.account_balance)
    assert status.is_trading_allowed is False
    assert "losses" in status.message.lower()

    # 5. Verify Max Drawdown Circuit Breaker
    dd_status = risk_manager.check_risk(8500.0) # 15% DD > 12% limit
    assert dd_status.is_trading_allowed is False
    assert dd_status.circuit_breaker_active is True
    assert "drawdown" in dd_status.message.lower()


def test_generate_current_decision_gated_by_risk():
    """Verify Bug #1 fix: generate_current_decision() gates signals with check_risk()."""
    ctx = ProductionEngineContext()
    
    # Trip the circuit breaker by recording 4 consecutive losses
    for _ in range(4):
        ctx.risk_manager.record_trade_result(-50.0, 9800.0)

    # Check risk directly
    risk_status = ctx.risk_manager.check_risk(ctx.trade_manager.account_balance)
    assert risk_status.is_trading_allowed is False

    # Generate current decision - MUST return HOLD and execution_authorized = False
    decision = ctx.generate_current_decision()
    assert decision["signal"] == "HOLD"
    assert decision["execution_authorized"] is False
    assert "BLOCKED BY RISK MANAGER" in decision["reason"]
    assert decision["risk_check"]["is_trading_allowed"] is False
