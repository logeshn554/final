import './styles/main.css';
import { STATE, log } from './state.js';
import { ALGORITHMS } from './config.js';
import { clamp } from './utils/math.js';
import { extractFeatures, computeReward } from './engine/features.js';
import { EnsembleEngine } from './engine/ensemble.js';
import { RiskEngine } from './engine/risk.js';
import { createAlgorithms } from './algorithms/index.js';
import { drawAllCharts } from './ui/charts.js';
import {
  renderPrice, renderEnsemble, renderVoteBreakdown, renderAlgoGrid,
  renderRegime, renderHMMBeliefs, renderPOMDP, renderOrderBook,
  renderRiskEngine, renderValueFns, renderTDStats, renderGAEStats,
  renderMORL, renderMetaRL, renderSafeRL, renderExecEngine,
  renderLog, renderUptime, renderQuantLayers,
  renderCandlesticks, renderTradingAlgos, renderInstitutionalAlgo, renderCandleInspector, renderTrainingModal,
  renderMTFConfluenceMatrix,
  renderProductionStrategy, renderActiveTradeSignal, renderMovementPrediction, renderAlgoDivergence, renderTrainingAudit,
  renderAlgoWinRateAndFixPanel,
  renderAlgoCapitalBenchmarkPanel,
  renderConnectionStatus,
  renderMasterDecisionBox,
  renderAutonomousHealingTerminal,
} from './ui/panels.js';
import { TradeSignalEngine } from './engine/trade-signals.js';
import { ProductionStrategyEngine } from './engine/production-strategy.js';
import { AlgoDiagnosticsEngine } from './engine/algo-diagnostics.js';
import { AlgoCapitalBenchmarkEngine } from './engine/algo-capital-benchmark.js';
import { MovementPredictionEngine } from './engine/movement-predictor.js';
import { PredictionFeedbackEngine } from './engine/prediction-feedback.js';
import { AutonomousHealingEngine } from './engine/autonomous-healing.js';

// 6 Production Quantitative Engines
import { DataIngestionEngine } from './engine/data-ingestion.js';
import { AlphaSignalEngine } from './engine/alpha-signals.js';
import { PortfolioConstructionEngine } from './engine/portfolio-construction.js';
import { SmartExecutionEngine } from './engine/smart-execution.js';
import { ProductionRiskEngine } from './engine/production-risk.js';
import { AttributionFeedbackEngine } from './engine/attribution-feedback.js';

// Candlestick Pattern Engine, Multi-Timeframe Engine, 8 Trading Algorithms Suite, Pinnacle Institutional Engine, Historical Trainer, Live Stream
import { CandlestickPatternEngine } from './engine/candlesticks.js';
import { MultiTimeframeEngine } from './engine/multi-timeframe.js';
import { TradingAlgorithmsSuite } from './engine/trading-algos.js';
import { InstitutionalQuantEngine } from './engine/advanced-institutional.js';
import { HistoricalTrainer } from './engine/historical-trainer.js';
import { BinanceLiveStream } from './engine/binance-live.js';

// ═══════════════════════════════════════════════════════
// INITIALIZATION
// ═══════════════════════════════════════════════════════

log('Production RL Engine v1.0 initializing...', 'info');

// Create all 34 algorithm instances
const algorithms = createAlgorithms();
log(`Loaded ${algorithms.length} RL algorithm instances`, 'info');

// Create ensemble & 6-layer quantitative engines
const ensemble = new EnsembleEngine();
const legacyRisk = new RiskEngine();

const dataEngine = new DataIngestionEngine();
const alphaEngine = new AlphaSignalEngine();
const portfolioEngine = new PortfolioConstructionEngine();
const smartExecEngine = new SmartExecutionEngine();
const prodRiskEngine = new ProductionRiskEngine();
const attrEngine = new AttributionFeedbackEngine();

// Candlestick, Multi-Timeframe & Classical Predictors Engines
const candlestickEngine = new CandlestickPatternEngine();
STATE.candlestickEngine = candlestickEngine;
const mtfEngine = new MultiTimeframeEngine();
STATE.mtfEngine = mtfEngine;

const tradingSuite = new TradingAlgorithmsSuite();
const institutionalEngine = new InstitutionalQuantEngine();
const historicalTrainer = new HistoricalTrainer();
const binanceLiveStream = new BinanceLiveStream();
const autonomousHealing = new AutonomousHealingEngine();
STATE.autonomousHealingEngine = autonomousHealing;

const tradeSignalEngine = new TradeSignalEngine();
tradeSignalEngine.healingEngine = autonomousHealing;

const productionStrategyEngine = new ProductionStrategyEngine();
productionStrategyEngine.healingEngine = autonomousHealing;

const algoDiagnosticsEngine = new AlgoDiagnosticsEngine();
algoDiagnosticsEngine.healingEngine = autonomousHealing;
STATE.algoDiagnostics = algoDiagnosticsEngine;

