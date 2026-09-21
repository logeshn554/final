"""
Volume Features — VWAP, OBV, cumulative delta proxy, relative volume, volume momentum.
"""

from __future__ import annotations
import numpy as np
import pandas as pd


def vwap(high: pd.Series, low: pd.Series, close: pd.Series, volume: pd.Series) -> pd.Series:
    """Volume Weighted Average Price (intraday cumulative)."""
    tp = (high + low + close) / 3.0
    cum_tp_vol = (tp * volume).cumsum()
    cum_vol = volume.cumsum()
    return cum_tp_vol / cum_vol.replace(0, 1e-10)


def obv(close: pd.Series, volume: pd.Series) -> pd.Series:
    """On-Balance Volume."""
    direction = close.diff().apply(lambda x: 1 if x > 0 else (-1 if x < 0 else 0))
    return (direction * volume).cumsum()


def cumulative_delta_proxy(
    open_: pd.Series, close: pd.Series, high: pd.Series, low: pd.Series, volume: pd.Series
) -> pd.Series:
    """Approximate buy/sell pressure from candle body position within range."""
    rng = (high - low).replace(0, 1e-10)
    buy_pct = (close - low) / rng
    sell_pct = (high - close) / rng
    delta = volume * (buy_pct - sell_pct)
    return delta.cumsum()


def relative_volume(volume: pd.Series, period: int = 20) -> pd.Series:
    """Current volume relative to average volume."""
    avg_vol = volume.rolling(period).mean()
    return volume / avg_vol.replace(0, 1e-10)


def volume_momentum(volume: pd.Series, period: int = 10) -> pd.Series:
    """Rate of change of volume."""
    prev = volume.rolling(period).mean().shift(1)
    return (volume - prev) / prev.replace(0, 1e-10)


def compute_volume_features(df: pd.DataFrame) -> pd.DataFrame:
    """Compute all volume features."""
    h, l, c, v = df["high"], df["low"], df["close"], df["volume"]
    o = df["open"]

    df["vwap"] = vwap(h, l, c, v)
    df["price_vs_vwap"] = (c - df["vwap"]) / df["vwap"].replace(0, 1e-10)

    df["obv"] = obv(c, v)
    df["obv_slope"] = df["obv"].diff(5) / 5.0

    df["cum_delta"] = cumulative_delta_proxy(o, c, h, l, v)

    df["rel_volume"] = relative_volume(v, 20)
    df["volume_ratio"] = df["rel_volume"]
    df["vol_momentum"] = volume_momentum(v, 10)
    df["volume_momentum"] = df["vol_momentum"]

    return df


# Aliases
compute_all_volume_features = compute_volume_features
