"""
Backtest Performance Metrics — Computes institutional-grade statistics.
"""

from __future__ import annotations
from dataclasses import dataclass
import numpy as np


@dataclass
class PerformanceMetrics:
    total_trades: int
    winning_trades: int
    losing_trades: int
    win_rate: float
    total_pnl_usd: float
    total_return_pct: float
    profit_factor: float
    sharpe_ratio: float
    sortino_ratio: float
    max_drawdown_pct: float
    max_drawdown_usd: float
    expectancy_usd: float
    avg_win_usd: float
    avg_loss_usd: float
    payoff_ratio: float
    avg_holding_minutes: float
    avg_mfe_pts: float
    avg_mae_pts: float
    calmar_ratio: float = 0.0
    trades_per_day: float = 0.0

    def to_dict(self) -> dict:
        return {
            "total_trades": self.total_trades,
            "winning_trades": self.winning_trades,
            "losing_trades": self.losing_trades,
            "win_rate": round(self.win_rate, 4),
            "total_pnl_usd": round(self.total_pnl_usd, 2),
            "total_return_pct": round(self.total_return_pct, 4),
            "profit_factor": round(self.profit_factor, 2),
            "sharpe_ratio": round(self.sharpe_ratio, 2),
            "sortino_ratio": round(self.sortino_ratio, 2),
            "calmar_ratio": round(self.calmar_ratio, 2),
            "trades_per_day": round(self.trades_per_day, 2),
            "max_drawdown_pct": round(self.max_drawdown_pct, 4),
            "max_drawdown_usd": round(self.max_drawdown_usd, 2),
            "expectancy_usd": round(self.expectancy_usd, 2),
            "avg_win_usd": round(self.avg_win_usd, 2),
            "avg_loss_usd": round(self.avg_loss_usd, 2),
            "payoff_ratio": round(self.payoff_ratio, 2),
            "avg_holding_minutes": round(self.avg_holding_minutes, 1),
            "avg_mfe_pts": round(self.avg_mfe_pts, 2),
            "avg_mae_pts": round(self.avg_mae_pts, 2),
        }


def calculate_metrics(
    trades: list[dict],
    initial_balance: float = 10000.0,
    risk_free_rate: float = 0.0,
) -> PerformanceMetrics:
    if not trades:
        return PerformanceMetrics(0, 0, 0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0)

    pnls = [t.get("pnl_usd", 0.0) for t in trades]
    pnl_pcts = [t.get("pnl_pct", 0.0) for t in trades]
    durations = [t.get("holding_time_minutes", 0) for t in trades]
    mfes = [t.get("mfe_pts", 0.0) for t in trades]
    maes = [t.get("mae_pts", 0.0) for t in trades]

    total_trades = len(pnls)
    wins = [p for p in pnls if p > 0]
    losses = [p for p in pnls if p < 0]

    win_count = len(wins)
    loss_count = len(losses)
    win_rate = win_count / total_trades if total_trades > 0 else 0.0

    total_pnl = sum(pnls)
    total_return_pct = total_pnl / initial_balance

    gross_profit = sum(wins)
    gross_loss = abs(sum(losses))
    profit_factor = (gross_profit / gross_loss) if gross_loss > 0 else (999.0 if gross_profit > 0 else 0.0)

    avg_win = (gross_profit / win_count) if win_count > 0 else 0.0
    avg_loss = (gross_loss / loss_count) if loss_count > 0 else 0.0
    payoff_ratio = (avg_win / avg_loss) if avg_loss > 0 else 1.0
    expectancy = (win_rate * avg_win) - ((1.0 - win_rate) * avg_loss)

    # Equity curve and Max Drawdown
    equity = initial_balance
    peak = initial_balance
    max_dd_usd = 0.0
    max_dd_pct = 0.0
    for p in pnls:
        equity += p
        if equity > peak:
            peak = equity
        dd_usd = peak - equity
        dd_pct = dd_usd / peak if peak > 0 else 0.0
        if dd_usd > max_dd_usd:
            max_dd_usd = dd_usd
        if dd_pct > max_dd_pct:
            max_dd_pct = dd_pct

    # Annualised Sharpe & Sortino ratios using trades-per-year
    avg_holding_mins = float(np.mean(durations)) if durations else 15.0
    trades_per_year = (525_960 / max(avg_holding_mins, 1.0))  # minutes per year
    annualisation_factor = np.sqrt(trades_per_year)

    excess_returns = np.array(pnl_pcts) - risk_free_rate / trades_per_year
    if len(excess_returns) > 1 and np.std(excess_returns) > 1e-10:
        sharpe = float((np.mean(excess_returns) / (np.std(excess_returns) + 1e-10)) * annualisation_factor)
        neg_returns = excess_returns[excess_returns < 0]
        downside_std = float(np.std(neg_returns)) if len(neg_returns) > 1 else 1e-10
        sortino = float((np.mean(excess_returns) / downside_std) * annualisation_factor)
    else:
        sharpe = 0.0
        sortino = 0.0

    calmar = total_return_pct / max(abs(max_dd_pct), 0.001)
    trades_per_day = float(1440.0 / max(avg_holding_mins, 1.0)) if durations else 0.0

    return PerformanceMetrics(
        total_trades=total_trades,
        winning_trades=win_count,
        losing_trades=loss_count,
        win_rate=win_rate,
        total_pnl_usd=total_pnl,
        total_return_pct=total_return_pct,
        profit_factor=profit_factor,
        sharpe_ratio=sharpe,
        sortino_ratio=sortino,
        max_drawdown_pct=max_dd_pct,
        max_drawdown_usd=max_dd_usd,
        expectancy_usd=expectancy,
        avg_win_usd=avg_win,
        avg_loss_usd=avg_loss,
        payoff_ratio=payoff_ratio,
        avg_holding_minutes=avg_holding_mins if durations else 0.0,
        avg_mfe_pts=float(np.mean(mfes)) if mfes else 0.0,
        avg_mae_pts=float(np.mean(maes)) if maes else 0.0,
        calmar_ratio=calmar,
        trades_per_day=trades_per_day,
    )

