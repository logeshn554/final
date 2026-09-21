"""
Unit tests for backtest simulation and institutional metrics.
"""

import numpy as np
import pandas as pd
import pytest

from backtest.metrics import calculate_metrics
from backtest.failure_analysis import FailureAnalyzer


def test_metrics_calculation():
    trades = [
        {"pnl_usd": 150.0, "pnl_pct": 0.015, "holding_time_minutes": 45, "mfe_pts": 200.0, "mae_pts": 50.0},
        {"pnl_usd": -80.0, "pnl_pct": -0.008, "holding_time_minutes": 30, "mfe_pts": 40.0, "mae_pts": 90.0},
        {"pnl_usd": 220.0, "pnl_pct": 0.022, "holding_time_minutes": 60, "mfe_pts": 250.0, "mae_pts": 40.0},
    ]

    metrics = calculate_metrics(trades, initial_balance=10000.0)
    assert metrics.total_trades == 3
    assert metrics.winning_trades == 2
    assert metrics.losing_trades == 1
    assert metrics.win_rate == pytest.approx(2 / 3, 0.01)
    assert metrics.total_pnl_usd == 290.0
    assert metrics.profit_factor > 1.0


def test_failure_analyzer():
    analyzer = FailureAnalyzer()
    bad_trade = {
        "id": "t1",
        "direction": "BUY",
        "entry_price": 60000.0,
        "pnl_usd": -120.0,
        "mfe_pts": 450.0,
        "regime_at_entry": "STRONG_UPTREND",
        "strategy_votes": '{"trend": {"signal": "BUY"}, "structure": {"signal": "SELL"}}',
    }

    diag = analyzer.diagnose_trade(bad_trade)
    assert diag.failure_category == "MOMENTUM_EXHAUSTION"
    assert "trend" in diag.culpable_strategies
