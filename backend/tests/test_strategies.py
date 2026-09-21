"""
Unit tests for all 5 trading strategies.
"""

import numpy as np
import pandas as pd
import pytest

from features.technical import compute_all_technical_features
from features.market_structure import compute_all_structure_features
from features.volatility import compute_all_volatility_features
from features.volume import compute_all_volume_features
from features.statistical import compute_all_statistical_features

from strategies.trend_strategy import TrendStrategy
from strategies.structure_strategy import StructureStrategy
from strategies.volatility_strategy import VolatilityStrategy
from strategies.mean_reversion_strategy import MeanReversionStrategy
from strategies.ml_strategy import MLStrategy


@pytest.fixture
def populated_dfs():
    np.random.seed(42)
    dfs = {}
    for tf in ["1m", "5m", "15m", "1h"]:
        n = 120
        prices = 3200.0 + np.cumsum(np.random.randn(n) * 10)
        df = pd.DataFrame({
            "timestamp": np.arange(n) * 60000,
            "open": prices,
            "high": prices + 8,
            "low": prices - 8,
            "close": prices + np.random.randn(n) * 3,
            "volume": np.random.rand(n) * 100 + 10,
        })
        df = compute_all_technical_features(df)
        df = compute_all_structure_features(df)
        df = compute_all_volatility_features(df)
        df = compute_all_volume_features(df)
        df = compute_all_statistical_features(df)
        dfs[tf] = df
    return dfs


def test_all_five_strategies(populated_dfs):
    current_price = float(populated_dfs["15m"]["close"].iloc[-1])
    regime = "STRONG_UPTREND"

    strategies = [
        TrendStrategy(),
        StructureStrategy(),
        VolatilityStrategy(),
        MeanReversionStrategy(),
        MLStrategy(),
    ]

    for strat in strategies:
        pred = strat.predict(populated_dfs, current_price, regime)
        assert pred.signal in ("BUY", "SELL", "HOLD")
        assert -1.0 <= pred.direction_score <= 1.0
        assert 0.0 <= pred.confidence <= 1.0
        assert pred.expected_move >= 0.0
        assert pred.strategy_name != ""
