"""
Backtest package — backtester, performance metrics, and failure analysis.
"""

from backtest.backtester import Backtester
from backtest.metrics import calculate_metrics, PerformanceMetrics
from backtest.failure_analysis import FailureAnalyzer, FailureDiagnosis

__all__ = [
    "Backtester",
    "calculate_metrics",
    "PerformanceMetrics",
    "FailureAnalyzer",
    "FailureDiagnosis",
]
