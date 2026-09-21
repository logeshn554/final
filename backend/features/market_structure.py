"""
Market Structure Features — Swing points, HH/HL/LH/LL, support/resistance zones,
break of structure, change of character, range detection.
"""

from __future__ import annotations
import numpy as np
import pandas as pd
from dataclasses import dataclass
from typing import Optional


@dataclass
class SwingPoint:
    index: int
    price: float
    is_high: bool  # True = swing high, False = swing low
    timestamp: int = 0


@dataclass
class StructureAnalysis:
    swing_highs: list[SwingPoint]
    swing_lows: list[SwingPoint]
    hh_count: int  # higher highs
    hl_count: int  # higher lows
    lh_count: int  # lower highs
    ll_count: int  # lower lows
    structure: str  # "BULLISH", "BEARISH", "RANGE"
    support_levels: list[float]
    resistance_levels: list[float]
    bos_detected: bool  # break of structure
    bos_direction: int  # +1 bullish BoS, -1 bearish BoS, 0 none
    choch_detected: bool  # change of character
    nearest_support: float
    nearest_resistance: float
    range_low: float
    range_high: float


def detect_swing_points(
    high: np.ndarray, low: np.ndarray, lookback: int = 5
) -> tuple[list[SwingPoint], list[SwingPoint]]:
    """Detect swing highs and lows using fractal method."""
    swing_highs = []
    swing_lows = []
    n = len(high)

    for i in range(lookback, n - lookback):
        # Swing high: highest in window
        if high[i] == np.max(high[i - lookback : i + lookback + 1]):
            swing_highs.append(SwingPoint(index=i, price=float(high[i]), is_high=True))

        # Swing low: lowest in window
        if low[i] == np.min(low[i - lookback : i + lookback + 1]):
            swing_lows.append(SwingPoint(index=i, price=float(low[i]), is_high=False))

    return swing_highs, swing_lows


def classify_structure(
    swing_highs: list[SwingPoint], swing_lows: list[SwingPoint], recent_n: int = 6
) -> tuple[int, int, int, int, str]:
    """Classify market structure from recent swings.
    Returns: (hh_count, hl_count, lh_count, ll_count, structure_label)
    """
    hh, hl, lh, ll = 0, 0, 0, 0

    recent_highs = swing_highs[-recent_n:] if len(swing_highs) >= 2 else swing_highs
    recent_lows = swing_lows[-recent_n:] if len(swing_lows) >= 2 else swing_lows

    for i in range(1, len(recent_highs)):
        if recent_highs[i].price > recent_highs[i - 1].price:
            hh += 1
        else:
            lh += 1

    for i in range(1, len(recent_lows)):
        if recent_lows[i].price > recent_lows[i - 1].price:
            hl += 1
        else:
            ll += 1

    # Determine structure
    bull_score = hh + hl
    bear_score = lh + ll
    total = bull_score + bear_score

    if total == 0:
        structure = "RANGE"
    elif bull_score > bear_score * 1.5:
        structure = "BULLISH"
    elif bear_score > bull_score * 1.5:
        structure = "BEARISH"
    else:
        structure = "RANGE"

    return hh, hl, lh, ll, structure


def find_support_resistance(
    swing_highs: list[SwingPoint],
    swing_lows: list[SwingPoint],
    current_price: float,
    cluster_pct: float = 0.003,
) -> tuple[list[float], list[float]]:
    """Find support and resistance zones by clustering swing points."""
    all_levels = (
        [sp.price for sp in swing_highs] + [sp.price for sp in swing_lows]
    )
    if not all_levels:
        return [], []

    # Cluster nearby levels
    all_levels.sort()
    clusters = []
    current_cluster = [all_levels[0]]

    for level in all_levels[1:]:
        if abs(level - current_cluster[-1]) / max(current_cluster[-1], 1e-10) < cluster_pct:
            current_cluster.append(level)
        else:
            clusters.append(np.mean(current_cluster))
            current_cluster = [level]
    clusters.append(np.mean(current_cluster))

    support = sorted([c for c in clusters if c < current_price], reverse=True)
    resistance = sorted([c for c in clusters if c > current_price])

    return support[:5], resistance[:5]


