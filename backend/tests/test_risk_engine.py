"""
Unit tests for Risk Engine, Stop Engine, Exit Engine, and Position Sizing.
Covers critical production tests: C2, C4, H2, H4, and L5 suite.
"""

import time
import pytest
import numpy as np
import pandas as pd
from unittest.mock import MagicMock

from risk.risk_manager import PortfolioRiskManager
from risk.stop_engine import DynamicStopEngine
from risk.exit_engine import DynamicExitEngine, ExitDecision
from risk.position_sizing import DynamicPositionSizer, ConfidenceToWinRateMapper
from execution.trade_manager import TradeManager
from backtest.backtester import Backtester
from storage.database import Database
from prediction.mfe_mae import MFEMAEEngine
from prediction.reversal_engine import ReversalEngine, ReversalAssessment
from ensemble.weighting import StrategyWeightEngine


def test_drawdown_circuit_breaker():
    """1. Balance drops 12% -> trading not allowed."""
    rm = PortfolioRiskManager(max_drawdown_pct=0.12, initial_balance=10000.0)
    # 8700 is 13% drawdown from 10000
    res = rm.check_risk(current_balance=8700.0)
    assert not res.is_trading_allowed
    assert res.circuit_breaker_active
    assert "drawdown" in res.message.lower()


def test_daily_loss_limit():
    """2. Balance drops 4% in one day -> trading not allowed."""
    rm = PortfolioRiskManager(daily_loss_limit_pct=0.04, initial_balance=10000.0)
    # Drops 4.5% from 10000 day start
    res = rm.check_risk(current_balance=9550.0)
    assert not res.is_trading_allowed
    assert "daily loss limit" in res.message.lower()


def test_consecutive_loss_cooldown():
    """3. 4 losses in a row -> 30min cooldown."""
    rm = PortfolioRiskManager(max_consecutive_losses=4, cooldown_seconds=1800, initial_balance=10000.0)
    bal = 10000.0
    for _ in range(4):
        rm.record_trade_result(-50.0, bal)
        bal -= 50.0

    assert rm.consecutive_losses == 4
    res = rm.check_risk(bal)
    assert not res.is_trading_allowed
    assert "cool-down" in res.message.lower() or "losses" in res.message.lower()


def test_day_reset():
    """4. Simulate midnight crossing -> day_start_balance updates."""
    rm = PortfolioRiskManager(initial_balance=10000.0)
    rm._current_day = "2026-01-01"  # simulated past day
    rm.consecutive_losses = 3

    # On next check today, it should reset day_start_balance to current balance
    rm.check_risk(current_balance=10500.0)
    assert rm.day_start_balance == 10500.0
    assert rm.consecutive_losses == 0


def test_stop_placement_buy_structural():
    """5. BUY with support levels -> stop below nearest support."""
    engine = DynamicStopEngine()
    current_price = 2500.0
    support_levels = [2480.0, 2450.0, 2420.0]
    resistance_levels = [2550.0, 2580.0]
    df = pd.DataFrame({"atr_14": [15.0]})
    placement = engine.calculate_stop(
        current_price=current_price,
        signal="BUY",
        df=df,
        support_levels=support_levels,
        resistance_levels=resistance_levels,
        mae_invalidation=20.0,
        regime="SIDEWAYS",
    )
    assert placement.stop_price < 2480.0
    assert placement.invalidation_level == 2480.0
    assert placement.stop_type == "SWING_LOW_SUPPORT"


def test_stop_placement_buy_no_levels():
    """6. BUY with empty support -> ATR fallback with guards."""
    engine = DynamicStopEngine()
    current_price = 2500.0
    placement = engine.calculate_stop(
        current_price=current_price,
        signal="BUY",
        df=pd.DataFrame(),
        support_levels=[],
        resistance_levels=[],
        mae_invalidation=25.0,
        regime="SIDEWAYS",
    )
    assert placement.stop_price < current_price
    assert placement.stop_type in ("MAE_VOLATILITY", "SWING_LOW_SUPPORT")
    assert placement.risk_distance > 0


