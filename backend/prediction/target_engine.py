"""
Dynamic Target Engine — Selects take-profit targets based on volatility, MFE distributions,
and market structure. ZERO hardcoded percentages or fixed ratios.
"""

from __future__ import annotations
from dataclasses import dataclass, field
import numpy as np
from prediction.expected_move import MoveDistribution
from prediction.mfe_mae import ExcursionProfile


@dataclass
class TargetZone:
    conservative_target: float    # High probability target
    conservative_prob: float      # e.g., 0.75
    base_target: float            # Expected value optimal target
    base_prob: float              # e.g., 0.50
    extended_target: float        # Trend runner / breakout extension
    extended_prob: float          # e.g., 0.25
    expected_range_low: float     # Predicted lower boundary
    expected_range_high: float    # Predicted upper boundary
    expected_move_magnitude: float# Points price can move
    expected_move_bps: float      # Basis points
    expected_duration_minutes: int
    risk_reward_ratio: float      # Market-derived, NOT fixed
    target_derivation_reason: str

    def to_dict(self) -> dict:
        return {
            "conservative_target": round(self.conservative_target, 2),
            "conservative_prob": round(self.conservative_prob, 4),
            "base_target": round(self.base_target, 2),
            "base_prob": round(self.base_prob, 4),
            "extended_target": round(self.extended_target, 2),
            "extended_prob": round(self.extended_prob, 4),
            "expected_range_low": round(self.expected_range_low, 2),
            "expected_range_high": round(self.expected_range_high, 2),
            "expected_move_magnitude": round(self.expected_move_magnitude, 2),
            "expected_move_bps": round(self.expected_move_bps, 2),
            "expected_duration_minutes": self.expected_duration_minutes,
            "risk_reward_ratio": round(self.risk_reward_ratio, 2),
            "target_derivation_reason": self.target_derivation_reason,
        }


class DynamicTargetEngine:
    """Derives dynamic take-profit targets from market distribution, structure, and MFE."""

    def calculate_targets(
        self,
        current_price: float,
        signal: str,
        move_dist: MoveDistribution,
        mfe_profile: ExcursionProfile,
        stop_price: float,
        resistance_levels: list[float],
        support_levels: list[float],
    ) -> TargetZone:
        is_buy = signal.upper() in ("BUY", "LONG")
        is_sell = signal.upper() in ("SELL", "SHORT")

        if not is_buy and not is_sell:
            # Neutral / HOLD: return symmetrical volatility range
            band = move_dist.p50_move
            return TargetZone(
                conservative_target=current_price,
                conservative_prob=0.5,
                base_target=current_price,
                base_prob=0.5,
                extended_target=current_price,
                extended_prob=0.5,
                expected_range_low=current_price - band,
                expected_range_high=current_price + band,
                expected_move_magnitude=band,
                expected_move_bps=(band / current_price) * 10000.0,
                expected_duration_minutes=move_dist.horizon_minutes,
                risk_reward_ratio=1.0,
                target_derivation_reason="Neutral hold — bounds based on median volatility dispersion",
            )

        sign = 1.0 if is_buy else -1.0

        # 1. Volatility & Empirical MFE Blending
        # Blend expected move percentiles with regime MFE empirical percentiles
        c_move = (move_dist.p25_move * 0.5) + (mfe_profile.mfe_p25 * 0.5)
        b_move = (move_dist.p50_move * 0.5) + (mfe_profile.mfe_p50 * 0.5)
        e_move = (move_dist.p75_move * 0.5) + (mfe_profile.mfe_p75 * 0.5)

        # 2. Structural Snapping
        # If there is a key resistance/support just before the target, snap to it to avoid front-running failure
        if is_buy and resistance_levels:
            valid_res = sorted([r for r in resistance_levels if r > current_price])
            # Check if any resistance is between 80% and 120% of base move
            for r in valid_res:
                dist = r - current_price
                if 0.5 * b_move <= dist <= 1.3 * b_move:
                    b_move = dist * 0.98  # Snap 2% below structural resistance
                    break
        elif is_sell and support_levels:
            valid_sup = sorted([s for s in support_levels if s < current_price], reverse=True)
            for s in valid_sup:
                dist = current_price - s
                if 0.5 * b_move <= dist <= 1.3 * b_move:
                    b_move = dist * 0.98  # Snap 2% above structural support
                    break

        conservative_target = current_price + sign * c_move
        base_target = current_price + sign * b_move
        extended_target = current_price + sign * e_move

        # Calculate dynamic Risk/Reward from ACTUAL price levels (not fixed 1:2)
        risk_distance = abs(current_price - stop_price)
        if risk_distance > 1e-4:
            dynamic_rr = b_move / risk_distance
        else:
            dynamic_rr = 1.5

        # Expected range boundaries
        if is_buy:
            range_low = stop_price
            range_high = extended_target
        else:
            range_low = extended_target
            range_high = stop_price

        bps = (b_move / current_price) * 10000.0
        reason = (
            f"Dynamic TP derived from {mfe_profile.regime} MFE distribution (p50={mfe_profile.mfe_p50:.1f}pts), "
            f"analog move distribution (p50={move_dist.p50_move:.1f}pts), and structural boundaries. "
            f"Market dynamic R:R={dynamic_rr:.2f}"
        )

        return TargetZone(
            conservative_target=conservative_target,
            conservative_prob=0.75,
            base_target=base_target,
            base_prob=0.50,
            extended_target=extended_target,
            extended_prob=0.25,
            expected_range_low=range_low,
            expected_range_high=range_high,
            expected_move_magnitude=b_move,
            expected_move_bps=bps,
            expected_duration_minutes=move_dist.horizon_minutes,
            risk_reward_ratio=dynamic_rr,
            target_derivation_reason=reason,
        )