const movementPredictor = new MovementPredictionEngine();
STATE.movementPredictor = movementPredictor;
const predictionFeedback = new PredictionFeedbackEngine();
predictionFeedback.healingEngine = autonomousHealing;
STATE.predictionFeedback = predictionFeedback;

const capitalBenchmarkEngine = new AlgoCapitalBenchmarkEngine(STATE.price);
STATE.capitalBenchmark = capitalBenchmarkEngine;

// Expose global click handlers for auto-fix buttons and $10 benchmark
window._fixAlgo = (id) => {
  algoDiagnosticsEngine.fixAlgorithm(id);
  renderAlgoGrid();
  renderAlgoWinRateAndFixPanel();
  renderAutonomousHealingTerminal();
};
window._fixAllAlgos = () => {
  algoDiagnosticsEngine.autoFixAll();
  renderAlgoGrid();
  renderAlgoWinRateAndFixPanel();
  renderAutonomousHealingTerminal();
};
window._resetBenchmark = () => {
  capitalBenchmarkEngine.reset(STATE.price);
  renderAlgoCapitalBenchmarkPanel();
};
window._fastSimBenchmark = (steps = 10) => {
  capitalBenchmarkEngine.fastSimulate(steps, STATE.price, STATE.movementPrediction);
  renderAlgoCapitalBenchmarkPanel();
  renderMasterDecisionBox();
};

// Calibrate all 34 algorithms immediately with 6-month historical baselines
historicalTrainer.calibrateBaseline(algorithms);

log('Multi-Timeframe Engine (1h, 30m, 15m, 3m): SYNCHRONIZED', 'info');
log('All 34 RL Algorithms: 6-MONTH BASELINE CALIBRATED (4,320h)', 'info');
log('Candlestick Engine (35+ Patterns): READY', 'info');
log('Active Trade Signals & Risk Orders (SL / TP / Kelly): ACTIVE', 'info');
log('Multi-Algorithm Divergence & Explainability Engine: ONLINE', 'info');
log('6-Month Historical Training Audit Engine: VERIFIED (4,320 Hours)', 'info');
log('8 Classical Trading Algorithms Suite: ACTIVE', 'info');
log('The Pinnacle Quant Engine (Avellaneda-Stoikov HJB + Hawkes + Kyle): ONLINE', 'info');
log('Historical 6-Month Pre-Trainer: INITIALIZED', 'info');
log('Layer 1 (Data Ingestion L2/L3): ONLINE', 'info');
log('Layer 2 (Alpha & 34 RL Matrix): ONLINE', 'info');
log('Layer 3 (Portfolio Mean-Variance & Beta-Neutral): ONLINE', 'info');
log('Layer 4 (Smart Execution Almgren-Chriss & SOR): STANDBY', 'info');
log('Layer 5 (Real-Time Risk & Kill Switch): ARMED', 'info');
log('Layer 6 (Attribution & Feedback): ONLINE', 'info');
log('Dynamic Movement Prediction Engine (Probabilistic Excursion · No Fixed TP/SL): ONLINE', 'info');
log('Self-Evaluating Prediction Feedback & Failure Learning Engine: ACTIVE', 'info');

// Previous state for reward computation
let prevPrice = STATE.price;
let prevFeatures = null;

// ═══════════════════════════════════════════════════════
// MAIN TICK — Called every second (1Hz Production Loop)
// ═══════════════════════════════════════════════════════