def test_exit_engine_trail_update():
    """7. Profit at 50% progress -> trailing stop moves."""
    exit_engine = DynamicExitEngine()
    reversal = ReversalAssessment(
        reversal_probability=0.2,
        exhaustion_detected=False,
        momentum_decay_detected=False,
        divergence_detected=False,
        risk_of_adverse_move=0.2,
        reasons=[],
    )

    # Entry 2500, initial stop 2460, target 2580. Current price 2545 (over 50% to target)
    df = pd.DataFrame({"atr_14": [10.0]})
    dec = exit_engine.evaluate_exit(
        position_direction="BUY",
        entry_price=2500.0,
        current_price=2545.0,
        current_stop=2460.0,
        target_price=2580.0,
        reversal=reversal,
        df=df,
        bars_held=6,
    )
    assert dec.action in ("TRAIL_STOP_UPDATE", "PARTIAL_TP")
    if dec.action == "TRAIL_STOP_UPDATE":
        assert dec.new_trailing_stop > 2460.0


def test_position_sizing_kelly():
    """8. Known payoff ratio 2.0, empirical win rate 0.55 -> Kelly fraction correct."""
    sizer = DynamicPositionSizer(fractional_kelly=0.25, max_risk_per_trade_pct=0.05)
    # Entry 100, Stop 95 (risk 5), Target 110 (gain 10) -> payoff b = 2.0
    # Full Kelly: (p*b - q)/b = (0.55*2 - 0.45)/2 = (1.10 - 0.45)/2 = 0.65/2 = 0.325
    res = sizer.calculate_size(
        account_balance=10000.0,
        entry_price=100.0,
        stop_price=95.0,
        target_price=110.0,
        confidence=0.60,
        historical_win_rate=0.55,
    )
    assert res.kelly_fraction == pytest.approx(0.325, abs=0.001)
    assert res.position_pct > 0.0


def test_partial_close_no_double_counting(tmp_path):
    """C2: Open -> partial at +50pts -> close at -20pts from entry, verify net PnL equals partial gain minus reversal loss."""
    db = Database(db_path=str(tmp_path / "test_c2.db"))
    mfe_mae = MFEMAEEngine()
    exit_engine = DynamicExitEngine()
    reversal_engine = ReversalEngine()
    weight_engine = StrategyWeightEngine()
    risk_manager = PortfolioRiskManager()

    tm = TradeManager(
        database=db,
        mfe_mae_engine=mfe_mae,
        exit_engine=exit_engine,
        reversal_engine=reversal_engine,
        weight_engine=weight_engine,
        risk_manager=risk_manager,
        initial_balance=10000.0,
    )

    # Open 1.0 unit BUY at $2500
    pos = tm.open_position(
        symbol="ETHUSDT",
        direction="BUY",
        entry_price=2500.0,
        stop_price=2450.0,
        target_price=2600.0,
        notional_usd=2500.0,
        regime="SIDEWAYS",
        strategy_votes={"trend": "BUY"},
    )
    assert pos.size == 1.0

    # Partial TP at +50pts ($2550) on 50% size (0.5 unit)
    exit_mock = ExitDecision(action="PARTIAL_TP", exit_score=0.7, urgency="MEDIUM", exit_fraction=0.5, reason="Partial test")
    tm.exit_engine.evaluate_exit = MagicMock(return_value=exit_mock)

    tm.on_price_update(current_price=2550.0, df=pd.DataFrame())
    assert tm.active_position.is_partial_closed
    assert tm.active_position.size == 0.5
    # Balance must NOT be credited yet (deferred to close_position)
    assert tm.account_balance == 10000.0
    partial_realized = tm.active_position.realized_pnl_usd
    assert partial_realized > 23.0

    # Price reverses to -20pts below entry ($2480) and closes remaining 0.5 unit
    trade = tm.close_position(exit_price=2480.0, exit_reason="STOP_HIT")
    expected_total = partial_realized + ((-20.0 * 0.5) - (2480.0 * 0.5 * 0.0004))
    assert trade.pnl_usd == pytest.approx(expected_total, abs=0.01)
    assert tm.account_balance == pytest.approx(10000.0 + expected_total, abs=0.01)


