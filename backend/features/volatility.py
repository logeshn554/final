"""
Volatility Features — ATR, realized vol, rolling vol, Parkinson, expansion/contraction,
historical move distribution, candle range statistics.
"""

from __future__ import annotations
import numpy as np
import pandas as pd


def atr(high: pd.Series, low: pd.Series, close: pd.Series, period: int = 14) -> pd.Series:
    """Average True Range."""
    tr1 = high - low
    tr2 = (high - close.shift(1)).abs()
    tr3 = (low - close.shift(1)).abs()
    tr = pd.concat([tr1, tr2, tr3], axis=1).max(axis=1)
    return tr.ewm(alpha=1.0 / period, min_periods=period).mean()


def realized_volatility(close: pd.Series, period: int = 20) -> pd.Series:
    """Realized volatility from log returns (annualized)."""
    ratio = (close / close.shift(1).replace(0, np.nan)).clip(lower=1e-8)
    log_ret = np.log(ratio).fillna(0.0)
    return log_ret.rolling(period, min_periods=2).std().fillna(0.0) * np.sqrt(365 * 24 * 60)  # ~minute-level annualization


def rolling_volatility(close: pd.Series, periods: list[int] = None) -> dict[str, pd.Series]:
    """Rolling volatility at multiple windows."""
    if periods is None:
        periods = [10, 20, 50]
    ratio = (close / close.shift(1).replace(0, np.nan)).clip(lower=1e-8)
    log_ret = np.log(ratio).fillna(0.0)
    return {f"vol_{p}": log_ret.rolling(p, min_periods=2).std().fillna(0.0) for p in periods}


def parkinson_volatility(high: pd.Series, low: pd.Series, period: int = 20) -> pd.Series:
    """Parkinson high-low volatility estimator (more efficient than close-close)."""
    hl_ratio = np.maximum(high / low.replace(0, 1e-10), 1e-8)
    return np.sqrt(np.log(hl_ratio).pow(2).rolling(period, min_periods=2).mean().fillna(0.0) / (4.0 * np.log(2)))


def vol_expansion_ratio(atr_series: pd.Series, slow: int = 50, fast: int = 10) -> pd.Series:
    """Ratio of short-term ATR to long-term ATR. > 1 = expansion, < 1 = contraction."""
    atr_fast = atr_series.rolling(fast).mean()
    atr_slow = atr_series.rolling(slow).mean()
    return atr_fast / atr_slow.replace(0, 1e-10)


def historical_move_distribution(
    close: np.ndarray, forward_bars: int = 5, lookback: int = 200
) -> dict:
    """Compute historical forward-return distribution from recent data.
    Returns percentiles of future moves in absolute price terms.
    """
    if len(close) < lookback + forward_bars:
        return {"p10": 0, "p25": 0, "p50": 0, "p75": 0, "p90": 0, "mean": 0, "std": 0}

    moves = []
    for i in range(len(close) - forward_bars - lookback, len(close) - forward_bars):
        if i < 0:
            continue
        future_ret = close[i + forward_bars] - close[i]
        moves.append(future_ret)

    if not moves or len(moves) < 2:
        return {"p10": 0, "p25": 0, "p50": 0, "p75": 0, "p90": 0, "mean": 0, "std": 0}

    moves = np.array(moves)
    return {
        "p10": float(np.percentile(moves, 10)),
        "p25": float(np.percentile(moves, 25)),
        "p50": float(np.percentile(moves, 50)),
        "p75": float(np.percentile(moves, 75)),
        "p90": float(np.percentile(moves, 90)),
        "mean": float(np.mean(moves)),
        "std": float(np.std(moves)) if len(moves) > 1 else 0.0,
    }


def candle_range_percentile(
    hl_range: pd.Series, current_range: float, lookback: int = 100
) -> float:
    """Where does the current candle range sit in the recent distribution? 0-100."""
    recent = hl_range.iloc[-lookback:].dropna()
    if len(recent) < 10:
        return 50.0
    return float((recent < current_range).sum() / len(recent) * 100)


def compute_volatility_features(df: pd.DataFrame) -> pd.DataFrame:
    """Compute all volatility features and add as columns."""
    df = df.copy()
    h, l, c = df["high"], df["low"], df["close"]

    df["atr_14"] = atr(h, l, c, 14)
    df["atr_7"] = atr(h, l, c, 7)
    df["atr_28"] = atr(h, l, c, 28)

    df["realized_vol"] = realized_volatility(c, 20)

    vol_dict = rolling_volatility(c, [10, 20, 50])
    for k, v in vol_dict.items():
        df[k] = v

    df["parkinson_vol"] = parkinson_volatility(h, l, 20)

    df["vol_expansion"] = vol_expansion_ratio(df["atr_14"], slow=50, fast=10)

    # Candle range as multiple of ATR
    df["range_atr_ratio"] = (h - l) / df["atr_14"].replace(0, 1e-10)

    # Bollinger bandwidth (as vol proxy)
    sma_20 = c.rolling(20).mean()
    std_20 = c.rolling(20).std()
    df["bb_bandwidth"] = (2 * std_20 / sma_20.replace(0, 1e-10))

    return df


# Aliases
compute_all_volatility_features = compute_volatility_features
