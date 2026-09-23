"""
Backtest Engine — Walk-forward, no-lookahead backtesting framework for the dynamic ensemble.
"""

from __future__ import annotations
import logging
from dataclasses import dataclass
import numpy as np
import pandas as pd

from regime.detector import RegimeDetector
from strategies.trend_strategy import TrendStrategy
from strategies.structure_strategy import StructureStrategy
from strategies.volatility_strategy import VolatilityStrategy
from strategies.mean_reversion_strategy import MeanReversionStrategy
from strategies.ml_strategy import MLStrategy
from ensemble.weighting import StrategyWeightEngine
from ensemble.confidence import ConfidenceCalibrator
from ensemble.aggregator import EnsembleAggregator
from prediction.expected_move import ExpectedMoveEngine
from prediction.mfe_mae import MFEMAEEngine
from prediction.target_engine import DynamicTargetEngine
from prediction.reversal_engine import ReversalEngine
from risk.stop_engine import DynamicStopEngine
from risk.position_sizing import DynamicPositionSizer
from risk.exit_engine import DynamicExitEngine
from backtest.metrics import calculate_metrics, PerformanceMetrics
from backtest.failure_analysis import FailureAnalyzer

logger = logging.getLogger(__name__)


class Backtester:
    """Simulates the entire multi-strategy, dynamic prediction and risk engine through time."""

    def __init__(
        self,
        initial_balance: float = 10000.0,
        fee_rate: float = 0.0004,     # 0.04% taker fee
        slippage_pts: float = 2.0,     # ~2 USDT slippage per fill
    ):
        self.initial_balance = initial_balance
        self.fee_rate = fee_rate
        self.slippage_pts = slippage_pts

        # Initialize engines
        self.regime_detector = RegimeDetector()
        self.strategies = {
            "trend": TrendStrategy(),
            "structure": StructureStrategy(),
            "volatility": VolatilityStrategy(),
            "mean_reversion": MeanReversionStrategy(),
            "ml": MLStrategy(forward_bars=4, min_train_samples=60),
        }
        self.weight_engine = StrategyWeightEngine()
        self.calibrator = ConfidenceCalibrator()
        self.aggregator = EnsembleAggregator(self.weight_engine, self.calibrator)
        self.expected_move_engine = ExpectedMoveEngine(forward_bars=6)
        self.mfe_mae_engine = MFEMAEEngine()
        self.target_engine = DynamicTargetEngine()
        self.reversal_engine = ReversalEngine()
        self.stop_engine = DynamicStopEngine()
        self.position_sizer = DynamicPositionSizer()
        self.exit_engine = DynamicExitEngine()
        self.failure_analyzer = FailureAnalyzer()

    def _apply_slippage(self, price: float, is_long: bool, is_entry: bool) -> float:
        """
        Entry BUY: fill higher (worse)    → price + slippage
        Entry SELL: fill lower (worse)    → price - slippage
        Exit BUY (sell to close): lower   → price - slippage
        Exit SELL (buy to cover): higher  → price + slippage
        """
        direction = 1 if (is_long == is_entry) else -1
        return price + direction * self.slippage_pts

    def run(
        self,
        dfs: dict[str, pd.DataFrame],   # timeframe -> DataFrame with all features
        primary_tf: str = "15m",
        warmup_bars: int = 60,
    ) -> dict:
        """Run backtest across historical bars."""
        primary_df = dfs.get(primary_tf)
        if primary_df is None or len(primary_df) <= warmup_bars:
            raise ValueError(f"Primary timeframe {primary_tf} missing or insufficient data (min {warmup_bars} bars)")

        n_bars = len(primary_df)
        balance = self.initial_balance
        trades: list[dict] = []

        # Current trade state
        in_pos = False
        direction = ""
        entry_price = 0.0
        stop_price = 0.0
        target_price = 0.0
        pos_size = 0.0
        entry_bar = 0
        highest_price = 0.0
        lowest_price = 0.0
        max_favorable = 0.0
        max_adverse = 0.0
        entry_regime = ""
        entry_votes = {}
        is_partial_closed = False

        for t in range(warmup_bars, n_bars):
            # Strict slice up to bar t — absolutely no future data leaked
            current_dfs = {tf: df.iloc[: min(t + 1, len(df))] for tf, df in dfs.items()}
            curr_bar = primary_df.iloc[t]
            bar_open = float(curr_bar["open"])
            bar_high = float(curr_bar["high"])
            bar_low = float(curr_bar["low"])
            bar_close = float(curr_bar["close"])

            # 1. Manage existing open position
            if in_pos:
                bars_held = t - entry_bar
                highest_price = max(highest_price, bar_high)
                lowest_price = min(lowest_price, bar_low)

                is_long = direction == "BUY"
                fav_pts = (highest_price - entry_price) if is_long else (entry_price - lowest_price)
                adv_pts = (entry_price - lowest_price) if is_long else (highest_price - entry_price)
                max_favorable = max(max_favorable, max(fav_pts, 0.0))
                max_adverse = max(max_adverse, max(adv_pts, 0.0))

                # Check Stop Loss breach
                stopped_out = (is_long and bar_low <= stop_price) or (not is_long and bar_high >= stop_price)
                # Check Target Hit
                target_hit = (is_long and bar_high >= target_price) or (not is_long and bar_low <= target_price)

                exit_reason = None
                exit_price = 0.0

                if stopped_out:
                    exit_reason = "STOP_LOSS"
                    exit_price = self._apply_slippage(stop_price, is_long=is_long, is_entry=False)
                elif target_hit:
                    exit_reason = "DYNAMIC_TARGET_HIT"
                    exit_price = self._apply_slippage(target_price, is_long=is_long, is_entry=False)

                else:
                    # Dynamic Exit evaluation mid-trade
                    rev = self.reversal_engine.assess(current_dfs[primary_tf], bar_close, direction)
                    exit_dec = self.exit_engine.evaluate_exit(
                        position_direction=direction,
                        entry_price=entry_price,
                        current_price=bar_close,
                        current_stop=stop_price,
                        target_price=target_price,
                        reversal=rev,
                        df=current_dfs[primary_tf],
                        bars_held=bars_held,
                    )
                    if exit_dec.action == "TRAIL_STOP_UPDATE" and exit_dec.new_trailing_stop:
                        stop_price = exit_dec.new_trailing_stop
                    elif exit_dec.action == "PARTIAL_TP" and not is_partial_closed:
                        is_partial_closed = True
                        p_size = pos_size * exit_dec.exit_fraction
                        pnl = (bar_close - entry_price) * p_size if is_long else (entry_price - bar_close) * p_size
                        fee = (bar_close * p_size) * self.fee_rate
                        balance += (pnl - fee)
                        pos_size -= p_size
                    elif exit_dec.action == "FULL_EXIT":
                        exit_reason = exit_dec.reason or "DYNAMIC_REVERSAL_EXIT"
                        exit_price = bar_close

                if exit_reason:
                    # Close position
                    pnl_pts = (exit_price - entry_price) if is_long else (entry_price - exit_price)
                    pnl_usd = (pnl_pts * pos_size)
                    fee = (exit_price * pos_size) * self.fee_rate
                    net_pnl = pnl_usd - fee
                    balance += net_pnl

                    trade_dict = {
                        "id": f"t_{len(trades)+1}",
                        "direction": direction,
                        "entry_price": entry_price,
                        "exit_price": exit_price,
                        "stop_price": stop_price,
                        "target_price": target_price,
                        "size": pos_size,
                        "pnl_usd": net_pnl,
                        "pnl_pct": net_pnl / (entry_price * pos_size) if (entry_price * pos_size) > 0 else 0.0,
                        "mfe_pts": max_favorable,
                        "mae_pts": max_adverse,
                        "regime_at_entry": entry_regime,
                        "exit_reason": exit_reason,
                        "holding_time_minutes": bars_held * 15,
                        "strategy_votes": entry_votes,
                    }
                    trades.append(trade_dict)

                    # Update empirical priors and weights
                    self.mfe_mae_engine.record_trade_excursion(entry_regime, max_favorable, max_adverse)
                    was_win = net_pnl > 0
                    for s_name, vote in entry_votes.items():
                        if vote.get("signal") == direction:
                            self.weight_engine.record_outcome(s_name, was_win)

                    in_pos = False
                    continue

            # 2. Check for new entry when flat
            if not in_pos:
                regime_state = self.regime_detector.detect(current_dfs, bar_close)

                # Get strategy predictions
                predictions = {}
                for name, strat in self.strategies.items():
                    try:
                        pred = strat.predict(current_dfs, bar_close, regime_state.primary_regime)
                        predictions[name] = pred
                    except Exception:
                        pass

                # Aggregate signals
                decision = self.aggregator.aggregate(predictions, regime_state, bar_close)

                if decision.signal in ("BUY", "SELL") and decision.confidence >= 0.40:
                    # Determine dynamic expected move and MFE profile
                    move_dist = self.expected_move_engine.estimate(
                        current_dfs[primary_tf], bar_close, direction=decision.signal
                    )
                    atr_col = "atr_14" if "atr_14" in curr_bar else None
                    atr_val = float(curr_bar[atr_col]) if atr_col and pd.notna(curr_bar[atr_col]) else bar_close * 0.003
                    mfe_profile = self.mfe_mae_engine.get_profile(regime_state.primary_regime, atr_val)

                    # Dynamic structural stop loss
                    stop_placement = self.stop_engine.calculate_stop(
                        current_price=bar_close,
                        signal=decision.signal,
                        df=current_dfs[primary_tf],
                        support_levels=decision.support_levels,
                        resistance_levels=decision.resistance_levels,
                        mae_invalidation=mfe_profile.mae_p85,
                        regime=regime_state.primary_regime,
                    )

                    # Dynamic Take Profit target
                    target_zone = self.target_engine.calculate_targets(
                        current_price=bar_close,
                        signal=decision.signal,
                        move_dist=move_dist,
                        mfe_profile=mfe_profile,
                        stop_price=stop_placement.stop_price,
                        resistance_levels=decision.resistance_levels,
                        support_levels=decision.support_levels,
                    )

                    # Dynamic position sizing
                    vol_exp = float(curr_bar["vol_expansion"]) if "vol_expansion" in curr_bar and pd.notna(curr_bar["vol_expansion"]) else 1.0
                    sizing = self.position_sizer.calculate_size(
                        account_balance=balance,
                        entry_price=bar_close,
                        stop_price=stop_placement.stop_price,
                        target_price=target_zone.base_target,
                        confidence=decision.confidence,
                        vol_expansion=vol_exp,
                    )

                    if sizing.notional_size_usd > 10.0:
                        in_pos = True
                        direction = decision.signal
                        entry_price = self._apply_slippage(bar_close, is_long=(direction == "BUY"), is_entry=True)
                        stop_price = stop_placement.stop_price
                        target_price = target_zone.base_target
                        pos_size = sizing.notional_size_usd / entry_price
                        entry_bar = t

                        highest_price = entry_price
                        lowest_price = entry_price
                        max_favorable = 0.0
                        max_adverse = 0.0
                        entry_regime = regime_state.primary_regime
                        entry_votes = {name: p.to_dict() for name, p in predictions.items()}
                        is_partial_closed = False

                        # Deduct entry fee
                        entry_fee = (entry_price * pos_size) * self.fee_rate
                        balance -= entry_fee

        metrics = calculate_metrics(trades, initial_balance=self.initial_balance)
        failure_summary = self.failure_analyzer.analyze_batch(trades)

        return {
            "metrics": metrics.to_dict(),
            "trades_count": len(trades),
            "final_balance": round(balance, 2),
            "trades": trades[-50:],  # return last 50 trades
            "failure_analysis": failure_summary,
        }
