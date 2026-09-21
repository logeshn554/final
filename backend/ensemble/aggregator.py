"""
Ensemble Aggregator — Combines predictions from all 5 strategies into a unified decision.
"""

from __future__ import annotations
from dataclasses import dataclass, field
import numpy as np
from strategies.base import StrategyPrediction
from ensemble.weighting import StrategyWeightEngine
from ensemble.confidence import ConfidenceCalibrator
from regime.detector import RegimeState


@dataclass
class EnsembleDecision:
    signal: str = "HOLD"                  # "BUY" | "SELL" | "HOLD"
    direction_score: float = 0.0          # [-1.0, +1.0]
    confidence: float = 0.0               # [0.0, 1.0] calibrated
    expected_move: float = 0.0            # price units
    expected_high: float = 0.0
    expected_low: float = 0.0
    expected_horizon_minutes: int = 0
    support_levels: list[float] = field(default_factory=list)
    resistance_levels: list[float] = field(default_factory=list)
    strategy_contributions: dict[str, dict] = field(default_factory=dict)
    contributing_strategies: list[str] = field(default_factory=list)
    agreement_count: int = 0
    conflict_detected: bool = False
    conflict_details: str = ""
    reason: str = ""

    def to_dict(self) -> dict:
        return {
            "signal": self.signal,
            "direction_score": round(self.direction_score, 4),
            "confidence": round(self.confidence, 4),
            "expected_move": round(self.expected_move, 2),
            "expected_high": round(self.expected_high, 2),
            "expected_low": round(self.expected_low, 2),
            "expected_horizon_minutes": self.expected_horizon_minutes,
            "support_levels": [round(s, 2) for s in self.support_levels],
            "resistance_levels": [round(r, 2) for r in self.resistance_levels],
            "contributing_strategies": self.contributing_strategies,
            "strategy_contributions": self.strategy_contributions,
            "agreement_count": self.agreement_count,
            "conflict_detected": self.conflict_detected,
            "conflict_details": self.conflict_details,
            "reason": self.reason,
        }


class EnsembleAggregator:
    """Aggregates all strategy predictions using dynamic weights and conflict resolution."""

    def __init__(self, weight_engine: StrategyWeightEngine, calibrator: ConfidenceCalibrator):
        self.weight_engine = weight_engine
        self.calibrator = calibrator

    def aggregate(
        self,
        predictions: dict[str, StrategyPrediction],
        regime_state: RegimeState,
        current_price: float,
    ) -> EnsembleDecision:
        if not predictions:
            return EnsembleDecision(reason="No strategy predictions available")

        # 1. Compute dynamic weights for the active regime
        weights = self.weight_engine.compute_weights(regime_state.primary_regime)

        # 2. Extract direction scores and confidences
        strat_names = list(predictions.keys())
        w_list = [weights.get(name, 0.2) for name in strat_names]
        w_sum = sum(w_list) or 1.0
        norm_weights = [w / w_sum for w in w_list]

        dir_scores = [predictions[name].direction_score for name in strat_names]
        conf_scores = [predictions[name].confidence for name in strat_names]

        # 3. Weighted ensemble direction score
        ensemble_dir = sum(d * w for d, w in zip(dir_scores, norm_weights))
        raw_confidence = sum(c * w for c, w in zip(conf_scores, norm_weights))

        # 4. Calibrate confidence
        calibrated_conf = self.calibrator.calibrate(
            raw_confidence=raw_confidence,
            direction_scores=dir_scores,
            weights=norm_weights,
            regime_confidence=regime_state.confidence,
        )

        # 5. Track agreement & conflict detection
        buy_votes = [name for name, p in predictions.items() if p.signal == "BUY"]
        sell_votes = [name for name, p in predictions.items() if p.signal == "SELL"]
        hold_votes = [name for name, p in predictions.items() if p.signal == "HOLD"]

        # Conflict happens when one strong strategy says BUY and another says SELL
        conflict_detected = bool(buy_votes and sell_votes)
        conflict_details = ""
        if conflict_detected:
            conflict_details = f"Divergence: BUY ({', '.join(buy_votes)}) vs SELL ({', '.join(sell_votes)})"

        # Agreement count in dominant direction
        if ensemble_dir > 0:
            agreement_count = len(buy_votes)
            contributing = buy_votes
        elif ensemble_dir < 0:
            agreement_count = len(sell_votes)
            contributing = sell_votes
        else:
            agreement_count = len(hold_votes)
            contributing = hold_votes

        # Agreement bonus: if 4 or 5 strategies align, boost confidence & move
        if agreement_count >= 4:
            calibrated_conf = min(calibrated_conf * 1.25, 0.95)
            ensemble_dir = np.clip(ensemble_dir * 1.15, -1.0, 1.0)

        # 6. Aggregate expected move and horizons
        valid_moves = [p.expected_move for p in predictions.values() if p.expected_move > 0]
        expected_move = float(np.average(valid_moves, weights=[weights.get(name, 0.2) for name in predictions if predictions[name].expected_move > 0])) if valid_moves else current_price * 0.005

        valid_horizons = [p.expected_horizon_minutes for p in predictions.values() if p.expected_horizon_minutes > 0]
        avg_horizon = int(np.mean(valid_horizons)) if valid_horizons else 30

        # Collect and deduplicate support/resistance levels
        all_supports = sorted(set(s for p in predictions.values() for s in p.support_levels if s < current_price), reverse=True)[:4]
        all_resistances = sorted(set(r for p in predictions.values() for r in p.resistance_levels if r > current_price))[:4]

        # 7. Formulate final signal
        # Higher threshold if conflict detected
        thresh = 0.22 if conflict_detected else 0.15
        conf_thresh = 0.40 if conflict_detected else 0.32

        if ensemble_dir > thresh and calibrated_conf > conf_thresh:
            signal = "BUY"
        elif ensemble_dir < -thresh and calibrated_conf > conf_thresh:
            signal = "SELL"
        else:
            signal = "HOLD"

        # 8. Record per-strategy contribution breakdown
        strategy_contributions = {}
        for name, pred in predictions.items():
            w = weights.get(name, 0.0)
            strategy_contributions[name] = {
                "signal": pred.signal,
                "weight": round(w, 4),
                "direction_score": round(pred.direction_score, 4),
                "confidence": round(pred.confidence, 4),
                "expected_move": round(pred.expected_move, 2),
                "reason": pred.reason,
            }

        # Formulate synthesized reason
        aligned_strats = ", ".join(contributing) if contributing else "none"
        reason_parts = [
            f"Ensemble {signal} (Dir: {ensemble_dir:+.2f}, Conf: {calibrated_conf:.0%})",
            f"Regime: {regime_state.primary_regime}",
            f"Contributing: {aligned_strats}",
        ]
        if conflict_details:
            reason_parts.append(conflict_details)

        final_reason = " | ".join(reason_parts)

        expected_high = current_price + (expected_move if ensemble_dir >= 0 else expected_move * 0.4)
        expected_low = current_price - (expected_move if ensemble_dir <= 0 else expected_move * 0.4)

        return EnsembleDecision(
            signal=signal,
            direction_score=float(ensemble_dir),
            confidence=float(calibrated_conf),
            expected_move=float(expected_move),
            expected_high=float(expected_high),
            expected_low=float(expected_low),
            expected_horizon_minutes=avg_horizon,
            support_levels=all_supports,
            resistance_levels=all_resistances,
            strategy_contributions=strategy_contributions,
            contributing_strategies=contributing,
            agreement_count=agreement_count,
            conflict_detected=conflict_detected,
            conflict_details=conflict_details,
            reason=final_reason,
        )
