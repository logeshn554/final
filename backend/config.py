"""
Production Configuration Manager — Validates environment variables, YAML config, and secrets.
"""

from __future__ import annotations
import os
import yaml
from typing import List, Optional
from dotenv import load_dotenv
from pydantic import BaseModel, Field
from pydantic_settings import BaseSettings, SettingsConfigDict

# Ensure .env is loaded from backend directory or project root
backend_env = os.path.join(os.path.dirname(__file__), ".env")
root_env = os.path.join(os.path.dirname(os.path.dirname(__file__)), ".env")
if os.path.exists(backend_env):
    load_dotenv(backend_env)
elif os.path.exists(root_env):
    load_dotenv(root_env)


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


class DeltaExchangeSettings(BaseModel):
    env: str = "india_prod"   # "india_prod" | "india_testnet" | "global"
    rest_urls: List[str] = [
        "https://api.india.delta.exchange",
        "https://cdn.india.delta.exchange",
    ]
    ws_urls: List[str] = [
        "wss://socket.india.delta.exchange",
    ]
    symbol: str = "ETHUSD"
    product_id: int = 3136
    lot_size: int = 1
    request_timeout: int = 10
    max_retries: int = 4
    api_key: Optional[str] = None
    api_secret: Optional[str] = None
    mcp_mode: str = "read"   # "read" | "trade"
    trade_enabled: bool = False
    dry_run: bool = True
    use_mcp_bridge: bool = False


class RiskSettings(BaseModel):
    max_portfolio_risk_pct: float = 1.0   # Reduced from 2.0 to 1.0 for safety (H1)
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
    exchange: str = "delta"  # "delta" | "binance"
    symbol: str = "ETHUSD"
    timeframes: List[str] = ["1m", "5m", "15m", "1h", "4h"]  # Added 4h for macro regime (M2)
    candle_buffer_size: int = 1000
    env: str = Field(default="development", validation_alias="APP_ENV")
    host: str = Field(default="0.0.0.0", validation_alias="HOST")
    port: int = Field(default=8000, validation_alias="PORT")
    api_auth_token: Optional[str] = Field(default=None, validation_alias="API_AUTH_TOKEN")
    cors_origins: List[str] = Field(default=["http://localhost:5173", "http://localhost:3000"], validation_alias="CORS_ORIGINS")
    database_path: str = Field(default="trades.db", validation_alias="DATABASE_PATH")
    log_level: str = Field(default="INFO", validation_alias="LOG_LEVEL")
    log_json: bool = Field(default=False, validation_alias="LOG_JSON")

    delta_exchange: DeltaExchangeSettings = Field(default_factory=DeltaExchangeSettings)
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

    # Explicit environment overrides for Delta Exchange live trading
    delta_cfg = data.get("delta_exchange", {})
    if os.getenv("DELTA_API_KEY"):
        delta_cfg["api_key"] = os.getenv("DELTA_API_KEY")
    if os.getenv("DELTA_API_SECRET"):
        delta_cfg["api_secret"] = os.getenv("DELTA_API_SECRET")
    if os.getenv("DELTA_ENV") or os.getenv("DELTA_MCP_ENV"):
        delta_cfg["env"] = os.getenv("DELTA_ENV") or os.getenv("DELTA_MCP_ENV")
    if os.getenv("DELTA_MCP_MODE"):
        delta_cfg["mcp_mode"] = os.getenv("DELTA_MCP_MODE")
    if os.getenv("TRADE_ENABLED"):
        delta_cfg["trade_enabled"] = os.getenv("TRADE_ENABLED").lower() in ("true", "1", "yes")
    if os.getenv("DRY_RUN"):
        delta_cfg["dry_run"] = os.getenv("DRY_RUN").lower() in ("true", "1", "yes")
    elif delta_cfg.get("mcp_mode") == "trade" or delta_cfg.get("trade_enabled"):
        delta_cfg["dry_run"] = False
    if os.getenv("DELTA_SYMBOL"):
        delta_cfg["symbol"] = os.getenv("DELTA_SYMBOL")
        data["symbol"] = os.getenv("DELTA_SYMBOL")
    if os.getenv("DELTA_LOT_SIZE"):
        try:
            delta_cfg["lot_size"] = int(os.getenv("DELTA_LOT_SIZE"))
        except (ValueError, TypeError):
            delta_cfg["lot_size"] = 1
    if os.getenv("EXCHANGE"):
        data["exchange"] = os.getenv("EXCHANGE")

    data["delta_exchange"] = delta_cfg
    return AppSettings(**data)


# Global singleton settings
settings = load_app_settings()
