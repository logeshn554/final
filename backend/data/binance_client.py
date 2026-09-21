"""
Binance Client — Async REST + WebSocket connector for ETHUSDT.
Multi-timeframe kline subscription, auto-reconnect, and multi-endpoint failover.
"""

from __future__ import annotations
import asyncio
import json
import logging
import time
from typing import Callable, Optional, Any
import httpx
from data.candle_store import Candle, CandleStore

logger = logging.getLogger(__name__)

TF_MAP = {"1m": "1m", "5m": "5m", "15m": "15m", "1h": "1h", "4h": "4h", "1d": "1d"}


class BinanceClient:
    """Production Binance REST + WebSocket client for ETHUSDT."""

    def __init__(self, arg1: Any = None, arg2: Any = None):
        # Support both (config, candle_store) and (candle_store, config)
        if isinstance(arg1, CandleStore):
            self.store = arg1
            config = arg2 or {}
        elif isinstance(arg2, CandleStore):
            self.store = arg2
            config = arg1 or {}
        else:
            self.store = CandleStore(buffer_size=1000)
            config = arg1 or {}

        binance_cfg = config.get("binance", {}) if isinstance(config, dict) else {}
        self.symbol = config.get("symbol", "ETHUSDT").upper() if isinstance(config, dict) else "ETHUSDT"
        self.timeframes = config.get("timeframes", ["1m", "5m", "15m", "1h"]) if isinstance(config, dict) else ["1m", "5m", "15m", "1h"]

        self.rest_urls = binance_cfg.get("rest_urls", [
            "https://data-api.binance.vision",
            "https://api.binance.com",
            "https://api1.binance.com",
            "https://api2.binance.com",
        ])
        self.ws_urls = binance_cfg.get("ws_urls", [
            "wss://stream.binance.com:9443/ws",
            "wss://stream.binance.com:443/ws",
            "wss://stream.binance.vision/ws",
        ])
        self.timeout = binance_cfg.get("request_timeout", 10)
        self.max_retries = binance_cfg.get("max_retries", 3)

        self._ws = None
        self._running = False
        self._last_msg_time = 0.0
        self._on_tick: Optional[Callable] = None

    # ─── REST API ─────────────────────────────────────────────────────

    async def fetch_klines(
        self, timeframe: str, limit: int = 500, symbol: Optional[str] = None
    ) -> list[Candle]:
        """Fetch historical klines via REST. Returns list of Candle objects."""
        sym = (symbol or self.symbol).upper()
        interval = TF_MAP.get(timeframe, timeframe)
        params = {"symbol": sym, "interval": interval, "limit": limit}

        for base in self.rest_urls:
            url = f"{base}/api/v3/klines"
            for attempt in range(self.max_retries):
                try:
                    async with httpx.AsyncClient(timeout=self.timeout) as client:
                        resp = await client.get(url, params=params)
                        resp.raise_for_status()
                        data = resp.json()
                        candles = []
                        for k in data:
                            c = Candle(
                                timestamp=int(k[0]),
                                open=float(k[1]),
                                high=float(k[2]),
                                low=float(k[3]),
                                close=float(k[4]),
                                volume=float(k[5]),
                                trades=int(k[8]) if len(k) > 8 else 0,
                                closed=True,
                            )
                            candles.append(c)
                        self.store.add_candles(timeframe, candles)
                        logger.info(f"Loaded {len(candles)} {timeframe} candles for {sym} from {base}")
                        return candles
                except Exception as e:
                    logger.warning(f"REST kline attempt {attempt+1} from {base}: {e}")
                    await asyncio.sleep(0.25)

        logger.error(f"All REST endpoints failed for {sym} {timeframe}")
        return []

    async def fetch_historical_klines(
        self, symbol: str, timeframe: str, limit: int = 300
    ) -> list[Candle]:
        """Alias for fetch_klines with symbol first."""
        return await self.fetch_klines(timeframe=timeframe, limit=limit, symbol=symbol)

    async def fetch_ticker_price(self, symbol: Optional[str] = None) -> float:
        """Get current ticker price for symbol."""
        sym = (symbol or self.symbol).upper()
        for base in self.rest_urls:
            try:
                url = f"{base}/api/v3/ticker/price"
                async with httpx.AsyncClient(timeout=self.timeout) as client:
                    resp = await client.get(url, params={"symbol": sym})
                    resp.raise_for_status()
                    return float(resp.json()["price"])
            except Exception as e:
                logger.warning(f"Ticker fetch from {base}: {e}")
        return 0.0

    async def warm_up(self, candles_per_tf: int = 300) -> None:
        """Fetch historical candles for all timeframes."""
        tasks = [self.fetch_klines(tf, candles_per_tf) for tf in self.timeframes]
        await asyncio.gather(*tasks, return_exceptions=True)
        logger.info(f"Warm-up complete for {self.symbol}: {self.store.summary()}")

    # ─── WebSocket ────────────────────────────────────────────────────

    async def start_stream(self, on_tick: Optional[Callable] = None) -> None:
        """Start multi-stream WebSocket for all timeframes."""
        self._on_tick = on_tick
        self._running = True
        while self._running:
            for ws_url in self.ws_urls:
                if not self._running:
                    break
                try:
                    await self._connect_ws(ws_url)
                except Exception as e:
                    logger.error(f"WebSocket error on {ws_url}: {e}")
                if self._running:
                    logger.info("Retrying WebSocket stream in 2s...")
                    await asyncio.sleep(2)

    async def start_websocket(self, on_tick: Optional[Callable] = None) -> None:
        """Alias for start_stream."""
        await self.start_stream(on_tick=on_tick)

    async def _connect_ws(self, ws_base_url: str) -> None:
        """Connect to combined stream for active symbol."""
        try:
            import websockets
        except ImportError:
            logger.error("websockets package not installed")
            return

        streams = "/".join(
            f"{self.symbol.lower()}@kline_{TF_MAP.get(tf, tf)}"
            for tf in self.timeframes
        )
        url = f"{ws_base_url}/{streams}"
        logger.info(f"Connecting real-time {self.symbol} WebSocket: {url}")

        async with websockets.connect(url, ping_interval=20) as ws:
            self._ws = ws
            self._last_msg_time = time.time()
            logger.info(f"Real-time WebSocket connected for {self.symbol}")

            async for raw in ws:
                try:
                    msg = json.loads(raw)
                    self._last_msg_time = time.time()
                    data = msg.get("data", msg)
                    if "k" in data:
                        self._process_kline(data)
                except json.JSONDecodeError:
                    continue

    def _process_kline(self, msg: dict) -> None:
        """Parse kline WebSocket message and update store."""
        k = msg["k"]
        tf = k["i"]
        candle = Candle(
            timestamp=int(k["t"]),
            open=float(k["o"]),
            high=float(k["h"]),
            low=float(k["l"]),
            close=float(k["c"]),
            volume=float(k["v"]),
            trades=int(k.get("n", 0)),
            closed=k.get("x", False),
        )

        if candle.close <= 0 or candle.high < candle.low or candle.open <= 0 or candle.volume < 0:
            return

        self.store.add_candle(tf, candle)

        if self._on_tick and candle.closed:
            try:
                self._on_tick(tf, candle)
            except Exception as e:
                logger.error(f"on_tick callback error: {e}")

    def stop(self) -> None:
        self._running = False
        if self._ws:
            asyncio.ensure_future(self._ws.close())

    @property
    def is_connected(self) -> bool:
        return (time.time() - self._last_msg_time) < 15.0 if self._last_msg_time else False
