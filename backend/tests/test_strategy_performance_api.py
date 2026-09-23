"""
Unit & Integration Tests for Backend Strategy Performance API & Paper Trading Database.
"""

import pytest
import time
import os
import sqlite3
from fastapi.testclient import TestClient

from storage.database import Database
from api.server import app, engine_ctx


@pytest.fixture
def test_db(tmp_path):
    db_file = str(tmp_path / "test_trades.db")
    db = Database(db_path=db_file)
    return db


@pytest.fixture
def client():
    from config import settings
    headers = {}
    if settings.api_auth_token:
        headers["Authorization"] = f"Bearer {settings.api_auth_token}"
    return TestClient(app, headers=headers)


def test_database_paper_trades_lifecycle(test_db):
    """Test recording paper trade, net PnL, fees, and retrieval."""
    now = time.time()
    
    # Insert a winning trade
    trade_win = {
        "id": "trade_1",
        "strategy_id": "rl_ppo",
        "symbol": "ETHUSDT",
        "timestamp": now - 300,
        "side": "BUY",
        "entry_price": 2500.0,
        "predicted_move": 15.0,
        "predicted_target": 2515.0,
        "predicted_stop": 2492.0,
        "confidence": 0.85,
        "regime": "TREND_UP",
        "quantity": 0.5,
        "fees": 1.003, # Binance 4 bps
        "slippage": 0.376, # 1.5 bps
        "exit_price": 2515.0,
        "exit_timestamp": now,
        "pnl": 7.50, # (2515 - 2500) * 0.5
        "net_pnl": 6.121, # 7.50 - 1.003 - 0.376
        "return_pct": 0.006,
        "holding_time": 300,
        "exit_reason": "TARGET_HIT",
        "successful": True,
        "loss_reason": ""
    }
    test_db.record_paper_trade(trade_win)

    trades = test_db.get_paper_trades(strategy_id="rl_ppo")
    assert len(trades) == 1
    assert trades[0]["strategy_id"] == "rl_ppo"
    assert trades[0]["successful"] == 1
    assert trades[0]["net_pnl"] == pytest.approx(6.121, rel=1e-3)


def test_sample_size_protection(test_db):
    """Verify that strategies with < 30 trades are flagged as not reliable."""
    now = time.time()

    # Record 5 winning trades for strategy A
    for i in range(5):
        test_db.record_paper_trade({
            "id": f"t_a_{i}",
            "strategy_id": "strategy_a",
            "symbol": "ETHUSDT",
            "timestamp": now - 100,
            "side": "BUY",
            "entry_price": 2500.0,
            "predicted_move": 10.0,
            "predicted_target": 2510.0,
            "predicted_stop": 2495.0,
            "confidence": 0.80,
            "regime": "SIDEWAYS",
            "quantity": 0.1,
            "fees": 0.20,
            "slippage": 0.07,
            "exit_price": 2510.0,
            "exit_timestamp": now,
            "pnl": 1.0,
            "net_pnl": 0.73,
            "return_pct": 0.004,
            "holding_time": 100,
            "exit_reason": "TARGET_HIT",
            "successful": True,
            "loss_reason": ""
        })

    leaderboard = test_db.get_strategy_leaderboard()
    assert len(leaderboard) == 1
    strat = leaderboard[0]
    assert strat["strategy_id"] == "strategy_a"
    assert strat["sample_size"] == 5
    assert strat["reliable"] is False
    assert strat["status"] == "INSUFFICIENT_DATA"


def test_api_leaderboard_endpoint(client):
    """Test GET /strategy-leaderboard endpoint."""
    response = client.get("/strategy-leaderboard")
    assert response.status_code == 200
    data = response.json()
    assert "leaderboard" in data
    assert "best_overall" in data
    assert "total_evaluated" in data


def test_api_master_decision_endpoint(client):
    """Test GET /master-decision endpoint canonical schema."""
    response = client.get("/master-decision?symbol=ETHUSDT")
    assert response.status_code == 200
    data = response.json()
    assert data["symbol"] == "ETHUSDT"
    assert data["signal"] in ["BUY", "SELL", "HOLD"]
    assert "movement" in data
    assert "favorable" in data["movement"]
    assert "adverse" in data["movement"]
    assert "execution" in data
    assert "risk" in data
    assert "explanation" in data
    assert "bestOverallStrategy" in data


def test_api_regime_performance_endpoint(client):
    """Test GET /strategy-regime-performance endpoint."""
    response = client.get("/strategy-regime-performance")
    assert response.status_code == 200
    data = response.json()
    assert "regime_matrix" in data
