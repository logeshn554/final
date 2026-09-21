"""
Confidence Calibration Engine — Calibrates raw strategy confidence against dispersion and entropy.
"""

from __future__ import annotations
import numpy as np


class ConfidenceCalibrator:
    """Calibrates confidence based on strategy consensus, dispersion, and regime alignment."""

    def calibrate(
        self,
        raw_confidence: float,
        direction_scores: list[float],
        weights: list[float],
        regime_confidence: float,
    ) -> float:
        """Calculate calibrated confidence score in [0.05, 0.95].

        Args:
            raw_confidence: Confidence before calibration [0, 1].
            direction_scores: Direction scores [-1, 1] from each strategy.
            weights: Corresponding normalized weights.
            regime_confidence: Confidence in the detected regime [0, 1].
        """
        if not direction_scores or not weights:
            return 0.1

        # Calculate dispersion (weighted standard deviation of direction scores)
        weighted_mean = sum(s * w for s, w in zip(direction_scores, weights))
        variance = sum(w * ((s - weighted_mean) ** 2) for s, w in zip(direction_scores, weights))
        std_dev = np.sqrt(max(variance, 0.0))

        # Higher dispersion -> lower confidence (disagreement penalty)
        # std_dev of 0 means full agreement -> penalty = 1.0 (no penalty)
        # std_dev of 1.0 means severe opposition -> penalty = 0.5
        consensus_factor = 1.0 - min(std_dev * 0.5, 0.5)

        # Fraction of strategies pointing in the same direction as the mean
        aligned_count = sum(1 for s in direction_scores if (s * weighted_mean > 0) or (abs(weighted_mean) < 0.05 and abs(s) < 0.1))
        alignment_ratio = aligned_count / len(direction_scores)

        # Regime clarity multiplier
        regime_factor = 0.7 + 0.3 * regime_confidence

        # Combine into calibrated confidence
        calibrated = raw_confidence * consensus_factor * (0.6 + 0.4 * alignment_ratio) * regime_factor
        return float(np.clip(calibrated, 0.05, 0.95))
