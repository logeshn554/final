"""
Technical Features — EMA, SMA, MACD, RSI, ADX, ROC, Stochastic, CCI, Williams %R.
All computed as vectorized numpy/pandas operations for speed.
"""

from __future__ import annotations
import numpy as np
import pandas as pd
from typing import Optional


def ema(series: pd.Series, period: int) -> pd.Series:
    """Exponential Moving Average."""
    return series.ewm(span=period, adjust=False).mean()


def sma(series: pd.Series, period: int) -> pd.Series:
    """Simple Moving Average."""
    return series.rolling(window=period, min_periods=period).mean()


def macd(
    close: pd.Series, fast: int = 12, slow: int = 26, signal: int = 9
) -> tuple[pd.Series, pd.Series, pd.Series]:
    """MACD line, signal line, histogram."""
    ema_fast = ema(close, fast)
    ema_slow = ema(close, slow)
    macd_line = ema_fast - ema_slow
    signal_line = ema(macd_line, signal)
    histogram = macd_line - signal_line
    return macd_line, signal_line, histogram


def rsi(close: pd.Series, period: int = 14) -> pd.Series:
    """Relative Strength Index."""
    delta = close.diff()
    gain = delta.clip(lower=0)
    loss = (-delta).clip(lower=0)
    avg_gain = gain.ewm(alpha=1.0 / period, min_periods=period).mean()
    avg_loss = loss.ewm(alpha=1.0 / period, min_periods=period).mean()
    rs = avg_gain / avg_loss.replace(0, 1e-10)
    return 100.0 - (100.0 / (1.0 + rs))


def adx(
    high: pd.Series, low: pd.Series, close: pd.Series, period: int = 14
) -> tuple[pd.Series, pd.Series, pd.Series]:
    """Average Directional Index. Returns (ADX, +DI, -DI)."""
    tr1 = high - low
    tr2 = (high - close.shift(1)).abs()
    tr3 = (low - close.shift(1)).abs()
    tr = pd.concat([tr1, tr2, tr3], axis=1).max(axis=1)

    plus_dm = high.diff().clip(lower=0)
    minus_dm = (-low.diff()).clip(lower=0)

    # Zero out when the other is larger
    mask = plus_dm > minus_dm
    plus_dm = plus_dm.where(mask, 0)
    minus_dm = minus_dm.where(~mask, 0)

    atr_val = tr.ewm(alpha=1.0 / period, min_periods=period).mean()
    plus_di = 100.0 * (
        plus_dm.ewm(alpha=1.0 / period, min_periods=period).mean()
        / atr_val.replace(0, 1e-10)
    )
    minus_di = 100.0 * (
        minus_dm.ewm(alpha=1.0 / period, min_periods=period).mean()
        / atr_val.replace(0, 1e-10)
    )

    dx = 100.0 * (plus_di - minus_di).abs() / (plus_di + minus_di).replace(0, 1e-10)
    adx_val = dx.ewm(alpha=1.0 / period, min_periods=period).mean()
    return adx_val, plus_di, minus_di


def roc(close: pd.Series, period: int = 10) -> pd.Series:
    """Rate of Change."""
    prev = close.shift(period)
    return ((close - prev) / prev.replace(0, 1e-10)) * 100.0


def stochastic(
    high: pd.Series, low: pd.Series, close: pd.Series,
    k_period: int = 14, d_period: int = 3
) -> tuple[pd.Series, pd.Series]:
    """Stochastic %K and %D."""
    lowest_low = low.rolling(k_period).min()
    highest_high = high.rolling(k_period).max()
    denom = (highest_high - lowest_low).replace(0, 1e-10)
    k = 100.0 * (close - lowest_low) / denom
    d = k.rolling(d_period).mean()
    return k, d


def cci(
    high: pd.Series, low: pd.Series, close: pd.Series, period: int = 20
) -> pd.Series:
    """Commodity Channel Index."""
    tp = (high + low + close) / 3.0
    sma_tp = tp.rolling(period).mean()
    mad = tp.rolling(period).apply(lambda x: np.mean(np.abs(x - np.mean(x))), raw=True)
    return (tp - sma_tp) / (0.015 * mad.replace(0, 1e-10))


def williams_r(
    high: pd.Series, low: pd.Series, close: pd.Series, period: int = 14
) -> pd.Series:
    """Williams %R."""
    hh = high.rolling(period).max()
    ll = low.rolling(period).min()
    return -100.0 * (hh - close) / (hh - ll).replace(0, 1e-10)


def momentum(close: pd.Series, period: int = 10) -> pd.Series:
    """Simple momentum (close - close[n])."""
    return close - close.shift(period)


def compute_all_technical(df: pd.DataFrame) -> pd.DataFrame:
    """Compute all technical indicators and add as columns."""
    c, h, l = df["close"], df["high"], df["low"]

    # EMAs
    for p in [9, 21, 50, 200]:
        df[f"ema_{p}"] = ema(c, p)

    # SMAs
    for p in [20, 50]:
        df[f"sma_{p}"] = sma(c, p)

    # MACD
    df["macd"], df["macd_signal"], df["macd_hist"] = macd(c)

    # RSI
    df["rsi"] = rsi(c, 14)
    df["rsi_6"] = rsi(c, 6)

    # ADX
    df["adx"], df["plus_di"], df["minus_di"] = adx(h, l, c, 14)

    # ROC
    df["roc_10"] = roc(c, 10)
    df["roc_5"] = roc(c, 5)

    # Stochastic
    df["stoch_k"], df["stoch_d"] = stochastic(h, l, c)

    # CCI
    df["cci"] = cci(h, l, c, 20)

    # Williams %R
    df["williams_r"] = williams_r(h, l, c)

    # Momentum
    df["momentum_10"] = momentum(c, 10)
    df["momentum_5"] = momentum(c, 5)

    # EMA structure
    df["ema_9_21_cross"] = (df["ema_9"] - df["ema_21"]).apply(np.sign)
    df["ema_21_50_cross"] = (df["ema_21"] - df["ema_50"]).apply(np.sign)
    df["ema_alignment"] = (
        (df["ema_9"] > df["ema_21"]).astype(int)
        + (df["ema_21"] > df["ema_50"]).astype(int)
        + (df["ema_50"] > df["ema_200"]).astype(int)
    ) / 3.0  # 1.0 = perfect bull alignment, 0.0 = perfect bear

    # Trend persistence: how many bars in a row the close > ema_21
    above_ema = (c > df["ema_21"]).astype(int)
    persistence = above_ema.copy()
    for i in range(1, len(persistence)):
        if persistence.iloc[i] == 1:
            persistence.iloc[i] = persistence.iloc[i - 1] + 1
        else:
            persistence.iloc[i] = 0
    # Standardized column aliases for strategies and ML models
    df["rsi_14"] = df["rsi"]
    df["adx_14"] = df["adx"]
    df["plus_di_14"] = df["plus_di"]
    df["minus_di_14"] = df["minus_di"]

    return df


# Aliases
compute_all_technical_features = compute_all_technical
