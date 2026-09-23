"""
Storage Models — Dataclasses and schemas for SQLite trade and engine logging.
"""

from __future__ import annotations
from dataclasses import dataclass, field, asdict
import time


@dataclass
class TradeRecord:
    id: str
    symbol: str
    direction: str              # "BUY" | "SELL"
    entry_price: float
    exit_price: float
    stop_price: float
    target_price: float
    size: float
    pnl_usd: float
    pnl_pct: float
    mfe_pts: float              # Max favorable excursion during trade
    mae_pts: float              # Max adverse excursion during trade
    regime_at_entry: str
    exit_reason: str            # "DYNAMIC_TP", "TRAILING_STOP", "INVALIDATION_STOP", "MANUAL"
    holding_time_minutes: int
    strategy_votes: str         # JSON string of strategy signals
    opened_at: float = field(default_factory=time.time)
    closed_at: float = field(default_factory=time.time)

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass
class SignalLog:
    timestamp: float
    symbol: str
    price: float
    signal: str                 # "BUY" | "SELL" | "HOLD"
    direction_score: float
    confidence: float
    regime: str
    expected_move: float
    target_base: float
    stop_price: float
    reasons: str
    contributing_strats: str
