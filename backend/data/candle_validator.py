from dataclasses import dataclass
import logging
import pandas as pd

logger = logging.getLogger(__name__)


@dataclass
class ValidationResult:
    is_valid: bool
    reason: str = ""


def validate_candle(c) -> ValidationResult:
    """Validate a single incoming Candle object."""
    if c.high < c.low:
        return ValidationResult(False, f"high({c.high}) < low({c.low})")
    if not (c.low <= c.close <= c.high):
        return ValidationResult(False, f"close({c.close}) outside [low,high]")
    if c.open <= 0 or c.close <= 0:
        return ValidationResult(False, "Non-positive OHLC price")
    if c.volume < 0:
        return ValidationResult(False, "Negative volume")
    return ValidationResult(True)


def validate_dataframe(df: pd.DataFrame) -> tuple[bool, str]:
    """Validate a candle DataFrame for duplicates, excessive gaps, or NaNs."""
    if df.empty:
        return True, ""
    if "timestamp" in df.columns:
        if df["timestamp"].duplicated().any():
            return False, "Duplicate timestamps found"
        gaps = df["timestamp"].diff().dropna()
        # More than 5x expected interval = data gap
        if not gaps.empty and (gaps > gaps.median() * 5).any():
            return False, "Large timestamp gaps detected"
    cols_to_check = [col for col in ["open", "high", "low", "close"] if col in df.columns]
    if cols_to_check and df[cols_to_check].isnull().any().any():
        return False, "NaN prices in DataFrame"
    return True, ""
