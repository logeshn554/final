"""
Strategy 4 — Mean Reversion / Extreme Detection

Answers: "Has price moved too far and is a reversal/reversion likely?"

Uses: RSI extremes, Bollinger Band deviations, Z-score, distance from VWAP,
distance from moving averages, overextension, exhaustion, reversal probability.
"""

from __future__ import annotations
import numpy as np
import pandas as pd
from strategies.base import BaseStrategy, StrategyPrediction


class MeanReversionStrategy(BaseStrategy):
    name = "mean_reversion"

    def predict(
        self,
        dfs: dict[str, pd.DataFrame],
        current_price: float,
        regime: str,
    ) -> StrategyPrediction:
        reasons = []
        reversion_scores = []

        # Multi-timeframe analysis with emphasis on lower TFs
        tf_weights = {"1m": 0.15, "5m": 0.30, "15m": 0.35, "1h": 0.20}

        for tf, weight in tf_weights.items():
            df = dfs.get(tf)
            if df is None or len(df) < 30:
                continue
            tf_score = self._evaluate_reversion(df, current_price, tf, reasons)
            reversion_scores.append((tf_score, weight))

        if not reversion_scores:
            return StrategyPrediction(strategy_name=self.name, reason="Insufficient data")

        total_w = sum(w for _, w in reversion_scores)
        direction_score = sum(s * w for s, w in reversion_scores) / max(total_w, 1e-10)
        direction_score = np.clip(direction_score, -1.0, 1.0)

        # Confidence: higher when multiple extremes agree
        extreme_count = sum(1 for s, _ in reversion_scores if abs(s) > 0.4)
        confidence = min(abs(direction_score) * 0.5 + extreme_count * 0.15, 1.0)

        # In strong trend regimes, reduce mean-reversion confidence
        if "STRONG" in regime.upper():
            confidence *= 0.6
            reasons.append("Strong trend reduces reversion confidence")

        # Signal: mean reversion is CONTRARIAN
        if direction_score > 0.20 and confidence > 0.35:
            signal = "BUY"  # oversold → buy
        elif direction_score < -0.20 and confidence > 0.35:
            signal = "SELL"  # overbought → sell
        else:
            signal = "HOLD"

        # Expected move: reversion toward mean — dynamically sized by deviation
        primary_df = dfs.get("15m", dfs.get("5m", pd.DataFrame()))
        atr_val = self._safe_get(primary_df, "atr_14", current_price * 0.003)
        z = self._safe_get(primary_df, "z_score_20", 0)

        # Reversion target = partial return toward the mean, scaled by how far we are
        reversion_distance = abs(z) * atr_val * 0.7  # mean reversion is partial, not full

        if signal == "BUY":
            expected_move = reversion_distance
            expected_high = current_price + reversion_distance
            expected_low = current_price - atr_val * 0.3
        elif signal == "SELL":
            expected_move = -reversion_distance
            expected_high = current_price + atr_val * 0.3
            expected_low = current_price - reversion_distance
        else:
            expected_move = 0
            expected_high = current_price + atr_val
            expected_low = current_price - atr_val

        return StrategyPrediction(
            signal=signal,
            direction_score=direction_score,
            confidence=confidence,
            expected_move=expected_move,
            expected_high=expected_high,
            expected_low=expected_low,
            expected_horizon_minutes=10,
            risk_level=1.0 - confidence,
            reason="; ".join(reasons[-5:]),
            strategy_name=self.name,
        )

    def _evaluate_reversion(
        self, df: pd.DataFrame, price: float, tf: str, reasons: list
    ) -> float:
        """Evaluate reversion signals for one timeframe.
        Returns positive = oversold (buy signal), negative = overbought (sell signal).
        """
        score = 0.0

        # 1. RSI extremes
        rsi = self._safe_get(df, "rsi", 50)
        if rsi < 25:
            score += 0.4
            reasons.append(f"{tf}: RSI oversold ({rsi:.1f})")
        elif rsi < 35:
            score += 0.2
        elif rsi > 75:
            score -= 0.4
            reasons.append(f"{tf}: RSI overbought ({rsi:.1f})")
        elif rsi > 65:
            score -= 0.2

        # Fast RSI for more extreme detection
        rsi_6 = self._safe_get(df, "rsi_6", 50)
        if rsi_6 < 15:
            score += 0.3
            reasons.append(f"{tf}: RSI(6) extreme oversold ({rsi_6:.1f})")
        elif rsi_6 > 85:
            score -= 0.3
            reasons.append(f"{tf}: RSI(6) extreme overbought ({rsi_6:.1f})")
        score = float(np.clip(score, -1.0, 1.0))

        # 2. Bollinger %B
        bb_pct = self._safe_get(df, "bb_pct_b", 0.5)
        if bb_pct < 0.05:
            score += 0.35
            reasons.append(f"{tf}: price below lower BB")
        elif bb_pct > 0.95:
            score -= 0.35
            reasons.append(f"{tf}: price above upper BB")
        score = float(np.clip(score, -1.0, 1.0))

        # 3. Z-score
        z = self._safe_get(df, "z_score_20", 0)
        if z < -2.0:
            score += 0.3
            reasons.append(f"{tf}: z-score={z:.2f} (extreme low)")
        elif z > 2.0:
            score -= 0.3
            reasons.append(f"{tf}: z-score={z:.2f} (extreme high)")
        elif abs(z) > 1.5:
            score += np.sign(-z) * 0.15
        score = float(np.clip(score, -1.0, 1.0))

        # 4. Distance from VWAP
        dist_vwap = self._safe_get(df, "price_vs_vwap", 0)
        if abs(dist_vwap) > 0.005:
            score += np.sign(-dist_vwap) * 0.2
            if abs(dist_vwap) > 0.01:
                reasons.append(f"{tf}: extended from VWAP ({dist_vwap*100:.2f}%)")

        # 5. Distance from EMA
        dist_ema = self._safe_get(df, "dist_ema_21", 0)
        if abs(dist_ema) > 1.0:
            score += np.sign(-dist_ema) * 0.15

        # 6. Stochastic extremes
        stoch_k = self._safe_get(df, "stoch_k", 50)
        if stoch_k < 15:
            score += 0.2
        elif stoch_k > 85:
            score -= 0.2

        # 7. CCI extremes
        cci_val = self._safe_get(df, "cci", 0)
        if cci_val < -150:
            score += 0.2
        elif cci_val > 150:
            score -= 0.2

        # Clip score to [-1, 1] first
        score = float(np.clip(score, -1.0, 1.0))

        # 8. Volume exhaustion: small additive signal rather than multiplicative
        rel_vol = self._safe_get(df, "rel_volume", 1.0)
        if rel_vol < 0.5 and abs(score) > 0.3:
            exhaustion_bonus = float(np.sign(score) * 0.10)   # max 10% additive boost
            score = float(np.clip(score + exhaustion_bonus, -1.0, 1.0))
            reasons.append(f"{tf}: low volume exhaustion bonus (relVol={rel_vol:.2f})")

        return score

