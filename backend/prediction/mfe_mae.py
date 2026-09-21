"""
MFE/MAE Distribution Analysis — Maximum Favorable & Adverse Excursion Engine.

Tracks empirical distributions of:
- How far trades ran in profit before failing or reversing (MFE)
- How deep adverse pullbacks went before trades succeeded (MAE)
Organized by market regime, allowing data-driven target and stop calibration.
"""

from __future__ import annotations
from dataclasses import dataclass, field
import numpy as np


@dataclass
class ExcursionProfile:
    regime: str
    mfe_p25: float      # Conservative favorable move
    mfe_p50: float      # Median favorable move
    mfe_p75: float      # Extended favorable move
    mae_p50: float      # Median normal pullback
    mae_p85: float      # Invalidation threshold (85th percentile of normal drawdowns)
    sample_count: int

    def to_dict(self) -> dict:
        return {
            "regime": self.regime,
            "mfe_p25": round(self.mfe_p25, 2),
            "mfe_p50": round(self.mfe_p50, 2),
            "mfe_p75": round(self.mfe_p75, 2),
            "mae_p50": round(self.mae_p50, 2),
            "mae_p85": round(self.mae_p85, 2),
            "sample_count": self.sample_count,
        }


class MFEMAEEngine:
    """Manages empirical MFE and MAE distributions across market regimes."""

    def __init__(self):
        # regime -> {"mfe": list[float], "mae": list[float]}
        self._history: dict[str, dict[str, list[float]]] = {}

    def record_trade_excursion(self, regime: str, mfe_pts: float, mae_pts: float):
        """Record completed trade's MFE and MAE."""
        if regime not in self._history:
            self._history[regime] = {"mfe": [], "mae": []}
        self._history[regime]["mfe"].append(abs(mfe_pts))
        self._history[regime]["mae"].append(abs(mae_pts))

        # Keep rolling window of 200 trades per regime
        if len(self._history[regime]["mfe"]) > 200:
            self._history[regime]["mfe"].pop(0)
            self._history[regime]["mae"].pop(0)

    def get_profile(self, regime: str, current_atr: float) -> ExcursionProfile:
        """Get excursion profile for regime, falling back to ATR-based empirical priors."""
        data = self._history.get(regime)
        if data and len(data["mfe"]) >= 15:
            mfe_arr = np.array(data["mfe"])
            mae_arr = np.array(data["mae"])
            return ExcursionProfile(
                regime=regime,
                mfe_p25=float(np.percentile(mfe_arr, 25)),
                mfe_p50=float(np.percentile(mfe_arr, 50)),
                mfe_p75=float(np.percentile(mfe_arr, 75)),
                mae_p50=float(np.percentile(mae_arr, 50)),
                mae_p85=float(np.percentile(mae_arr, 85)),
                sample_count=len(mfe_arr),
            )

        # Empirical priors scaled dynamically by current ATR and regime type
        regime_mults = {
            "STRONG_UPTREND": (1.2, 2.2, 3.5, 0.7, 1.2),
            "STRONG_DOWNTREND": (1.2, 2.2, 3.5, 0.7, 1.2),
            "WEAK_UPTREND": (0.8, 1.5, 2.4, 0.8, 1.4),
            "WEAK_DOWNTREND": (0.8, 1.5, 2.4, 0.8, 1.4),
            "BREAKOUT": (1.5, 2.8, 4.2, 0.8, 1.3),
            "BREAKDOWN": (1.5, 2.8, 4.2, 0.8, 1.3),
            "HIGH_VOL": (1.4, 2.5, 4.0, 1.1, 1.8),
            "LOW_VOL": (0.6, 1.0, 1.6, 0.5, 0.9),
            "SIDEWAYS": (0.6, 1.1, 1.8, 0.6, 1.1),
            "MEAN_REVERTING": (0.7, 1.3, 2.0, 0.6, 1.1),
        }

        m25, m50, m75, a50, a85 = regime_mults.get(regime, (0.8, 1.4, 2.2, 0.7, 1.2))

        return ExcursionProfile(
            regime=regime,
            mfe_p25=current_atr * m25,
            mfe_p50=current_atr * m50,
            mfe_p75=current_atr * m75,
            mae_p50=current_atr * a50,
            mae_p85=current_atr * a85,
            sample_count=0,
        )
