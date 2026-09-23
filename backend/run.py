"""
Main Entry Point — Run the API server, execute a backtest, or compute a live signal for ETHUSDT.

Usage:
  python run.py api        # Start the FastAPI server (default: port 8000)
  python run.py signal     # Fetch live Ethereum candles, compute features, and print signal
  python run.py backtest   # Run walk-forward backtest simulation for ETHUSDT
"""

from __future__ import annotations
import sys
import asyncio
import json
import logging
import warnings

warnings.filterwarnings("ignore", category=RuntimeWarning)
logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("run")

ACTIVE_SYMBOL = "ETHUSDT"


def _free_port_if_in_use(port: int):
    """Ensure port is freed on Windows before uvicorn binds to avoid [Errno 10048]."""
    try:
        import os
        import subprocess
        import time
        current_pid = os.getpid()
        cmd = f'powershell -Command "Get-NetTCPConnection -LocalPort {port} -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess"'
        res = subprocess.run(cmd, shell=True, capture_output=True, text=True)
        pids = set(res.stdout.strip().split())
        for p in pids:
            p = p.strip()
            if p and p.isdigit():
                pid_int = int(p)
                if pid_int != current_pid and pid_int > 0:
                    logger.info(f"Terminating existing process PID {pid_int} on port {port} to prevent Errno 10048...")
                    subprocess.run(f"taskkill /F /PID {pid_int}", shell=True, capture_output=True)
                    time.sleep(1.0)
    except Exception as e:
        logger.warning(f"Port check/free warning: {e}")


def run_api(host: str = "0.0.0.0", port: int = 8000, reload: bool = False):
    """Start uvicorn server with automatic port freeing."""
    _free_port_if_in_use(port)
    import uvicorn
    logger.info(f"Starting Ethereum (ETHUSDT) Engine Server on http://{host}:{port} (reload={reload})")
    uvicorn.run("api.server:app", host=host, port=port, reload=reload)


async def run_signal():
    """Fetch live data and print complete decision for Ethereum."""
    from api.server import engine_ctx
    from config import settings
    exchange_name = getattr(settings, "exchange", "delta").upper()
    sym = engine_ctx.symbol
    logger.info(f"Fetching live {sym} klines from {exchange_name}...")
    for tf in ["1m", "5m", "15m", "1h"]:
        await engine_ctx.active_client.fetch_historical_klines(sym, tf, limit=200)

    decision = engine_ctx.generate_current_decision(sym)
    print("\n" + "=" * 60)
    print(f"   ETHEREUM ({sym}) DYNAMIC ENGINE DECISION [{exchange_name}]")
    print("=" * 60)
    print(f"SIGNAL:            {decision['signal']}")
    print(f"CONFIDENCE:        {decision['confidence']:.1%}")
    print(f"ENTRY PRICE:       ${decision['entry_price']:,.2f}")
    print(f"REGIME:            {decision['regime']['primary_regime']}")
    print(f"EXPECTED RANGE:    ${decision['dynamic_expected_range']['low']:,.2f} - ${decision['dynamic_expected_range']['high']:,.2f}")
    print(f"BASE TAKE PROFIT:  ${decision['dynamic_take_profit']['base_target']:,.2f} (P={decision['dynamic_take_profit']['base_prob']:.0%})")
    print(f"CONSERVATIVE TP:   ${decision['dynamic_take_profit']['conservative_target']:,.2f} (P={decision['dynamic_take_profit']['conservative_prob']:.0%})")
    print(f"EXTENDED TP:       ${decision['dynamic_take_profit']['extended_target']:,.2f} (P={decision['dynamic_take_profit']['extended_prob']:.0%})")
    print(f"STOP LOSS:         ${decision['stop_loss']['stop_price']:,.2f} ({decision['stop_loss']['stop_type']})")
    print(f"RISK/REWARD (MKT): {decision['risk_reward_ratio']:.2f}")
    print(f"EXP MOVE MAG:      ${decision['expected_move_magnitude']:,.2f} ({decision['expected_move_bps']:.1f} bps)")
    print(f"EXP DURATION:      {decision['expected_move_duration_minutes']} minutes")
    print(f"REASON:            {decision['reason']}")
    print(f"CONTRIBUTING:      {', '.join(decision['contributing_strategies'])}")
    print("=" * 60 + "\n")


async def run_backtest_cli():
    """Fetch historical Ethereum data and run backtest."""
    from config import settings
    from data.candle_store import CandleStore
    from data.delta_client import DeltaExchangeClient
    from data.binance_client import BinanceClient
    from features.technical import compute_all_technical_features
    from features.market_structure import compute_all_structure_features
    from features.volatility import compute_all_volatility_features
    from features.volume import compute_all_volume_features
    from features.statistical import compute_all_statistical_features
    from backtest.backtester import Backtester

    sym = getattr(settings, "symbol", "ETHUSD")
    exch = getattr(settings, "exchange", "delta").lower()
    store = CandleStore(buffer_size=1000)

    if exch == "delta":
        client = DeltaExchangeClient(settings.model_dump(), store)
    else:
        client = BinanceClient.from_settings(store, settings)


    logger.info(f"Downloading historical {sym} candles from {exch.upper()} for backtesting...")
    for tf in ["1m", "5m", "15m", "1h"]:
        await client.fetch_historical_klines(sym, tf, limit=500)

    dfs = {}
    for tf in ["1m", "5m", "15m", "1h"]:
        df = store.get_dataframe(tf)
        if df is not None and len(df) > 50:
            df = compute_all_technical_features(df)
            df = compute_all_structure_features(df)
            df = compute_all_volatility_features(df)
            df = compute_all_volume_features(df)
            df = compute_all_statistical_features(df)
            dfs[tf] = df

    logger.info("Running walk-forward backtest for Ethereum...")
    bt = Backtester(initial_balance=10000.0, slippage_pts=0.25)
    results = bt.run(dfs, primary_tf="15m", warmup_bars=60)

    m = results["metrics"]
    print("\n" + "=" * 60)
    print(f"        {ACTIVE_SYMBOL} BACKTEST PERFORMANCE SUMMARY")
    print("=" * 60)
    print(f"Total Trades:     {m['total_trades']}")
    print(f"Win Rate:         {m['win_rate']:.1%}")
    print(f"Total PnL:        ${m['total_pnl_usd']:,.2f} ({m['total_return_pct']:+.1%})")
    print(f"Profit Factor:    {m['profit_factor']:.2f}")
    print(f"Sharpe Ratio:     {m['sharpe_ratio']:.2f}")
    print(f"Sortino Ratio:    {m['sortino_ratio']:.2f}")
    print(f"Max Drawdown:     {m['max_drawdown_pct']:.1%} (${m['max_drawdown_usd']:,.2f})")
    print(f"Payoff Ratio:     {m['payoff_ratio']:.2f}")
    print(f"Avg Holding Time: {m['avg_holding_minutes']:.1f} mins")
    print("=" * 60 + "\n")


def main():
    cmd = sys.argv[1] if len(sys.argv) > 1 and not sys.argv[1].startswith("-") else "api"
    reload_flag = "--reload" in sys.argv
    if cmd == "api":
        run_api(reload=reload_flag)
    elif cmd == "signal":
        asyncio.run(run_signal())
    elif cmd == "backtest":
        asyncio.run(run_backtest_cli())
    else:
        print(f"Unknown command: {cmd}. Available: api, signal, backtest")


if __name__ == "__main__":
    main()
