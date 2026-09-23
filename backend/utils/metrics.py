"""
Prometheus Metrics Tracker — Exposes system health, inference latency, and signal statistics.
"""

from __future__ import annotations
import time
from typing import Dict, Any


try:
    from prometheus_client import Counter, Histogram, Gauge, generate_latest, REGISTRY
    signals_total = Counter("trading_signals_total", "Total signals", ["signal", "regime"])
    trades_total = Counter("trading_trades_total", "Total trades", ["direction", "exit_reason"])
    trade_pnl = Histogram("trading_trade_pnl_usd", "Trade PnL", buckets=[-500, -100, -50, 0, 50, 100, 500])
    account_balance = Gauge("trading_account_balance_usd", "Current account balance")
    ws_connected = Gauge("trading_ws_connected", "WebSocket connected")
except Exception:
    signals_total = None
    trades_total = None
    trade_pnl = None
    account_balance = None
    ws_connected = None


class MetricsRegistry:
    """Lightweight in-memory Prometheus metrics exporter."""

    def __init__(self):
        self.signal_counts: Dict[str, int] = {}
        self.ws_reconnects: int = 0
        self.inference_latencies: list[float] = []
        self.current_price: float = 0.0
        self.candle_counts: Dict[str, int] = {}
        self.start_time: float = time.time()

    def record_signal(self, symbol: str, signal: str):
        key = f"{symbol}_{signal}"
        self.signal_counts[key] = self.signal_counts.get(key, 0) + 1

    def record_ws_reconnect(self):
        self.ws_reconnects += 1

    def record_latency(self, duration_seconds: float):
        self.inference_latencies.append(duration_seconds)
        if len(self.inference_latencies) > 200:
            self.inference_latencies.pop(0)

    def set_price(self, price: float):
        self.current_price = price

    def set_candle_count(self, timeframe: str, count: int):
        self.candle_counts[timeframe] = count

    def generate_prometheus_text(self, symbol: str = "ETHUSDT") -> str:
        """Outputs Prometheus exposition format."""
        prom_text = ""
        try:
            if "generate_latest" in globals() and generate_latest:
                prom_text = generate_latest().decode("utf-8")
        except Exception:
            prom_text = ""

        uptime = time.time() - self.start_time
        avg_latency = sum(self.inference_latencies) / len(self.inference_latencies) if self.inference_latencies else 0.0

        lines = [
            "# HELP engine_uptime_seconds Process uptime in seconds",
            "# TYPE engine_uptime_seconds gauge",
            f"engine_uptime_seconds {uptime:.1f}",
            "",
            "# HELP engine_current_price Latest market price",
            "# TYPE engine_current_price gauge",
            f'engine_current_price{{symbol="{symbol}"}} {self.current_price:.2f}',
            "",
            "# HELP engine_inference_latency_seconds Average feature and model inference latency",
            "# TYPE engine_inference_latency_seconds gauge",
            f"engine_inference_latency_seconds {avg_latency:.4f}",
            "",
            "# HELP engine_ws_reconnects_total Total WebSocket reconnect events",
            "# TYPE engine_ws_reconnects_total counter",
            f"engine_ws_reconnects_total {self.ws_reconnects}",
            "",
            "# HELP engine_signals_total Total generated trading signals by action",
            "# TYPE engine_signals_total counter",
        ]

        for key, count in self.signal_counts.items():
            sym, sig = key.split("_", 1)
            lines.append(f'engine_signals_total{{symbol="{sym}",action="{sig}"}} {count}')

        lines.append("")
        lines.append("# HELP engine_candles_total Stored candles per timeframe")
        lines.append("# TYPE engine_candles_total gauge")
        for tf, count in self.candle_counts.items():
            lines.append(f'engine_candles_total{{timeframe="{tf}"}} {count}')

        custom_text = "\n".join(lines) + "\n"
        return prom_text + "\n" + custom_text if prom_text else custom_text


metrics_registry = MetricsRegistry()