def test_slippage_direction_and_events():
    """H4: Verify _apply_slippage deducts slippage (worse fill) across all 4 events."""
    bt = Backtester(initial_balance=10000.0, slippage_pts=2.0)

    # 1. Entry BUY: fill higher -> 2500 + 2 = 2502
    buy_entry = bt._apply_slippage(2500.0, is_long=True, is_entry=True)
    assert buy_entry == 2502.0

    # 2. Entry SELL: fill lower -> 2500 - 2 = 2498
    sell_entry = bt._apply_slippage(2500.0, is_long=False, is_entry=True)
    assert sell_entry == 2498.0

    # 3. Exit BUY (sell to close): fill lower -> 2600 - 2 = 2598
    buy_exit = bt._apply_slippage(2600.0, is_long=True, is_entry=False)
    assert buy_exit == 2598.0

    # 4. Exit SELL (buy to cover): fill higher -> 2400 + 2 = 2402
    sell_exit = bt._apply_slippage(2400.0, is_long=False, is_entry=False)
    assert sell_exit == 2402.0


def test_multi_day_daily_limit_reset():
    """C4: Simulate 2-day sequence where Day 1 ends at +5%, Day 2 loses 3.9%."""
    rm = PortfolioRiskManager(daily_loss_limit_pct=0.04, initial_balance=10000.0)

    # Day 1: +5% -> balance becomes 10500
    rm.update_balance(10500.0)
    check1 = rm.check_risk(10500.0)
    assert check1.is_trading_allowed

    # Day 2: session starts fresh at 10500 via reset_for_session
    rm.reset_for_session(10500.0)
    assert rm.day_start_balance == 10500.0

    # Now loses 3.9% of 10500 (~410 loss -> balance 10090)
    # This is 0.9% above Day 1 start (10000), but -3.9% from Day 2 start (10500)
    rm.update_balance(10090.0)
    check2 = rm.check_risk(10090.0)
    assert check2.is_trading_allowed

    # If it loses further to 4.2% down from Day 2 start (balance 10050, drop of 450 / 10500 = 4.28%)
    rm.update_balance(10050.0)
    check3 = rm.check_risk(10050.0)
    assert not check3.is_trading_allowed
    assert "daily loss limit" in check3.message.lower()


def test_stop_placement_sell_and_guards():
    """Test SELL stop placement, risk capping (>3x ATR), risk floor (<0.5x ATR), and neutral signal."""
    engine = DynamicStopEngine()
    
    # 1. Neutral signal -> neutral placement
    neutral = engine.calculate_stop(2500.0, "HOLD", pd.DataFrame(), [], [], 10.0)
    assert neutral.stop_type == "NEUTRAL"
    assert neutral.stop_price == 2500.0
    assert "stop_price" in neutral.to_dict()

    # 2. SELL with structural resistance
    df_sell = pd.DataFrame({"high": [2520.0, 2522.0, 2525.0, 2528.0, 2530.0], "atr_14": [10.0] * 5})
    sell_struct = engine.calculate_stop(
        current_price=2500.0,
        signal="SELL",
        df=df_sell,
        support_levels=[],
        resistance_levels=[2525.0],
        mae_invalidation=15.0,
        regime="STRONG_DOWNTREND",
    )
    assert sell_struct.stop_price > 2525.0
    assert sell_struct.stop_type == "SWING_HIGH_RESISTANCE"


    # 3. Maximum risk cap guard: resistance 100 pts away when ATR is 10 (risk 100 > 30)
    capped = engine.calculate_stop(
        current_price=2500.0,
        signal="BUY",
        df=pd.DataFrame({"atr_14": [10.0]}),
        support_levels=[2400.0],
        resistance_levels=[],
        mae_invalidation=20.0,
    )
    assert "CAPPED" in capped.reason
    assert capped.risk_distance <= 25.0  # capped to 2.5 * ATR = 25.0

    # 4. Minimum risk floor guard: support 1 pt away when ATR is 10 (risk 1 < 5)
    floored = engine.calculate_stop(
        current_price=2500.0,
        signal="BUY",
        df=pd.DataFrame({"atr_14": [10.0]}),
        support_levels=[2499.5],
        resistance_levels=[],
        mae_invalidation=1.0,
    )
    assert "FLOORED" in floored.reason or floored.risk_distance >= 5.0


