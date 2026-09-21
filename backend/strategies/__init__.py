"""
Strategies package — 5 complementary strategies + base classes.
"""

from strategies.base import BaseStrategy, StrategyPrediction
from strategies.trend_strategy import TrendStrategy
from strategies.structure_strategy import StructureStrategy
from strategies.volatility_strategy import VolatilityStrategy
from strategies.mean_reversion_strategy import MeanReversionStrategy
from strategies.ml_strategy import MLStrategy

__all__ = [
    "BaseStrategy",
    "StrategyPrediction",
    "TrendStrategy",
    "StructureStrategy",
    "VolatilityStrategy",
    "MeanReversionStrategy",
    "MLStrategy",
]
