"""
Strategy 3 — Volatility / Range / ATR

Answers: "Given the current volatility, how far can price reasonably move?"

Uses: ATR regime, realized vol, vol expansion/contraction, historical move
distribution, average excursion after similar setups, candle range stats.
"""

from __future__ import annotations
import numpy as np
import pandas as pd
from strategies.base import BaseStrategy, StrategyPrediction
from features.volatility import historical_move_distribution, candle_range_percentile


class VolatilityStrategy(BaseStrategy):
    name = "volatility"

    def predict(
        self,
        dfs: dict[str, pd.DataFrame],
        current_price: float,
        regime: str,
    ) -> StrategyPrediction:
        reasons = []

        # Primary timeframe for volatility analysis
        df = dfs.get("15m", dfs.get("5m", pd.DataFrame()))
        if df is None or len(df) < 50:
            return StrategyPrediction(strategy_name=self.name, reason="Insufficient data")

        # ── Volatility State Assessment ───
        atr_val = self._safe_get(df, "atr_14", current_price * 0.003)
        vol_expansion = self._safe_get(df, "vol_expansion", 1.0)
        bb_bandwidth = self._safe_get(df, "bb_bandwidth", 0.02)
        realized_vol = self._safe_get(df, "realized_vol", 0.3)

        # Classify volatility regime
        if vol_expansion > 1.5:
            vol_regime = "EXPANDING"
            reasons.append(f"Volatility expanding ({vol_expansion:.2f}x)")
        elif vol_expansion < 0.7:
            vol_regime = "CONTRACTING"
            reasons.append(f"Volatility contracting ({vol_expansion:.2f}x)")
        else:
            vol_regime = "NORMAL"

        # ── Historical Move Distribution ───
        closes = df["close"].values
        move_dist = historical_move_distribution(closes, forward_bars=5, lookback=200)

        # ── Direction from recent price action momentum ───
        roc_5 = self._safe_get(df, "roc_5", 0)
        momentum = self._safe_get(df, "momentum_5", 0)
        mom_direction = np.sign(momentum) if abs(momentum) > atr_val * 0.1 else 0

        # Vol-expansion often favors continuation; contraction favors breakout
        direction_score = 0.0
        confidence = 0.3

        if vol_regime == "EXPANDING":
            # Strong expansion → favor continuation of current direction
            direction_score = np.clip(mom_direction * 0.5, -0.6, 0.6)
            confidence = 0.5
            reasons.append("Expansion favors momentum continuation")
        elif vol_regime == "CONTRACTING":
            # Squeeze → expect breakout, direction less certain
            direction_score = mom_direction * 0.2
            confidence = 0.25
            reasons.append("Compression detected — breakout expected")
        else:
            direction_score = mom_direction * 0.3
            confidence = 0.35

        # Candle range context
        if "hl_range" in df.columns:
            current_range = float(df["hl_range"].iloc[-1])
            range_pctile = candle_range_percentile(df["hl_range"], current_range)
            if range_pctile > 85:
                reasons.append(f"Wide candle range ({range_pctile:.0f}th pctile)")
                confidence += 0.1
            elif range_pctile < 15:
                reasons.append(f"Narrow candle range ({range_pctile:.0f}th pctile)")

        # ── Expected Move from Distribution — NOT fixed ───
        # Use the historical distribution to set realistic targets
        if direction_score > 0:
            expected_move = max(move_dist["p75"], atr_val)  # upside bias: use p75
            expected_high = current_price + abs(move_dist["p90"])
            expected_low = current_price - abs(move_dist["p25"])
        elif direction_score < 0:
            expected_move = min(move_dist["p25"], -atr_val)  # downside bias: use p25
            expected_high = current_price + abs(move_dist["p75"])
            expected_low = current_price - abs(move_dist["p90"])
        else:
            expected_move = 0
            expected_high = current_price + abs(move_dist["p75"])
            expected_low = current_price - abs(move_dist["p75"])

        # Risk from volatility extremes
        risk = np.clip(vol_expansion / 2.5, 0.1, 1.0)

        # Signal
        if abs(direction_score) > 0.2 and confidence > 0.35:
            signal = "BUY" if direction_score > 0 else "SELL"
        else:
            signal = "HOLD"

        return StrategyPrediction(
            signal=signal,
            direction_score=direction_score,
            confidence=confidence,
            expected_move=abs(float(expected_move)),
            expected_high=expected_high,
            expected_low=expected_low,
            expected_horizon_minutes=15,
            risk_level=risk,
            reason="; ".join(reasons),
            strategy_name=self.name,
        )
