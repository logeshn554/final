"""
Position Sizing Engine — Fractional Kelly criterion with dynamic payoff ratio and volatility scaling.
"""

from __future__ import annotations
from dataclasses import dataclass
import numpy as np


@dataclass
class SizingResult:
    position_pct: float            # Recommended allocation of equity [0.0, 1.0]
    kelly_fraction: float          # Full Kelly fraction
    fractional_kelly_applied: float# Sizing fraction (e.g. 0.25x)
    volatility_adjustment: float   # Scale factor from current vol vs normal
    max_capital_at_risk_usd: float # Max allowed dollar loss on trade
    notional_size_usd: float       # Position notional size
    sizing_rationale: str

    def to_dict(self) -> dict:
        return {
            "position_pct": round(self.position_pct, 4),
            "kelly_fraction": round(self.kelly_fraction, 4),
            "fractional_kelly_applied": round(self.fractional_kelly_applied, 4),
            "volatility_adjustment": round(self.volatility_adjustment, 4),
            "max_capital_at_risk_usd": round(self.max_capital_at_risk_usd, 2),
            "notional_size_usd": round(self.notional_size_usd, 2),
            "sizing_rationale": self.sizing_rationale,
        }


class DynamicPositionSizer:
    """Computes dynamic position sizing using fractional Kelly and volatility scaling."""

    def __init__(
        self,
        fractional_kelly: float = 0.25,
        max_position_pct: float = 0.30,
        max_risk_per_trade_pct: float = 0.02,
    ):
        self.fractional_kelly = fractional_kelly
        self.max_position_pct = max_position_pct
        self.max_risk_per_trade_pct = max_risk_per_trade_pct

    def calculate_size(
        self,
        account_balance: float,
        entry_price: float,
        stop_price: float,
        target_price: float,
        confidence: float,
        vol_expansion: float = 1.0,
    ) -> SizingResult:
        if account_balance <= 0 or entry_price <= 0:
            return SizingResult(0.0, 0.0, 0.0, 1.0, 0.0, 0.0, "Invalid account balance or entry price")

        risk_dist = abs(entry_price - stop_price)
        target_dist = abs(target_price - entry_price)

        if risk_dist < 1e-4:
            return SizingResult(0.0, 0.0, 0.0, 1.0, 0.0, 0.0, "Risk distance near zero")

        # Dynamic payoff ratio b = gain / loss
        b = target_dist / risk_dist

        # Calibrated win probability p from confidence
        p = float(np.clip(confidence, 0.35, 0.85))
        q = 1.0 - p

        # Full Kelly Criterion: f* = (p * b - q) / b
        if b > 0:
            full_kelly = (p * b - q) / b
        else:
            full_kelly = 0.0

        full_kelly = max(0.0, full_kelly)

        # Volatility scaling: when volatility expands abnormally, scale down size
        vol_factor = 1.0 / max(vol_expansion, 0.7)
        vol_factor = float(np.clip(vol_factor, 0.4, 1.3))

        # Apply fractional Kelly (e.g. quarter Kelly)
        f_kelly = full_kelly * self.fractional_kelly * vol_factor

        # Sizing bounded by maximum risk per trade
        # Capital at risk = position_size * (risk_dist / entry_price)
        risk_per_unit = risk_dist / entry_price
        max_risk_dollars = account_balance * self.max_risk_per_trade_pct
        max_notional_by_risk = max_risk_dollars / max(risk_per_unit, 1e-4)

        notional_from_kelly = account_balance * f_kelly
        final_notional = min(notional_from_kelly, max_notional_by_risk, account_balance * self.max_position_pct)

        pos_pct = final_notional / account_balance if account_balance > 0 else 0.0

        reason = (
            f"Fractional Kelly={self.fractional_kelly:.2f}x (Full Kelly={full_kelly:.1%}, Payoff b={b:.2f}, P(Win)={p:.1%}), "
            f"Vol scale={vol_factor:.2f}x. Risk capped at {self.max_risk_per_trade_pct:.1%} of equity."
        )

        return SizingResult(
            position_pct=pos_pct,
            kelly_fraction=full_kelly,
            fractional_kelly_applied=self.fractional_kelly,
            volatility_adjustment=vol_factor,
            max_capital_at_risk_usd=final_notional * risk_per_unit,
            notional_size_usd=final_notional,
            sizing_rationale=reason,
        )
