"""
Alert Notifier — Asynchronous dispatch to Webhooks, Telegram, Discord, and Slack.
"""

from __future__ import annotations
import asyncio
import logging
import json
import httpx
from typing import Optional, Dict, Any

logger = logging.getLogger(__name__)


class AlertNotifier:
    """Dispatches trade and signal alerts to external endpoints."""

    def __init__(
        self,
        webhook_url: Optional[str] = None,
        telegram_token: Optional[str] = None,
        telegram_chat_id: Optional[str] = None,
        min_confidence: float = 0.55,
        min_alert_interval_seconds: float = 120.0,
    ):
        self.webhook_url = webhook_url
        self.telegram_token = telegram_token
        self.telegram_chat_id = telegram_chat_id
        self.min_confidence = min_confidence
        self.min_alert_interval_seconds = min_alert_interval_seconds
        self._last_alert_time: float = 0.0
        self._last_signal_sent: str = ""

    async def notify_signal(self, decision: dict):
        """Send notification when a confident BUY or SELL signal is issued."""
        signal = decision.get("signal", "HOLD")
        confidence = decision.get("confidence", 0.0)

        if signal not in ("BUY", "SELL") or confidence < self.min_confidence:
            return

        now = time.time()
        if (now - self._last_alert_time) < self.min_alert_interval_seconds:
            logger.debug(f"Alert suppressed (cooldown {self.min_alert_interval_seconds}s). Last alert {now - self._last_alert_time:.0f}s ago.")
            return

        if signal == self._last_signal_sent:
            logger.debug(f"Alert suppressed (duplicate direction '{signal}').")
            return

        self._last_alert_time = now
        self._last_signal_sent = signal

        symbol = decision.get("symbol", "ETHUSDT")
        price = decision.get("entry_price", 0.0)
        tp_base = decision.get("dynamic_take_profit", {}).get("base_target", 0.0)
        stop = decision.get("stop_loss", {}).get("stop_price", 0.0)
        rr = decision.get("risk_reward_ratio", 0.0)
        reason = decision.get("reason", "")

        msg = (
            f"🚨 *{symbol} {signal} SIGNAL* 🚨\n"
            f"• *Entry:* ${price:,.2f}\n"
            f"• *Target (Base):* ${tp_base:,.2f}\n"
            f"• *Stop-Loss:* ${stop:,.2f}\n"
            f"• *Confidence:* {confidence:.1%}\n"
            f"• *Market R:R:* {rr:.2f}\n"
            f"• *Reason:* {reason}"
        )

        tasks = []
        if self.webhook_url:
            tasks.append(self._send_webhook(self.webhook_url, decision))
        if self.telegram_token and self.telegram_chat_id:
            tasks.append(self._send_telegram(msg))

        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)

    async def notify_trade_closed(self, trade: dict):
        """Send notification when a position closes with PnL summary (no rate limit)."""
        symbol = trade.get("symbol", "ETHUSDT")
        direction = trade.get("direction", "")
        pnl_usd = trade.get("pnl_usd", 0.0)
        pnl_pct = trade.get("pnl_pct", 0.0)
        exit_reason = trade.get("exit_reason", "")
        entry_price = trade.get("entry_price", 0.0)
        exit_price = trade.get("exit_price", 0.0)

        emoji = "🟢" if pnl_usd >= 0 else "🔴"
        msg = (
            f"{emoji} *{symbol} TRADE CLOSED ({direction})* {emoji}\n"
            f"• *PnL:* ${pnl_usd:+,.2f} ({pnl_pct:+.2%})\n"
            f"• *Entry:* ${entry_price:,.2f} → *Exit:* ${exit_price:,.2f}\n"
            f"• *Reason:* {exit_reason}"
        )

        tasks = []
        if self.webhook_url:
            tasks.append(self._send_webhook(self.webhook_url, {"event": "trade_closed", "data": trade}))
        if self.telegram_token and self.telegram_chat_id:
            tasks.append(self._send_telegram(msg))

        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)


    async def _send_webhook(self, url: str, payload: dict):
        try:
            async with httpx.AsyncClient(timeout=5) as client:
                resp = await client.post(url, json=payload)
                resp.raise_for_status()
                logger.info(f"Alert webhook delivered: {resp.status_code}")
        except Exception as e:
            logger.warning(f"Failed to post alert webhook: {e}")

    async def _send_telegram(self, text: str):
        try:
            url = f"https://api.telegram.org/bot{self.telegram_token}/sendMessage"
            payload = {
                "chat_id": self.telegram_chat_id,
                "text": text,
                "parse_mode": "Markdown",
            }
            async with httpx.AsyncClient(timeout=5) as client:
                resp = await client.post(url, json=payload)
                resp.raise_for_status()
                logger.info("Telegram alert delivered successfully")
        except Exception as e:
            logger.warning(f"Failed to send Telegram alert: {e}")
