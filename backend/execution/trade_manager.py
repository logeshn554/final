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
from risk.risk_manager import PortfolioRiskManager
from utils.logger import trade_ctx

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
    realized_pnl_usd: float = 0.0      # Cumulative realized PnL from partials (C2)
    initial_size: float = 0.0          # Original size before any partials (C2)

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "symbol": self.symbol,
            "direction": self.direction,
            "entry_price": self.entry_price,
            "current_stop": self.current_stop,
            "target_price": self.target_price,
            "size": self.size,
            "notional_usd": self.notional_usd,
            "regime_at_entry": self.regime_at_entry,
            "strategy_votes": self.strategy_votes,
            "opened_at": self.opened_at,
            "bars_held": self.bars_held,
            "highest_price_seen": self.highest_price_seen,
            "lowest_price_seen": self.lowest_price_seen,
            "max_favorable_pts": self.max_favorable_pts,
            "max_adverse_pts": self.max_adverse_pts,
            "is_partial_closed": self.is_partial_closed,
            "realized_pnl_usd": self.realized_pnl_usd,
            "initial_size": self.initial_size,
        }


class TradeManager:
    """Simulated trade execution and lifecycle tracking manager."""

    def __init__(
        self,
        database: Database,
        mfe_mae_engine: MFEMAEEngine,
        exit_engine: DynamicExitEngine,
        reversal_engine: ReversalEngine,
        weight_engine: StrategyWeightEngine,
        risk_manager: PortfolioRiskManager | None = None,
        initial_balance: float = 10000.0,
    ):
        self.db = database
        self.mfe_mae_engine = mfe_mae_engine
        self.exit_engine = exit_engine
        self.reversal_engine = reversal_engine
        self.weight_engine = weight_engine
        self.risk_manager = risk_manager
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
            realized_pnl_usd=0.0,
            initial_size=size,
        )
        self.active_position = pos

        # Structured logging context (M1)
        trade_ctx.set({"trade_id": pos.id, "symbol": pos.symbol})

        # Persist to database for crash recovery (M4)
        self.db.save_open_position(pos.to_dict())

        # Wire Prometheus metrics (L3)
        try:
            from utils.metrics import signals_total, account_balance
            if signals_total is not None:
                signals_total.labels(signal=direction, regime=regime).inc()
            if account_balance is not None:
                account_balance.set(self.account_balance)
        except Exception:
            pass

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
            self.db.save_open_position(pos.to_dict())

        elif decision.action == "PARTIAL_TP" and not pos.is_partial_closed:
            # Realize partial profit without double-crediting balance (C2)
            pos.is_partial_closed = True
            partial_size = pos.size * decision.exit_fraction
            fee = (current_price * partial_size) * 0.0004
            pnl = ((current_price - pos.entry_price) if is_long else (pos.entry_price - current_price)) * partial_size - fee

            pos.realized_pnl_usd += pnl
            # Do NOT add to self.account_balance here — deferred to close_position (single settlement)
            pos.size -= partial_size
            pos.notional_usd -= (pos.notional_usd * decision.exit_fraction)
            if decision.new_trailing_stop:
                pos.current_stop = decision.new_trailing_stop

            self.db.save_open_position(pos.to_dict())
            logger.info(f"Position #{pos.id} PARTIAL_TP: locked ${pnl:.2f} (cum_partial: ${pos.realized_pnl_usd:.2f}), remaining size: {pos.size:.4f}")

        elif decision.action == "FULL_EXIT":
            self.close_position(current_price, decision.reason)

        return decision

    def close_position(self, exit_price: float, exit_reason: str) -> TradeRecord:
        pos = self.active_position
        if pos is None:
            raise ValueError("No active position to close")

        is_long = pos.direction.upper() in ("BUY", "LONG")
        pnl_pts = (exit_price - pos.entry_price) if is_long else (pos.entry_price - exit_price)
        remaining_fee = (exit_price * pos.size) * 0.0004
        remaining_pnl = (pnl_pts * pos.size) - remaining_fee

        # Single credit of net PnL (realized from partials + remaining leg) (C2)
        total_pnl_usd = pos.realized_pnl_usd + remaining_pnl
        init_size = pos.initial_size if pos.initial_size > 0 else pos.size
        initial_notional = pos.entry_price * init_size
        pnl_pct = total_pnl_usd / initial_notional if initial_notional > 0 else 0.0

        self.account_balance += total_pnl_usd
        duration_mins = max(int((time.time() - pos.opened_at) / 60), 1)

        trade = TradeRecord(
            id=pos.id,
            symbol=pos.symbol,
            direction=pos.direction,
            entry_price=pos.entry_price,
            exit_price=exit_price,
            stop_price=pos.current_stop,
            target_price=pos.target_price,
            size=init_size,
            pnl_usd=total_pnl_usd,
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
        was_win = total_pnl_usd > 0
        for strat_name, vote in pos.strategy_votes.items():
            if isinstance(vote, dict):
                vote_sig = vote.get("signal")
            else:
                vote_sig = getattr(vote, "signal", None)
            if vote_sig == pos.direction:
                self.weight_engine.record_outcome(strat_name, was_win, db=self.db)

        # 3. Inform PortfolioRiskManager of trade outcome (circuit breakers & consecutive losses)
        if self.risk_manager is not None:
            self.risk_manager.record_trade_result(total_pnl_usd, self.account_balance)

        # 4. Persist to database & clean up open_positions table (M4)
        self.db.record_trade(trade)
        self.db.delete_open_position(pos.id)
        self.closed_trades.append(trade)
        self.active_position = None

        # Wire Prometheus metrics (L3)
        try:
            from utils.metrics import trades_total, trade_pnl, account_balance
            if trades_total is not None:
                trades_total.labels(direction=pos.direction, exit_reason=exit_reason).inc()
            if trade_pnl is not None:
                trade_pnl.observe(total_pnl_usd)
            if account_balance is not None:
                account_balance.set(self.account_balance)
        except Exception:
            pass

        # Reset trace context (M1)
        trade_ctx.set({})


        logger.info(f"Closed #{trade.id} at {exit_price:.2f} ({exit_reason}) | Total PnL: ${total_pnl_usd:+.2f} ({pnl_pct:+.2%})")
        return trade

    def restore_position(self, record: dict) -> ActivePosition:
        """Restore position from crash recovery state (M4)."""
        pos = ActivePosition(
            id=record["id"],
            symbol=record["symbol"],
            direction=record["direction"],
            entry_price=float(record["entry_price"]),
            current_stop=float(record.get("stop_price") or record.get("current_stop", 0.0)),
            target_price=float(record["target_price"]),
            size=float(record["size"]),
            notional_usd=float(record["notional_usd"]),
            regime_at_entry=record.get("regime", record.get("regime_at_entry", "UNKNOWN")),
            strategy_votes=record.get("strategy_votes", {}),
            opened_at=float(record.get("opened_at", time.time())),
            realized_pnl_usd=float(record.get("realized_pnl_usd", 0.0)),
            initial_size=float(record.get("initial_size", record["size"])),
        )
        self.active_position = pos
        trade_ctx.set({"trade_id": pos.id, "symbol": pos.symbol})
        logger.warning(f"Restored open position #{pos.id} from crash recovery: {pos.direction} {pos.size:.4f} @ {pos.entry_price:.2f}")
        return pos
