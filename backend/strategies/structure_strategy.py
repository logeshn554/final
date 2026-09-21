"""
Strategy 2 — Market Structure / Support-Resistance

Answers: "Where is price likely to react?"

Uses: Swing highs/lows, HH/HL/LH/LL, break of structure, change of character,
support/resistance zones, range boundaries, breakout/rejection detection.
"""

from __future__ import annotations
import numpy as np
import pandas as pd
from strategies.base import BaseStrategy, StrategyPrediction
from features.market_structure import analyze_structure, StructureAnalysis


class StructureStrategy(BaseStrategy):
    name = "structure"

    def predict(
        self,
        dfs: dict[str, pd.DataFrame],
        current_price: float,
        regime: str,
    ) -> StrategyPrediction:
        reasons = []
        direction_scores = []
        all_supports = []
        all_resistances = []

        # Analyze structure on multiple timeframes
        tf_weights = {"1h": 0.30, "15m": 0.35, "5m": 0.20, "1m": 0.15}

        for tf, weight in tf_weights.items():
            df = dfs.get(tf)
            if df is None or len(df) < 30:
                continue

            analysis = analyze_structure(df, lookback=5)
            tf_score = self._score_structure(analysis, current_price, tf, reasons)
            direction_scores.append((tf_score, weight))

            all_supports.extend(analysis.support_levels)
            all_resistances.extend(analysis.resistance_levels)

        if not direction_scores:
            return StrategyPrediction(strategy_name=self.name, reason="Insufficient data")

        # Weighted average direction
        total_weight = sum(w for _, w in direction_scores)
        direction_score = sum(s * w for s, w in direction_scores) / max(total_weight, 1e-10)
        direction_score = np.clip(direction_score, -1.0, 1.0)

        # Deduplicate and sort S/R levels
        supports = sorted(set(round(s, 2) for s in all_supports if s < current_price), reverse=True)[:5]
        resistances = sorted(set(round(r, 2) for r in all_resistances if r > current_price))[:5]

        # Confidence from structure clarity
        confidence = min(abs(direction_score) * 0.7 + 0.3 * (len(supports) + len(resistances) > 3), 1.0)

        # Signal
        if direction_score > 0.15 and confidence > 0.30:
            signal = "BUY"
        elif direction_score < -0.15 and confidence > 0.30:
            signal = "SELL"
        else:
            signal = "HOLD"

        # Expected move bounded by nearest S/R — NOT a fixed ratio
        nearest_res = resistances[0] if resistances else current_price * 1.005
        nearest_sup = supports[0] if supports else current_price * 0.995
        upside = nearest_res - current_price
        downside = current_price - nearest_sup

        if signal == "BUY":
            expected_move = upside
            expected_high = nearest_res
            expected_low = nearest_sup
        elif signal == "SELL":
            expected_move = -downside
            expected_high = nearest_res
            expected_low = nearest_sup
        else:
            expected_move = 0
            expected_high = nearest_res
            expected_low = nearest_sup

        risk = 1.0 - confidence

        return StrategyPrediction(
            signal=signal,
            direction_score=direction_score,
            confidence=confidence,
            expected_move=expected_move,
            expected_high=expected_high,
            expected_low=expected_low,
            expected_horizon_minutes=20,
            support_levels=supports,
            resistance_levels=resistances,
            risk_level=risk,
            reason="; ".join(reasons[-5:]),
            strategy_name=self.name,
        )

    def _score_structure(
        self, analysis: StructureAnalysis, price: float, tf: str, reasons: list
    ) -> float:
        """Score market structure for a single timeframe."""
        score = 0.0

        # 1. HH/HL vs LH/LL structure
        bull_swing = analysis.hh_count + analysis.hl_count
        bear_swing = analysis.lh_count + analysis.ll_count
        total_swings = bull_swing + bear_swing
        if total_swings > 0:
            struct_bias = (bull_swing - bear_swing) / total_swings
            score += struct_bias * 0.4
            if abs(struct_bias) > 0.5:
                label = "bullish" if struct_bias > 0 else "bearish"
                reasons.append(f"{tf}: {label} structure (HH:{analysis.hh_count} HL:{analysis.hl_count} LH:{analysis.lh_count} LL:{analysis.ll_count})")

        # 2. Break of structure
        if analysis.bos_detected:
            score += analysis.bos_direction * 0.3
            reasons.append(f"{tf}: BoS {'bullish' if analysis.bos_direction > 0 else 'bearish'}")

        # 3. Change of character (strong reversal signal)
        if analysis.choch_detected:
            score -= 0.2  # ChoCh often signals reversal of current trend
            reasons.append(f"{tf}: Change of Character detected")

        # 4. Price position relative to S/R
        if analysis.nearest_resistance > 0 and analysis.nearest_support > 0:
            range_total = analysis.nearest_resistance - analysis.nearest_support
            if range_total > 0:
                position = (price - analysis.nearest_support) / range_total
                # Near support = bullish bias, near resistance = bearish bias
                position_bias = (0.5 - position) * 0.3  # reversed: low position = bullish
                score += position_bias

        # 5. Range vs breakout detection
        range_size = analysis.range_high - analysis.range_low
        if range_size > 0:
            if price > analysis.range_high:
                score += 0.25  # breakout above range
                reasons.append(f"{tf}: breakout above range")
            elif price < analysis.range_low:
                score -= 0.25  # breakdown below range
                reasons.append(f"{tf}: breakdown below range")

        return np.clip(score, -1, 1)
