"""
Market Regime Detector — Multi-signal regime classifier for ETHUSDT (Ethereum).

Classifies the market into:
- STRONG_UPTREND, WEAK_UPTREND
- STRONG_DOWNTREND, WEAK_DOWNTREND
- SIDEWAYS
- HIGH_VOL, LOW_VOL
- BREAKOUT, BREAKDOWN
- MEAN_REVERTING
- TRANSITION
"""

from __future__ import annotations
from dataclasses import dataclass, field
from typing import Optional
import numpy as np
import pandas as pd


@dataclass
class RegimeState:
    primary_regime: str = "SIDEWAYS"
    secondary_regime: str = "NORMAL_VOL"
    confidence: float = 0.5
    trend_strength: float = 0.0      # [0, 1] from ADX/EMA alignment
    volatility_state: str = "NORMAL" # "LOW", "NORMAL", "HIGH", "EXPANDING", "CONTRACTING"
    is_trending: bool = False
    is_ranging: bool = True
    is_breakout: bool = False
    bars_in_regime: int = 1
    regime_scores: dict[str, float] = field(default_factory=dict)
    description: str = ""
    macro_bias: str = "NEUTRAL"      # "BULL" | "BEAR" | "NEUTRAL"

    def to_dict(self) -> dict:
        return {
            "primary_regime": self.primary_regime,
            "secondary_regime": self.secondary_regime,
            "confidence": round(self.confidence, 4),
            "trend_strength": round(self.trend_strength, 4),
            "volatility_state": self.volatility_state,
            "is_trending": self.is_trending,
            "is_ranging": self.is_ranging,
            "is_breakout": self.is_breakout,
            "bars_in_regime": self.bars_in_regime,
            "regime_scores": {k: round(v, 4) for k, v in self.regime_scores.items()},
            "description": self.description,
            "macro_bias": self.macro_bias,
        }