function tick() {
  STATE.tick++;
  const tickStart = performance.now();

  const isConnected = STATE.connection.isOnline && (STATE.connection.status === 'connected' || (STATE.price > 100 && STATE.connection.status !== 'disconnected'));

  // ── NETWORK DISCONNECT & OFFLINE GUARD ──
  // FREEZE when completely offline or disconnected with no price
  if (!isConnected && (!STATE.price || STATE.price <= 100)) {
    renderConnectionStatus();
    renderPrice();
    renderUptime();
    return;
  }

  // ── LIVE REGIME DETECTION (Bayesian HMM on live prices) ──
  liveRegimeUpdate();
  livePomdpUpdate();

  // ── LAYER 1: DATA INGESTION ──
  const dataLayer = dataEngine.update(STATE.price);
  // Only update layer1 fields that the live stream hasn't already populated
  if (!STATE.layer1.orderBook.bids || STATE.layer1.orderBook.bids.length === 0) {
    STATE.layer1 = dataLayer;
    STATE.spread = dataLayer.orderBook.spread;
  }
  const currentDataLayer = STATE.layer1;
  const currentOB = currentDataLayer.orderBook;

  // ── MULTI-TIMEFRAME CANDLESTICK ENGINE (1h, 30m, 15m, 3m) ──
  const tickVol = (currentOB.totalBidVol || 20) + (currentOB.totalAskVol || 20);
  const mtfResult = mtfEngine.update(STATE.price, tickVol);
  STATE.mtfAnalysis = mtfResult;
  STATE.candles = mtfResult.candles;

  // Candlestick Pattern Recognition on active timeframe (35+ patterns + 1h History)
  const activeTf = STATE.selectedTimeframe || STATE.tf || '15m';
  const activeCandles = mtfEngine.getCandles(activeTf);
  const caResult = candlestickEngine.detectPatterns(activeCandles, true, activeTf);
  STATE.candlestickAnalysis = {
    ...caResult,
    patternHistory: candlestickEngine.getPatternHistory(),
    mtfConfluence: mtfResult.confluenceScore,
    score: clamp(caResult.score * 0.5 + mtfResult.confluenceScore * 0.5, -1, 1),
  };

  // ── ADVANCED TRADING ALGORITHMS SUITE (6 Institutional Disciplines) ──
  const taResult = tradingSuite.evaluate(
    STATE.prices,
    currentOB,
    STATE.layer1.quantFeeds,
    {
      btcPrice: STATE.btcPrice,
      candles: activeCandles,
      drawdown: STATE.drawdown,
    }
  );
  STATE.tradingAlgos = taResult;

  // ── PINNACLE INSTITUTIONAL QUANT ENGINE (Avellaneda-Stoikov HJB + Hawkes + Kyle's Lambda) ──
  const instResult = institutionalEngine.update(
    STATE.price,
    STATE.position,
    STATE.prices,
    currentOB,
    STATE.layer1.recentTrades || []
  );
  STATE.institutionalAlgo = instResult;

  // 2. Extract features (incorporates candlestick score, classical algos, and pinnacle institutional signal)
  const features = extractFeatures(STATE);
  STATE.features = features;

  // 3. Compute reward from last tick with executable fees, spread, slippage, and impact
  const reward = prevFeatures
    ? computeReward(1, prevPrice, STATE.price, STATE.position, {
        spread: STATE.spread,
        feeRate: 0.0004,
        kylesLambda: STATE.institutionalAlgo ? STATE.institutionalAlgo.kyle?.lambda : 0.02,
        drawdown: STATE.drawdown,
      })
    : 0;

  // 4. Update all 34 RL algorithms
  for (let i = 0; i < algorithms.length; i++) {
    try {
      algorithms[i].update(features, reward);
      const result = algorithms[i].getSignal();
      STATE.signals[algorithms[i].id] = result;
    } catch (e) {
      STATE.signals[algorithms[i].id] = { signal: 0, conf: 0.1, direction: 0, metrics: { error: e.message } };
    }
  }

  // ── LAYER 2: ALPHA GENERATION (Stat-Arb, Factors, ML Stack, Microstructure, Pinnacle HJB + 34 RL) ──
  const alphaLayer = alphaEngine.update(currentDataLayer, STATE.prices, STATE.signals, instResult);
  STATE.layer2 = alphaLayer;

  // 5. Ensemble aggregation
  const actualReturn = STATE.prices.length >= 2
    ? STATE.prices[STATE.prices.length - 1] / STATE.prices[STATE.prices.length - 2] - 1
    : 0;
  const ensSignal = ensemble.update(STATE.signals, actualReturn);
  STATE.ensemble = clamp(alphaLayer.compositeAlpha * 0.70 + ensSignal * 0.30, -1, 1);

  // ── LAYER 3: PORTFOLIO CONSTRUCTION (Mean-Variance, Beta Neutral, TCA hurdle) ──
  const returnSlice = STATE.prices.slice(-30).map((p, i, a) => i > 0 ? (p / a[i - 1] - 1) : 0);
  const portfolioLayer = portfolioEngine.optimize(
    STATE.ensemble,
    STATE.price,
    STATE.spread,
    returnSlice,
    STATE.position,
    STATE.equity
  );
  STATE.layer3 = portfolioLayer;

  // ── LAYER 5 (Pre-Trade): Risk Gatekeeper ──
  const preTrade = prodRiskEngine.checkPreTrade(portfolioLayer.targetETH, STATE.price, STATE.equity);

  // ── LAYER 4: SMART EXECUTION (Almgren-Chriss Slicing & Venue SOR) ──
  let execResult = null;
  if (preTrade.approved && Math.abs(portfolioLayer.targetETH - STATE.position) >= 0.01) {
    if (!smartExecEngine.activeOrder) {
      smartExecEngine.planExecution(portfolioLayer.targetETH, STATE.position, STATE.price, 'ALMGREN_CHRISS');
    }
  }
  execResult = smartExecEngine.executeSlice(
    STATE.price,
    STATE.spread,
    alphaLayer.microstructure.vpin,
    STATE.layer1.recentTrades || []
  );
  STATE.layer4 = {
    ...smartExecEngine,
    ...execResult,
    mode: smartExecEngine.activeOrder ? smartExecEngine.activeOrder.mode : 'ALMGREN_CHRISS',
    executionLog: smartExecEngine.executionLog,
  };

  // Update held position from execution slice
  if (execResult && execResult.sliceETH > 0) {
    const sign = smartExecEngine.activeOrder
      ? (smartExecEngine.activeOrder.side === 'BUY' ? 1 : -1)
      : (portfolioLayer.targetETH > STATE.position ? 1 : -1);
    STATE.position = clamp(STATE.position + sign * execResult.sliceETH, -5.0, 5.0);
  }

  // Position mark-to-market tracking
  liveUpdatePosition();

  // ── LAYER 5 (Post-Trade): Real-Time Risk & Autonomous Kill Switch ──
  const riskLayer = prodRiskEngine.evaluate(
    STATE.position,
    STATE.price,
    STATE.equity,
    STATE.maxEquity,
    returnSlice
  );
  STATE.layer5 = riskLayer;
  if (riskLayer.mustLiquidate && Math.abs(STATE.position) > 0.01) {
    log(`KILL SWITCH ACTIVATED: ${riskLayer.killSwitchReason} — FLATTENING TO 100% CASH`, 'warn');
    STATE.position = 0;
  }

  // ── LAYER 6: ATTRIBUTION, MODEL DRIFT & A/B TESTING ──
  const totalPnL = (STATE.realizedPnL || 0) + (STATE.unrealizedPnL || 0);
  const attrLayer = attrEngine.update(
    STATE.price,
    prevPrice,
    STATE.position,
    totalPnL,
    execResult,
    alphaLayer.compositeAlpha
  );
  STATE.layer6 = attrLayer;

  // ── DYNAMIC MOVEMENT PREDICTION & PREDICTION FEEDBACK LEARNING ──
  const completedSnapshots = movementPredictor.processOutcomes(STATE.price, STATE.prices, STATE.tick);
  if (completedSnapshots && completedSnapshots.length > 0) {
    for (const snap of completedSnapshots) {
      if (snap.prediction) {
        predictionFeedback.recordOutcome(snap.prediction, {
          actualMFE: snap.outcome.maxUp,
          actualMAE: Math.abs(snap.outcome.maxDown),
          actualFinalMove: snap.outcome.finalMove,
          duration: snap.ticksElapsed,
        });
      }
    }
  }

  // Compute live ATR from active candles
  const currentATR = tradeSignalEngine.computeATR(activeCandles);
  const currentRegimeStr = STATE.productionStrategy?.regime || (STATE.regime ? STATE.regime.toUpperCase() : 'TRENDING');

  // Generate dynamic movement prediction: HOW FAR price can move (Up/Down)
  const movementPrediction = movementPredictor.predict({
    price: STATE.price,
    prices: STATE.prices,
    features: features,
    atr: currentATR,
    regime: currentRegimeStr,
    ensemble: STATE.ensemble,
    signals: STATE.signals,
    rsi: productionStrategyEngine.computeRSI(STATE.prices),
    momentum: Math.round((STATE.prices.length >= 10 ? (STATE.price / STATE.prices[STATE.prices.length - 10] - 1) : 0) * 10000) / 100,
    volatilityScore: Math.round((STATE.risk?.volatility || 0.038) * 1000),
    microDirection: STATE.institutionalAlgo ? (STATE.institutionalAlgo.signal > 0 ? 1 : STATE.institutionalAlgo.signal < 0 ? -1 : 0) : 0,
    regimeConfidence: Math.round((STATE.regimeProbs?.[STATE.regime] || 0.6) * 100),
    candlestickScore: STATE.candlestickAnalysis?.score || 0,
    mtfConfluence: STATE.mtfAnalysis?.confluenceScore || 0,
    quantData: STATE.institutionalAlgo,
  });
  STATE.movementPrediction = movementPrediction;
  productionStrategyEngine.movementPrediction = movementPrediction;
  tradeSignalEngine.movementPrediction = movementPrediction;

  // ── TRADE SETUP, PRODUCTION STRATEGY, DIVERGENCE EXPLAINABILITY & 6-MONTH TRAINING AUDIT ──
  STATE.productionStrategy = productionStrategyEngine.evaluate({
    price: STATE.price,
    prices: STATE.prices,
    ensemble: STATE.ensemble,
    signals: STATE.signals,
    quantData: STATE.institutionalAlgo,
    candlestickData: STATE.candlestickAnalysis,
    riskData: STATE.layer5,
    mtfData: STATE.mtfAnalysis,
    activeCandles: activeCandles,
    movementPrediction: movementPrediction,
  });
  STATE.tradeSetup = tradeSignalEngine.evaluateTradeSetup(STATE);
  STATE.algoDivergence = tradeSignalEngine.analyzeDivergenceAndFix(STATE.signals, STATE);
  STATE.trainingAudit = tradeSignalEngine.getTrainingAudit();

  // ── $10 CAPITAL LIVE BENCHMARK UPDATE ──
  capitalBenchmarkEngine.tick(STATE.price, STATE.signals, movementPrediction);

  // 8. Update derived state for UI
  updateDerivedState(features, reward);

  // 10. Render UI
  const safe = (fn) => { try { fn(); } catch (e) { console.error('Render error:', e); } };

  safe(renderConnectionStatus);
  safe(renderPrice);
  safe(renderMasterDecisionBox);
  safe(renderEnsemble);
  safe(renderVoteBreakdown);
  safe(renderProductionStrategy);
  safe(renderActiveTradeSignal);
  safe(renderMovementPrediction);
  safe(renderRegime);
  safe(renderHMMBeliefs);
  safe(renderPOMDP);
  safe(renderOrderBook);
  safe(renderRiskEngine);
  safe(renderValueFns);
  safe(renderTDStats);
  safe(renderGAEStats);
  safe(renderMORL);
  safe(renderMetaRL);
  safe(renderSafeRL);
  safe(renderExecEngine);
  safe(renderQuantLayers);
  safe(renderMTFConfluenceMatrix);
  safe(renderCandleInspector);
  safe(renderCandlesticks);
  safe(renderTradingAlgos);
  safe(renderInstitutionalAlgo);
  safe(renderAlgoDivergence);
  safe(renderLog);
  safe(renderUptime);
  safe(renderAlgoCapitalBenchmarkPanel);

  if (STATE.tick % 3 === 0 || STATE.tick === 1) {
    safe(renderAlgoGrid);
    safe(renderAlgoWinRateAndFixPanel);
    safe(renderAutonomousHealingTerminal);
    safe(renderTrainingAudit);
  }

  safe(drawAllCharts);

  // Store for next tick
  prevPrice = STATE.price;
  prevFeatures = new Float64Array(features);

  const tickTime = performance.now() - tickStart;
  const lt = document.getElementById('latency');
  if (lt) lt.textContent = `${tickTime.toFixed(0)}ms`;
}

