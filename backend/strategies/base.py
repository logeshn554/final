"""
Strategy Base — Standardized prediction dataclass and abstract base class.
"""

from __future__ import annotations
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Optional
import pandas as pd


@dataclass
class StrategyPrediction:
    """Standardized output from every strategy."""
    signal: str = "HOLD"                     # "BUY" | "SELL" | "HOLD"
    direction_score: float = 0.0             # [-1.0, +1.0]
    confidence: float = 0.0                  # [0, 1]
    expected_move: float = 0.0               # expected move in price units
    expected_high: float = 0.0               # predicted high
    expected_low: float = 0.0                # predicted low
    expected_horizon_minutes: int = 0        # how long to reach target
    support_levels: list[float] = field(default_factory=list)
    resistance_levels: list[float] = field(default_factory=list)
    risk_level: float = 0.5                  # [0, 1] where 1 = maximum risk
    reason: str = ""
    strategy_name: str = ""

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
            "risk_level": round(self.risk_level, 4),
            "reason": self.reason,
            "strategy_name": self.strategy_name,
        }


class BaseStrategy(ABC):
    """Abstract base class for all strategies."""

    name: str = "base"

    @abstractmethod
    def predict(
        self,
        dfs: dict[str, pd.DataFrame],  # timeframe -> DataFrame with features
        current_price: float,
        regime: str,
    ) -> StrategyPrediction:
        """Generate a prediction from current market state.

        Args:
            dfs: Dict of timeframe -> DataFrame with OHLCV + all computed features.
            current_price: Latest close price.
            regime: Current detected market regime string.

        Returns:
            StrategyPrediction with all fields populated.
        """
        ...

    def _safe_get(self, df: pd.DataFrame, col: str, default: float = 0.0) -> float:
        """Safely get the latest value of a column."""
        if col in df.columns and len(df) > 0:
            val = df[col].iloc[-1]
            if pd.notna(val):
                return float(val)
        return default