def detect_bos_choch(
    swing_highs: list[SwingPoint],
    swing_lows: list[SwingPoint],
    close: np.ndarray,
) -> tuple[bool, int, bool]:
    """Detect Break of Structure and Change of Character.
    Returns: (bos_detected, bos_direction, choch_detected)
    """
    if len(swing_highs) < 2 or len(swing_lows) < 2:
        return False, 0, False

    current = close[-1] if len(close) > 0 else 0
    prev_high = swing_highs[-2].price
    last_high = swing_highs[-1].price
    prev_low = swing_lows[-2].price
    last_low = swing_lows[-1].price

    bos = False
    bos_dir = 0
    choch = False

    # Bullish BoS: price breaks above previous swing high in a bullish structure
    if current > last_high and last_low > prev_low:
        bos = True
        bos_dir = 1

    # Bearish BoS: price breaks below previous swing low in a bearish structure
    if current < last_low and last_high < prev_high:
        bos = True
        bos_dir = -1

    # Change of Character: structure reversal
    # Bullish to bearish ChoCh: was making HH/HL, now breaks below last swing low
    if last_high < prev_high and current < last_low and prev_high > swing_highs[-3].price if len(swing_highs) >= 3 else False:
        choch = True

    # Bearish to bullish ChoCh: was making LH/LL, now breaks above last swing high
    if last_low > prev_low and current > last_high and prev_low < swing_lows[-3].price if len(swing_lows) >= 3 else False:
        choch = True

    return bos, bos_dir, choch


def analyze_structure(df: pd.DataFrame, lookback: int = 5) -> StructureAnalysis:
    """Complete market structure analysis."""
    high = df["high"].values
    low = df["low"].values
    close = df["close"].values
    current_price = close[-1] if len(close) > 0 else 0

    swing_highs, swing_lows = detect_swing_points(high, low, lookback)
    hh, hl, lh, ll, structure = classify_structure(swing_highs, swing_lows)
    supports, resistances = find_support_resistance(
        swing_highs, swing_lows, current_price
    )
    bos, bos_dir, choch = detect_bos_choch(swing_highs, swing_lows, close)

    nearest_sup = supports[0] if supports else current_price * 0.995
    nearest_res = resistances[0] if resistances else current_price * 1.005

    # Range boundaries from recent swing extremes
    recent_highs = [sp.price for sp in swing_highs[-10:]]
    recent_lows = [sp.price for sp in swing_lows[-10:]]
    range_high = max(recent_highs) if recent_highs else current_price * 1.01
    range_low = min(recent_lows) if recent_lows else current_price * 0.99

    return StructureAnalysis(
        swing_highs=swing_highs,
        swing_lows=swing_lows,
        hh_count=hh,
        hl_count=hl,
        lh_count=lh,
        ll_count=ll,
        structure=structure,
        support_levels=supports,
        resistance_levels=resistances,
        bos_detected=bos,
        bos_direction=bos_dir,
        choch_detected=choch,
        nearest_support=nearest_sup,
        nearest_resistance=nearest_res,
        range_low=range_low,
        range_high=range_high,
    )


def compute_structure_features(df: pd.DataFrame) -> pd.DataFrame:
    """Add structure-based features to the DataFrame."""
    high = df["high"].values
    low = df["low"].values
    close = df["close"].values
    n = len(df)

    # Distance from recent swing high/low (rolling)
    swing_h_dist = np.full(n, 0.0)
    swing_l_dist = np.full(n, 0.0)

    window = 20
    for i in range(window, n):
        recent_high = np.max(high[i - window : i + 1])
        recent_low = np.min(low[i - window : i + 1])
        rng = recent_high - recent_low
        if rng > 0:
            swing_h_dist[i] = (recent_high - close[i]) / rng
            swing_l_dist[i] = (close[i] - recent_low) / rng

    df["dist_from_swing_high"] = swing_h_dist
    df["dist_from_swing_low"] = swing_l_dist

    # Recent range position (0 = at low, 1 = at high)
    df["range_position"] = swing_l_dist

    # Detect swing points and annotate BoS
    if n >= 20:
        analysis = analyze_structure(df, lookback=4)
        df["bos_bullish"] = int(analysis.bos_detected and analysis.bos_direction > 0)
        df["bos_bearish"] = int(analysis.bos_detected and analysis.bos_direction < 0)
        df["swing_high"] = float(analysis.range_high)
        df["swing_low"] = float(analysis.range_low)
    else:
        df["bos_bullish"] = 0
        df["bos_bearish"] = 0
        df["swing_high"] = float(high[-1]) if n > 0 else 0.0
        df["swing_low"] = float(low[-1]) if n > 0 else 0.0

    return df


def analyze_market_structure(df_or_high, *args, **kwargs) -> StructureAnalysis:
    """Resilient wrapper for market structure analysis."""
    if isinstance(df_or_high, pd.DataFrame):
        return analyze_structure(df_or_high, **kwargs)
    if len(args) >= 2:
        high = np.asarray(df_or_high)
        low = np.asarray(args[0])
        close = np.asarray(args[1])
        df_temp = pd.DataFrame({"high": high, "low": low, "close": close})
        return analyze_structure(df_temp, lookback=kwargs.get("lookback", 4))
    raise ValueError("Invalid arguments provided to analyze_market_structure")


# Aliases
compute_all_structure_features = compute_structure_features

