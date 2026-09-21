"""
Reversal Engine — Continuous probability of reversal estimator.

Evaluates:
- Momentum decay rate (MACD histogram decreasing, ROC deceleration)
- Overextension / resistance proximity
- Volume exhaustion / divergence
- Strategy disagreement score
"""

from __future__ import annotations
from dataclasses import dataclass
import numpy as np
import pandas as pd


@dataclass
class ReversalAssessment:
    reversal_probability: float   # [0.0, 1.0]
    exhaustion_detected: bool
    momentum_decay_detected: bool
    divergence_detected: bool
    risk_of_adverse_move: float   # [0.0, 1.0]
    reasons: list[str]

    def to_dict(self) -> dict:
        return {
            "reversal_probability": round(self.reversal_probability, 4),
            "exhaustion_detected": self.exhaustion_detected,
            "momentum_decay_detected": self.momentum_decay_detected,
            "divergence_detected": self.divergence_detected,
            "risk_of_adverse_move": round(self.risk_of_adverse_move, 4),
            "reasons": self.reasons,
        }


class ReversalEngine:
    """Estimates the probability that the current move is reversing or stalling."""

    def assess(
        self,
        df: pd.DataFrame,
        current_price: float,
        position_direction: str,  # "BUY" (long) or "SELL" (short)
        disagreement_score: float = 0.0,
    ) -> ReversalAssessment:
        reasons = []
        p_rev = 0.15  # baseline probability
        exhaustion = False
        mom_decay = False
        divergence = False

        if df is None or len(df) < 20:
            return ReversalAssessment(
                reversal_probability=0.2,
                exhaustion_detected=False,
                momentum_decay_detected=False,
                divergence_detected=False,
                risk_of_adverse_move=0.2,
                reasons=["Insufficient data for reversal assessment"],
            )

        is_long = position_direction.upper() in ("BUY", "LONG")

        # 1. Momentum Decay
        if "macd_hist" in df.columns and len(df) >= 3:
            hists = df["macd_hist"].iloc[-3:].values
            if is_long and hists[-1] < hists[-2] < hists[-3] and hists[-1] > 0:
                mom_decay = True
                p_rev += 0.20
                reasons.append("MACD histogram decaying (bullish momentum fading)")
            elif not is_long and hists[-1] > hists[-2] > hists[-3] and hists[-1] < 0:
                mom_decay = True
                p_rev += 0.20
                reasons.append("MACD histogram rising (bearish momentum fading)")

        # 2. RSI Exhaustion
        if "rsi_14" in df.columns:
            rsi = float(df["rsi_14"].iloc[-1])
            if is_long and rsi > 78:
                exhaustion = True
                p_rev += 0.25
                reasons.append(f"Severe bullish overextension (RSI={rsi:.1f})")
            elif not is_long and rsi < 22:
                exhaustion = True
                p_rev += 0.25
                reasons.append(f"Severe bearish overextension (RSI={rsi:.1f})")

        # 3. Volume Exhaustion / Divergence
        if "volume_ratio" in df.columns and "roc_5" in df.columns:
            vol_ratio = float(df["volume_ratio"].iloc[-1])
            roc = float(df["roc_5"].iloc[-1])
            # High volume with stalling price change = absorption/exhaustion
            if vol_ratio > 2.0 and abs(roc) < 0.1:
                divergence = True
                p_rev += 0.20
                reasons.append(f"Volume spike ({vol_ratio:.1f}x) with stagnant price progress (absorption)")

        # 4. Strategy Disagreement Penalty
        if disagreement_score > 0.4:
            p_rev += disagreement_score * 0.25
            reasons.append(f"Ensemble disagreement elevated ({disagreement_score:.2f})")

        p_rev = float(np.clip(p_rev, 0.05, 0.95))
        risk_adverse = float(np.clip(p_rev * 1.1, 0.05, 0.95))

        return ReversalAssessment(
            reversal_probability=p_rev,
            exhaustion_detected=exhaustion,
            momentum_decay_detected=mom_decay,
            divergence_detected=divergence,
            risk_of_adverse_move=risk_adverse,
            reasons=reasons,
        )
