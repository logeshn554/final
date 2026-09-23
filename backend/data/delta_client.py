"""
Delta Exchange Client — Async REST + WebSocket connector for Delta Exchange (India & Global).
Supports multi-timeframe candlestick fetching, real-time ticker, open interest, funding rate,
and WebSocket streams with automatic reconnect and ping/pong heartbeats.
"""

from __future__ import annotations
import asyncio
import json
import logging
import time
from typing import Callable, Optional, Any, Dict, List
import httpx
from data.candle_store import Candle, CandleStore

logger = logging.getLogger(__name__)

# Map common timeframes to Delta Exchange resolution parameters
DELTA_TF_MAP = {
    "1m": "1m",
    "3m": "3m",
    "5m": "5m",
    "15m": "15m",
    "30m": "30m",
    "1h": "1h",
    "2h": "2h",
    "4h": "4h",
    "6h": "6h",
    "1d": "1d",
    "1w": "1w",
}

# Timeframe duration in seconds for range calculation
TF_SECONDS = {
    "1m": 60,
    "3m": 180,
    "5m": 300,
    "15m": 900,
    "30m": 1800,
    "1h": 3600,
    "2h": 7200,
    "4h": 14400,
    "6h": 21600,
    "1d": 86400,
    "1w": 604800,
}

# Known environment endpoints
ENV_ENDPOINTS = {
    "india_prod": {
        "rest": ["https://api.india.delta.exchange", "https://cdn.india.delta.exchange"],
        "ws": ["wss://socket.india.delta.exchange"],
    },
    "india_testnet": {
        "rest": ["https://demo.delta.exchange"],
        "ws": ["wss://socket.demo.delta.exchange", "wss://socket.india.delta.exchange"],
    },
    "global": {
        "rest": ["https://api.delta.exchange"],
        "ws": ["wss://socket.delta.exchange"],
    },
}


