"""
Failure Analysis — Classifies losing trades, attributes strategy culpability, and diagnoses failure modes.
"""

from __future__ import annotations
from dataclasses import dataclass
import json


@dataclass
class FailureDiagnosis:
    trade_id: str
    failure_category: str        # "FALSE_BREAKOUT", "MOMENTUM_EXHAUSTION", "REGIME_MISMATCH", "VOLATILITY_WHIPSAW", "STRUCTURAL_INVALIDATION"
    culpable_strategies: list[str]
    loss_usd: float
    mfe_before_loss_pts: float
    attribution_notes: str

    def to_dict(self) -> dict:
        return {
            "trade_id": self.trade_id,
            "failure_category": self.failure_category,
            "culpable_strategies": self.culpable_strategies,
            "loss_usd": round(self.loss_usd, 2),
            "mfe_before_loss_pts": round(self.mfe_before_loss_pts, 2),
            "attribution_notes": self.attribution_notes,
        }


class FailureAnalyzer:
    """Diagnoses root cause of trade failure to refine risk parameters and weights."""

    def diagnose_trade(self, trade_dict: dict) -> FailureDiagnosis:
        trade_id = str(trade_dict.get("id", "unknown"))
        pnl = float(trade_dict.get("pnl_usd", 0.0))
        mfe = float(trade_dict.get("mfe_pts", 0.0))
        regime = str(trade_dict.get("regime_at_entry", "SIDEWAYS"))
        votes_raw = trade_dict.get("strategy_votes", "{}")

        culpable = []
        try:
            votes = json.loads(votes_raw) if isinstance(votes_raw, str) else votes_raw
            culpable = [s for s, v in votes.items() if (isinstance(v, dict) and v.get("signal") == trade_dict.get("direction")) or v == trade_dict.get("direction")]
        except Exception:
            culpable = []

        # 1. Did it move substantially in profit before collapsing?
        entry = float(trade_dict.get("entry_price", 1.0))
        mfe_pct = mfe / entry if entry > 0 else 0.0

        if mfe_pct > 0.006:
            # Traveled at least 0.6% in profit then reversed
            category = "MOMENTUM_EXHAUSTION"
            notes = f"Trade reached significant profit (+{mfe:.1f}pts) but reversed sharply into stop before profit realization"
        elif "BREAKOUT" in regime or "BREAKDOWN" in regime:
            category = "FALSE_BREAKOUT"
            notes = f"Breakout failure in {regime} regime; immediate counter-trend trap"
        elif "HIGH_VOL" in regime:
            category = "VOLATILITY_WHIPSAW"
            notes = "Stopped out due to high-volatility spike exceeding normal noise boundaries"
        elif regime in ("SIDEWAYS", "TRANSITION") and "trend" in culpable:
            category = "REGIME_MISMATCH"
            notes = "Trend strategy entered in non-trending regime"
        else:
            category = "STRUCTURAL_INVALIDATION"
            notes = "Clear break of structural invalidation level"

        return FailureDiagnosis(
            trade_id=trade_id,
            failure_category=category,
            culpable_strategies=culpable,
            loss_usd=pnl,
            mfe_before_loss_pts=mfe,
            attribution_notes=notes,
        )

    def analyze_batch(self, losing_trades: list[dict]) -> dict:
        """Aggregate breakdown of failure categories across multiple losing trades."""
        diagnoses = [self.diagnose_trade(t) for t in losing_trades if t.get("pnl_usd", 0) < 0]
        category_counts: dict[str, int] = {}
        strategy_loss_counts: dict[str, int] = {}

        for d in diagnoses:
            category_counts[d.failure_category] = category_counts.get(d.failure_category, 0) + 1
            for s in d.culpable_strategies:
                strategy_loss_counts[s] = strategy_loss_counts.get(s, 0) + 1

        return {
            "total_failures_analyzed": len(diagnoses),
            "failure_categories": category_counts,
            "strategy_culpability_frequency": strategy_loss_counts,
            "detailed_diagnoses": [d.to_dict() for d in diagnoses[:20]],
        }
