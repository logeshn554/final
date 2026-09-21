"""
Dynamic Exit Engine — Evaluates continuous exit conditions, profit-taking, and trailing stops.
NO fixed take profit or sell percentages.
"""

from __future__ import annotations
from dataclasses import dataclass, field
import numpy as np
import pandas as pd
from prediction.reversal_engine import ReversalAssessment


@dataclass
class ExitDecision:
    action: str                  # "HOLD", "PARTIAL_TP", "FULL_EXIT", "TRAIL_STOP_UPDATE"
    exit_score: float            # [0.0, 1.0]
    urgency: str                 # "LOW", "MEDIUM", "HIGH", "IMMEDIATE"
    new_trailing_stop: float | None = None
    exit_fraction: float = 0.0   # 0.0 to 1.0
    reason: str = ""

    def to_dict(self) -> dict:
        return {
            "action": self.action,
            "exit_score": round(self.exit_score, 4),
            "urgency": self.urgency,
            "new_trailing_stop": round(self.new_trailing_stop, 2) if self.new_trailing_stop else None,
            "exit_fraction": round(self.exit_fraction, 2),
            "reason": self.reason,
        }


class DynamicExitEngine:
    """Evaluates whether to hold, trim, trail, or exit an active position based on evolving dynamics."""

    def evaluate_exit(
        self,
        position_direction: str,  # "BUY" or "SELL"
        entry_price: float,
        current_price: float,
        current_stop: float,
        target_price: float,
        reversal: ReversalAssessment,
        df: pd.DataFrame,
        bars_held: int,
    ) -> ExitDecision:
        is_long = position_direction.upper() in ("BUY", "LONG")
        current_profit_pts = (current_price - entry_price) if is_long else (entry_price - current_price)
        total_target_distance = abs(target_price - entry_price)
        profit_progress = current_profit_pts / max(total_target_distance, 1.0)

        # 1. Stop breach check
        if (is_long and current_price <= current_stop) or (not is_long and current_price >= current_stop):
            return ExitDecision(
                action="FULL_EXIT",
                exit_score=1.0,
                urgency="IMMEDIATE",
                exit_fraction=1.0,
                reason="Dynamic stop-loss invalidation reached",
            )

        # 2. Target achievement check
        if profit_progress >= 1.0:
            return ExitDecision(
                action="FULL_EXIT",
                exit_score=0.95,
                urgency="HIGH",
                exit_fraction=1.0,
                reason="Primary dynamic target zone fully achieved",
            )

        # 3. Dynamic Trailing Stop Adjustment
        # If profit progress > 40%, move trailing stop to structure
        new_trail = None
        atr_col = "atr_14" if "atr_14" in df.columns else None
        atr_val = float(df[atr_col].iloc[-1]) if atr_col and pd.notna(df[atr_col].iloc[-1]) else entry_price * 0.003

        if profit_progress >= 0.5:
            # Lock in profit: place trailing stop 1 ATR behind current price
            candidate_trail = current_price - (atr_val * 1.0) if is_long else current_price + (atr_val * 1.0)
            if is_long and candidate_trail > current_stop:
                new_trail = candidate_trail
            elif not is_long and candidate_trail < current_stop:
                new_trail = candidate_trail

        # 4. Exit Score Calculation
        # Combines reversal probability, exhaustion, and time elapsed
        score = reversal.reversal_probability * 0.50
        if reversal.exhaustion_detected:
            score += 0.25
        if reversal.momentum_decay_detected:
            score += 0.15

        # If in profit but strong reversal is detected -> partial profit taking
        if profit_progress > 0.35 and score > 0.65:
            return ExitDecision(
                action="PARTIAL_TP",
                exit_score=score,
                urgency="MEDIUM",
                new_trailing_stop=new_trail,
                exit_fraction=0.5,
                reason=f"Partial take profit: {profit_progress:.0%} progress with elevated reversal score ({score:.2f})",
            )

        # Full dynamic early exit if trade turns into severe reversal
        if score > 0.85:
            return ExitDecision(
                action="FULL_EXIT",
                exit_score=score,
                urgency="HIGH",
                exit_fraction=1.0,
                reason=f"Dynamic exit triggered: critical reversal signal ({score:.2f})",
            )

        if new_trail is not None:
            return ExitDecision(
                action="TRAIL_STOP_UPDATE",
                exit_score=score,
                urgency="LOW",
                new_trailing_stop=new_trail,
                exit_fraction=0.0,
                reason=f"Trailing stop updated to {new_trail:.1f} to protect unrealized gains",
            )

        return ExitDecision(
            action="HOLD",
            exit_score=score,
            urgency="LOW",
            new_trailing_stop=None,
            exit_fraction=0.0,
            reason=f"Conditions healthy. Profit progress: {profit_progress:.1%}, Reversal score: {score:.2f}",
        )
