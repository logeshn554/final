"""
Strategy 1 — Trend / Momentum

Answers: "Is the market currently trending and in which direction?"

Uses: EMA structure, MACD, ADX, RSI directional bias, ROC, momentum,
higher-high / higher-low structure, trend persistence, multi-TF alignment.
"""

from __future__ import annotations
import numpy as np
import pandas as pd
from strategies.base import BaseStrategy, StrategyPrediction


class TrendStrategy(BaseStrategy):
    name = "trend"

    def predict(
        self,
        dfs: dict[str, pd.DataFrame],
        current_price: float,
        regime: str,
    ) -> StrategyPrediction:
        scores = {}
        reasons = []

        # Evaluate each timeframe (weighted by importance)
        tf_weights = {"1h": 0.35, "15m": 0.30, "5m": 0.20, "1m": 0.15}

        for tf, weight in tf_weights.items():
            df = dfs.get(tf)
            if df is None or len(df) < 50:
                continue

            tf_score = self._evaluate_tf(df, reasons, tf)
            scores[tf] = tf_score * weight

        if not scores:
            return StrategyPrediction(strategy_name=self.name, reason="Insufficient data")

        # Weighted direction score
        total_weight = sum(tf_weights[tf] for tf in scores)
        direction_score = sum(scores.values()) / max(total_weight, 1e-10)
        direction_score = np.clip(direction_score, -1.0, 1.0)

        # Multi-TF agreement bonus
        agreement = sum(1 for s in scores.values() if np.sign(s) == np.sign(direction_score))
        agreement_pct = agreement / max(len(scores), 1)

        # Confidence from direction strength and agreement
        confidence = min(abs(direction_score) * 0.6 + agreement_pct * 0.4, 1.0)

        # Signal
        if direction_score > 0.15 and confidence > 0.35:
            signal = "BUY"
        elif direction_score < -0.15 and confidence > 0.35:
            signal = "SELL"
        else:
            signal = "HOLD"

        # Expected move from ATR and trend strength
        primary_df = dfs.get("15m", dfs.get("5m", pd.DataFrame()))
        atr_val = self._safe_get(primary_df, "atr_14", current_price * 0.003)
        trend_strength = abs(direction_score)

        # Move estimate scales with trend strength and volatility — NOT a fixed ratio
        expected_move = atr_val * (1.0 + trend_strength * 2.0) * np.sign(direction_score)
        expected_high = current_price + abs(expected_move) if direction_score > 0 else current_price + atr_val * 0.3
        expected_low = current_price - abs(expected_move) if direction_score < 0 else current_price - atr_val * 0.3

        # Risk assessment
        adx_val = self._safe_get(primary_df, "adx", 20)
        risk = 1.0 - np.clip(adx_val / 60.0, 0, 1)  # stronger trend = lower risk

        return StrategyPrediction(
            signal=signal,
            direction_score=direction_score,
            confidence=confidence,
            expected_move=expected_move,
            expected_high=expected_high,
            expected_low=expected_low,
            expected_horizon_minutes=self._estimate_horizon(dfs),
            risk_level=risk,
            reason="; ".join(reasons[-5:]),
            strategy_name=self.name,
        )

    def _evaluate_tf(self, df: pd.DataFrame, reasons: list, tf: str) -> float:
        """Evaluate trend score for a single timeframe. Returns [-1, 1]."""
        score = 0.0
        n_factors = 0

        # 1. EMA alignment (0 to 1, mapped to -1 to 1)
        ema_align = self._safe_get(df, "ema_alignment", 0.5)
        ema_score = (ema_align - 0.5) * 2.0  # -1 to 1
        score += ema_score * 1.5
        n_factors += 1.5

        # 2. EMA 9/21 cross direction
        cross_9_21 = self._safe_get(df, "ema_9_21_cross", 0)
        score += cross_9_21 * 1.0
        n_factors += 1.0

        # 3. MACD histogram direction and magnitude
        macd_hist = self._safe_get(df, "macd_hist", 0)
        atr_val = self._safe_get(df, "atr_14", 1)
        macd_norm = np.clip(macd_hist / max(atr_val * 0.5, 1e-10), -1, 1)
        score += macd_norm * 1.2
        n_factors += 1.2

        # 4. ADX trend strength + DI direction
        adx_val = self._safe_get(df, "adx", 20)
        plus_di = self._safe_get(df, "plus_di", 0)
        minus_di = self._safe_get(df, "minus_di", 0)
        adx_strength = np.clip(adx_val / 50.0, 0, 1)
        di_direction = 1.0 if plus_di > minus_di else -1.0
        score += di_direction * adx_strength * 1.3
        n_factors += 1.3

        if adx_val > 25:
            reasons.append(f"{tf}: ADX={adx_val:.0f} strong trend")

        # 5. RSI directional bias (not extremes — that's mean reversion's job)
        rsi_val = self._safe_get(df, "rsi", 50)
        rsi_direction = np.clip((rsi_val - 50) / 30, -1, 1)  # 50 = neutral
        score += rsi_direction * 0.8
        n_factors += 0.8

        # 6. ROC momentum
        roc_val = self._safe_get(df, "roc_10", 0)
        roc_norm = np.clip(roc_val / 3.0, -1, 1)  # normalize
        score += roc_norm * 0.7
        n_factors += 0.7

        # 7. Trend persistence
        persistence = self._safe_get(df, "trend_persistence", 0)
        if persistence > 10:
            score += 0.5
            n_factors += 0.5
            reasons.append(f"{tf}: trend persisted {int(persistence)} bars")

        # 8. Momentum
        mom = self._safe_get(df, "momentum_10", 0)
        mom_norm = np.clip(mom / max(atr_val, 1e-10), -1, 1)
        score += mom_norm * 0.6
        n_factors += 0.6

        final = score / max(n_factors, 1)
        if abs(final) > 0.3:
            direction = "bullish" if final > 0 else "bearish"
            reasons.append(f"{tf}: {direction} trend score={final:.2f}")

        return np.clip(final, -1, 1)

    def _estimate_horizon(self, dfs: dict) -> int:
        """Estimate time horizon based on timeframe data available."""
        if "1h" in dfs and len(dfs["1h"]) > 20:
            return 60  # 1h timeframe suggests longer holds
        elif "15m" in dfs and len(dfs["15m"]) > 20:
            return 30
        return 15
