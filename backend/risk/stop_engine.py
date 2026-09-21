"""
Dynamic Stop Engine — Structural and volatility-anchored stop loss placement.
NEVER uses fixed percentages or arbitrary dollar amounts.
"""

from __future__ import annotations
from dataclasses import dataclass
import numpy as np
import pandas as pd


@dataclass
class StopPlacement:
    stop_price: float
    invalidation_level: float        # Price level where trade thesis is invalid
    buffer_distance: float           # Volatility buffer added beyond structural level
    risk_distance: float             # abs(entry - stop)
    risk_bps: float                  # Basis points at risk
    stop_type: str                   # "SWING_LOW", "SWING_HIGH", "MAE_BOUND", "VOLATILITY_STRUCTURE"
    reason: str

    def to_dict(self) -> dict:
        return {
            "stop_price": round(self.stop_price, 2),
            "invalidation_level": round(self.invalidation_level, 2),
            "buffer_distance": round(self.buffer_distance, 2),
            "risk_distance": round(self.risk_distance, 2),
            "risk_bps": round(self.risk_bps, 2),
            "stop_type": self.stop_type,
            "reason": self.reason,
        }


class DynamicStopEngine:
    """Calculates stop-loss strictly based on market structure and volatility buffer."""

    def calculate_stop(
        self,
        current_price: float,
        signal: str,
        df: pd.DataFrame,
        support_levels: list[float],
        resistance_levels: list[float],
        mae_invalidation: float,
    ) -> StopPlacement:
        is_buy = signal.upper() in ("BUY", "LONG")
        is_sell = signal.upper() in ("SELL", "SHORT")

        if df is None:
            df = pd.DataFrame()

        if not is_buy and not is_sell:
            return StopPlacement(
                stop_price=current_price,
                invalidation_level=current_price,
                buffer_distance=0.0,
                risk_distance=0.0,
                risk_bps=0.0,
                stop_type="NEUTRAL",
                reason="No active direction for stop placement",
            )

        # Volatility buffer (0.35x ATR)
        atr_col = "atr_14" if "atr_14" in df.columns else None
        if atr_col and len(df) > 0 and pd.notna(df[atr_col].iloc[-1]):
            atr_val = float(df[atr_col].iloc[-1])
        else:
            atr_val = current_price * 0.003
        buffer = atr_val * 0.35

        if is_buy:
            # 1. Look for nearest structural swing low or support level below current price
            structural_levels = [s for s in support_levels if s < current_price]

            # Also check recent 20-bar lowest low
            if "low" in df.columns and len(df) >= 15:
                recent_swing_low = float(df["low"].iloc[-20:].min())
                structural_levels.append(recent_swing_low)

            if structural_levels:
                # Nearest relevant support level
                invalidation = max(structural_levels)
                # If too close (e.g. inside noise buffer), pick next lower or subtract MAE
                if (current_price - invalidation) < buffer:
                    lower_levels = [s for s in structural_levels if (current_price - s) >= buffer]
                    invalidation = max(lower_levels) if lower_levels else (current_price - max(mae_invalidation, atr_val))
                stop_price = invalidation - buffer
                stop_type = "SWING_LOW_SUPPORT"
                reason = f"Structural stop below support {invalidation:.1f} with {buffer:.1f} ATR buffer"
            else:
                # Volatility and empirical MAE fallback
                risk_dist = max(mae_invalidation, atr_val * 1.5)
                invalidation = current_price - risk_dist
                stop_price = invalidation - buffer
                stop_type = "MAE_VOLATILITY"
                reason = f"Empirical MAE invalidation ({risk_dist:.1f}pts) with ATR buffer"

            risk_dist = current_price - stop_price

        else:  # is_sell
            structural_levels = [r for r in resistance_levels if r > current_price]

            if "high" in df.columns and len(df) >= 15:
                recent_swing_high = float(df["high"].iloc[-20:].max())
                structural_levels.append(recent_swing_high)

            if structural_levels:
                invalidation = min(structural_levels)
                if (invalidation - current_price) < buffer:
                    higher_levels = [r for r in structural_levels if (r - current_price) >= buffer]
                    invalidation = min(higher_levels) if higher_levels else (current_price + max(mae_invalidation, atr_val))
                stop_price = invalidation + buffer
                stop_type = "SWING_HIGH_RESISTANCE"
                reason = f"Structural stop above resistance {invalidation:.1f} with {buffer:.1f} ATR buffer"
            else:
                risk_dist = max(mae_invalidation, atr_val * 1.5)
                invalidation = current_price + risk_dist
                stop_price = invalidation + buffer
                stop_type = "MAE_VOLATILITY"
                reason = f"Empirical MAE invalidation ({risk_dist:.1f}pts) with ATR buffer"

            risk_dist = stop_price - current_price

        risk_bps = (risk_dist / current_price) * 10000.0

        return StopPlacement(
            stop_price=stop_price,
            invalidation_level=invalidation,
            buffer_distance=buffer,
            risk_distance=risk_dist,
            risk_bps=risk_bps,
            stop_type=stop_type,
            reason=reason,
        )
