"""
Trade Manager — Manages trade lifecycle (open, monitor, trail stop, partial exit, close)
and updates MFE/MAE and strategy weighting feedback loops.
"""

from __future__ import annotations
from dataclasses import dataclass, field
import time
import uuid
import json
import logging
import pandas as pd

from storage.models import TradeRecord
from storage.database import Database
from prediction.mfe_mae import MFEMAEEngine
from prediction.reversal_engine import ReversalEngine
from ensemble.weighting import StrategyWeightEngine
from risk.exit_engine import DynamicExitEngine, ExitDecision
from risk.position_sizing import DynamicPositionSizer

logger = logging.getLogger(__name__)


@dataclass
class ActivePosition:
    id: str
    symbol: str
    direction: str                     # "BUY" | "SELL"
    entry_price: float
    current_stop: float
    target_price: float
    size: float
    notional_usd: float
    regime_at_entry: str
    strategy_votes: dict
    opened_at: float
    bars_held: int = 0
    highest_price_seen: float = 0.0
    lowest_price_seen: float = 0.0
    max_favorable_pts: float = 0.0
    max_adverse_pts: float = 0.0
    is_partial_closed: bool = False


class TradeManager:
    """Simulated trade execution and lifecycle tracking manager."""

    def __init__(
        self,
        database: Database,
        mfe_mae_engine: MFEMAEEngine,
        exit_engine: DynamicExitEngine,
        reversal_engine: ReversalEngine,
        weight_engine: StrategyWeightEngine,
        initial_balance: float = 10000.0,
    ):
        self.db = database
        self.mfe_mae_engine = mfe_mae_engine
        self.exit_engine = exit_engine
        self.reversal_engine = reversal_engine
        self.weight_engine = weight_engine
        self.account_balance = initial_balance
        self.active_position: ActivePosition | None = None
        self.closed_trades: list[TradeRecord] = []

    def open_position(
        self,
        symbol: str,
        direction: str,
        entry_price: float,
        stop_price: float,
        target_price: float,
        notional_usd: float,
        regime: str,
        strategy_votes: dict,
    ) -> ActivePosition | None:
        if self.active_position is not None:
            # Already have an open position
            return None

        size = notional_usd / entry_price if entry_price > 0 else 0.0
        pos = ActivePosition(
            id=str(uuid.uuid4())[:8],
            symbol=symbol,
            direction=direction,
            entry_price=entry_price,
            current_stop=stop_price,
            target_price=target_price,
            size=size,
            notional_usd=notional_usd,
            regime_at_entry=regime,
            strategy_votes=strategy_votes,
            opened_at=time.time(),
            highest_price_seen=entry_price,
            lowest_price_seen=entry_price,
        )
        self.active_position = pos
        logger.info(f"Opened {direction} position #{pos.id} at {entry_price:.2f}, target={target_price:.2f}, stop={stop_price:.2f}")
        return pos

    def on_price_update(
        self,
        current_price: float,
        df: pd.DataFrame,
    ) -> ExitDecision | None:
        pos = self.active_position
        if pos is None:
            return None

        pos.bars_held += 1
        is_long = pos.direction.upper() in ("BUY", "LONG")

        # Update high/low marks and MFE/MAE
        pos.highest_price_seen = max(pos.highest_price_seen, current_price)
        pos.lowest_price_seen = min(pos.lowest_price_seen, current_price)

        if is_long:
            fav_pts = pos.highest_price_seen - pos.entry_price
            adv_pts = pos.entry_price - pos.lowest_price_seen
        else:
            fav_pts = pos.entry_price - pos.lowest_price_seen
            adv_pts = pos.highest_price_seen - pos.entry_price

        pos.max_favorable_pts = max(pos.max_favorable_pts, max(fav_pts, 0.0))
        pos.max_adverse_pts = max(pos.max_adverse_pts, max(adv_pts, 0.0))

        # Reversal evaluation
        reversal = self.reversal_engine.assess(df, current_price, pos.direction)

        # Dynamic exit evaluation
        decision = self.exit_engine.evaluate_exit(
            position_direction=pos.direction,
            entry_price=pos.entry_price,
            current_price=current_price,
            current_stop=pos.current_stop,
            target_price=pos.target_price,
            reversal=reversal,
            df=df,
            bars_held=pos.bars_held,
        )

        if decision.action == "TRAIL_STOP_UPDATE" and decision.new_trailing_stop:
            pos.current_stop = decision.new_trailing_stop

        elif decision.action == "PARTIAL_TP" and not pos.is_partial_closed:
            # Realize partial profit
            pos.is_partial_closed = True
            partial_size = pos.size * decision.exit_fraction
            pnl = (current_price - pos.entry_price) * partial_size if is_long else (pos.entry_price - current_price) * partial_size
            self.account_balance += pnl
            pos.size -= partial_size
            pos.notional_usd -= (pos.notional_usd * decision.exit_fraction)
            if decision.new_trailing_stop:
                pos.current_stop = decision.new_trailing_stop

        elif decision.action == "FULL_EXIT":
            self.close_position(current_price, decision.reason)

        return decision

    def close_position(self, exit_price: float, exit_reason: str) -> TradeRecord:
        pos = self.active_position
        if pos is None:
            raise ValueError("No active position to close")

        is_long = pos.direction.upper() in ("BUY", "LONG")
        pnl_pts = (exit_price - pos.entry_price) if is_long else (pos.entry_price - exit_price)
        pnl_usd = pnl_pts * pos.size
        pnl_pct = pnl_pts / pos.entry_price if pos.entry_price > 0 else 0.0

        self.account_balance += pnl_usd
        duration_mins = max(int((time.time() - pos.opened_at) / 60), 1)

        trade = TradeRecord(
            id=pos.id,
            symbol=pos.symbol,
            direction=pos.direction,
            entry_price=pos.entry_price,
            exit_price=exit_price,
            stop_price=pos.current_stop,
            target_price=pos.target_price,
            size=pos.size,
            pnl_usd=pnl_usd,
            pnl_pct=pnl_pct,
            mfe_pts=pos.max_favorable_pts,
            mae_pts=pos.max_adverse_pts,
            regime_at_entry=pos.regime_at_entry,
            exit_reason=exit_reason,
            holding_time_minutes=duration_mins,
            strategy_votes=json.dumps(pos.strategy_votes),
            opened_at=pos.opened_at,
            closed_at=time.time(),
        )

        # 1. Update empirical MFE/MAE engine
        self.mfe_mae_engine.record_trade_excursion(
            regime=pos.regime_at_entry,
            mfe_pts=pos.max_favorable_pts,
            mae_pts=pos.max_adverse_pts,
        )

        # 2. Feed performance back to strategy weighting engine
        was_win = pnl_usd > 0
        for strat_name, vote in pos.strategy_votes.items():
            if isinstance(vote, dict):
                vote_sig = vote.get("signal")
            else:
                vote_sig = getattr(vote, "signal", None)
            if vote_sig == pos.direction:
                self.weight_engine.record_outcome(strat_name, was_win)

        # 3. Persist to database
        self.db.record_trade(trade)
        self.closed_trades.append(trade)
        self.active_position = None

        logger.info(f"Closed #{trade.id} at {exit_price:.2f} ({exit_reason}) | PnL: ${pnl_usd:+.2f} ({pnl_pct:+.2%})")
        return trade
