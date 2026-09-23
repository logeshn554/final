"""
Production Structured Logging — Rotating file handler, optional JSON formatting, and trace contexts.
"""

from __future__ import annotations
import logging
import os
import sys
import json
import time
import contextvars
from collections import deque
from logging.handlers import RotatingFileHandler
from typing import Any, Optional

# ContextVar for tracing trade_id and symbol across execution logs (M1)
trade_ctx: contextvars.ContextVar[dict] = contextvars.ContextVar("trade_ctx", default={})
recent_logs_buffer: deque[dict] = deque(maxlen=300)


class StructuredLogger(logging.LoggerAdapter):
    """Logger adapter that automatically injects current trade context."""

    def process(self, msg: Any, kwargs: Any) -> tuple[Any, Any]:
        ctx = trade_ctx.get({})
        extra = kwargs.get("extra", {})
        if isinstance(extra, dict):
            extra.update(ctx)
        else:
            extra = dict(ctx)
        kwargs["extra"] = extra
        return msg, kwargs


class JSONFormatter(logging.Formatter):
    """Formats log records as single-line JSON with context correlation."""

    def format(self, record: logging.LogRecord) -> str:
        ctx = trade_ctx.get({})
        log_data = {
            "timestamp": self.formatTime(record, self.datefmt),
            "level": record.levelname,
            "logger": record.name,
            "message": record.getMessage(),
            "module": record.module,
            "line": record.lineno,
        }
        if ctx:
            log_data.update(ctx)
        if hasattr(record, "extra") and isinstance(record.extra, dict):
            log_data.update(record.extra)
        if record.exc_info:
            log_data["exception"] = self.formatException(record.exc_info)

        recent_logs_buffer.append(log_data)
        return json.dumps(log_data)


def get_recent_logs(limit: int = 50, trade_id: Optional[str] = None) -> list[dict]:
    """Return latest structured logs, optionally filtered by trade_id."""
    logs = list(recent_logs_buffer)
    if trade_id:
        logs = [l for l in logs if l.get("trade_id") == trade_id]
    return logs[-limit:]



def setup_logger(
    name: str = "trading_engine",
    level: str = "INFO",
    log_dir: str = "logs",
    log_json: bool = False,
) -> logging.Logger:
    """Configures a thread-safe, rotating logger for production."""
    logger = logging.getLogger(name)
    logger.setLevel(getattr(logging, level.upper(), logging.INFO))

    # Prevent duplicate handlers
    if logger.handlers:
        return logger

    # Ensure log directory exists
    os.makedirs(log_dir, exist_ok=True)

    # 1. Console Handler
    console_handler = logging.StreamHandler(sys.stdout)
    if log_json:
        console_handler.setFormatter(JSONFormatter())
    else:
        fmt = logging.Formatter(
            "%(asctime)s [%(levelname)s] [%(name)s:%(lineno)d] %(message)s",
            datefmt="%Y-%m-%d %H:%M:%S",
        )
        console_handler.setFormatter(fmt)
    logger.addHandler(console_handler)

    # 2. Rotating File Handler (Max 20MB per file, keep 5 backups)
    log_file = os.path.join(log_dir, "engine.log")
    file_handler = RotatingFileHandler(
        log_file,
        maxBytes=20 * 1024 * 1024,
        backupCount=5,
        encoding="utf-8",
    )
    if log_json:
        file_handler.setFormatter(JSONFormatter())
    else:
        file_handler.setFormatter(fmt)
    logger.addHandler(file_handler)

    return logger
