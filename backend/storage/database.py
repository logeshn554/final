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
        conn = sqlite3.connect(self.db_path)
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
