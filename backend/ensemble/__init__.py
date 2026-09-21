"""
Ensemble package — dynamic weighting, aggregator, and confidence calibration.
"""

from ensemble.weighting import StrategyWeightEngine, REGIME_AFFINITY
from ensemble.confidence import ConfidenceCalibrator
from ensemble.aggregator import EnsembleAggregator, EnsembleDecision

__all__ = [
    "StrategyWeightEngine",
    "REGIME_AFFINITY",
    "ConfidenceCalibrator",
    "EnsembleAggregator",
    "EnsembleDecision",
]
