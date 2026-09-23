"""
SQLite Database Manager — Async and sync persistent logging of trades, signals, and performance.
"""

from __future__ import annotations
import sqlite3
import os
import json
import time
import logging
from storage.models import TradeRecord, SignalLog

logger = logging.getLogger(__name__)


class Database:
    """Manages SQLite storage for trades, signals, and regime-strategy performance tracking."""

    def __init__(self, db_path: str = "trades.db"):
        if not os.path.isabs(db_path):
            root_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
            self.db_path = os.path.join(root_dir, db_path)
        else:
            self.db_path = db_path
        self._init_db()

    def _get_conn(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.db_path, timeout=15.0)
        conn.execute("PRAGMA journal_mode=WAL;")
        conn.execute("PRAGMA busy_timeout=10000;")
        conn.row_factory = sqlite3.Row
        return conn

    def _init_db(self):
        """Create tables if they don't exist."""
        with self._get_conn() as conn:
            cursor = conn.cursor()

            cursor.execute("""
            CREATE TABLE IF NOT EXISTS trades (
                id TEXT PRIMARY KEY,
                symbol TEXT,
                direction TEXT,
                entry_price REAL,
                exit_price REAL,
                stop_price REAL,
                target_price REAL,
                size REAL,
                pnl_usd REAL,
                pnl_pct REAL,
                mfe_pts REAL,
                mae_pts REAL,
                regime_at_entry TEXT,
                exit_reason TEXT,
                holding_time_minutes INTEGER,
                strategy_votes TEXT,
                opened_at REAL,
                closed_at REAL
            )
            """)

            cursor.execute("""
            CREATE INDEX IF NOT EXISTS idx_trades_closed_at ON trades(closed_at);
            """)

            cursor.execute("""
            CREATE TABLE IF NOT EXISTS open_positions (
                id TEXT PRIMARY KEY,
                symbol TEXT,
                direction TEXT,
                entry_price REAL,
                stop_price REAL,
                target_price REAL,
                size REAL,
                notional_usd REAL,
                regime TEXT,
                strategy_votes TEXT,
                opened_at REAL,
                realized_pnl_usd REAL,
                initial_size REAL
            )
            """)

            cursor.execute("""
            CREATE TABLE IF NOT EXISTS signals (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                timestamp REAL,
                symbol TEXT,
                price REAL,
                signal TEXT,
                direction_score REAL,
                confidence REAL,
                regime TEXT,
                expected_move REAL,
                target_base REAL,
                stop_price REAL,
                reasons TEXT,
                contributing_strats TEXT
            )
            """)

            cursor.execute("""
            CREATE TABLE IF NOT EXISTS strategy_performance (
                strategy_name TEXT,
                regime TEXT,
                total_trades INTEGER,
                winning_trades INTEGER,
                win_rate REAL,
                total_pnl_usd REAL,
                PRIMARY KEY (strategy_name, regime)
            )
            """)

            cursor.execute("""
            CREATE TABLE IF NOT EXISTS strategy_paper_trades (
                id TEXT PRIMARY KEY,
                strategy_id TEXT,
                symbol TEXT,
                timestamp REAL,
                side TEXT,
                entry_price REAL,
                predicted_move REAL,
                predicted_target REAL,
                predicted_stop REAL,
                confidence REAL,
                regime TEXT,
                quantity REAL,
                fees REAL,
                slippage REAL,
                exit_price REAL,
                exit_timestamp REAL,
                pnl REAL,
                net_pnl REAL,
                return_pct REAL,
                holding_time REAL,
                exit_reason TEXT,
                successful INTEGER,
                loss_reason TEXT
            )
            """)

            cursor.execute("""
            CREATE TABLE IF NOT EXISTS strategy_health (
                strategy_id TEXT PRIMARY KEY,
                status TEXT,
                score REAL,
                confidence REAL,
                sample_size INTEGER,
                drawdown REAL,
                recent_win_rate REAL,
                updated_at REAL
            )
            """)
            # ─── Persistent Strategy Weights (Global Self-Evolving) ─────────
            cursor.execute("""
            CREATE TABLE IF NOT EXISTS strategy_weights (
                strategy_name TEXT PRIMARY KEY,
                base_weight   REAL NOT NULL DEFAULT 1.0,
                performance_history TEXT NOT NULL DEFAULT '[]',
                updated_at    REAL NOT NULL DEFAULT 0
            )
            """)

            cursor.execute("""
            CREATE TABLE IF NOT EXISTS delta_live_trades (
                id TEXT PRIMARY KEY,
                order_id TEXT,
                symbol TEXT,
                product_id INTEGER,
                direction TEXT,
                size INTEGER,
                entry_price REAL,
                take_profit_price REAL,
                stop_loss_price REAL,
                leverage INTEGER,
                status TEXT,
                created_at REAL
            )
            """)
            conn.commit()

    def save_weight_state(self, base_weights: dict, performance_history: dict) -> None:
        """Atomically persist ALL strategy base-weights and rolling performance history.

        Called every time any strategy outcome is recorded so the self-evolving
        weights survive engine restarts across all algorithms simultaneously.
        """
        import time as _time
        now = _time.time()
        try:
            with self._get_conn() as conn:
                for strat_name, base_w in base_weights.items():
                    history = performance_history.get(strat_name, [])
                    conn.execute("""
                    INSERT INTO strategy_weights (strategy_name, base_weight, performance_history, updated_at)
                    VALUES (?, ?, ?, ?)
                    ON CONFLICT(strategy_name) DO UPDATE SET
                        base_weight = excluded.base_weight,
                        performance_history = excluded.performance_history,
                        updated_at = excluded.updated_at
                    """, (strat_name, base_w, json.dumps(history), now))
                conn.commit()
                logger.debug("[WeightPersistence] Saved weights for %d strategies.", len(base_weights))
        except Exception as e:
            logger.error("[WeightPersistence] Failed to save weight state: %s", e)

    def load_weight_state(self) -> tuple[dict, dict] | None:
        """Load persisted strategy weights from the database.

        Returns:
            (base_weights, performance_history) or None if no data exists yet.
        """
        try:
            with self._get_conn() as conn:
                cursor = conn.cursor()
                cursor.execute("SELECT strategy_name, base_weight, performance_history FROM strategy_weights")
                rows = cursor.fetchall()
                if not rows:
                    return None
                base_weights: dict = {}
                performance_history: dict = {}
                for row in rows:
                    strat = row["strategy_name"]
                    base_weights[strat] = float(row["base_weight"])
                    try:
                        performance_history[strat] = json.loads(row["performance_history"])
                    except Exception:
                        performance_history[strat] = []
                logger.info(
                    "[WeightPersistence] Restored weights for: %s",
                    list(base_weights.keys())
                )
                return base_weights, performance_history
        except Exception as e:
            logger.error("[WeightPersistence] Failed to load weight state: %s", e)
            return None

    def record_trade(self, trade: TradeRecord):
        """Insert completed trade record."""
        try:
            with self._get_conn() as conn:
                conn.execute("""
                INSERT INTO trades VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """, (
                    trade.id, trade.symbol, trade.direction, trade.entry_price, trade.exit_price,
                    trade.stop_price, trade.target_price, trade.size, trade.pnl_usd, trade.pnl_pct,
                    trade.mfe_pts, trade.mae_pts, trade.regime_at_entry, trade.exit_reason,
                    trade.holding_time_minutes, trade.strategy_votes, trade.opened_at, trade.closed_at
                ))
                conn.commit()
        except Exception as e:
            logger.error(f"Failed to record trade: {e}")

    def log_signal(self, sig: SignalLog):
        """Record generated signal for audit and performance evaluation."""
        try:
            with self._get_conn() as conn:
                conn.execute("""
                INSERT INTO signals (timestamp, symbol, price, signal, direction_score, confidence, regime, expected_move, target_base, stop_price, reasons, contributing_strats)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """, (
                    sig.timestamp, sig.symbol, sig.price, sig.signal, sig.direction_score,
                    sig.confidence, sig.regime, sig.expected_move, sig.target_base,
                    sig.stop_price, sig.reasons, sig.contributing_strats
                ))
                conn.commit()
        except Exception as e:
            logger.error(f"Failed to log signal: {e}")

    def get_recent_trades(self, limit: int = 50) -> list[dict]:
        """Fetch latest completed trades."""
        with self._get_conn() as conn:
            cursor = conn.cursor()
            cursor.execute("SELECT * FROM trades ORDER BY closed_at DESC LIMIT ?", (limit,))
            return [dict(row) for row in cursor.fetchall()]

    def get_performance_summary(self) -> dict:
        """Compute aggregate performance statistics."""
        with self._get_conn() as conn:
            cursor = conn.cursor()
            cursor.execute("SELECT COUNT(*), SUM(pnl_usd), AVG(pnl_pct), SUM(CASE WHEN pnl_usd > 0 THEN 1 ELSE 0 END) FROM trades")
            row = cursor.fetchone()
            total_trades = row[0] or 0
            total_pnl = row[1] or 0.0
            avg_pnl_pct = row[2] or 0.0
            wins = row[3] or 0
            win_rate = (wins / total_trades) if total_trades > 0 else 0.0

            return {
                "total_trades": total_trades,
                "winning_trades": wins,
                "win_rate": round(win_rate, 4),
                "total_pnl_usd": round(total_pnl, 2),
                "avg_pnl_pct": round(avg_pnl_pct, 4),
            }

    def record_paper_trade(self, trade_data: dict):
        """Insert or update a strategy paper trade."""
        try:
            with self._get_conn() as conn:
                conn.execute("""
                INSERT OR REPLACE INTO strategy_paper_trades VALUES (
                    ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
                )
                """, (
                    trade_data.get("id"),
                    trade_data.get("strategy_id"),
                    trade_data.get("symbol", "ETHUSDT"),
                    trade_data.get("timestamp", 0.0),
                    trade_data.get("side", "HOLD"),
                    trade_data.get("entry_price", 0.0),
                    trade_data.get("predicted_move", 0.0),
                    trade_data.get("predicted_target", 0.0),
                    trade_data.get("predicted_stop", 0.0),
                    trade_data.get("confidence", 0.0),
                    trade_data.get("regime", "UNKNOWN"),
                    trade_data.get("quantity", 0.0),
                    trade_data.get("fees", 0.0),
                    trade_data.get("slippage", 0.0),
                    trade_data.get("exit_price", 0.0),
                    trade_data.get("exit_timestamp", 0.0),
                    trade_data.get("pnl", 0.0),
                    trade_data.get("net_pnl", 0.0),
                    trade_data.get("return_pct", 0.0),
                    trade_data.get("holding_time", 0.0),
                    trade_data.get("exit_reason", ""),
                    1 if trade_data.get("successful") else 0,
                    trade_data.get("loss_reason", "")
                ))
                conn.commit()
        except Exception as e:
            logger.error(f"Failed to record paper trade: {e}")

    def get_paper_trades(self, strategy_id: str | None = None, limit: int = 100) -> list[dict]:
        """Fetch latest paper trades, optionally filtered by strategy_id."""
        with self._get_conn() as conn:
            cursor = conn.cursor()
            if strategy_id:
                cursor.execute(
                    "SELECT * FROM strategy_paper_trades WHERE strategy_id = ? ORDER BY exit_timestamp DESC LIMIT ?",
                    (strategy_id, limit)
                )
            else:
                cursor.execute(
                    "SELECT * FROM strategy_paper_trades ORDER BY exit_timestamp DESC LIMIT ?",
                    (limit,)
                )
            return [dict(row) for row in cursor.fetchall()]

    def get_strategy_leaderboard(self) -> list[dict]:
        """Compute live strategy leaderboard from closed paper trades."""
        with self._get_conn() as conn:
            cursor = conn.cursor()
            cursor.execute("""
            SELECT 
                strategy_id,
                COUNT(*) as sample_size,
                SUM(CASE WHEN successful = 1 THEN 1 ELSE 0 END) as wins,
                SUM(CASE WHEN successful = 0 THEN 1 ELSE 0 END) as losses,
                SUM(net_pnl) as net_pnl,
                SUM(fees + slippage) as total_costs,
                AVG(return_pct) as avg_return,
                SUM(CASE WHEN net_pnl > 0 THEN net_pnl ELSE 0 END) as gross_profit,
                SUM(CASE WHEN net_pnl < 0 THEN ABS(net_pnl) ELSE 0 END) as gross_loss
            FROM strategy_paper_trades
            WHERE exit_timestamp > 0
            GROUP BY strategy_id
            """)
            rows = cursor.fetchall()
            
            leaderboard = []
            for row in rows:
                d = dict(row)
                sample = d["sample_size"]
                wins = d["wins"]
                win_rate = (wins / sample) if sample > 0 else 0.0
                gross_win = d["gross_profit"] or 0.0
                gross_loss = d["gross_loss"] or 0.0
                profit_factor = (gross_win / gross_loss) if gross_loss > 0 else (3.0 if gross_win > 0 else 1.0)
                
                # Minimum sample size shrinkage for score
                sample_penalty = min(1.0, sample / 30.0)
                score = round(max(0.0, min(1.0, (win_rate * 0.4 + (1.0 if d["net_pnl"] > 0 else 0.2) * 0.3 + min(profit_factor / 3.0, 1.0) * 0.3) * sample_penalty)), 4)
                
                status = "HEALTHY" if sample >= 30 and score >= 0.55 else ("INSUFFICIENT_DATA" if sample < 30 else ("WATCH" if score >= 0.40 else "DEGRADED"))

                leaderboard.append({
                    "strategy_id": d["strategy_id"],
                    "sample_size": sample,
                    "wins": wins,
                    "losses": d["losses"],
                    "win_rate": round(win_rate, 4),
                    "net_pnl": round(d["net_pnl"] or 0.0, 2),
                    "total_costs": round(d["total_costs"] or 0.0, 4),
                    "profit_factor": round(profit_factor, 2),
                    "score": score,
                    "status": status,
                    "reliable": sample >= 30
                })

            leaderboard.sort(key=lambda x: x["score"], reverse=True)
            for idx, item in enumerate(leaderboard, 1):
                item["rank"] = idx

            return leaderboard

    def get_regime_performance(self) -> dict:
        """Fetch regime x strategy performance breakdown."""
        with self._get_conn() as conn:
            cursor = conn.cursor()
            cursor.execute("""
            SELECT regime, strategy_id, COUNT(*) as trades, SUM(net_pnl) as net_pnl, AVG(successful) as win_rate
            FROM strategy_paper_trades
            WHERE exit_timestamp > 0
            GROUP BY regime, strategy_id
            """)
            breakdown = {}
            for row in cursor.fetchall():
                r = dict(row)
                reg = r["regime"] or "UNKNOWN"
                if reg not in breakdown:
                    breakdown[reg] = {}
                breakdown[reg][r["strategy_id"]] = {
                    "trades": r["trades"],
                    "net_pnl": round(r["net_pnl"] or 0.0, 2),
                    "win_rate": round(r["win_rate"] or 0.0, 4)
                }
            return breakdown

    # ─── Open Positions (Crash Recovery / M4) ───────────────────────────

    def save_open_position(self, pos_data: dict) -> None:
        """Persist currently active position to SQLite for restart recovery."""
        try:
            with self._get_conn() as conn:
                conn.execute("""
                INSERT OR REPLACE INTO open_positions (
                    id, symbol, direction, entry_price, stop_price, target_price,
                    size, notional_usd, regime, strategy_votes, opened_at,
                    realized_pnl_usd, initial_size
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """, (
                    pos_data["id"], pos_data["symbol"], pos_data["direction"],
                    pos_data["entry_price"], pos_data.get("current_stop", pos_data.get("stop_price", 0.0)),
                    pos_data["target_price"], pos_data["size"], pos_data["notional_usd"],
                    pos_data.get("regime_at_entry", pos_data.get("regime", "UNKNOWN")),
                    json.dumps(pos_data.get("strategy_votes", {})) if isinstance(pos_data.get("strategy_votes"), dict) else str(pos_data.get("strategy_votes", "{}")),
                    pos_data.get("opened_at", 0.0),
                    pos_data.get("realized_pnl_usd", 0.0),
                    pos_data.get("initial_size", pos_data["size"]),
                ))
                conn.commit()
        except Exception as e:
            logger.error(f"Failed to save open position: {e}")

    def delete_open_position(self, pos_id: str) -> None:
        """Remove closed position from active positions table."""
        try:
            with self._get_conn() as conn:
                conn.execute("DELETE FROM open_positions WHERE id = ?", (pos_id,))
                conn.commit()
        except Exception as e:
            logger.error(f"Failed to delete open position: {e}")

    def load_open_position(self) -> dict | None:
        """Load any unrestored open position after crash/restart."""
        try:
            with self._get_conn() as conn:
                cursor = conn.cursor()
                cursor.execute("SELECT * FROM open_positions ORDER BY opened_at DESC LIMIT 1")
                row = cursor.fetchone()
                if not row:
                    return None
                d = dict(row)
                if isinstance(d.get("strategy_votes"), str):
                    try:
                        d["strategy_votes"] = json.loads(d["strategy_votes"])
                    except Exception:
                        pass
                return d
        except Exception as e:
            logger.error(f"Failed to load open position: {e}")
            return None

    # ─── Async Database Support (C6) ────────────────────────────────────

    async def init_async(self) -> None:
        """Async schema initialization via aiosqlite."""
        try:
            import aiosqlite
            async with aiosqlite.connect(self.db_path) as db:
                await db.execute("PRAGMA journal_mode=WAL;")
                await db.execute("PRAGMA busy_timeout=10000;")
                await db.commit()
        except ImportError:
            pass

    async def record_trade_async(self, trade: TradeRecord) -> None:
        """Async record trade to prevent event-loop starvation."""
        import asyncio
        await asyncio.to_thread(self.record_trade, trade)

    async def log_signal_async(self, sig: SignalLog) -> None:
        """Async record signal to prevent event-loop starvation."""
        import asyncio
        await asyncio.to_thread(self.log_signal, sig)

    def log_delta_trade(self, data: dict) -> None:
        """Record a live Delta Exchange order execution."""
        try:
            with self._get_conn() as conn:
                cursor = conn.cursor()
                cursor.execute(
                    """
                    INSERT OR REPLACE INTO delta_live_trades (
                        id, order_id, symbol, product_id, direction, size,
                        entry_price, take_profit_price, stop_loss_price, leverage, status, created_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        str(data.get("id") or data.get("order_id") or time.time()),
                        str(data.get("order_id", "")),
                        str(data.get("symbol", "ETHUSD")),
                        int(data.get("product_id", 3136)),
                        str(data.get("side", data.get("direction", "BUY"))).upper(),
                        int(data.get("size", 1)),
                        float(data.get("entry_price", 0.0)),
                        float(data.get("take_profit_price", 0.0)),
                        float(data.get("stop_loss_price", 0.0)),
                        int(data.get("leverage", 10)),
                        str(data.get("status", "executed")),
                        float(data.get("timestamp", time.time())),
                    ),
                )
                conn.commit()
        except Exception as e:
            logger.error(f"Failed to log Delta trade: {e}")

    def get_delta_trade_count(self) -> int:
        """Count total completed live trades on Delta Exchange."""
        try:
            with self._get_conn() as conn:
                cursor = conn.cursor()
                cursor.execute("SELECT COUNT(*) FROM delta_live_trades WHERE status = 'executed'")
                row = cursor.fetchone()
                return int(row[0]) if row else 0
        except Exception as e:
            logger.error(f"Failed to get Delta trade count: {e}")
            return 0



