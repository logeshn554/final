"""
Market Data Processor — Unified data access, validation, and derived field computation.
"""

from __future__ import annotations
import numpy as np
import pandas as pd
import time
import logging
from typing import Optional

from data.candle_store import CandleStore

logger = logging.getLogger(__name__)


class MarketDataProcessor:
    """Unified market data interface with freshness validation."""

    def __init__(self, store: CandleStore, config: Optional[dict] = None):
        self.store = store
        cfg = config or {}
        self.min_candles = cfg.get("engine", {}).get("min_candles_required", 60)

    @property
    def price(self) -> float:
        return self.store.last_price()

    def get_ohlcv(self, timeframe: str) -> pd.DataFrame:
        """Get OHLCV DataFrame for a timeframe with derived columns."""
        df = self.store.get_df(timeframe).copy()
        if df.empty:
            return df

        # Add derived columns
        df["returns"] = df["close"].pct_change().fillna(0.0)
        ratio = (df["close"] / df["close"].shift(1).replace(0, np.nan)).clip(lower=1e-8)
        df["log_returns"] = np.log(ratio).fillna(0.0)
        df["typical_price"] = (df["high"] + df["low"] + df["close"]) / 3.0
        df["hl_range"] = df["high"] - df["low"]
        df["body"] = (df["close"] - df["open"]).abs()
        df["upper_shadow"] = df["high"] - df[["open", "close"]].max(axis=1)
        df["lower_shadow"] = df[["open", "close"]].min(axis=1) - df["low"]
        df["is_bullish"] = (df["close"] >= df["open"]).astype(int)
        return df

    def get_closes(self, timeframe: str) -> np.ndarray:
        return self.store.get_closes(timeframe)

    def is_ready(self) -> bool:
        return self.store.is_ready(self.min_candles)

    def freshness_report(self) -> dict:
        return self.store.freshness()

    def health(self) -> dict:
        return {
            "ready": self.is_ready(),
            "price": self.price,
            "freshness": self.freshness_report(),
            "buffers": self.store.summary(),
        }


# Alias for backward compatibility
MarketData = MarketDataProcessor
