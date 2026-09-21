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
    df = df.copy()
    c, h, l = df["close"], df["high"], df["low"]

    new_cols: dict[str, Any] = {}

    # EMAs
    for p in [9, 21, 50, 200]:
        new_cols[f"ema_{p}"] = ema(c, p)

    # SMAs
    for p in [20, 50]:
        new_cols[f"sma_{p}"] = sma(c, p)

    # MACD
    m_line, m_sig, m_hist = macd(c)
    new_cols["macd"] = m_line
    new_cols["macd_signal"] = m_sig
    new_cols["macd_hist"] = m_hist

    # RSI
    new_cols["rsi"] = rsi(c, 14)
    new_cols["rsi_6"] = rsi(c, 6)

    # ADX
    adx_v, p_di, m_di = adx(h, l, c, 14)
    new_cols["adx"] = adx_v
    new_cols["plus_di"] = p_di
    new_cols["minus_di"] = m_di

    # ROC
    new_cols["roc_10"] = roc(c, 10)
    new_cols["roc_5"] = roc(c, 5)

    # Stochastic
    st_k, st_d = stochastic(h, l, c)
    new_cols["stoch_k"] = st_k
    new_cols["stoch_d"] = st_d

    # CCI
    new_cols["cci"] = cci(h, l, c, 20)

    # Williams %R
    new_cols["williams_r"] = williams_r(h, l, c)

    # Momentum
    new_cols["momentum_10"] = momentum(c, 10)
    new_cols["momentum_5"] = momentum(c, 5)

    # EMA structure
    ema_9 = new_cols["ema_9"]
    ema_21 = new_cols["ema_21"]
    ema_50 = new_cols["ema_50"]
    ema_200 = new_cols["ema_200"]

    new_cols["ema_9_21_cross"] = (ema_9 - ema_21).apply(np.sign)
    new_cols["ema_21_50_cross"] = (ema_21 - ema_50).apply(np.sign)
    new_cols["ema_alignment"] = (
        (ema_9 > ema_21).astype(int)
        + (ema_21 > ema_50).astype(int)
        + (ema_50 > ema_200).astype(int)
    ) / 3.0  # 1.0 = perfect bull alignment, 0.0 = perfect bear

    # Trend persistence: how many bars in a row the close > ema_21
    above_ema = (c > ema_21).astype(int)
    persistence = above_ema.copy()
    for i in range(1, len(persistence)):
        if persistence.iloc[i] == 1:
            persistence.iloc[i] = persistence.iloc[i - 1] + 1
        else:
            persistence.iloc[i] = 0
    new_cols["trend_persistence"] = persistence

    # Standardized column aliases for strategies and ML models
    new_cols["rsi_14"] = new_cols["rsi"]
    new_cols["adx_14"] = new_cols["adx"]
    new_cols["plus_di_14"] = new_cols["plus_di"]
    new_cols["minus_di_14"] = new_cols["minus_di"]

    # Assign all generated indicators
    for col_name, col_data in new_cols.items():
        df[col_name] = col_data

    return df


# Aliases
compute_all_technical_features = compute_all_technical
