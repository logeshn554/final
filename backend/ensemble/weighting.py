"""
Dynamic Strategy Weighting — Adapts strategy weights according to market regime and performance.
"""

from __future__ import annotations
from dataclasses import dataclass, field
import numpy as np


# Regime-to-Strategy Affinity Matrix (multipliers)
REGIME_AFFINITY: dict[str, dict[str, float]] = {
    "STRONG_UPTREND": {
        "trend": 1.6, "structure": 1.2, "volatility": 1.0, "mean_reversion": 0.2, "ml": 1.2
    },
    "WEAK_UPTREND": {
        "trend": 1.3, "structure": 1.2, "volatility": 1.0, "mean_reversion": 0.5, "ml": 1.1
    },
    "STRONG_DOWNTREND": {
        "trend": 1.6, "structure": 1.2, "volatility": 1.0, "mean_reversion": 0.2, "ml": 1.2
    },
    "WEAK_DOWNTREND": {
        "trend": 1.3, "structure": 1.2, "volatility": 1.0, "mean_reversion": 0.5, "ml": 1.1
    },
    "SIDEWAYS": {
        "trend": 0.3, "structure": 1.3, "volatility": 0.8, "mean_reversion": 1.7, "ml": 1.0
    },
    "MEAN_REVERTING": {
        "trend": 0.2, "structure": 1.2, "volatility": 0.8, "mean_reversion": 1.8, "ml": 1.0
    },
    "HIGH_VOL": {
        "trend": 0.9, "structure": 0.9, "volatility": 1.8, "mean_reversion": 0.5, "ml": 1.1
    },
    "LOW_VOL": {
        "trend": 0.5, "structure": 1.1, "volatility": 1.4, "mean_reversion": 1.2, "ml": 0.8
    },
    "BREAKOUT": {
        "trend": 1.5, "structure": 1.5, "volatility": 1.4, "mean_reversion": 0.1, "ml": 1.1
    },
    "BREAKDOWN": {
        "trend": 1.5, "structure": 1.5, "volatility": 1.4, "mean_reversion": 0.1, "ml": 1.1
    },
    "TRANSITION": {
        "trend": 0.7, "structure": 1.2, "volatility": 1.1, "mean_reversion": 0.9, "ml": 1.0
    },
}


class StrategyWeightEngine:
    """Computes dynamic, normalized weights for all 5 strategies given the regime and track record."""

    def __init__(self, base_weights: dict[str, float] | None = None):
        self.base_weights = base_weights or {
            "trend": 1.0,
            "structure": 1.0,
            "volatility": 1.0,
            "mean_reversion": 1.0,
            "ml": 1.0,
        }
        # Rolling accuracy records: strategy -> list of bool (last 30 trades)
        self.performance_history: dict[str, list[bool]] = {
            s: [] for s in self.base_weights
        }

    def record_outcome(self, strategy_name: str, was_profitable: bool):
        """Update recent accuracy tracker."""
        if strategy_name in self.performance_history:
            history = self.performance_history[strategy_name]
            history.append(was_profitable)
            if len(history) > 40:
                history.pop(0)

    def compute_weights(self, regime: str) -> dict[str, float]:
        """Compute regime-adjusted and performance-scaled normalized weights."""
        raw_weights = {}
        affinities = REGIME_AFFINITY.get(regime, {})

        for strat, base in self.base_weights.items():
            # 1. Regime affinity multiplier
            regime_mult = affinities.get(strat, 1.0)

            # 2. Performance multiplier from rolling win rate
            history = self.performance_history.get(strat, [])
            if len(history) >= 8:
                recent_win_rate = sum(history) / len(history)
                # Maps 30% winrate -> 0.6x, 50% -> 1.0x, 70% -> 1.4x
                perf_mult = np.clip(recent_win_rate * 2.0, 0.4, 1.6)
            else:
                perf_mult = 1.0

            raw_weights[strat] = base * regime_mult * perf_mult

        total = sum(raw_weights.values())
        if total <= 0:
            n = len(raw_weights)
            return {s: 1.0 / n for s in raw_weights}

        return {s: round(w / total, 4) for s, w in raw_weights.items()}
