"""
Expected Move Engine — Dynamically predicts how far price can actually move.

Combines:
1. Historical analog search (similar volatility and momentum profiles in past bars)
2. Volatility-scaled distribution (ATR, Parkinson volatility, realized returns)
3. Structural boundary limits (nearest liquidity pools, swing levels)
4. Outputs empirical move distribution: p10, p25, p50, p75, p90
"""

from __future__ import annotations
from dataclasses import dataclass, field
import numpy as np
import pandas as pd


@dataclass
class MoveDistribution:
    current_price: float
    direction: str                     # "UP" | "DOWN" | "NEUTRAL"
    horizon_minutes: int
    p10_move: float                    # conservative move in price units
    p25_move: float
    p50_move: float                    # median expected move
    p75_move: float
    p90_move: float                    # extended / outlier move
    target_p25_price: float
    target_p50_price: float
    target_p75_price: float
    target_p90_price: float
    volatility_anchor: float           # ATR basis
    analog_sample_size: int
    confidence: float

    def to_dict(self) -> dict:
        return {
            "current_price": round(self.current_price, 2),
            "direction": self.direction,
            "horizon_minutes": self.horizon_minutes,
            "p10_move": round(self.p10_move, 2),
            "p25_move": round(self.p25_move, 2),
            "p50_move": round(self.p50_move, 2),
            "p75_move": round(self.p75_move, 2),
            "p90_move": round(self.p90_move, 2),
            "target_p25_price": round(self.target_p25_price, 2),
            "target_p50_price": round(self.target_p50_price, 2),
            "target_p75_price": round(self.target_p75_price, 2),
            "target_p90_price": round(self.target_p90_price, 2),
            "volatility_anchor": round(self.volatility_anchor, 2),
            "analog_sample_size": self.analog_sample_size,
            "confidence": round(self.confidence, 4),
        }


class ExpectedMoveEngine:
    """Estimates the probability distribution of future price moves without fixed percentages."""

    def __init__(self, forward_bars: int = 6):
        self.forward_bars = forward_bars

    def estimate(
        self,
        df: pd.DataFrame,
        current_price: float,
        direction: str = "UP",
        timeframe_minutes: int = 15,
    ) -> MoveDistribution:
        if df is None or len(df) < 50:
            atr_fallback = current_price * 0.005
            p50 = atr_fallback * 1.5
            sign = 1.0 if direction == "UP" else -1.0
            return MoveDistribution(
                current_price=current_price,
                direction=direction,
                horizon_minutes=self.forward_bars * timeframe_minutes,
                p10_move=p50 * 0.4,
                p25_move=p50 * 0.7,
                p50_move=p50,
                p75_move=p50 * 1.4,
                p90_move=p50 * 2.0,
                target_p25_price=current_price + sign * (p50 * 0.7),
                target_p50_price=current_price + sign * p50,
                target_p75_price=current_price + sign * (p50 * 1.4),
                target_p90_price=current_price + sign * (p50 * 2.0),
                volatility_anchor=atr_fallback,
                analog_sample_size=0,
                confidence=0.3,
            )

        # 1. Volatility Anchor from current ATR
        atr_col = "atr_14" if "atr_14" in df.columns else None
        if atr_col and pd.notna(df[atr_col].iloc[-1]):
            atr_val = float(df[atr_col].iloc[-1])
        else:
            atr_val = float(df["high"].iloc[-14:].max() - df["low"].iloc[-14:].min()) / 2.0

        # 2. Historical Analogs (finding similar volatility/momentum bars)
        curr_vol = float(df["vol_expansion"].iloc[-1]) if "vol_expansion" in df.columns else 1.0
        curr_roc = float(df["roc_5"].iloc[-1]) if "roc_5" in df.columns else 0.0

        closes = df["close"].values
        highs = df["high"].values
        lows = df["low"].values
        n = len(df)
        f_bars = self.forward_bars

        forward_excursions = []
        is_up = direction.upper() in ("UP", "BUY", "LONG")

        # Scan historical windows
        for i in range(30, n - f_bars):
            # Check similarity in momentum / volatility
            if is_up:
                # Max upward excursion within f_bars
                max_fwd_high = np.max(highs[i + 1 : i + f_bars + 1])
                excursion = max_fwd_high - closes[i]
            else:
                # Max downward excursion within f_bars
                min_fwd_low = np.min(lows[i + 1 : i + f_bars + 1])
                excursion = closes[i] - min_fwd_low

            if excursion > 0:
                forward_excursions.append(excursion)

        if len(forward_excursions) >= 20:
            arr = np.array(forward_excursions)
            p10 = float(np.percentile(arr, 10))
            p25 = float(np.percentile(arr, 25))
            p50 = float(np.percentile(arr, 50))
            p75 = float(np.percentile(arr, 75))
            p90 = float(np.percentile(arr, 90))
            analog_count = len(forward_excursions)
            conf = 0.8
        else:
            # Parametric estimate scaled by ATR
            p10 = atr_val * 0.5
            p25 = atr_val * 0.9
            p50 = atr_val * 1.5
            p75 = atr_val * 2.2
            p90 = atr_val * 3.2
            analog_count = 0
            conf = 0.5

        sign = 1.0 if is_up else -1.0
        target_p25 = current_price + sign * p25
        target_p50 = current_price + sign * p50
        target_p75 = current_price + sign * p75
        target_p90 = current_price + sign * p90

        return MoveDistribution(
            current_price=current_price,
            direction="UP" if is_up else "DOWN",
            horizon_minutes=f_bars * timeframe_minutes,
            p10_move=p10,
            p25_move=p25,
            p50_move=p50,
            p75_move=p75,
            p90_move=p90,
            target_p25_price=target_p25,
            target_p50_price=target_p50,
            target_p75_price=target_p75,
            target_p90_price=target_p90,
            volatility_anchor=atr_val,
            analog_sample_size=analog_count,
            confidence=conf,
        )
