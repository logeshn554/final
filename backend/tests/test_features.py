"""
Unit tests for feature engineering pipelines.
"""

import numpy as np
import pandas as pd
import pytest

from features.technical import compute_all_technical_features
from features.market_structure import compute_all_structure_features
from features.volatility import compute_all_volatility_features
from features.volume import compute_all_volume_features
from features.statistical import compute_all_statistical_features


@pytest.fixture
def sample_ohlcv():
    np.random.seed(42)
    n = 100
    prices = 3200.0 + np.cumsum(np.random.randn(n) * 10)
    highs = prices + np.random.rand(n) * 12
    lows = prices - np.random.rand(n) * 12
    opens = prices + np.random.randn(n) * 3
    closes = prices + np.random.randn(n) * 3
    volumes = np.random.rand(n) * 50 + 10

    return pd.DataFrame({
        "timestamp": np.arange(n) * 60000,
        "open": opens,
        "high": highs,
        "low": lows,
        "close": closes,
        "volume": volumes,
    })


def test_technical_features(sample_ohlcv):
    df = compute_all_technical_features(sample_ohlcv)
    assert "ema_9" in df.columns
    assert "ema_21" in df.columns
    assert "rsi_14" in df.columns
    assert "macd" in df.columns
    assert "adx_14" in df.columns
    assert not df["rsi_14"].iloc[-1] != df["rsi_14"].iloc[-1]  # check not NaN


def test_market_structure_features(sample_ohlcv):
    df = compute_all_structure_features(sample_ohlcv)
    assert "swing_high" in df.columns
    assert "swing_low" in df.columns
    assert "bos_bullish" in df.columns


def test_volatility_features(sample_ohlcv):
    df = compute_all_volatility_features(sample_ohlcv)
    assert "atr_14" in df.columns
    assert "vol_expansion" in df.columns
    assert "realized_vol" in df.columns
    assert df["atr_14"].iloc[-1] > 0


def test_volume_and_statistical_features(sample_ohlcv):
    df = compute_all_volume_features(sample_ohlcv)
    assert "vwap" in df.columns
    assert "obv" in df.columns

    df = compute_all_statistical_features(df)
    assert "z_score_20" in df.columns
    assert "bb_upper" in df.columns
    assert "bb_lower" in df.columns
