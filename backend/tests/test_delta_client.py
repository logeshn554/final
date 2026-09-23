"""
Unit tests for Delta Exchange Client, Executor, and MCP Bridge.
"""

import pytest
import time
from data.candle_store import CandleStore, Candle
from data.delta_client import DeltaExchangeClient, DELTA_TF_MAP
from data.mcp_bridge import DeltaMCPBridge
from execution.delta_executor import DeltaExchangeExecutor


def test_delta_client_initialization():
    """Verify DeltaExchangeClient initializes correctly with store and config."""
    store = CandleStore(buffer_size=100)
    config = {
        "symbol": "ETHUSD",
        "timeframes": ["1m", "5m", "15m", "1h"],
        "delta_exchange": {
            "env": "india_prod",
            "symbol": "ETHUSD",
            "rest_urls": ["https://api.india.delta.exchange"],
            "ws_urls": ["wss://socket.india.delta.exchange"],
        }
    }
    client = DeltaExchangeClient(config, store)
    assert client.symbol == "ETHUSD"
    assert client.env == "india_prod"
    assert client.rest_urls == ["https://api.india.delta.exchange"]
    assert client.ws_urls == ["wss://socket.india.delta.exchange"]


def test_delta_timeframe_mapping():
    """Verify standard timeframes map to Delta Exchange resolutions."""
    assert DELTA_TF_MAP["1m"] == "1m"
    assert DELTA_TF_MAP["5m"] == "5m"
    assert DELTA_TF_MAP["15m"] == "15m"
    assert DELTA_TF_MAP["1h"] == "1h"
    assert DELTA_TF_MAP["1d"] == "1d"


def test_delta_process_ticker_msg():
    """Verify ticker message updates cache properly."""
    store = CandleStore(buffer_size=100)
    client = DeltaExchangeClient({"symbol": "ETHUSD"}, store)

    msg = {
        "type": "v2/ticker",
        "symbol": "ETHUSD",
        "mark_price": "2655.45",
        "close": "2656.00",
        "spot_index_price": "2654.80",
        "open_interest": "12500.0",
        "funding_rate": "0.00015",
        "volume_24h": "9800000.0",
    }
    client._process_ticker_msg(msg)

    assert client.latest_ticker["mark_price"] == 2655.45
    assert client.latest_ticker["close"] == 2656.00
    assert client.latest_ticker["spot_index_price"] == 2654.80
    assert client.latest_ticker["open_interest"] == 12500.0
    assert client.latest_ticker["funding_rate"] == 0.00015


def test_delta_process_candle_msg():
    """Verify WebSocket candlestick message adds candle to store."""
    store = CandleStore(buffer_size=100)
    client = DeltaExchangeClient({"symbol": "ETHUSD"}, store)

    msg = {
        "type": "candlestick_1m",
        "symbol": "ETHUSD",
        "candle_start_time": 1690000000, # seconds
        "open": 2650.0,
        "high": 2660.0,
        "low": 2645.0,
        "close": 2658.0,
        "volume": 12.5,
        "trades": 45,
        "is_closed": True,
    }
    client._process_candle_msg(msg)

    assert store.get_candle_count("1m") == 1
    candle = store.get_latest_candle("1m")
    assert candle is not None
    assert candle.open == 2650.0
    assert candle.high == 2660.0
    assert candle.low == 2645.0
    assert candle.close == 2658.0
    assert candle.volume == 12.5
    assert candle.closed is True
    # Verify timestamp converted to milliseconds
    assert candle.timestamp == 1690000000000


@pytest.mark.asyncio
async def test_delta_executor_dry_run():
    """Verify DeltaExchangeExecutor dry-run order placement returns simulated fill with TP and SP brackets."""
    executor = DeltaExchangeExecutor(env="india_prod", dry_run=True)
    res = await executor.place_order(
        symbol="ETHUSD",
        size=10,
        side="buy",
        order_type="limit_order",
        limit_price=2650.0,
        take_profit_price=2700.0,
        stop_loss_price=2620.0,
    )
    assert res["success"] is True
    assert res["simulated"] is True
    assert res["status"] == "filled"
    assert "sim-delta-" in res["order_id"]
    assert res["payload"]["side"] == "buy"
    assert res["payload"]["limit_price"] == "2650.0"
    assert res["payload"]["bracket_take_profit_price"] == "2700.0"
    assert res["payload"]["bracket_take_profit_limit_price"] == "2700.0"
    assert res["payload"]["bracket_stop_loss_price"] == "2620.0"
    assert res["payload"]["bracket_stop_loss_limit_price"] == "2620.0"
    assert res["payload"]["stop_trigger_method"] == "mark_price"
    assert res["take_profit_price"] == 2700.0
    assert res["stop_loss_price"] == 2620.0
    assert res["tp"] == 2700.0
    assert res["sp"] == 2620.0