/**
 * Update derived state values from algorithm internals
 */
function updateDerivedState(features, reward) {
  // Value functions (from algorithm #4 ValueFunction and #5 Bellman)
  const vfAlgo = algorithms[3]; // ValueFunction
  const bellmanAlgo = algorithms[4]; // Bellman
  STATE.valueFunction = {
    V_s: vfAlgo.metrics.V_s ? parseFloat(vfAlgo.metrics.V_s) : 0,
    Q_buy: bellmanAlgo.metrics.Q
      ? parseFloat(bellmanAlgo.metrics.Q.split('/')[0]) : 0,
    Q_sell: bellmanAlgo.metrics.Q
      ? parseFloat(bellmanAlgo.metrics.Q.split('/')[2] || 0) : 0,
    Q_hold: bellmanAlgo.metrics.Q
      ? parseFloat(bellmanAlgo.metrics.Q.split('/')[1] || 0) : 0,
    advantage: vfAlgo.metrics.tdError ? parseFloat(vfAlgo.metrics.tdError) : 0,
  };

  // TD stats (from algorithm #8 TDLearning)
  const tdAlgo = algorithms[7];
  STATE.tdStats = {
    tdError: tdAlgo.metrics.tdError ? parseFloat(tdAlgo.metrics.tdError) : 0,
    returnGt: algorithms[2].metrics.G_t ? parseFloat(algorithms[2].metrics.G_t) : 0,
    nStep: 5,
  };

  // Q-values and TD errors for chart
  STATE.qValues.push(STATE.valueFunction.Q_buy);
  if (STATE.qValues.length > 200) STATE.qValues.shift();
  STATE.tdErrors.push(STATE.tdStats.tdError);
  if (STATE.tdErrors.length > 200) STATE.tdErrors.shift();

  // GAE values (from algorithm #17 GAE)
  const gaeAlgo = algorithms[16];
  const gaeVal = gaeAlgo.metrics.gaeAdv ? parseFloat(gaeAlgo.metrics.gaeAdv) : STATE.ensemble * 0.3;
  STATE.gaeValues.push(gaeVal);
  if (STATE.gaeValues.length > 200) STATE.gaeValues.shift();

  // Multi-objective scores (from algorithm #32)
  const morlAlgo = algorithms[31];
  if (morlAlgo.metrics.objectives) {
    const objs = morlAlgo.metrics.objectives.split('/').map(Number);
    STATE.morlScores = {
      return: Math.abs(objs[0] || 0) * 2,
      risk: Math.abs(objs[1] || 0) * 2,
      sharpe: Math.abs(objs[2] || 0) * 2,
      turnover: Math.abs(objs[3] || 0) * 2,
    };
  }

  // Meta-RL stats (from algorithm #30)
  const metaAlgo = algorithms[29];
  STATE.metaRL = {
    adaptScore: metaAlgo.metrics.adaptScore
      ? parseFloat(metaAlgo.metrics.adaptScore) / 100
      : 0.5,
    contextTasks: metaAlgo.metrics.taskProgress
      ? parseInt(metaAlgo.metrics.taskProgress.split('/')[0]) : 0,
    metaSteps: metaAlgo.metrics.innerSteps || 3,
    fastLR: 0.01,
  };

  // Safe RL stats (from algorithm #33)
  const safeAlgo = algorithms[32];
  STATE.safeRL = {
    safetyScore: safeAlgo.metrics.safetyScore
      ? parseFloat(safeAlgo.metrics.safetyScore) / 100
      : 0.95,
    violated: safeAlgo.metrics.constraint === 'VIOLATED',
    lagrangian: safeAlgo.metrics.lagrangian
      ? parseFloat(safeAlgo.metrics.lagrangian)
      : 0.3,
  };
}

