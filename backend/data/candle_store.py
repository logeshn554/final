"""
Candle Store — Thread-safe ring-buffer OHLCV storage per timeframe.
Provides pandas DataFrame views with no copy overhead for feature computation.
"""

from __future__ import annotations
import numpy as np
import pandas as pd
from collections import deque
from dataclasses import dataclass, field
from typing import Optional
import threading
import time
import logging

logger = logging.getLogger(__name__)


@dataclass
class Candle:
    """Single OHLCV candle."""
    timestamp: int  # open time in ms
    open: float
    high: float
    low: float
    close: float
    volume: float
    trades: int = 0
    closed: bool = True

    @property
    def range(self) -> float:
        return self.high - self.low

    @property
    def body(self) -> float:
        return abs(self.close - self.open)

    @property
    def upper_shadow(self) -> float:
        return self.high - max(self.open, self.close)

    @property
    def lower_shadow(self) -> float:
        return min(self.open, self.close) - self.low

    @property
    def is_bullish(self) -> bool:
        return self.close >= self.open

    @property
    def typical_price(self) -> float:
        return (self.high + self.low + self.close) / 3.0

    @property
    def mid(self) -> float:
        return (self.high + self.low) / 2.0


class TimeframeBuffer:
    """Ring buffer for one timeframe with efficient DataFrame conversion."""

    def __init__(self, max_size: int = 1000):
        self.max_size = max_size
        self._candles: deque[Candle] = deque(maxlen=max_size)
        self._lock = threading.Lock()
        self._df_cache: Optional[pd.DataFrame] = None
        self._cache_len: int = 0
        self.last_update: float = 0.0

    def add(self, candle: Candle) -> None:
        """Add or update the latest candle."""
        with self._lock:
            if self._candles and self._candles[-1].timestamp == candle.timestamp:
                self._candles[-1] = candle  # update in-place
            else:
                # Check for duplicate older timestamps
                if self._candles and candle.timestamp <= self._candles[-1].timestamp:
                    return  # stale data, ignore
                self._candles.append(candle)
            self._df_cache = None  # invalidate cache
            self.last_update = time.time()

    def add_batch(self, candles: list[Candle]) -> int:
        """Add a sorted batch of candles. Returns count added."""
        added = 0
        with self._lock:
            for c in sorted(candles, key=lambda x: x.timestamp):
                if self._candles and c.timestamp <= self._candles[-1].timestamp:
                    if c.timestamp == self._candles[-1].timestamp:
                        self._candles[-1] = c
                    continue
                self._candles.append(c)
                added += 1
            if added:
                self._df_cache = None
                self.last_update = time.time()
        return added

    @property
    def df(self) -> pd.DataFrame:
        """Efficient DataFrame view with caching. Always returns a copy so callers cannot corrupt the buffer."""
        with self._lock:
            if self._df_cache is not None and self._cache_len == len(self._candles):
                return self._df_cache.copy()
            if not self._candles:
                self._df_cache = pd.DataFrame(
                    columns=["timestamp", "open", "high", "low", "close", "volume", "trades"]
                )
                self._cache_len = 0
                return self._df_cache.copy()
            data = {
                "timestamp": [c.timestamp for c in self._candles],
                "open": [c.open for c in self._candles],
                "high": [c.high for c in self._candles],
                "low": [c.low for c in self._candles],
                "close": [c.close for c in self._candles],
                "volume": [c.volume for c in self._candles],
                "trades": [c.trades for c in self._candles],
            }
            self._df_cache = pd.DataFrame(data)
            self._cache_len = len(self._candles)
            return self._df_cache.copy()

    @property
    def closes(self) -> np.ndarray:
        return self.df["close"].values if len(self._candles) else np.array([])

    @property
    def highs(self) -> np.ndarray:
        return self.df["high"].values if len(self._candles) else np.array([])

    @property
    def lows(self) -> np.ndarray:
        return self.df["low"].values if len(self._candles) else np.array([])

    @property
    def volumes(self) -> np.ndarray:
        return self.df["volume"].values if len(self._candles) else np.array([])

    @property
    def last_close(self) -> float:
        return self._candles[-1].close if self._candles else 0.0

    @property
    def last_candle(self) -> Optional[Candle]:
        return self._candles[-1] if self._candles else None

    def __len__(self) -> int:
        return len(self._candles)

    def is_fresh(self, max_age_seconds: float = 30.0) -> bool:
        return (time.time() - self.last_update) < max_age_seconds


class CandleStore:
    """Multi-timeframe candle storage with thread-safe access and caching."""

    def __init__(
        self,
        timeframes: list[str] | None = None,
        buffer_size: int = 1000,
    ):
        # Handle case where CandleStore(buffer_size=1000) was called with keyword or first positional
        if isinstance(timeframes, int):
            buffer_size = timeframes
            timeframes = None

        self.timeframes = timeframes or ["1m", "5m", "15m", "1h"]
        self.buffers: dict[str, TimeframeBuffer] = {
            tf: TimeframeBuffer(max_size=buffer_size) for tf in self.timeframes
        }

    def add_candle(self, timeframe: str, candle: Candle) -> None:
        if timeframe not in self.buffers:
            self.buffers[timeframe] = TimeframeBuffer(max_size=1000)
            if timeframe not in self.timeframes:
                self.timeframes.append(timeframe)
        self.buffers[timeframe].add(candle)

    def add_candles(self, timeframe: str, candles: list[Candle]) -> int:
        if timeframe not in self.buffers:
            self.buffers[timeframe] = TimeframeBuffer(max_size=1000)
            if timeframe not in self.timeframes:
                self.timeframes.append(timeframe)
        return self.buffers[timeframe].add_batch(candles)

    def get_df(self, timeframe: str) -> pd.DataFrame:
        if timeframe in self.buffers:
            return self.buffers[timeframe].df
        return pd.DataFrame()

    def get_dataframe(self, timeframe: str) -> pd.DataFrame:
        """Alias for get_df."""
        return self.get_df(timeframe)

    def get_closes(self, timeframe: str) -> np.ndarray:
        if timeframe in self.buffers:
            return self.buffers[timeframe].closes
        return np.array([])

    def last_price(self) -> float:
        """Get latest price from fastest timeframe."""
        for tf in self.timeframes:
            buf = self.buffers[tf]
            if buf.last_close > 0:
                return buf.last_close
        return 0.0

    def get_latest_price(self, timeframe: str | None = None) -> float:
        """Get latest price for timeframe or fastest available."""
        if timeframe and timeframe in self.buffers:
            return self.buffers[timeframe].last_close
        return self.last_price()

    def get_candle_count(self, timeframe: str) -> int:
        """Get number of candles currently buffered for timeframe."""
        if timeframe in self.buffers:
            return len(self.buffers[timeframe])
        return 0

    def get_latest_candle(self, timeframe: str) -> Optional[Candle]:
        """Get latest Candle object for timeframe."""
        if timeframe in self.buffers:
            return self.buffers[timeframe].last_candle
        return None

    def is_ready(self, min_candles: int = 100) -> bool:
        """Check if all timeframes have enough data."""
        return all(len(self.buffers[tf]) >= min_candles for tf in self.timeframes)

    def freshness(self) -> dict[str, bool]:
        return {tf: buf.is_fresh() for tf, buf in self.buffers.items()}

    def summary(self) -> dict:
        return {
            tf: {
                "count": len(buf),
                "fresh": buf.is_fresh(),
                "last_close": buf.last_close,
                "last_update": buf.last_update,
            }
            for tf, buf in self.buffers.items()
        }
