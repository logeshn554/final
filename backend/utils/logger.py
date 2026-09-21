"""
Production Structured Logging — Rotating file handler, optional JSON formatting, and trace contexts.
"""

from __future__ import annotations
import logging
import os
import sys
import json
import time
from logging.handlers import RotatingFileHandler
from typing import Any


class JSONFormatter(logging.Formatter):
    """Formats log records as single-line JSON for log aggregators (ELK, CloudWatch, Datadog)."""

    def format(self, record: logging.LogRecord) -> str:
        log_data = {
            "timestamp": self.formatTime(record, self.datefmt),
            "level": record.levelname,
            "logger": record.name,
            "message": record.getMessage(),
            "module": record.module,
            "line": record.lineno,
        }
        if hasattr(record, "extra") and isinstance(record.extra, dict):
            log_data.update(record.extra)
        if record.exc_info:
            log_data["exception"] = self.formatException(record.exc_info)
        return json.dumps(log_data)


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