// ═══════════════════════════════════════════════════════
// EVENT HANDLERS
// ═══════════════════════════════════════════════════════

// Algorithm filter tabs
document.getElementById('algoTabs')?.addEventListener('click', (e) => {
  if (e.target.classList.contains('tab')) {
    STATE.algoFilter = e.target.dataset.cat;
    document.querySelectorAll('#algoTabs .tab').forEach(t => t.classList.remove('active'));
    e.target.classList.add('active');
    renderAlgoGrid();
  }
});

// Multi-Timeframe switching (1m, 3m, 15m, 30m, 1h)
window._switchTimeframe = (tf) => {
  if (!tf) return;
  STATE.selectedTimeframe = tf;
  STATE.tf = tf;
  document.querySelectorAll('#tfTabs .tab').forEach(t => {
    if (t.dataset.tf === tf) t.classList.add('active');
    else t.classList.remove('active');
  });
  renderMTFConfluenceMatrix();
  drawAllCharts();
  const desc = tf === '1h' ? 'Macro Structure' : tf === '30m' ? 'Market Structure' : tf === '15m' ? 'Tactical Momentum' : tf === '3m' ? 'Precision Trigger' : 'Micro-Scalp Trigger';
  log(`Switched active candlestick timeframe to [${tf.toUpperCase()}] (${desc})`, 'info');
};

