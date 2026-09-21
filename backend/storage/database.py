"""
SQLite Database Manager — Async and sync persistent logging of trades, signals, and performance.
"""

from __future__ import annotations
import sqlite3
import os
import json
import logging
from storage.models import TradeRecord, SignalLog

logger = logging.getLogger(__name__)


class Database:
    """Manages SQLite storage for trades, signals, and regime-strategy performance tracking."""

    def __init__(self, db_path: str = "trades.db"):
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
            conn.commit()

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