class DeltaExchangeClient:
    """Production Delta Exchange REST + WebSocket client for ETH/crypto derivatives."""

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

        cfg = config if isinstance(config, dict) else {}
        delta_cfg = cfg.get("delta_exchange", {}) if isinstance(cfg, dict) else {}

        self.env = delta_cfg.get("env", "india_prod")
        default_endpoints = ENV_ENDPOINTS.get(self.env, ENV_ENDPOINTS["india_prod"])

        # Configure symbol: Delta Exchange contracts usually use ETHUSD or ETHUSDT
        raw_symbol = delta_cfg.get("symbol") or cfg.get("symbol", "ETHUSD")
        if raw_symbol.upper() == "ETHUSDT" and self.env == "india_prod":
            # In Delta Exchange India, perpetual futures are often listed under ETHUSD
            self.symbol = delta_cfg.get("contract_symbol", "ETHUSD").upper()
        else:
            self.symbol = raw_symbol.upper()

        self.timeframes = cfg.get("timeframes", ["1m", "5m", "15m", "1h"])

        # REST endpoints
        custom_rest = delta_cfg.get("rest_urls") or ([delta_cfg["rest_url"]] if "rest_url" in delta_cfg else None)
        self.rest_urls: List[str] = custom_rest or default_endpoints["rest"]

        # WebSocket endpoints
        custom_ws = delta_cfg.get("ws_urls") or ([delta_cfg["ws_url"]] if "ws_url" in delta_cfg else None)
        self.ws_urls: List[str] = custom_ws or default_endpoints["ws"]

        self.timeout = delta_cfg.get("request_timeout", 10)
        self.max_retries = delta_cfg.get("max_retries", 3)
        self.api_key = delta_cfg.get("api_key")
        self.api_secret = delta_cfg.get("api_secret")

        self._ws = None
        self._running = False
        self._last_msg_time = 0.0
        self._on_tick: Optional[Callable] = None

        # Real-time state cache
        self.latest_ticker: Dict[str, Any] = {
            "mark_price": 0.0,
            "close": 0.0,
            "spot_index_price": 0.0,
            "open_interest": 0.0,
            "funding_rate": 0.0,
            "volume_24h": 0.0,
            "timestamp": 0.0,
        }

    # ─── REST API ─────────────────────────────────────────────────────

    async def fetch_klines(
        self, timeframe: str, limit: int = 300, symbol: Optional[str] = None
    ) -> list[Candle]:
        """
        Fetch historical candles from Delta Exchange /v2/history/candles.
        Populates CandleStore and returns list of Candle instances.
        """
        sym = (symbol or self.symbol).upper()
        resolution = DELTA_TF_MAP.get(timeframe, timeframe)
        sec_per_bar = TF_SECONDS.get(resolution, 60)

        now_sec = int(time.time())
        start_sec = now_sec - (limit * sec_per_bar)

        params = {
            "symbol": sym,
            "resolution": resolution,
            "start": start_sec,
            "end": now_sec,
        }

        for base in self.rest_urls:
            url = f"{base}/v2/history/candles"
            for attempt in range(self.max_retries):
                try:
                    async with httpx.AsyncClient(timeout=self.timeout) as client:
                        resp = await client.get(url, params=params)
                        resp.raise_for_status()
                        payload = resp.json()

                        # Delta response format: {"success": true, "result": [...]}
                        raw_candles = payload.get("result", []) if isinstance(payload, dict) else []
                        if not raw_candles and isinstance(payload, list):
                            raw_candles = payload

                        candles: list[Candle] = []
                        for item in raw_candles:
                            # Delta returns time in seconds or ms
                            t = int(item.get("time", 0))
                            if t < 10_000_000_000:
                                t *= 1000

                            c = Candle(
                                timestamp=t,
                                open=float(item.get("open", 0.0)),
                                high=float(item.get("high", 0.0)),
                                low=float(item.get("low", 0.0)),
                                close=float(item.get("close", 0.0)),
                                volume=float(item.get("volume", 0.0)),
                                trades=int(item.get("trades", item.get("count", 0))),
                                closed=True,
                            )
                            if c.close > 0 and c.high >= c.low:
                                candles.append(c)

                        # Sort ascending by timestamp
                        candles.sort(key=lambda x: x.timestamp)

                        if candles:
                            self.store.add_candles(timeframe, candles)
                            logger.info(
                                f"Loaded {len(candles)} {timeframe} candles for {sym} from Delta Exchange ({base})"
                            )
                            return candles

                except Exception as e:
                    logger.warning(f"Delta REST kline attempt {attempt+1} from {base}: {e}")
                    await asyncio.sleep(0.25)

        logger.error(f"All Delta Exchange REST endpoints failed for {sym} {timeframe}")
        return []

    async def fetch_historical_klines(
        self, symbol: str, timeframe: str, limit: int = 300
    ) -> list[Candle]:
        """Alias for fetch_klines with symbol first."""
        return await self.fetch_klines(timeframe=timeframe, limit=limit, symbol=symbol)

    async def fetch_ticker(self, symbol: Optional[str] = None) -> Dict[str, Any]:
        """Fetch real-time ticker data (mark price, funding rate, open interest)."""
        sym = (symbol or self.symbol).upper()
        for base in self.rest_urls:
            url = f"{base}/v2/tickers/{sym}"
            try:
                async with httpx.AsyncClient(timeout=self.timeout) as client:
                    resp = await client.get(url)
                    resp.raise_for_status()
                    payload = resp.json()
                    res = payload.get("result", {}) if isinstance(payload, dict) else {}

                    mark_p = float(res.get("mark_price") or res.get("close") or 0.0)
                    close_p = float(res.get("close") or mark_p)
                    spot_p = float(res.get("spot_index_price") or close_p)
                    oi = float(res.get("open_interest") or 0.0)
                    funding = float(res.get("funding_rate") or 0.0)
                    vol = float(res.get("volume_24h") or res.get("volume") or 0.0)

                    self.latest_ticker = {
                        "mark_price": mark_p,
                        "close": close_p,
                        "spot_index_price": spot_p,
                        "open_interest": oi,
                        "funding_rate": funding,
                        "volume_24h": vol,
                        "timestamp": time.time(),
                    }
                    return self.latest_ticker
            except Exception as e:
                logger.warning(f"Delta ticker fetch from {base}: {e}")

        return self.latest_ticker

    async def fetch_ticker_price(self, symbol: Optional[str] = None) -> float:
        """Get current mark or close price for symbol."""
        ticker = await self.fetch_ticker(symbol)
        return ticker.get("mark_price") or ticker.get("close") or 0.0

    async def warm_up(self, candles_per_tf: int = 300) -> None:
        """Fetch historical candles for all timeframes."""
        tasks = [self.fetch_klines(tf, candles_per_tf) for tf in self.timeframes]
        await asyncio.gather(*tasks, return_exceptions=True)
        logger.info(f"Warm-up complete for {self.symbol} on Delta Exchange: {self.store.summary()}")

    # ─── WebSocket API ────────────────────────────────────────────────

    async def start_stream(self, on_tick: Optional[Callable] = None) -> None:
        """Start real-time WebSocket connection for Delta Exchange."""
        self._on_tick = on_tick
        self._running = True

        while self._running:
            for ws_url in self.ws_urls:
                if not self._running:
                    break
                try:
                    await self._connect_ws(ws_url)
                except Exception as e:
                    logger.error(f"Delta WebSocket error on {ws_url}: {e}")
                if self._running:
                    logger.info("Retrying Delta Exchange WebSocket stream in 2s...")
                    await asyncio.sleep(2)

    async def start_websocket(self, on_tick: Optional[Callable] = None) -> None:
        """Alias for start_stream."""
        await self.start_stream(on_tick=on_tick)

    async def _connect_ws(self, ws_base_url: str) -> None:
        """Connect to Delta Exchange WebSocket, subscribe, and maintain ping/pong."""
        try:
            import websockets
        except ImportError:
            logger.error("websockets package not installed")
            return

        logger.info(f"Connecting real-time Delta Exchange WebSocket: {ws_base_url}")
        async with websockets.connect(ws_base_url, ping_interval=25, ping_timeout=15) as ws:
            self._ws = ws
            self._last_msg_time = time.time()
            logger.info(f"Connected to Delta Exchange WebSocket for {self.symbol}")

            # Subscribe to channels: ticker and candlesticks for configured timeframes
            channels: List[Dict[str, Any]] = [
                {"name": "v2/ticker", "symbols": [self.symbol]},
            ]
            for tf in self.timeframes:
                res = DELTA_TF_MAP.get(tf, tf)
                channels.append({"name": f"candlestick_{res}", "symbols": [self.symbol]})

            sub_msg = {
                "type": "subscribe",
                "payload": {
                    "channels": channels
                }
            }
            await ws.send(json.dumps(sub_msg))

            # Ping loop background task
            async def ping_loop():
                while self._running and ws.open:
                    await asyncio.sleep(15)
                    try:
                        await ws.send(json.dumps({"type": "ping"}))
                    except Exception:
                        break

            ping_task = asyncio.create_task(ping_loop())

            try:
                async for raw in ws:
                    try:
                        msg = json.loads(raw)
                        self._last_msg_time = time.time()
                        mtype = msg.get("type", "")

                        if mtype == "pong":
                            continue

                        if mtype == "v2/ticker" or "mark_price" in msg:
                            self._process_ticker_msg(msg)

                        elif mtype.startswith("candlestick_") or "open" in msg:
                            self._process_candle_msg(msg)

                    except json.JSONDecodeError:
                        continue
            finally:
                ping_task.cancel()

    def _process_ticker_msg(self, msg: dict) -> None:
        """Parse ticker WebSocket payload and update metrics."""
        mark = float(msg.get("mark_price") or msg.get("close") or 0.0)
        close_p = float(msg.get("close") or mark)
        spot_p = float(msg.get("spot_index_price") or close_p)
        oi = float(msg.get("open_interest") or 0.0)
        funding = float(msg.get("funding_rate") or 0.0)
        vol = float(msg.get("volume_24h") or msg.get("volume") or 0.0)

        if mark > 0:
            self.latest_ticker = {
                "mark_price": mark,
                "close": close_p,
                "spot_index_price": spot_p,
                "open_interest": oi,
                "funding_rate": funding,
                "volume_24h": vol,
                "timestamp": time.time(),
            }

    def _process_candle_msg(self, msg: dict) -> None:
        """Parse candlestick WebSocket message and insert into store."""
        mtype = msg.get("type", "")
        # Extract timeframe from channel name: e.g. "candlestick_1m" -> "1m"
        tf = "1m"
        if mtype.startswith("candlestick_"):
            tf = mtype.replace("candlestick_", "")
        elif "resolution" in msg:
            tf = msg["resolution"]

        # Timestamp conversion
        t = int(msg.get("candle_start_time") or msg.get("time") or time.time() * 1000)
        if t < 10_000_000_000:
            t *= 1000

        try:
            candle = Candle(
                timestamp=t,
                open=float(msg.get("open", 0.0)),
                high=float(msg.get("high", 0.0)),
                low=float(msg.get("low", 0.0)),
                close=float(msg.get("close", 0.0)),
                volume=float(msg.get("volume", 0.0)),
                trades=int(msg.get("trades", msg.get("count", 0))),
                closed=bool(msg.get("is_closed", False)),
            )
        except (ValueError, TypeError):
            return

        if candle.close <= 0 or candle.high < candle.low or candle.open <= 0 or candle.volume < 0:
            return

        self.store.add_candle(tf, candle)

        if self._on_tick and candle.closed:
            try:
                self._on_tick(tf, candle)
            except Exception as e:
                logger.error(f"Delta on_tick callback error: {e}")

    def stop(self) -> None:
        """Stop WebSocket loops."""
        self._running = False
        if self._ws:
            asyncio.ensure_future(self._ws.close())

    def is_data_fresh(self, max_age_seconds: float = 60.0) -> bool:
        """Check if WebSocket or client data has been received within max_age_seconds."""
        if not self._last_msg_time:
            return False
        return (time.time() - self._last_msg_time) <= max_age_seconds

    @property
    def is_connected(self) -> bool:
        """Check if WebSocket or client has received data within the last 20 seconds."""
        return (time.time() - self._last_msg_time) < 20.0 if self._last_msg_time else False