@pytest.mark.asyncio
async def test_delta_executor_place_order_with_tp_sp_aliases():
    """Verify place_order accepts tp and sp arguments directly."""
    executor = DeltaExchangeExecutor(env="india_prod", dry_run=True)
    res = await executor.place_order(
        symbol="ETHUSD",
        size=1,
        side="sell",
        order_type="market_order",
        tp=2550.0,
        sp=2680.0,
    )
    assert res["success"] is True
    assert res["payload"]["side"] == "sell"
    assert res["payload"]["bracket_take_profit_price"] == "2550.0"
    assert res["payload"]["bracket_stop_loss_price"] == "2680.0"
    assert res["tp"] == 2550.0
    assert res["sp"] == 2680.0


def test_mcp_bridge_helpers():
    """Verify MCP bridge initialization and helpers."""
    bridge = DeltaMCPBridge(env="india_prod", mode="read")
    assert bridge.env == "india_prod"
    assert bridge.mode == "read"
    req_id = bridge._next_id()
    assert req_id == 1
    assert bridge._next_id() == 2


def test_delta_executor_dynamic_leverage():
    """Verify dynamic leverage scales inversely with Stop Price (SP) distance."""
    # Tight stop ($15 distance on $2600): clamped to max 25x
    lev_tight = DeltaExchangeExecutor.calculate_leverage_from_stop(2600.0, 2585.0, buffer_factor=2.0, min_leverage=2, max_leverage=25)
    assert lev_tight == 25

    # Medium stop ($50 distance on $2600): ~26 -> clamped to 25x
    lev_med = DeltaExchangeExecutor.calculate_leverage_from_stop(2600.0, 2550.0, buffer_factor=2.0, min_leverage=2, max_leverage=25)
    assert lev_med == 25

    # Wide stop ($130 distance on $2600): 10x
    lev_wide = DeltaExchangeExecutor.calculate_leverage_from_stop(2600.0, 2470.0, buffer_factor=2.0, min_leverage=2, max_leverage=25)
    assert lev_wide == 10

    # Huge stop ($260 distance on $2600): 5x
    lev_huge = DeltaExchangeExecutor.calculate_leverage_from_stop(2600.0, 2340.0, buffer_factor=2.0, min_leverage=2, max_leverage=25)
    assert lev_huge == 5


@pytest.mark.asyncio
async def test_delta_executor_execute_master_trade_1_lot():
    """Verify execute_master_trade dynamically computes leverage and executes exactly 1 lot with brackets."""
    executor = DeltaExchangeExecutor(
        api_key="mock_key",
        api_secret="mock_secret",
        env="india_prod",
        dry_run=True,
    )
    result = await executor.execute_master_trade(
        symbol="ETHUSD",
        direction="BUY",
        entry_price=2600.0,
        take_profit_price=2650.0,
        stop_loss_price=2470.0,  # $130 distance -> 10x leverage
        size=1,
    )
    assert result["success"] is True
    assert result["size"] == 1
    assert result["side"] == "buy"
    assert result["leverage"] == 10
    assert result["product_id"] == 3136
    assert result["take_profit_price"] == 2650.0
    assert result["stop_loss_price"] == 2470.0
    assert result["tp"] == 2650.0
    assert result["sp"] == 2470.0


@pytest.mark.asyncio
async def test_execute_master_trade_api_endpoint_with_tp_sp():
    """Verify POST /api/v1/trade/execute endpoint accepts tp and sp in request payload."""
    from fastapi.testclient import TestClient
    from api.server import app, engine_ctx
    from config import settings

    headers = {}
    if settings.api_auth_token:
        headers["Authorization"] = f"Bearer {settings.api_auth_token}"

    orig_dry_run = engine_ctx.delta_executor.dry_run
    orig_trades_count = engine_ctx.delta_trades_count
    engine_ctx.delta_executor.dry_run = True
    engine_ctx.delta_trades_count = 0
    try:
        client = TestClient(app, headers=headers)
        res = client.post(
            "/api/v1/trade/execute",
            json={
                "symbol": "ETHUSD",
                "direction": "BUY",
                "entry_price": 2600.0,
                "tp": 2650.0,
                "sp": 2470.0,
                "size": 1,
            },
        )
        assert res.status_code == 200
        data = res.json()
        assert data["status"] == "executed"
        assert data["trade"]["size"] == 1
        assert data["trade"]["leverage"] == 10
        assert data["trade"]["product_id"] == 3136
        assert data["trade"]["tp"] == 2650.0
        assert data["trade"]["sp"] == 2470.0
    finally:
        engine_ctx.delta_executor.dry_run = orig_dry_run
        engine_ctx.delta_trades_count = orig_trades_count

