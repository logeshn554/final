"""
Strategy 5 — ML / Sequence Model

Answers: "What does historical pattern recognition predict for the next N bars?"

Uses: Gradient-boosted tree / regression models trained on multi-timeframe engineered features.
Predicts:
- Forward return direction (P(up) vs P(down))
- Expected move magnitude (in price points / bps)
- Dynamic confidence from probability margin
"""

from __future__ import annotations
import logging
import numpy as np
import pandas as pd
from typing import Optional, Any
from strategies.base import BaseStrategy, StrategyPrediction

logger = logging.getLogger(__name__)

# Feature columns to extract for ML models
FEATURE_COLS = [
    "rsi_14", "adx_14", "macd", "macd_hist", "stoch_k", "stoch_d",
    "cci_20", "williams_r", "roc_5", "roc_20", "momentum_5",
    "vol_expansion", "atr_ratio", "realized_vol", "parkinson_vol",
    "volume_ratio", "volume_momentum", "obv_slope",
    "z_score_20", "bb_pct_b", "bb_bandwidth", "dist_from_vwap_pct",
    "dist_ema_9_pct", "dist_ema_21_pct", "dist_ema_50_pct"
]


class MLStrategy(BaseStrategy):
    name = "ml"

    def __init__(self, forward_bars: int = 5, min_train_samples: int = 80):
        self.forward_bars = forward_bars
        self.min_train_samples = min_train_samples
        self._clf_model: Any = None
        self._reg_model: Any = None
        self._is_trained: bool = False
        self._last_trained_len: int = 0

    def _extract_feature_vector(self, df: pd.DataFrame) -> Optional[np.ndarray]:
        """Extract a single feature vector from the latest row of df."""
        if df is None or len(df) < 10:
            return None
        available_cols = [c for c in FEATURE_COLS if c in df.columns]
        if len(available_cols) < 5:
            return None
        row = df[available_cols].iloc[-1].fillna(0.0).values
        return row.astype(np.float32)

    def _prepare_training_data(self, df: pd.DataFrame) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
        """Build X (features), y_dir (direction 0/1), y_mag (magnitude in points)."""
        available_cols = [c for c in FEATURE_COLS if c in df.columns]
        if len(available_cols) < 5 or len(df) <= self.forward_bars + 20:
            return np.empty((0, 0)), np.empty((0,)), np.empty((0,))

        feature_matrix = df[available_cols].fillna(0.0).values
        closes = df["close"].values

        n = len(df) - self.forward_bars
        X = feature_matrix[:n]
        future_returns = (closes[self.forward_bars:] - closes[:n]) / closes[:n]
        future_pts = np.abs(closes[self.forward_bars:] - closes[:n])

        # Direction: 1 for up (>0.0005 to filter noise), 0 for down
        y_dir = (future_returns > 0.0).astype(int)
        y_mag = future_pts

        return X, y_dir, y_mag

    def _train_or_update(self, df: pd.DataFrame):
        """Train classifier and regressor on available features."""
        try:
            X, y_dir, y_mag = self._prepare_training_data(df)
            if len(X) < self.min_train_samples:
                return

            try:
                import xgboost as xgb
                self._clf_model = xgb.XGBClassifier(
                    n_estimators=35,
                    max_depth=3,
                    learning_rate=0.08,
                    subsample=0.8,
                    eval_metric="logloss",
                    random_state=42
                )
                self._reg_model = xgb.XGBRegressor(
                    n_estimators=35,
                    max_depth=3,
                    learning_rate=0.08,
                    subsample=0.8,
                    random_state=42
                )
            except Exception:
                # Fallback to scikit-learn HistGradientBoosting
                from sklearn.ensemble import HistGradientBoostingClassifier, HistGradientBoostingRegressor
                self._clf_model = HistGradientBoostingClassifier(
                    max_iter=35, max_depth=3, learning_rate=0.08, random_state=42
                )
                self._reg_model = HistGradientBoostingRegressor(
                    max_iter=35, max_depth=3, learning_rate=0.08, random_state=42
                )

            self._clf_model.fit(X, y_dir)
            self._reg_model.fit(X, y_mag)
            self._is_trained = True
            self._last_trained_len = len(df)
        except Exception as e:
            logger.warning(f"MLStrategy training failed: {e}")

    def predict(
        self,
        dfs: dict[str, pd.DataFrame],
        current_price: float,
        regime: str,
    ) -> StrategyPrediction:
        reasons = []

        # Prefer 15m or 5m timeframe for ML setup
        df = dfs.get("15m", dfs.get("5m", pd.DataFrame()))
        if df is None or len(df) < 50:
            return StrategyPrediction(strategy_name=self.name, reason="Insufficient bar history")

        # Retrain periodically if new data has arrived
        if not self._is_trained or (len(df) - self._last_trained_len) >= 30:
            self._train_or_update(df)

        atr_val = self._safe_get(df, "atr_14", current_price * 0.003)

        if not self._is_trained or self._clf_model is None:
            # Cold-start heuristic until ML model fits enough samples
            rsi = self._safe_get(df, "rsi_14", 50.0)
            z_score = self._safe_get(df, "z_score_20", 0.0)
            roc_5 = self._safe_get(df, "roc_5", 0.0)

            # Composite heuristic score
            heuristic_score = np.clip((50.0 - rsi) / 50.0 * 0.3 + (roc_5 / 100.0) * 0.4 - z_score * 0.3, -1.0, 1.0)
            conf = min(abs(heuristic_score) * 0.8 + 0.2, 0.6)
            sig = "BUY" if heuristic_score > 0.2 else ("SELL" if heuristic_score < -0.2 else "HOLD")
            move = max(atr_val * 1.5, current_price * 0.004)

            return StrategyPrediction(
                signal=sig,
                direction_score=float(heuristic_score),
                confidence=float(conf),
                expected_move=float(move),
                expected_high=current_price + (move if sig == "BUY" else move * 0.5),
                expected_low=current_price - (move if sig == "SELL" else move * 0.5),
                expected_horizon_minutes=self.forward_bars * 15,
                risk_level=0.5,
                reason=f"Cold-start feature heuristic (RSI={rsi:.1f}, Z={z_score:.2f})",
                strategy_name=self.name,
            )

        # Build feature vector for latest bar
        available_cols = [c for c in FEATURE_COLS if c in df.columns]
        x_curr = df[available_cols].iloc[-1:].fillna(0.0).values

        try:
            proba = self._clf_model.predict_proba(x_curr)[0]
            p_up = float(proba[1]) if len(proba) > 1 else 0.5
            p_down = float(proba[0]) if len(proba) > 1 else 0.5
            pred_mag = float(self._reg_model.predict(x_curr)[0])
        except Exception as e:
            logger.warning(f"ML inference error: {e}")
            p_up, p_down, pred_mag = 0.5, 0.5, atr_val

        # Direction score: centered at 0 in [-1.0, 1.0]
        direction_score = (p_up - 0.5) * 2.0
        confidence = float(np.clip(abs(p_up - 0.5) * 2.0, 0.1, 0.95))

        # Expected move from regressor, bounded by realistic ATR range
        expected_move = float(np.clip(pred_mag, atr_val * 0.5, atr_val * 4.0))

        if direction_score > 0.15 and confidence > 0.35:
            signal = "BUY"
            reasons.append(f"ML model P(Up)={p_up:.1%}")
        elif direction_score < -0.15 and confidence > 0.35:
            signal = "SELL"
            reasons.append(f"ML model P(Down)={p_down:.1%}")
        else:
            signal = "HOLD"
            reasons.append(f"ML neutral/balanced P(Up)={p_up:.1%}")

        expected_high = current_price + (expected_move if direction_score >= 0 else expected_move * 0.4)
        expected_low = current_price - (expected_move if direction_score <= 0 else expected_move * 0.4)

        return StrategyPrediction(
            signal=signal,
            direction_score=float(direction_score),
            confidence=float(confidence),
            expected_move=float(expected_move),
            expected_high=float(expected_high),
            expected_low=float(expected_low),
            expected_horizon_minutes=self.forward_bars * 15,
            support_levels=[current_price - expected_move * 0.8],
            resistance_levels=[current_price + expected_move * 0.8],
            risk_level=float(np.clip(1.0 - confidence, 0.1, 0.9)),
            reason=" | ".join(reasons),
            strategy_name=self.name,
        )