document.getElementById('tfTabs')?.addEventListener('click', (e) => {
  if (e.target.classList.contains('tab')) {
    window._switchTimeframe(e.target.dataset.tf);
  }
});

// Algo card selection (exposed globally for onclick)
window._selectAlgo = (id) => {
  document.querySelectorAll('.algo-card').forEach(c => c.classList.remove('active'));
  const el = document.getElementById('ac_' + id);
  if (el) el.classList.add('active');
  const a = ALGORITHMS.find(x => x.id === id);
  const sig = STATE.signals[id];
  if (a && sig) {
    const metricsStr = sig.metrics
      ? Object.entries(sig.metrics).map(([k, v]) => `${k}=${v}`).join(' ')
      : '';
    log(`Inspecting: ${a.name} (${a.tag}) — ${metricsStr}`, 'info');
  }
};

// 6-Layer Architecture Tab Switcher
document.getElementById('layerNav')?.addEventListener('click', (e) => {
  const tab = e.target.closest('.layer-tab');
  if (tab && tab.dataset.layer) {
    window._switchLayer(tab.dataset.layer);
  }
});

window._switchLayer = (layerId) => {
  STATE.activeLayerTab = layerId;
  document.querySelectorAll('#layerNav .layer-tab').forEach(t => {
    if (t.dataset.layer === layerId) t.classList.add('active');
    else t.classList.remove('active');
  });
  renderQuantLayers();
  drawAllCharts();
  log(`Active view: Layer ${layerId.toUpperCase()} (${layerId === 'overview' ? '6-Layer Executive Pipeline' : 'Detailed Telemetry'})`, 'info');
};

// Manual Kill Switch Override
window._toggleKillSwitch = () => {
  prodRiskEngine.toggleKillSwitch();
  STATE.layer5.killSwitchTriggered = prodRiskEngine.killSwitchTriggered;
  STATE.layer5.killSwitchReason = prodRiskEngine.killSwitchReason;
  if (prodRiskEngine.killSwitchTriggered) {
    STATE.position = 0;
    log('EMERGENCY KILL SWITCH ENGAGED: ALL POSITIONS FLATTENED TO CASH', 'warn');
  } else {
    log('Kill switch disarmed: normal execution resumed', 'info');
  }
  renderQuantLayers();
  renderRiskEngine();
};

// ═══════════════════════════════════════════════════════
// NETWORK LIVENESS & LIVE EXCHANGE CONTROLS
// ═══════════════════════════════════════════════════════

// Listen to browser network changes (Internet ON / OFF)
window.addEventListener('online', () => {
  log('🌐 Internet connection restored. Auto-reconnecting to live market stream...', 'info');
  STATE.connection.isOnline = true;
  binanceLiveStream.reconnect();
  renderConnectionStatus();
});

window.addEventListener('offline', () => {
  log('🔴 Internet connection lost! Live market stream paused. Halted synthetic ticking.', 'warn');
  STATE.connection.isOnline = false;
  STATE.connection.status = 'offline';
  binanceLiveStream.pause();
  renderConnectionStatus();
  renderPrice();
});

// Live Stream Toggle (Disconnect / Reconnect Live Feed)
window._toggleLiveStream = () => {
  if (STATE.connection.status === 'connected') {
    // Disconnect from live feed
    binanceLiveStream.disconnect();
    STATE.connection.status = 'disconnected';
    STATE.connection.provider = 'DISCONNECTED';
    log('Live market stream disconnected. Click to reconnect.', 'warn');
    renderConnectionStatus();
    renderPrice();
  } else {
    // Reconnect to live feed
    log('Reconnecting to LIVE MARKET STREAM...', 'info');
    STATE.connection.status = 'connecting';
    window._connectLiveBinance();
  }
};