class RegimeDetector:
    """Classifies current market regime using multi-timeframe and multi-indicator signals."""

    REGIMES = [
        "STRONG_UPTREND", "WEAK_UPTREND",
        "STRONG_DOWNTREND", "WEAK_DOWNTREND",
        "SIDEWAYS", "HIGH_VOL", "LOW_VOL",
        "BREAKOUT", "BREAKDOWN", "MEAN_REVERTING", "TRANSITION"
    ]

    def __init__(self):
        self._last_regime: str = "SIDEWAYS"
        self._bars_in_regime: int = 1

    def detect(self, dfs: dict[str, pd.DataFrame], current_price: float) -> RegimeState:
        # Prefer 15m as base regime timeframe, fallback to 1h or 5m
        df = dfs.get("15m", dfs.get("1h", dfs.get("5m", pd.DataFrame())))
        if df is None or len(df) < 30:
            return RegimeState(description="Insufficient data for regime classification")

        # Extract features
        adx = self._val(df, "adx_14", 20.0)
        plus_di = self._val(df, "plus_di_14", 20.0)
        minus_di = self._val(df, "minus_di_14", 20.0)
        bb_bandwidth = self._val(df, "bb_bandwidth", 0.02)
        vol_expansion = self._val(df, "vol_expansion", 1.0)
        hurst = self._val(df, "hurst_proxy", 0.5)
        dist_ema_50 = self._val(df, "dist_ema_50_pct", 0.0)
        ema_9 = self._val(df, "ema_9", current_price)
        ema_21 = self._val(df, "ema_21", current_price)
        ema_50 = self._val(df, "ema_50", current_price)
        roc_20 = self._val(df, "roc_20", 0.0)
        bos_bullish = bool(self._val(df, "bos_bullish", 0))
        bos_bearish = bool(self._val(df, "bos_bearish", 0))

        # Higher timeframe confirmation (1h)
        df_1h = dfs.get("1h")
        ema_bullish_1h = False
        ema_bearish_1h = False
        if df_1h is not None and len(df_1h) >= 20:
            e9 = self._val(df_1h, "ema_9", current_price)
            e21 = self._val(df_1h, "ema_21", current_price)
            e50 = self._val(df_1h, "ema_50", current_price)
            ema_bullish_1h = e9 > e21 > e50
            ema_bearish_1h = e9 < e21 < e50

        # Macro timeframe confirmation (4h)
        df_4h = dfs.get("4h")
        macro_bear = False
        macro_bull = False
        macro_bias = "NEUTRAL"
        if df_4h is not None and len(df_4h) >= 20:
            e21_4h = self._val(df_4h, "ema_21", current_price)
            e50_4h = self._val(df_4h, "ema_50", current_price)
            adx_4h = self._val(df_4h, "adx_14", 20.0)
            macro_bear = current_price < e21_4h < e50_4h and adx_4h > 22
            macro_bull = current_price > e21_4h > e50_4h and adx_4h > 22
            if macro_bull:
                macro_bias = "BULL"
            elif macro_bear:
                macro_bias = "BEAR"

        # Indicator metrics
        di_spread = plus_di - minus_di
        ema_stacked_bull = (ema_9 > ema_21 > ema_50) and (current_price > ema_9)
        ema_stacked_bear = (ema_9 < ema_21 < ema_50) and (current_price < ema_9)
        trend_strength = float(np.clip(adx / 50.0, 0.0, 1.0))

        # Volatility state
        if vol_expansion > 1.6 or bb_bandwidth > 0.05:
            vol_state = "HIGH"
        elif vol_expansion < 0.65 or bb_bandwidth < 0.012:
            vol_state = "LOW"
        elif vol_expansion > 1.25:
            vol_state = "EXPANDING"
        elif vol_expansion < 0.8:
            vol_state = "CONTRACTING"
        else:
            vol_state = "NORMAL"

        scores: dict[str, float] = {r: 0.0 for r in self.REGIMES}

        # 1. Breakouts / Breakdowns
        if bos_bullish and vol_expansion > 1.2:
            scores["BREAKOUT"] += 0.85
        elif bos_bullish:
            scores["BREAKOUT"] += 0.5

        if bos_bearish and vol_expansion > 1.2:
            scores["BREAKDOWN"] += 0.85
        elif bos_bearish:
            scores["BREAKDOWN"] += 0.5

        # 2. Strong / Weak Trends
        if ema_stacked_bull and adx > 25 and di_spread > 5:
            if adx > 35 and ema_bullish_1h:
                scores["STRONG_UPTREND"] += 0.90
            else:
                scores["WEAK_UPTREND"] += 0.75
        elif di_spread > 8 and current_price > ema_21:
            scores["WEAK_UPTREND"] += 0.60

        if ema_stacked_bear and adx > 25 and di_spread < -5:
            if adx > 35 and ema_bearish_1h:
                scores["STRONG_DOWNTREND"] += 0.90
            else:
                scores["WEAK_DOWNTREND"] += 0.75
        elif di_spread < -8 and current_price < ema_21:
            scores["WEAK_DOWNTREND"] += 0.60

        # 3. Mean Reverting
        if hurst < 0.45 or (adx < 18 and abs(di_spread) < 8):
            scores["MEAN_REVERTING"] += 0.70

        # 4. Volatility Regimes
        if vol_state == "HIGH":
            scores["HIGH_VOL"] += 0.65
        elif vol_state == "LOW":
            scores["LOW_VOL"] += 0.65

        # 5. Sideways / Range
        if adx < 20 and abs(dist_ema_50) < 1.0 and vol_state in ("NORMAL", "LOW"):
            scores["SIDEWAYS"] += 0.75

        # 6. Transition
        if 20 <= adx <= 25 and abs(di_spread) < 6:
            scores["TRANSITION"] += 0.45

        # Apply 4h macro context override
        if macro_bear:
            scores["STRONG_UPTREND"] *= 0.3
            scores["WEAK_UPTREND"] *= 0.5
            scores["BREAKDOWN"] += 0.3
        if macro_bull:
            scores["STRONG_DOWNTREND"] *= 0.3
            scores["WEAK_DOWNTREND"] *= 0.5
            scores["BREAKOUT"] += 0.3

        # Select highest scoring regime
        best_regime = max(scores, key=lambda k: scores[k])
        highest_score = scores[best_regime]

        if highest_score < 0.35:
            best_regime = "SIDEWAYS"
            highest_score = 0.4

        # Track regime persistence
        if best_regime == self._last_regime:
            self._bars_in_regime += 1
        else:
            self._bars_in_regime = 1
            self._last_regime = best_regime

        confidence = float(np.clip(highest_score, 0.2, 0.95))
        is_trending = best_regime in ("STRONG_UPTREND", "WEAK_UPTREND", "STRONG_DOWNTREND", "WEAK_DOWNTREND")
        is_breakout = best_regime in ("BREAKOUT", "BREAKDOWN")
        is_ranging = best_regime in ("SIDEWAYS", "LOW_VOL", "MEAN_REVERTING")

        desc = f"Regime: {best_regime} (Conf: {confidence:.0%}, ADX: {adx:.1f}, Vol: {vol_state}, Macro: {macro_bias}, Bars: {self._bars_in_regime})"

        return RegimeState(
            primary_regime=best_regime,
            secondary_regime=f"{vol_state}_VOL",
            confidence=confidence,
            trend_strength=trend_strength,
            volatility_state=vol_state,
            is_trending=is_trending,
            is_ranging=is_ranging,
            is_breakout=is_breakout,
            bars_in_regime=self._bars_in_regime,
            regime_scores=scores,
            description=desc,
            macro_bias=macro_bias,
        )


    def _val(self, df: pd.DataFrame, col: str, default: float = 0.0) -> float:
        if col in df.columns and len(df) > 0:
            v = df[col].iloc[-1]
            if pd.notna(v):
                return float(v)
        return default
