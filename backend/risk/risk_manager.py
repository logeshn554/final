"""
Risk Manager — Portfolio level protection, circuit breakers, and exposure limits.
"""

from __future__ import annotations
from dataclasses import dataclass
import time
import datetime
import logging

logger = logging.getLogger(__name__)


@dataclass
class RiskStatus:
    is_trading_allowed: bool
    current_drawdown_pct: float
    peak_balance: float
    current_balance: float
    daily_loss_pct: float
    circuit_breaker_active: bool
    consecutive_losses: int
    message: str

    def to_dict(self) -> dict:
        return {
            "is_trading_allowed": self.is_trading_allowed,
            "current_drawdown_pct": round(self.current_drawdown_pct, 4),
            "peak_balance": round(self.peak_balance, 2),
            "current_balance": round(self.current_balance, 2),
            "daily_loss_pct": round(self.daily_loss_pct, 4),
            "circuit_breaker_active": self.circuit_breaker_active,
            "consecutive_losses": self.consecutive_losses,
            "message": self.message,
        }


class PortfolioRiskManager:
    """Enforces safety rules: daily loss limits, drawdown brakes, consecutive loss cooldowns."""

    def __init__(
        self,
        max_drawdown_pct: float = 0.12,
        daily_loss_limit_pct: float = 0.04,
        max_consecutive_losses: int = 4,
        cooldown_seconds: int = 1800,
        initial_balance: float = 10000.0,
    ):
        self.max_drawdown_pct = max_drawdown_pct
        self.daily_loss_limit_pct = daily_loss_limit_pct
        self.max_consecutive_losses = max_consecutive_losses
        self.cooldown_seconds = cooldown_seconds

        self.peak_balance: float = initial_balance
        self.day_start_balance: float = initial_balance
        self.consecutive_losses: int = 0
        self.last_loss_time: float = 0.0
        self._current_day: str = datetime.date.today().isoformat()


    def _maybe_reset_day(self, current_balance: float):
        """Reset daily tracking benchmarks when calendar date rolls over (C4)."""
        today = datetime.date.today().isoformat()
        if today != self._current_day:
            self._current_day = today
            self.day_start_balance = current_balance
            self.consecutive_losses = 0
            logger.info(f"New trading day {today}. Day-start balance reset to {current_balance:.2f}")

    def reset_for_session(self, balance: float):
        """Explicitly reset state for a new session or test injection."""
        self.day_start_balance = balance
        self.peak_balance = max(self.peak_balance, balance)
        self.consecutive_losses = 0
        self._current_day = datetime.date.today().isoformat()

    def update_balance(self, current_balance: float):
        self._maybe_reset_day(current_balance)
        if current_balance > self.peak_balance:
            self.peak_balance = current_balance

    def record_trade_result(self, profit_usd: float, current_balance: float):
        self._maybe_reset_day(current_balance)
        self.update_balance(current_balance)
        if profit_usd < 0:
            self.consecutive_losses += 1
            self.last_loss_time = time.time()
        else:
            self.consecutive_losses = 0

    def check_risk(self, current_balance: float) -> RiskStatus:
        self._maybe_reset_day(current_balance)
        self.update_balance(current_balance)

        # Drawdown calculation
        dd = (self.peak_balance - current_balance) / max(self.peak_balance, 1.0)
        daily_loss = (self.day_start_balance - current_balance) / max(self.day_start_balance, 1.0)

        # 1. Max Drawdown Circuit Breaker
        if dd >= self.max_drawdown_pct:
            return RiskStatus(
                is_trading_allowed=False,
                current_drawdown_pct=dd,
                peak_balance=self.peak_balance,
                current_balance=current_balance,
                daily_loss_pct=daily_loss,
                circuit_breaker_active=True,
                consecutive_losses=self.consecutive_losses,
                message=f"Circuit Breaker: Max drawdown {dd:.1%} exceeded limit of {self.max_drawdown_pct:.1%}",
            )

        # 2. Daily Loss Limit
        if daily_loss >= self.daily_loss_limit_pct:
            return RiskStatus(
                is_trading_allowed=False,
                current_drawdown_pct=dd,
                peak_balance=self.peak_balance,
                current_balance=current_balance,
                daily_loss_pct=daily_loss,
                circuit_breaker_active=True,
                consecutive_losses=self.consecutive_losses,
                message=f"Daily Loss Limit hit ({daily_loss:.1%} >= {self.daily_loss_limit_pct:.1%})",
            )

        # 3. Consecutive loss cool-down
        if self.consecutive_losses >= self.max_consecutive_losses:
            elapsed = time.time() - self.last_loss_time
            if elapsed < self.cooldown_seconds:
                remaining = int(self.cooldown_seconds - elapsed)
                return RiskStatus(
                    is_trading_allowed=False,
                    current_drawdown_pct=dd,
                    peak_balance=self.peak_balance,
                    current_balance=current_balance,
                    daily_loss_pct=daily_loss,
                    circuit_breaker_active=False,
                    consecutive_losses=self.consecutive_losses,
                    message=f"Cool-down active after {self.consecutive_losses} losses ({remaining}s remaining)",
                )

        return RiskStatus(
            is_trading_allowed=True,
            current_drawdown_pct=dd,
            peak_balance=self.peak_balance,
            current_balance=current_balance,
            daily_loss_pct=daily_loss,
            circuit_breaker_active=False,
            consecutive_losses=self.consecutive_losses,
            message="Risk limits normal. Trading permitted.",
        )
