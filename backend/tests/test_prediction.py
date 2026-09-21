"""
Unit tests for expected move distribution and dynamic target engine for ETHUSDT.
Verifies no hardcoded percentages or fixed ratios are used.
"""

import numpy as np
import pandas as pd
import pytest

from prediction.expected_move import ExpectedMoveEngine
from prediction.mfe_mae import MFEMAEEngine
from prediction.target_engine import DynamicTargetEngine
from risk.stop_engine import DynamicStopEngine


def test_no_hardcoded_take_profit_eth():
    expected_move_engine = ExpectedMoveEngine(forward_bars=6)
    mfe_mae_engine = MFEMAEEngine()
    target_engine = DynamicTargetEngine()
    stop_engine = DynamicStopEngine()

    current_price = 3200.0  # ETH price scale
    atr = 25.0

    df = pd.DataFrame({
        "open": [3200.0] * 60,
        "high": [3215.0] * 60,
        "low": [3185.0] * 60,
        "close": [3205.0] * 60,
        "atr_14": [atr] * 60,
        "vol_expansion": [1.2] * 60,
        "roc_5": [0.4] * 60,
    })

    move_dist = expected_move_engine.estimate(df, current_price, direction="BUY")
    mfe_profile = mfe_mae_engine.get_profile("STRONG_UPTREND", atr)

    stop = stop_engine.calculate_stop(
        current_price=current_price,
        signal="BUY",
        df=df,
        support_levels=[3160.0],
        resistance_levels=[3260.0],
        mae_invalidation=30.0,
    )

    targets = target_engine.calculate_targets(
        current_price=current_price,
        signal="BUY",
        move_dist=move_dist,
        mfe_profile=mfe_profile,
        stop_price=stop.stop_price,
        resistance_levels=[3260.0],
        support_levels=[3160.0],
    )

    # Assert targets are dynamically computed
    assert targets.base_target > current_price
    assert targets.conservative_target > current_price
    assert targets.extended_target >= targets.base_target

    # Assert NOT equal to fixed 1.02 or 1.03 (strictly dynamic)
    assert abs(targets.base_target - (current_price * 1.02)) > 0.5
    assert abs(targets.base_target - (current_price * 1.03)) > 0.5

    # Assert Risk/Reward is calculated from actual market distances
    expected_rr = (targets.base_target - current_price) / (current_price - stop.stop_price)
    assert abs(targets.risk_reward_ratio - expected_rr) < 0.1
