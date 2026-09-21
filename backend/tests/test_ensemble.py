"""
Unit tests for regime classification and ensemble aggregation.
"""

import numpy as np
import pandas as pd
import pytest

from regime.detector import RegimeDetector
from ensemble.weighting import StrategyWeightEngine
from ensemble.confidence import ConfidenceCalibrator
from ensemble.aggregator import EnsembleAggregator
from strategies.base import StrategyPrediction


def test_regime_detector():
    detector = RegimeDetector()
    df = pd.DataFrame({
        "close": [60000.0] * 50,
        "adx_14": [30.0] * 50,
        "plus_di_14": [28.0] * 50,
        "minus_di_14": [10.0] * 50,
        "ema_9": [60100.0] * 50,
        "ema_21": [60050.0] * 50,
        "ema_50": [60000.0] * 50,
        "vol_expansion": [1.1] * 50,
    })
    regime = detector.detect({"15m": df}, 60150.0)
    assert regime.primary_regime in detector.REGIMES
    assert 0.0 <= regime.confidence <= 1.0


def test_ensemble_aggregator():
    weight_engine = StrategyWeightEngine()
    calibrator = ConfidenceCalibrator()
    aggregator = EnsembleAggregator(weight_engine, calibrator)

    predictions = {
        "trend": StrategyPrediction(signal="BUY", direction_score=0.7, confidence=0.8, expected_move=400.0, strategy_name="trend"),
        "structure": StrategyPrediction(signal="BUY", direction_score=0.5, confidence=0.7, expected_move=350.0, strategy_name="structure"),
        "volatility": StrategyPrediction(signal="BUY", direction_score=0.4, confidence=0.6, expected_move=420.0, strategy_name="volatility"),
        "mean_reversion": StrategyPrediction(signal="HOLD", direction_score=0.0, confidence=0.3, expected_move=200.0, strategy_name="mean_reversion"),
        "ml": StrategyPrediction(signal="BUY", direction_score=0.6, confidence=0.75, expected_move=380.0, strategy_name="ml"),
    }

    from regime.detector import RegimeState
    regime = RegimeState(primary_regime="STRONG_UPTREND", confidence=0.8)

    decision = aggregator.aggregate(predictions, regime, 60000.0)
    assert decision.signal == "BUY"
    assert decision.confidence > 0.4
    assert decision.expected_move > 0
    assert "trend" in decision.contributing_strategies