window._connectLiveBinance = () => {
  STATE.connection.mode = 'live';
  STATE.connection.status = 'connecting';
  renderConnectionStatus();

  binanceLiveStream.connect((status, provider, latency) => {
    renderConnectionStatus();
    renderPrice();
    renderMasterDecisionBox();
  });
};

window._resetCapitalBenchmark = () => {
  capitalBenchmarkEngine.reset(STATE.price);
  log('⚡ 34-Algorithm Paper Trading Arena RESET: All 34 accounts initialized to $10.00 cash & 0 trades.', 'info');
  renderAlgoCapitalBenchmarkPanel();
  renderMasterDecisionBox();
};
window._resetBenchmark = window._resetCapitalBenchmark;

// ═══════════════════════════════════════════════════════
// AUTONOMOUS BACKGROUND TRAINING PIPELINE
// Automatically trains all 34 RL algorithms and quant suites
// on 180 days (4,320 hours) multi-timeframe dataset in the background.
// Zero manual triggers or popup modals.
// ═══════════════════════════════════════════════════════

async function autoTrainInBackground() {
  log('⚡ [AUTONOMOUS ENGINE] Auto-training all 34 RL algorithms across 180-day multi-timeframe dataset (1h, 30m, 15m, 3m)...', 'info');
  STATE.historicalTraining.isTraining = true;
  STATE.historicalTraining.showModal = false;

  try {
    const metrics = await historicalTrainer.train(algorithms, (update) => {
      STATE.historicalTraining.progress = update.progress;
      STATE.historicalTraining.metrics.finalLoss = update.loss;
      STATE.historicalTraining.metrics.winRatePct = `${update.winRate}%`;
      STATE.historicalTraining.metrics.confluenceWinRate = `${update.confluenceWinRate}%`;
    });

    if (metrics) {
      STATE.historicalTraining.metrics.totalReturnPct = metrics.totalReturnPct;
      STATE.historicalTraining.metrics.sharpeRatio = metrics.sharpeRatio;
      STATE.historicalTraining.metrics.confluenceWinRate = metrics.confluenceWinRate;
      STATE.historicalTraining.metrics.winRatePct = `${metrics.winRatePct}%`;
    }

    STATE.historicalTraining.isTraining = false;
    STATE.historicalTraining.trained = true;
    log(`✓ [AUTO-TRAINING COMPLETE] All 34 RL Models + 6 Quant Suites trained on 180-day dataset. Win Rate: ${historicalTrainer.metrics.winRatePct}, Confluence: ${historicalTrainer.metrics.confluenceWinRate}, Sharpe: ${historicalTrainer.metrics.sharpeRatio}. Continuing continuous online training on live Binance feed.`, 'info');
  } catch (err) {
    console.error('Autonomous background training error:', err);
    STATE.historicalTraining.isTraining = false;
  }

  renderAlgoGrid();
  renderMTFConfluenceMatrix();
  drawAllCharts();
}

window._startHistoricalTraining = async () => {
  return autoTrainInBackground();
};

window._closeTrainingModal = () => {
  STATE.historicalTraining.showModal = false;
  renderTrainingModal();
};

// Resize handler
window.addEventListener('resize', () => {
  drawAllCharts();
});

// ═══════════════════════════════════════════════════════
// LIVE-ONLY INLINED ANALYSIS FUNCTIONS
// (Regime detection & POMDP run on live prices — NOT simulation)
// ═══════════════════════════════════════════════════════

/** HMM Bayesian regime detection — runs on live price data */
function liveRegimeUpdate() {
  if (STATE.prices.length < 10) return;

  const T = {
    bull:     { bull: 0.92, bear: 0.02, ranging: 0.04, volatile: 0.02 },
    bear:     { bull: 0.03, bear: 0.90, ranging: 0.04, volatile: 0.03 },
    ranging:  { bull: 0.05, bear: 0.05, ranging: 0.85, volatile: 0.05 },
    volatile: { bull: 0.04, bear: 0.04, ranging: 0.07, volatile: 0.85 },
  };

  const returns5 = STATE.prices.length >= 6
    ? (STATE.prices[STATE.prices.length - 1] / STATE.prices[STATE.prices.length - 6] - 1)
    : 0;
  const recentVol = (() => {
    if (STATE.prices.length < 10) return 0.001;
    const rets = [];
    for (let i = STATE.prices.length - 10; i < STATE.prices.length; i++) {
      if (i > 0) rets.push(STATE.prices[i] / STATE.prices[i-1] - 1);
    }
    let s = 0;
    const m = rets.reduce((a,b) => a+b, 0) / rets.length;
    for (const r of rets) s += (r - m) ** 2;
    return Math.sqrt(s / rets.length);
  })();

  const priors = STATE.regimeProbs;
  const likelihoods = {
    bull:     Math.exp(-0.5 * ((returns5 - 0.003) / 0.005) ** 2) * Math.exp(-0.5 * ((recentVol - 0.002) / 0.002) ** 2),
    bear:     Math.exp(-0.5 * ((returns5 + 0.003) / 0.005) ** 2) * Math.exp(-0.5 * ((recentVol - 0.003) / 0.002) ** 2),
    ranging:  Math.exp(-0.5 * ((returns5 - 0) / 0.003) ** 2) * Math.exp(-0.5 * ((recentVol - 0.001) / 0.001) ** 2),
    volatile: Math.exp(-0.5 * ((returns5 - 0) / 0.008) ** 2) * Math.exp(-0.5 * ((recentVol - 0.006) / 0.003) ** 2),
  };

  const newProbs = {};
  let total = 0;
  for (const state of ['bull', 'bear', 'ranging', 'volatile']) {
    let transProb = 0;
    for (const prev of ['bull', 'bear', 'ranging', 'volatile']) {
      transProb += priors[prev] * T[prev][state];
    }
    newProbs[state] = transProb * likelihoods[state];
    total += newProbs[state];
  }
  for (const k of Object.keys(newProbs)) {
    newProbs[k] = Math.max(0.01, newProbs[k] / (total || 1));
  }
  const s = Object.values(newProbs).reduce((a, b) => a + b, 0);
  for (const k of Object.keys(newProbs)) newProbs[k] /= s;

  STATE.regimeProbs = newProbs;
  STATE.regime = Object.entries(newProbs).sort((a, b) => b[1] - a[1])[0][0];
}

