"""
Production Configuration Manager — Validates environment variables, YAML config, and secrets.
"""

from __future__ import annotations
import os
import yaml
from typing import List, Optional
from pydantic import BaseModel, Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class BinanceSettings(BaseModel):
    rest_urls: List[str] = [
        "https://data-api.binance.vision",
        "https://api.binance.com",
        "https://api1.binance.com",
        "https://api2.binance.com",
    ]
    ws_urls: List[str] = [
        "wss://stream.binance.com:443/ws",
        "wss://stream.binance.com:9443/ws",
        "wss://data-stream.binance.vision/ws",
    ]
    request_timeout: int = 10
    max_retries: int = 4
    rate_limit_pause: float = 0.25
    api_key: Optional[str] = None
    api_secret: Optional[str] = None


class RiskSettings(BaseModel):
    max_portfolio_risk_pct: float = 2.0
    max_position_pct: float = 15.0
    max_daily_loss_pct: float = 4.0
    max_drawdown_pct: float = 12.0
    max_concurrent_positions: int = 1
    kelly_fraction_cap: float = 0.25
    fee_pct: float = 0.04
    slippage_ticks: int = 1


class AlertSettings(BaseModel):
    enabled: bool = False
    webhook_url: Optional[str] = None
    telegram_bot_token: Optional[str] = None
    telegram_chat_id: Optional[str] = None
    min_confidence_to_alert: float = 0.55


class AppSettings(BaseSettings):
    """Central typed settings for institutional production deployment."""
    symbol: str = "ETHUSDT"
    timeframes: List[str] = ["1m", "5m", "15m", "1h"]
    candle_buffer_size: int = 1000
    env: str = Field(default="production", validation_alias="APP_ENV")
    host: str = Field(default="0.0.0.0", validation_alias="HOST")
    port: int = Field(default=8000, validation_alias="PORT")
    api_auth_token: Optional[str] = Field(default=None, validation_alias="API_AUTH_TOKEN")
    cors_origins: List[str] = ["*"]
    database_path: str = Field(default="trades.db", validation_alias="DATABASE_PATH")
    log_level: str = Field(default="INFO", validation_alias="LOG_LEVEL")
    log_json: bool = Field(default=False, validation_alias="LOG_JSON")

    binance: BinanceSettings = Field(default_factory=BinanceSettings)
    risk: RiskSettings = Field(default_factory=RiskSettings)
    alerts: AlertSettings = Field(default_factory=AlertSettings)

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        env_nested_delimiter="__",
        extra="ignore",
    )


def load_app_settings(yaml_path: Optional[str] = None) -> AppSettings:
    """Load settings combining YAML defaults and environment variable overrides."""
    data = {}
    path = yaml_path or os.path.join(os.path.dirname(__file__), "config.yaml")
    if os.path.exists(path):
        try:
            with open(path, "r", encoding="utf-8") as f:
                data = yaml.safe_load(f) or {}
        except Exception as e:
            print(f"Warning: Failed to parse {path}: {e}")

    return AppSettings(**data)


# Global singleton settings
settings = load_app_settings()
