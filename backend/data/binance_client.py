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

    def __init__(
        self,
        candle_store: CandleStore,
        *,
        symbol: str = "ETHUSDT",
        timeframes: list[str] | None = None,
        rest_urls: list[str] | None = None,
        ws_urls: list[str] | None = None,
        request_timeout: int = 10,
        max_retries: int = 3,
    ):
        self.store = candle_store
        self.symbol = symbol.upper()
        self.timeframes = timeframes or ["1m", "5m", "15m", "1h"]

        self.rest_urls = rest_urls or [
            "https://data-api.binance.vision",
            "https://api.binance.com",
            "https://api1.binance.com",
            "https://api2.binance.com",
            "https://api3.binance.com",
        ]
        self.ws_urls = ws_urls or [
            "wss://stream.binance.com:9443/ws",
            "wss://stream.binance.com:443/ws",
            "wss://data-stream.binance.vision/ws",
        ]
        self.timeout = request_timeout
        self.max_retries = max_retries

        self._ws = None
        self._running = False
        self._last_msg_time = 0.0
        self._on_tick: Optional[Callable] = None

    @classmethod
    def from_settings(cls, store: CandleStore, settings: Any) -> "BinanceClient":
        """Factory creating client from typed AppSettings or dict (C5)."""
        if hasattr(settings, "binance"):
            b = settings.binance
            return cls(
                store,
                symbol=getattr(settings, "symbol", "ETHUSDT"),
                timeframes=getattr(settings, "timeframes", None),
                rest_urls=getattr(b, "rest_urls", None),
                ws_urls=getattr(b, "ws_urls", None),
                request_timeout=getattr(b, "request_timeout", 10),
                max_retries=getattr(b, "max_retries", 3),
            )
        cfg = settings if isinstance(settings, dict) else {}
        b = cfg.get("binance", {})
        return cls(
            store,
            symbol=cfg.get("symbol", "ETHUSDT"),
            timeframes=cfg.get("timeframes", None),
            rest_urls=b.get("rest_urls", None),
            ws_urls=b.get("ws_urls", None),
            request_timeout=b.get("request_timeout", 10),
            max_retries=b.get("max_retries", 3),
        )

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

        async def _watchdog(ws, timeout: float = 45.0):
            while self._running:
                await asyncio.sleep(10)
                if self._last_msg_time and (time.time() - self._last_msg_time > timeout):
                    logger.error(f"WebSocket stale for {timeout}s — forcing reconnect")
                    await ws.close()
                    return

        async def _recv_loop(ws):
            async for raw in ws:
                try:
                    msg = json.loads(raw)
                    self._last_msg_time = time.time()
                    data = msg.get("data", msg)
                    if "k" in data:
                        self._process_kline(data)
                except json.JSONDecodeError:
                    continue

        async with websockets.connect(url, ping_interval=20) as ws:
            self._ws = ws
            self._last_msg_time = time.time()
            logger.info(f"Real-time WebSocket connected for {self.symbol}")
            await asyncio.gather(
                _recv_loop(ws),
                _watchdog(ws, timeout=45.0),
                return_exceptions=True,
            )

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

    def is_data_fresh(self, max_age_seconds: float = 60.0) -> bool:
        """Check if WebSocket data has been received within max_age_seconds."""
        if not self._last_msg_time:
            return False
        return (time.time() - self._last_msg_time) <= max_age_seconds

    @property
    def is_connected(self) -> bool:
        return (time.time() - self._last_msg_time) < 45.0 if self._last_msg_time else False