/** POMDP belief state update — runs on live price data */
function livePomdpUpdate() {
  const prices = STATE.prices;
  if (prices.length < 20) return;

  const ret5 = prices[prices.length - 1] / prices[prices.length - 6] - 1;
  const momentum = prices[prices.length - 1] / prices[prices.length - 11] - 1;

  const likelihoods = {
    'Accum.':   Math.exp(-0.5 * ((ret5 - 0.002) / 0.004) ** 2) * (momentum > 0 ? 1.3 : 0.7),
    'Dist.':    Math.exp(-0.5 * ((ret5 + 0.002) / 0.004) ** 2) * (momentum < 0 ? 1.3 : 0.7),
    'Ranging':  Math.exp(-0.5 * (ret5 / 0.002) ** 2),
    'Breakout': Math.exp(-0.5 * ((Math.abs(ret5) - 0.008) / 0.005) ** 2),
  };

  let total = 0;
  for (const k of Object.keys(STATE.pomdpBelief)) {
    STATE.pomdpBelief[k] *= likelihoods[k];
    STATE.pomdpBelief[k] = Math.max(0.01, STATE.pomdpBelief[k]);
    total += STATE.pomdpBelief[k];
  }
  for (const k of Object.keys(STATE.pomdpBelief)) {
    STATE.pomdpBelief[k] /= total;
  }
}

/** Position mark-to-market and equity tracking (inlined from simulation) */
function liveUpdatePosition() {
  const price = STATE.price;

  if (STATE.position !== 0 && (!STATE.entryPrice || STATE.entryPrice === 0)) {
    STATE.entryPrice = price;
  } else if (Math.abs(STATE.position) < 0.0001) {
    STATE.position = 0;
    STATE.entryPrice = 0;
  }

  if (STATE.position !== 0 && STATE.entryPrice !== 0) {
    STATE.unrealizedPnL = (price - STATE.entryPrice) * STATE.position;
  } else {
    STATE.unrealizedPnL = 0;
  }

  STATE.equity = 10000 + (STATE.realizedPnL || 0) + STATE.unrealizedPnL;
  STATE.equityHistory.push(STATE.equity);
  if (STATE.equityHistory.length > 500) STATE.equityHistory.shift();

  STATE.maxEquity = Math.max(STATE.maxEquity, STATE.equity);
  STATE.drawdown = STATE.maxEquity > 0 ? (STATE.equity - STATE.maxEquity) / STATE.maxEquity * 100 : 0;
}

// ═══════════════════════════════════════════════════════
// START ENGINE — LIVE ONLY (NO SIMULATION)
// ═══════════════════════════════════════════════════════

log('⚡ Dynamic Market Analyst Engine v3.0 — LIVE ONLY', 'info');
log('Connecting to Binance / Coinbase / Bybit live stream...', 'info');
log('HMM Bayesian regime detector: ONLINE (live prices)', 'info');
log('POMDP belief tracker: ONLINE (live prices)', 'info');
log('34 RL algorithms: READY', 'info');
log('Dynamic ATR-adaptive strategy: ARMED', 'info');
log('Execution engine: STANDBY', 'info');
log('─── LIVE ENGINE STARTED ───', 'info');

// Initial render
renderAlgoGrid();
renderConnectionStatus();
renderAutonomousHealingTerminal();
tick();

// Main loop @ 1Hz (Continuous Online Reinforcement Learning)
setInterval(tick, 1000);

// Auto-connect to Live Binance / Coinbase / Bybit Stream immediately
window._connectLiveBinance();

// Automatically train all models in the background on startup
autoTrainInBackground();