def test_exit_engine_full_exits():
    """Test ExitEngine stop breach exit and target achieved exit."""
    exit_engine = DynamicExitEngine()
    rev = ReversalAssessment(0.1, False, False, False, 0.1, [])

    # 1. Stop breach (BUY with current_price <= stop)
    stop_exit = exit_engine.evaluate_exit(
        position_direction="BUY",
        entry_price=2500.0,
        current_price=2450.0,
        current_stop=2460.0,
        target_price=2600.0,
        reversal=rev,
        df=pd.DataFrame(),
        bars_held=3,
    )
    assert stop_exit.action == "FULL_EXIT"
    assert "stop-loss" in stop_exit.reason.lower()
    assert "action" in stop_exit.to_dict()

    # 2. Target hit (profit_progress >= 1.0)
    target_exit = exit_engine.evaluate_exit(
        position_direction="BUY",
        entry_price=2500.0,
        current_price=2610.0,
        current_stop=2460.0,
        target_price=2600.0,
        reversal=rev,
        df=pd.DataFrame(),
        bars_held=8,
    )
    assert target_exit.action == "FULL_EXIT"
    assert "target zone" in target_exit.reason.lower()

    # 3. Short trailing stop update
    short_trail = exit_engine.evaluate_exit(
        position_direction="SELL",
        entry_price=2500.0,
        current_price=2440.0,  # 60 pts profit out of 100 pt target
        current_stop=2550.0,
        target_price=2400.0,
        reversal=rev,
        df=pd.DataFrame({"atr_14": [10.0]}),
        bars_held=5,
    )
    assert short_trail.action in ("TRAIL_STOP_UPDATE", "PARTIAL_TP")
    if short_trail.action == "TRAIL_STOP_UPDATE":
        assert short_trail.new_trailing_stop < 2550.0


def test_position_sizer_edge_cases_and_mapping():
    """Test invalid balance/price edge cases and ConfidenceToWinRateMapper."""
    sizer = DynamicPositionSizer()
    mapper = ConfidenceToWinRateMapper()

    # Mapper tests
    assert mapper.map_confidence(0.30) == 0.40
    assert mapper.map_confidence(0.50) == 0.45
    assert mapper.map_confidence(0.60) == 0.50
    assert mapper.map_confidence(0.70) == 0.55
    assert mapper.map_confidence(0.80) == 0.60
    assert mapper.map_confidence(0.90) == 0.65

    # Zero or negative inputs
    res_zero_bal = sizer.calculate_size(0.0, 2500.0, 2450.0, 2600.0, 0.60)
    assert res_zero_bal.position_pct == 0.0

    res_zero_risk = sizer.calculate_size(10000.0, 2500.0, 2500.0, 2600.0, 0.60)
    assert res_zero_risk.position_pct == 0.0

    # Valid sizing dictionary serialization
    res_valid = sizer.calculate_size(10000.0, 2500.0, 2450.0, 2600.0, 0.60)
    d = res_valid.to_dict()
    assert "position_pct" in d
    assert "notional_size_usd" in d


