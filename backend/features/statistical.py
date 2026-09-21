"""
Statistical Features — Z-score, Bollinger Bands, distance from MA, Hurst exponent proxy.
"""

from __future__ import annotations
import warnings
import numpy as np
import pandas as pd

warnings.filterwarnings("ignore", category=RuntimeWarning)



def z_score(close: pd.Series, period: int = 20) -> pd.Series:
    """Price z-score relative to rolling mean."""
    mean = close.rolling(period).mean()
    std = close.rolling(period).std()
    return (close - mean) / std.replace(0, 1e-10)


def bollinger_bands(
    close: pd.Series, period: int = 20, num_std: float = 2.0
) -> tuple[pd.Series, pd.Series, pd.Series]:
    """Bollinger Bands (upper, middle, lower)."""
    middle = close.rolling(period).mean()
    std = close.rolling(period).std()
    upper = middle + num_std * std
    lower = middle - num_std * std
    return upper, middle, lower


def bollinger_pct_b(close: pd.Series, period: int = 20, num_std: float = 2.0) -> pd.Series:
    """Bollinger %B — where price is within the bands. 0 = lower, 1 = upper."""
    upper, middle, lower = bollinger_bands(close, period, num_std)
    return (close - lower) / (upper - lower).replace(0, 1e-10)


def distance_from_ma(close: pd.Series, ma: pd.Series) -> pd.Series:
    """Normalized distance from a moving average."""
    return (close - ma) / ma.replace(0, 1e-10) * 100


def hurst_exponent_proxy(close: pd.Series, max_lag: int = 20) -> float:
    """Approximate Hurst exponent using rescaled range.
    H > 0.5 = trending, H < 0.5 = mean reverting, H = 0.5 = random walk.
    """
    if len(close) < max_lag * 3:
        return 0.5

    values = close.dropna().values
    if len(values) < max_lag * 3:
        return 0.5

    try:
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", category=RuntimeWarning)
            with np.errstate(all='ignore'):
                lags = range(4, max_lag + 1)
                rs_values = []

                for lag in lags:
                    n = len(values) // lag
                    if n < 2:
                        continue
                    rs_list = []
                    for i in range(n):
                        segment = values[i * lag : (i + 1) * lag]
                        if len(segment) < 6:
                            continue
                        denom = np.where(np.abs(segment[:-1]) > 1e-8, segment[:-1], 1e-8)
                        returns = np.diff(segment) / denom
                        if len(returns) < 5:
                            continue

                        # Guard against degrees of freedom <= 0 and zero variance
                        var = float(np.var(returns, ddof=1)) if len(returns) > 1 else 0.0
                        if var <= 1e-12 or np.isnan(var):
                            continue
                        s = float(np.sqrt(var))

                        mean_ret = float(np.mean(returns))
                        deviations = np.cumsum(returns - mean_ret)
                        r = float(np.max(deviations) - np.min(deviations))

                        if s > 1e-8 and r > 1e-8 and not np.isnan(r) and not np.isnan(s):
                            rs_list.append(r / s)

                    if rs_list:
                        mean_rs = float(np.mean(rs_list))
                        if mean_rs > 1e-8 and not np.isnan(mean_rs):
                            rs_values.append((float(lag), mean_rs))

                if len(rs_values) < 3:
                    return 0.5

                log_lags = np.log(np.maximum([v[0] for v in rs_values], 1.0))
                log_rs = np.log(np.maximum([v[1] for v in rs_values], 1e-8))

                slope = np.polyfit(log_lags, log_rs, 1)[0]
                if np.isnan(slope) or np.isinf(slope):
                    return 0.5
                return float(np.clip(slope, 0.0, 1.0))
    except Exception:
        return 0.5


def compute_statistical_features(df: pd.DataFrame) -> pd.DataFrame:
    """Compute all statistical features."""
    df = df.copy()
    c = df["close"]

    df["z_score_20"] = z_score(c, 20)
    df["z_score_50"] = z_score(c, 50)

    df["bb_upper"], df["bb_middle"], df["bb_lower"] = bollinger_bands(c, 20, 2.0)
    df["bb_upper_3"], _, df["bb_lower_3"] = bollinger_bands(c, 20, 3.0)
    df["bb_pct_b"] = bollinger_pct_b(c, 20)

    if "ema_9" in df.columns:
        df["dist_ema_9_pct"] = (c - df["ema_9"]) / df["ema_9"].replace(0, 1e-10) * 100.0
    if "ema_21" in df.columns:
        df["dist_ema_21"] = distance_from_ma(c, df["ema_21"])
        df["dist_ema_21_pct"] = (c - df["ema_21"]) / df["ema_21"].replace(0, 1e-10) * 100.0
    if "ema_50" in df.columns:
        df["dist_ema_50"] = distance_from_ma(c, df["ema_50"])
        df["dist_ema_50_pct"] = (c - df["ema_50"]) / df["ema_50"].replace(0, 1e-10) * 100.0
    if "sma_20" in df.columns:
        df["dist_sma_20"] = distance_from_ma(c, df["sma_20"])
    if "vwap" in df.columns:
        df["dist_vwap"] = distance_from_ma(c, df["vwap"])
        df["dist_from_vwap_pct"] = (c - df["vwap"]) / df["vwap"].replace(0, 1e-10) * 100.0

    # Hurst proxy
    df["hurst_proxy"] = hurst_exponent_proxy(c)

    return df


# Aliases
compute_all_statistical_features = compute_statistical_features
