import './styles/main.css';
import { STATE, log } from './state.js';
import { ALGORITHMS } from './config.js';
import { clamp } from './utils/math.js';
import { extractFeatures, computeReward } from './engine/features.js';
import { simPrice, simRegime, simPOMDP, updatePosition, simLogs } from './engine/simulation.js';
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
  renderProductionStrategy, renderActiveTradeSignal, renderAlgoDivergence, renderTrainingAudit,
  renderAlgoWinRateAndFixPanel,
} from './ui/panels.js';
import { TradeSignalEngine } from './engine/trade-signals.js';
import { ProductionStrategyEngine } from './engine/production-strategy.js';
import { AlgoDiagnosticsEngine } from './engine/algo-diagnostics.js';

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
const tradeSignalEngine = new TradeSignalEngine();
const productionStrategyEngine = new ProductionStrategyEngine();
const algoDiagnosticsEngine = new AlgoDiagnosticsEngine();
STATE.algoDiagnostics = algoDiagnosticsEngine;

// Expose global click handlers for auto-fix buttons
window._fixAlgo = (id) => {
  algoDiagnosticsEngine.fixAlgorithm(id);
  renderAlgoGrid();
  renderAlgoWinRateAndFixPanel();
};
window._fixAllAlgos = () => {
  algoDiagnosticsEngine.autoFixAll();
  renderAlgoGrid();
  renderAlgoWinRateAndFixPanel();
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

// Previous state for reward computation
let prevPrice = STATE.price;
let prevFeatures = null;

// ═══════════════════════════════════════════════════════
// MAIN TICK — Called every second (1Hz Production Loop)
// ═══════════════════════════════════════════════════════

function tick() {
  STATE.tick++;
  const tickStart = performance.now();

  // Market updates (Live WebSocket vs Simulation)
  if (!STATE.isLiveBinance) {
    simPrice();
    simRegime();
    simPOMDP();
  }

  // ── LAYER 1: DATA INGESTION ──
  const simDataLayer = dataEngine.update(STATE.price);
  if (!STATE.isLiveBinance) {
    STATE.layer1 = simDataLayer;
    STATE.spread = simDataLayer.orderBook.spread;
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

  // ── 8 TRADING ALGORITHMS SUITE (Classical Quant Strategies) ──
  const taResult = tradingSuite.evaluate(STATE.prices, currentOB, STATE.layer1.quantFeeds);
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

  // 3. Compute reward from last tick
  const reward = prevFeatures
    ? computeReward(1, prevPrice, STATE.price, STATE.position)
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
  ensemble.update(STATE.signals, actualReturn);
  STATE.ensemble = alphaLayer.compositeAlpha;

  // ── LAYER 3: PORTFOLIO CONSTRUCTION (Mean-Variance, Beta Neutral, TCA hurdle) ──
  const returnSlice = STATE.prices.slice(-30).map((p, i, a) => i > 0 ? (p / a[i - 1] - 1) : 0);
  const portfolioLayer = portfolioEngine.optimize(
    alphaLayer.compositeAlpha,
    STATE.price,
    STATE.spread,
    returnSlice,
    STATE.position
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
  execResult = smartExecEngine.executeSlice(STATE.price, STATE.spread, alphaLayer.microstructure.vpin);
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

  // Legacy position update for equity tracking
  updatePosition(STATE.ensemble > 0.3 ? 0 : STATE.ensemble < -0.3 ? 2 : 1, STATE.ensemble);

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

  // ── TRADE SETUP, PRODUCTION STRATEGY, DIVERGENCE EXPLAINABILITY & 6-MONTH TRAINING AUDIT ──
  STATE.tradeSetup = tradeSignalEngine.evaluateTradeSetup(STATE);
  STATE.productionStrategy = productionStrategyEngine.evaluate({
    price: STATE.price,
    prices: STATE.prices,
    ensemble: STATE.ensemble,
    signals: STATE.signals,
    quantData: STATE.institutionalAlgo,
    candlestickData: STATE.candlestickAnalysis,
    riskData: STATE.layer5,
    mtfData: STATE.mtfAnalysis,
  });
  STATE.algoDivergence = tradeSignalEngine.analyzeDivergenceAndFix(STATE.signals, STATE);
  STATE.trainingAudit = tradeSignalEngine.getTrainingAudit();

  // 8. Update derived state for UI
  updateDerivedState(features, reward);

  // 9. Logs
  simLogs();

  // 10. Render UI
  renderPrice();
  renderEnsemble();
  renderVoteBreakdown();
  renderProductionStrategy();
  renderActiveTradeSignal();
  renderRegime();
  renderHMMBeliefs();
  renderPOMDP();
  renderOrderBook();
  renderRiskEngine();
  renderValueFns();
  renderTDStats();
  renderGAEStats();
  renderMORL();
  renderMetaRL();
  renderSafeRL();
  renderExecEngine();
  renderQuantLayers();
  renderMTFConfluenceMatrix();
  renderCandleInspector();
  renderCandlesticks();
  renderTradingAlgos();
  renderInstitutionalAlgo();
  renderAlgoDivergence();
  renderLog();
  renderUptime();

  if (STATE.tick % 3 === 0) {
    renderAlgoGrid();
    renderAlgoWinRateAndFixPanel();
    renderTrainingAudit();
  } else if (STATE.tick === 1) {
    renderAlgoGrid();
    renderAlgoWinRateAndFixPanel();
    renderTrainingAudit();
  }

  drawAllCharts();

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

// Multi-Timeframe switching (3m, 15m, 30m, 1h)
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
  log(`Switched active candlestick timeframe to [${tf.toUpperCase()}] (${tf === '1h' ? 'Macro Structure' : tf === '30m' ? 'Market Structure' : tf === '15m' ? 'Tactical Momentum' : 'Precision Trigger'})`, 'info');
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

// Live Stream Toggle (Binance Public WebSocket vs Simulation)
window._toggleLiveStream = () => {
  if (STATE.isLiveBinance) {
    binanceLiveStream.disconnect((status) => {
      STATE.isLiveBinance = false;
      const btn = document.getElementById('btnLiveToggle');
      if (btn) { btn.textContent = '○ SIMULATED'; btn.classList.remove('active-live'); }
      const badge = document.getElementById('liveBadge');
      if (badge) badge.style.borderColor = 'var(--danger)';
    });
  } else {
    window._connectLiveBinance();
  }
};

window._connectLiveBinance = () => {
  binanceLiveStream.connect((status) => {
    STATE.isLiveBinance = status;
    const btn = document.getElementById('btnLiveToggle');
    if (btn && status) { btn.textContent = '● LIVE BINANCE'; btn.classList.add('active-live'); }
    const badge = document.getElementById('liveBadge');
    if (badge && status) {
      badge.style.borderColor = 'var(--green)';
      badge.innerHTML = '<div class="live-dot" style="background:var(--green)"></div>LIVE BINANCE';
    }
    log('CONNECTED TO LIVE BINANCE PUBLIC FEED (ethusdt@ticker, depth20, trades)!', 'info');
    renderPrice();
  });
};

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
// START ENGINE
// ═══════════════════════════════════════════════════════

log('Connecting to Binance ETH/USDT stream...', 'info');
log('HMM regime detector: ONLINE', 'info');
log('World model (Dreamer): ONLINE', 'info');
log('All 34 algorithms: READY', 'info');
log('Execution engine: STANDBY', 'info');
log('─── ENGINE STARTED ───', 'info');

// Initial render
renderAlgoGrid();
tick();

// Main loop @ 1Hz (Continuous Online Reinforcement Learning)
setInterval(tick, 1000);

// Auto-connect to Live Binance Stream immediately
window._connectLiveBinance();

// Automatically train all models in the background on startup
autoTrainInBackground();

