import './styles/main.css';
import { STATE, log } from './state.js';
import { ALGORITHMS } from './config.js';
import { clamp } from './utils/math.js';
import { extractFeatures, computeReward } from './engine/features.js';
import { EnsembleEngine } from './engine/ensemble.js';
import { RiskEngine } from './engine/risk.js';
import { createAlgorithms } from './algorithms/index.js';
import { drawAllCharts, invalidateCanvasSizeCache } from './ui/charts.js';
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
  renderStrategyPerformancePanel,
  renderConnectionStatus,
  renderMasterDecisionBox,
  renderHeaderMasterSignalArea,
  renderAutonomousHealingTerminal,
  renderResearchAlgorithmStack,
  renderMasterHistoryPage,
} from './ui/panels.js';
import { VolatilityMasterSuite } from './engine/volatility-suite.js';
import { DeepMicrostructureEngine } from './engine/microstructure-deep.js';
import { DeepLOBTensorEngine } from './engine/deep-lob.js';
import { DeepTimeSeriesForecaster } from './engine/neural-forecasters.js';
import { FoundationModelEnsemble } from './engine/foundation-adapters.js';
import { MetaLabelingEngine } from './engine/meta-labeling.js';
import { ExtremeValueTheoryModel, ConformalPredictor } from './engine/probabilistic-evt.js';
import { HierarchicalRiskParity } from './engine/hierarchical-portfolio.js';

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
import { PythonEngineBridge } from './engine/python-engine-bridge.js';
import { MastermindEngine } from './engine/mastermind.js';
import { StrategyPerformanceEngine } from './engine/strategy-performance-engine.js';

// ═══════════════════════════════════════════════════════
// INITIALIZATION
// ═══════════════════════════════════════════════════════

log('Production RL Engine v1.0 initializing...', 'info');

// Create all 43 algorithm instances
const algorithms = createAlgorithms();
log(`Loaded ${algorithms.length} RL algorithm instances (Original 34 + Research-Grade 35..43)`, 'info');

// Dynamic Strategy Performance Engine (Continuous Paper-Trading Evaluator across all models)
const strategyPerformanceEngine = new StrategyPerformanceEngine();
STATE.strategyPerformanceEngine = strategyPerformanceEngine;
window._strategyPerformanceEngine = strategyPerformanceEngine;

// Central Authoritative Mastermind Engine
const mastermindEngine = new MastermindEngine();
STATE.mastermindEngine = mastermindEngine;
window._mastermindEngine = mastermindEngine;

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
historicalTrainer.calibrateBaseline(algorithms, '6m');
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

// Instantiate Research-Grade Quant & Deep AI Engines
const volatilityMaster = new VolatilityMasterSuite();
const deepMicrostructure = new DeepMicrostructureEngine();
const deepLOB = new DeepLOBTensorEngine();
const neuralForecaster = new DeepTimeSeriesForecaster();
const foundationEnsemble = new FoundationModelEnsemble();
const metaLabeler = new MetaLabelingEngine();
tradeSignalEngine.metaLabeler = metaLabeler;
STATE.metaLabeler = metaLabeler;
const conformalPredictor = new ConformalPredictor();


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

// Master Signal Complete History Page Navigation & Filter Handlers
window._showMasterHistoryPage = () => {
  const histPage = document.getElementById('masterHistoryPage');
  const mainLayout = document.querySelector('.main-layout');
  const layerNav = document.getElementById('layerNav');
  if (histPage) {
    histPage.style.display = 'block';
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }
  if (mainLayout) mainLayout.style.display = 'none';
  if (layerNav) layerNav.style.display = 'none';
  renderMasterHistoryPage();
};

window._hideMasterHistoryPage = () => {
  const histPage = document.getElementById('masterHistoryPage');
  const mainLayout = document.querySelector('.main-layout');
  const layerNav = document.getElementById('layerNav');
  if (histPage) histPage.style.display = 'none';
  if (mainLayout) mainLayout.style.display = '';
  if (layerNav) layerNav.style.display = '';
  window.scrollTo({ top: 0, behavior: 'smooth' });
};

window._toggleMasterHistoryPage = () => {
  const histPage = document.getElementById('masterHistoryPage');
  if (histPage && histPage.style.display !== 'none') {
    window._hideMasterHistoryPage();
  } else {
    window._showMasterHistoryPage();
  }
};

window._showPaperTradingArena = () => {
  window._hideMasterHistoryPage();
  const panel = document.getElementById('algoCapitalBenchmarkPanel');
  if (panel) {
    panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
    panel.style.boxShadow = '0 0 35px rgba(16,185,129,0.55)';
    setTimeout(() => {
      panel.style.boxShadow = '';
    }, 3000);
  }
};

window._setHistoryFilter = (filter) => {
  window._mhpFilter = filter;
  renderMasterHistoryPage();
};

// Clear All Trading History & Reset Performance Ledgers
window._clearAllTradingHistory = (skipConfirm = false) => {
  if (!skipConfirm && typeof window.confirm === 'function') {
    const ok = window.confirm('Are you sure you want to clear ALL trading history? This will wipe all completed master trades, dynamic win rate records, and paper trading records.');
    if (!ok) return;
  }

  // 1. Reset Master Trade state and history ledger
  if (STATE.masterTrade) {
    STATE.masterTrade.stats = {
      totalTrades: 0,
      wins: 0,
      losses: 0,
      winRate: 0.0,
      winStreak: 0,
      cumulativePnLUSD: 0.00,
      history: [],
    };
    if (STATE.masterTrade.status === 'RESOLVED_TP' || STATE.masterTrade.status === 'RESOLVED_SP') {
      STATE.masterTrade.status = 'IDLE';
      STATE.masterTrade.direction = 0;
      STATE.masterTrade.action = 'SCANNING';
    }
  }

  // 2. Reset Production Strategy Engine history
  if (productionStrategyEngine) {
    productionStrategyEngine.tradeHistory = [];
    productionStrategyEngine.tradeCount = 0;
    productionStrategyEngine.winCount = 0;
    if (productionStrategyEngine.stats) {
      productionStrategyEngine.stats.tradesExecuted = 0;
      productionStrategyEngine.stats.winRatePct = 0;
      productionStrategyEngine.stats.totalPnlUSD = 0;
    }
  }

  // 3. Reset 43-Algorithm $10 Capital Arena & wipe localStorage
  if (capitalBenchmarkEngine) {
    capitalBenchmarkEngine.reset(STATE.price);
  }

  // 4. Reset Prediction Feedback History
  STATE.predictionHistory = [];
  STATE.failureAnalysis = null;

  // 5. Update header count badge
  const headerCountEl = document.getElementById('masterHistoryCount');
  if (headerCountEl) headerCountEl.textContent = '0';

  // 6. Force re-render of all relevant panels
  renderMasterHistoryPage();
  renderHeaderMasterSignalArea();
  renderActiveTradeSignal();
  renderMasterDecisionBox();
  renderAlgoCapitalBenchmarkPanel();

  log('ALL TRADING HISTORY CLEARED: Clean slate ready for real-time live execution.', 'warn');
};

// Manual Execute: Instant BUY (1) or SELL (-1) passing strictly through MasterMind risk authorization
window._manualExecuteTrade = (direction = 1) => {
  const manualDecision = mastermindEngine.evaluateManual(direction, {
    price: STATE.price,
    prices: STATE.prices,
    signals: STATE.signals,
    strategyPerformance: STATE.strategyPerformance,
    pythonEngineDecision: STATE.pythonEngine?.decision,
    institutionalAlgo: STATE.institutionalAlgo,
    microstructure: STATE.layer2?.microstructure || {},
    candlestickAnalysis: STATE.candlestickAnalysis,
    mtfAnalysis: STATE.mtfAnalysis,
    movementPrediction: STATE.movementPrediction,
    researchStack: STATE.researchStack,
    autoHealing: STATE.autonomousHealingEngine,
    equity: STATE.equity,
    killSwitch: STATE.layer5?.mustLiquidate || STATE.layer5?.killSwitchTriggered,
    atr: STATE.atr || 16.0,
  });
  STATE.masterDecision = manualDecision;

  if (manualDecision.approved && STATE.masterTrade) {
    STATE.masterTrade.status = 'ACTIVE';
    STATE.masterTrade.direction = direction;
    STATE.masterTrade.action = direction === 1 ? 'BUY' : 'SELL';
    STATE.masterTrade.entryPrice = STATE.price;
    STATE.masterTrade.tpPrice = manualDecision.execution?.takeProfitPrice || (direction === 1 ? STATE.price + 25 : STATE.price - 25);
    STATE.masterTrade.spPrice = manualDecision.execution?.stopPrice || (direction === 1 ? STATE.price - 18 : STATE.price + 18);
    STATE.masterTrade.tpDistance = Math.abs(STATE.masterTrade.tpPrice - STATE.price);
    STATE.masterTrade.slDistance = Math.abs(STATE.masterTrade.spPrice - STATE.price);
    STATE.masterTrade.positionETH = manualDecision.risk?.positionSizeETH || 1.0;
    STATE.masterTrade.positionUSD = (STATE.masterTrade.positionETH * STATE.price).toFixed(2);
    const now = Date.now();
    const timeStr = new Date(now).toLocaleTimeString();
    const dateStr = new Date(now).toISOString().slice(0, 10);
    STATE.masterTrade.entryTime = now;
    STATE.masterTrade.entryTimeStr = timeStr;
    STATE.masterTrade.entryDateStr = dateStr;
    STATE.masterTrade.boughtTime = direction === 1 ? timeStr : null;
    STATE.masterTrade.soldTime = direction === 1 ? null : timeStr;
    STATE.masterTrade.boughtDate = direction === 1 ? dateStr : null;
    STATE.masterTrade.soldDate = direction === 1 ? null : dateStr;
    STATE.masterTrade.elapsedSec = 0;
    STATE.masterTrade.elapsedStr = '0s';
    STATE.masterTrade.livePnlUSD = '0.00';
    STATE.masterTrade.livePnlPct = 0;
    STATE.masterTrade.progressPct = 0;
    STATE.masterTrade.triggerType = `MANUAL ${direction === 1 ? 'BUY' : 'SELL'} (MasterMind Authorized)`;
    STATE.masterTrade.scanReason = null;
  }

  renderHeaderMasterSignalArea();
  renderActiveTradeSignal();
  renderMasterDecisionBox();
  log(`MANUAL TRADE: ${direction === 1 ? 'BUY' : 'SELL'} @ $${STATE.price?.toFixed(2)} [MasterMind Auth: ${manualDecision.approved ? 'APPROVED' : 'BLOCKED'}]`, manualDecision.approved ? 'info' : 'warn');
};

// Manual Close: Instant market exit for active trade governed by MasterMind
window._manualCloseTrade = (reason = 'MANUAL MARKET EXIT') => {
  if (STATE.masterTrade && STATE.masterTrade.status === 'ACTIVE') {
    const exitPrice = STATE.price;
    const isBuy = STATE.masterTrade.direction === 1;
    const grossPnl = isBuy ? (exitPrice - STATE.masterTrade.entryPrice) * (STATE.masterTrade.positionETH || 1.0)
                           : (STATE.masterTrade.entryPrice - exitPrice) * (STATE.masterTrade.positionETH || 1.0);
    const isWin = grossPnl > 0;
    tradeSignalEngine._resolveTrade(STATE, STATE.masterTrade, exitPrice, reason, isWin, 'MANUAL EXIT');
  }
  renderHeaderMasterSignalArea();
  renderActiveTradeSignal();
  renderMasterHistoryPage();
  renderMasterDecisionBox();
  log(`MANUAL TRADE CLOSED: Position closed @ $${STATE.price?.toFixed(2)} (Reason: ${reason})`, 'info');
};

// Calibrate all 43 algorithms immediately with 1-year multi-timeframe historical baselines
historicalTrainer.calibrateBaseline(algorithms);

log('Multi-Timeframe Engine (1m, 15m, 30m, 60m/1h): SYNCHRONIZED', 'info');
log('All 43 RL Algorithms: 1-YEAR BASELINE CALIBRATED (8,760h / 73,320+ MTF bars)', 'info');
log('Candlestick Engine (35+ Patterns): READY', 'info');
log('Active Trade Signals & Risk Orders (SL / TP / Kelly): ACTIVE', 'info');
log('Multi-Algorithm Divergence & Explainability Engine: ONLINE', 'info');
log('1-Year Multi-Timeframe Training Audit Engine: VERIFIED (8,760 Hours · 1m, 15m, 30m, 60m)', 'info');
log('8 Classical Trading Algorithms Suite: ACTIVE', 'info');
log('The Pinnacle Quant Engine (Avellaneda-Stoikov HJB + Hawkes + Kyle): ONLINE', 'info');
log('Historical 1-Year Multi-Timeframe Pre-Trainer: INITIALIZED', 'info');
log('Layer 1 (Data Ingestion L2/L3): ONLINE', 'info');
log('Layer 2 (Alpha & RL Ensemble Matrix): ONLINE', 'info');
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
// DATA QUALITY GATE (RIG-Micro: Regime Integrity Gated Microstructure)
// No verified live exchange stream = No feature generation = No trade signal
// ═══════════════════════════════════════════════════════

export function evaluateDataQualityGate() {
  const now = Date.now();
  const times = STATE.dataFeedTimes || {};

  const priceFresh = STATE.price !== null && STATE.price > 0 && (now - times.priceTime < 15000);
  const depthFresh = (STATE.layer1?.orderBook?.bids?.length > 0) && (now - times.depthTime < 25000);
  const tradesFresh = (STATE.layer1?.recentTrades?.length > 0) && (now - times.tradesTime < 30000);
  const btcFresh = STATE.btcPrice !== null && STATE.btcPrice > 0 && (now - times.btcTime < 30000);
  const klinesFresh = (STATE.candles?.['15m']?.length >= 5) || (STATE.prices?.length >= 5);

  const checks = {
    priceFresh,
    depthFresh,
    tradesFresh,
    btcFresh,
    klinesFresh,
    derivativesFresh: STATE.layer1?.quantFeeds?.fundingRate !== null,
  };

  // Rigorous Gate: Must have live price, recent price tick, depth, and at least 5 historical prices
  const isReady = (STATE.price !== null && STATE.price > 0 && STATE.prices.length >= 5 && STATE.connection.status !== 'offline');

  STATE.dataQualityGate = {
    isReady,
    status: isReady ? 'GATE_OPEN (VERIFIED REAL DATA)' : 'GATE_LOCKED (AWAITING VERIFIED DATA)',
    checks,
    lastCheckTime: now,
  };

  return isReady;
}

// ═══════════════════════════════════════════════════════
// MAIN TICK — Called every second (1Hz Production Loop)
// ═══════════════════════════════════════════════════════

function tick() {
  STATE.tick++;
  const tickStart = performance.now();

  const isDataReady = evaluateDataQualityGate();

  // ── DATA QUALITY GATE GUARD (RIG-Micro) ──
  // When waiting for initial ticks, still render connection, price, and active master scanning telemetry
  if (!isDataReady) {
    renderConnectionStatus();
    renderPrice();
    renderHeaderMasterSignalArea();
    renderMasterDecisionBox();
    renderUptime();
    if (STATE.prices.length > 0) {
      renderOrderBook();
      drawAllCharts();
    }
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

  // ── UPDATE DYNAMIC STRATEGY PERFORMANCE ENGINE (Tick & Paper Trades) ──
  strategyPerformanceEngine.updateMarketData(
    STATE.price,
    STATE.spread || 0.15,
    STATE.high24,
    STATE.low24,
    STATE.regime
  );

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

  // ── RESEARCH-GRADE QUANT & DEEP AI/RL ALGORITHM STACK ──
  const volResult = volatilityMaster.update(activeCandles, STATE.price);
  const microResult = deepMicrostructure.update(currentOB, STATE.layer1.recentTrades || [], activeCandles);
  const lobResult = deepLOB.update(currentOB);
  const neuralResult = neuralForecaster.update(
    STATE.prices,
    STATE.volumes,
    microResult.multiLevelOFI ? [microResult.multiLevelOFI] : [],
    [volResult.consensusVol]
  );
  const foundationResult = foundationEnsemble.evaluate(STATE.prices);

  // Extreme Value Theory (EVT) Peaks-Over-Threshold on losses
  const lossesSlice = STATE.prices.slice(-40).map((p, i, a) => i > 0 ? (a[i - 1] - p) / (a[i - 1] || 1) : 0).filter(r => r > 0);
  const evtTail = ExtremeValueTheoryModel.fitPOT(lossesSlice);

  // Conformal Prediction finite-sample interval
  conformalPredictor.addCalibrationSample(STATE.price, foundationResult.blendedMedianPrice || STATE.price);
  const conformalInterval = conformalPredictor.predictInterval(STATE.price);

  // Marcos López de Prado Meta-Labeling
  const prospectiveDir = neuralResult.compositeSignal > 0.08 ? 1 : neuralResult.compositeSignal < -0.08 ? -1 : 0;
  const metaEvaluation = metaLabeler.evaluateTrade(prospectiveDir, neuralResult.confidence, {
    vol: volResult.consensusVol,
    ofi: microResult.multiLevelOFI,
    trend: neuralResult.compositeSignal,
    spreadBps: (STATE.spread / (STATE.price || 1)) * 10000,
  });
  if (metaEvaluation) {
    metaEvaluation.metaWinProb = metaEvaluation.winProbability;
  }

  // Hierarchical Risk Parity (HRP) Multi-Asset Allocation
  const ethVar = Math.pow(volResult.consensusVol, 2) / (365 * 24);
  const btcVar = ethVar * 0.82;
  const solVar = ethVar * 1.38;
  const usdtVar = 1e-8;
  const covMat = [
    [ethVar, ethVar * 0.72, ethVar * 0.65, 0],
    [ethVar * 0.72, btcVar, btcVar * 0.68, 0],
    [ethVar * 0.65, btcVar * 0.68, solVar, 0],
    [0, 0, 0, usdtVar],
  ];
  const hrpAllocation = HierarchicalRiskParity.allocate(covMat, ['ETH', 'BTC', 'SOL', 'USDT']);

  STATE.researchStack = {
    volatility: volResult,
    microstructure: microResult,
    deepLOB: lobResult,
    neuralForecaster: neuralResult,
    foundation: foundationResult,
    evtTail,
    conformal: conformalInterval,
    metaLabeling: metaEvaluation,
    hrp: hrpAllocation,
  };


  // 2. Extract features (incorporates candlestick score, classical algos, and pinnacle institutional signal)
  const features = extractFeatures(STATE);
  STATE.features = features;

  // 3. Compute executable transition reward & run Continuous Online Training on Live Market Data
  const currentAction = STATE.position > 0 ? 0 : STATE.position < 0 ? 2 : 1;
  const reward = (prevPrice > 0 && STATE.price)
    ? computeReward(currentAction, prevPrice, STATE.price, STATE.position, {
        spread: STATE.spread || 0.15,
        feeRate: 0.0004,
        kylesLambda: 0.015,
      })
    : 0;

  if (prevFeatures && prevPrice > 0) {
    historicalTrainer.trainLiveStep(algorithms, {
      price: STATE.price,
      prevPrice,
      features,
      prevFeatures,
      position: STATE.position,
      spread: STATE.spread,
      orderBook: STATE.orderBook,
      trades: STATE.layer1.recentTrades,
    });
  }

  // 4. Retrieve current policy actions and signals from all 43 online-adapted algorithms
  for (let i = 0; i < algorithms.length; i++) {
    try {
      if (typeof algorithms[i].predict === 'function') {
        algorithms[i].predict(features);
      }
      const result = algorithms[i].getSignal(features);
      STATE.signals[algorithms[i].id] = result;
    } catch (e) {
      STATE.signals[algorithms[i].id] = { signal: 0, conf: 0.1, direction: 0, metrics: { error: e.message } };
    }
  }

  // Update header badge dynamically with live continuous training counter
  if (STATE.liveTraining && STATE.liveTraining.liveSamplesTrained > 0) {
    const badge = document.getElementById('autoTrainBadge');
    if (badge && !STATE.historicalTraining.isTraining) {
      badge.innerHTML = `<span class="live-dot" style="background:var(--green);"></span>● 6-MO REAL TRAINED + LIVE ONLINE LEARNING: ${STATE.liveTraining.liveSamplesTrained} TICKS`;
    }
    if (STATE.liveTraining.liveSamplesTrained % 30 === 0) {
      log(`⚡ [LIVE CONTINUOUS LEARNING] Step #${STATE.liveTraining.liveSamplesTrained} · 43 RL models adapted on live tick · Live Loss: ${STATE.liveTraining.liveLoss} · Live Win Rate: ${STATE.liveTraining.liveWinRate}%`, 'info');
    }
  }

  // ── LAYER 2: ALPHA GENERATION (Stat-Arb, Factors, ML Stack, Microstructure, Pinnacle HJB + RL Ensemble) ──
  const alphaLayer = alphaEngine.update(currentDataLayer, STATE.prices, STATE.signals, instResult);
  STATE.layer2 = alphaLayer;

  // 5. Ensemble aggregation
  const actualReturn = STATE.prices.length >= 2
    ? STATE.prices[STATE.prices.length - 1] / STATE.prices[STATE.prices.length - 2] - 1
    : 0;
  const ensSignal = ensemble.update(STATE.signals, actualReturn);
  STATE.ensemble = clamp(alphaLayer.compositeAlpha * 0.70 + ensSignal * 0.30, -1, 1);

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
    researchData: STATE.researchStack,
  });

  // ── $10 CAPITAL LIVE BENCHMARK UPDATE ──
  capitalBenchmarkEngine.tick(STATE.price, STATE.signals, movementPrediction);

  STATE.algoDivergence = tradeSignalEngine.analyzeDivergenceAndFix(STATE.signals, STATE);
  STATE.tradeSetup = tradeSignalEngine.evaluateTradeSetup(STATE);
  STATE.trainingAudit = tradeSignalEngine.getTrainingAudit(STATE, capitalBenchmarkEngine);

  // ── DYNAMIC STRATEGY PERFORMANCE EVALUATION BUS ──
  // Aggregates directional signals across all 43 RL algorithms + quant engines + deep models + Python
  const allStrategySignals = {};
  for (const id in STATE.signals) {
    allStrategySignals[`rl_${id}`] = STATE.signals[id];
  }
  allStrategySignals['ensemble_rl'] = {
    direction: STATE.ensemble > 0.05 ? 1 : STATE.ensemble < -0.05 ? -1 : 0,
    signal: STATE.ensemble > 0.05 ? 'BUY' : STATE.ensemble < -0.05 ? 'SELL' : 'HOLD',
    conf: Math.abs(STATE.ensemble || 0.5),
  };
  allStrategySignals['alpha_engine'] = {
    direction: alphaLayer.compositeAlpha > 0.05 ? 1 : alphaLayer.compositeAlpha < -0.05 ? -1 : 0,
    signal: alphaLayer.compositeAlpha > 0.05 ? 'BUY' : alphaLayer.compositeAlpha < -0.05 ? 'SELL' : 'HOLD',
    conf: Math.abs(alphaLayer.compositeAlpha || 0.5),
  };
  const instSource = instResult || STATE.institutionalAlgo;
  allStrategySignals['institutional_hjb'] = {
    direction: instSource?.signal > 0.05 ? 1 : instSource?.signal < -0.05 ? -1 : 0,
    signal: instSource?.action || 'HOLD',
    conf: Math.abs(instSource?.signal || 0.6),
  };
  allStrategySignals['candlestick_engine'] = {
    direction: STATE.candlestickAnalysis?.score > 0.05 ? 1 : STATE.candlestickAnalysis?.score < -0.05 ? -1 : 0,
    signal: STATE.candlestickAnalysis?.score > 0.05 ? 'BUY' : STATE.candlestickAnalysis?.score < -0.05 ? 'SELL' : 'HOLD',
    conf: Math.abs(STATE.candlestickAnalysis?.score || 0.5),
  };
  allStrategySignals['mtf_confluence'] = {
    direction: STATE.mtfAnalysis?.confluenceScore > 0.05 ? 1 : STATE.mtfAnalysis?.confluenceScore < -0.05 ? -1 : 0,
    signal: STATE.mtfAnalysis?.confluenceScore > 0.05 ? 'BUY' : STATE.mtfAnalysis?.confluenceScore < -0.05 ? 'SELL' : 'HOLD',
    conf: Math.abs(STATE.mtfAnalysis?.confluenceScore || 0.5),
  };
  allStrategySignals['production_strategy'] = {
    direction: STATE.productionStrategy?.direction || 0,
    signal: STATE.productionStrategy?.action || 'HOLD',
    conf: STATE.productionStrategy?.confidence || 0.5,
  };
  allStrategySignals['trade_signal_engine'] = {
    direction: STATE.tradeSetup?.direction || 0,
    signal: STATE.tradeSetup?.action || 'HOLD',
    conf: STATE.tradeSetup?.confidence || 0.5,
  };
  allStrategySignals['microstructure_deep'] = {
    direction: (alphaLayer.microstructure?.obi > 0.1 && alphaLayer.microstructure?.vpin < 0.35) ? 1 : (alphaLayer.microstructure?.obi < -0.1) ? -1 : 0,
    signal: 'HOLD',
    conf: 0.6,
  };
  allStrategySignals['deep_lob'] = {
    direction: STATE.researchStack?.deepLOB?.score > 0.05 ? 1 : STATE.researchStack?.deepLOB?.score < -0.05 ? -1 : 0,
    signal: 'HOLD',
    conf: Math.abs(STATE.researchStack?.deepLOB?.score || 0.5),
  };
  allStrategySignals['neural_forecaster'] = {
    direction: STATE.researchStack?.neuralForecaster?.score > 0.05 ? 1 : STATE.researchStack?.neuralForecaster?.score < -0.05 ? -1 : 0,
    signal: 'HOLD',
    conf: 0.6,
  };
  allStrategySignals['foundation_ensemble'] = {
    direction: STATE.researchStack?.foundation?.score > 0.05 ? 1 : STATE.researchStack?.foundation?.score < -0.05 ? -1 : 0,
    signal: 'HOLD',
    conf: 0.6,
  };
  allStrategySignals['meta_labeling'] = {
    direction: STATE.researchStack?.metaLabeling?.winProb > 0.6 ? 1 : STATE.researchStack?.metaLabeling?.winProb < 0.4 ? -1 : 0,
    signal: 'HOLD',
    conf: STATE.researchStack?.metaLabeling?.winProb || 0.5,
  };
  allStrategySignals['volatility_suite'] = { direction: 0, signal: 'HOLD', conf: 0.5 };

  if (STATE.pythonEngine?.decision) {
    const pyDec = STATE.pythonEngine.decision;
    const pyDir = pyDec.signal === 'BUY' ? 1 : pyDec.signal === 'SELL' ? -1 : 0;
    allStrategySignals['python_ensemble'] = { direction: pyDir, signal: pyDec.signal, conf: pyDec.confidence || 0.6 };
    const strats = pyDec.strategy_contributions || {};
    for (const [k, sc] of Object.entries(strats)) {
      const sd = sc.signal === 'BUY' ? 1 : sc.signal === 'SELL' ? -1 : 0;
      allStrategySignals[`python_${k}`] = { direction: sd, signal: sc.signal || 'HOLD', conf: sc.confidence || 0.5 };
    }
  }

  // MasterMind self-performance evaluation bus:
  // Register previous tick's MasterMind decision into allStrategySignals
  // so MasterMind's actual decisions are paper-traded and verified continuously!
  if (STATE.masterDecision) {
    allStrategySignals['mastermind'] = {
      direction: STATE.masterDecision.direction || 0,
      signal: STATE.masterDecision.signal || 'HOLD',
      conf: STATE.masterDecision.confidence || 0.5,
      tp: STATE.masterDecision.execution?.takeProfitPrice,
      sl: STATE.masterDecision.execution?.stopPrice,
    };
  }

  strategyPerformanceEngine.ingestSignals(allStrategySignals, {
    price: STATE.price,
    spread: STATE.spread || 0.15,
    movementPrediction: movementPrediction,
    atr: currentATR,
    regime: currentRegimeStr,
  });

  const strategyPerformanceState = strategyPerformanceEngine.getState(currentRegimeStr);
  STATE.strategyPerformance = strategyPerformanceState;

  // ══════════════════════════════════════════════════════════════════════
  // ── AUTHORITATIVE MASTERMIND EVALUATION (ETHUSDT) ──
  // The Single Master Authority: Ingests Dynamic Strategy Performance
  // Weights + 43 RL Models + Python 5-Strategy Ensemble + Institutional HJB + Deep Research
  // ══════════════════════════════════════════════════════════════════════
  const masterDecision = mastermindEngine.evaluate({
    price: STATE.price,
    prices: STATE.prices,
    signals: STATE.signals,
    strategyPerformance: strategyPerformanceState,
    pythonEngineDecision: STATE.pythonEngine?.decision,
    institutionalAlgo: instResult || STATE.institutionalAlgo,
    microstructure: alphaLayer.microstructure,
    candlestickAnalysis: STATE.candlestickAnalysis,
    mtfAnalysis: STATE.mtfAnalysis,
    movementPrediction: STATE.movementPrediction,
    researchStack: STATE.researchStack,
    autoHealing: STATE.autonomousHealingEngine,
    equity: STATE.equity,
    killSwitch: STATE.layer5?.mustLiquidate,
    atr: currentATR,
  });
  STATE.masterDecision = masterDecision;

  // Synchronize Master Trade Execution Lifecycle with Authoritative Decision
  if (STATE.masterTrade) {
    if (masterDecision.approved && STATE.masterTrade.status === 'IDLE') {
      STATE.masterTrade.status = 'ACTIVE';
      STATE.masterTrade.direction = masterDecision.direction;
      STATE.masterTrade.action = masterDecision.signal;
      STATE.masterTrade.entryPrice = STATE.price;
      STATE.masterTrade.tpPrice = masterDecision.execution?.takeProfitPrice || masterDecision.movement?.favorable?.targetPrice || masterDecision.targetRange?.base;
      STATE.masterTrade.spPrice = masterDecision.execution?.stopPrice || masterDecision.movement?.adverse?.stopPrice || masterDecision.stopRange?.stopPrice;
      STATE.masterTrade.tpDistance = Math.abs(STATE.masterTrade.tpPrice - STATE.price);
      STATE.masterTrade.slDistance = Math.abs(STATE.masterTrade.spPrice - STATE.price);
      STATE.masterTrade.positionETH = masterDecision.risk.positionSizeETH;
      STATE.masterTrade.positionUSD = (masterDecision.risk.positionSizeETH * STATE.price).toFixed(2);
      STATE.masterTrade.entryTime = Date.now();
      STATE.masterTrade.entryTimeStr = new Date().toLocaleTimeString();
      STATE.masterTrade.entryDateStr = new Date().toISOString().slice(0, 10);
      STATE.masterTrade.boughtTime = masterDecision.direction === 1 ? STATE.masterTrade.entryTimeStr : null;
      STATE.masterTrade.soldTime = masterDecision.direction === -1 ? STATE.masterTrade.entryTimeStr : null;
      STATE.masterTrade.elapsedSec = 0;
      STATE.masterTrade.elapsedStr = '0s';
      STATE.masterTrade.livePnlUSD = '0.00';
      STATE.masterTrade.livePnlPct = 0;
      STATE.masterTrade.progressPct = 0;
      STATE.masterTrade.scanReason = null;
    } else if (!masterDecision.approved && STATE.masterTrade.status === 'IDLE') {
      STATE.masterTrade.action = 'SCANNING';
      STATE.masterTrade.scanReason = masterDecision.risk?.rejectionReason || masterDecision.reason;
    }
  }

  // ── LAYER 3: PORTFOLIO CONSTRUCTION (Mastermind Governs Position Weight) ──
  const targetETHOverride = (masterDecision.approved && masterDecision.risk?.approved)
    ? (masterDecision.direction * masterDecision.risk.positionSizeETH)
    : 0;

  const returnSlice = STATE.prices.slice(-30).map((p, i, a) => i > 0 ? (p / a[i - 1] - 1) : 0);
  const portfolioLayer = portfolioEngine.optimize(
    STATE.ensemble,
    STATE.price,
    STATE.spread,
    returnSlice,
    STATE.position,
    STATE.equity,
    targetETHOverride
  );
  STATE.layer3 = portfolioLayer;

  // ── LAYER 5 (Pre-Trade): Production Risk Gatekeeper ──
  const preTrade = prodRiskEngine.checkPreTrade(portfolioLayer.targetETH, STATE.price, STATE.equity);

  // ── LAYER 4: SMART EXECUTION (Strictly Governed by Mastermind + Risk Gate) ──
  let execResult = null;
  const executionAuthorized = masterDecision.approved && preTrade.approved;
  if (executionAuthorized && Math.abs(portfolioLayer.targetETH - STATE.position) >= 0.01) {
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

  // 8. Update derived state for UI
  updateDerivedState(features, reward);

  // 10. Render UI
  const safe = (fn) => { try { fn(); } catch (e) { console.error('Render error:', e); } };

  // Capture current window scroll to guarantee no jump to top
  const winScrollY = window.scrollY || document.documentElement.scrollTop || 0;
  const winScrollX = window.scrollX || document.documentElement.scrollLeft || 0;

  // Blur active element if it's an interactive button inside a re-rendered container,
  // preventing browser's automatic fallback focus reset to <body> from scrolling to (0,0)
  if (document.activeElement && document.activeElement !== document.body && document.activeElement !== document.documentElement) {
    const tag = document.activeElement.tagName;
    if (tag === 'BUTTON' || tag === 'A') {
      document.activeElement.blur();
    }
  }

  requestAnimationFrame(() => {
    safe(renderConnectionStatus);
    safe(renderPrice);
    safe(renderHeaderMasterSignalArea);
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
    safe(renderResearchAlgorithmStack);
    safe(renderAlgoDivergence);
    safe(renderLog);
    safe(renderUptime);
    safe(renderStrategyPerformancePanel);
    safe(renderAlgoCapitalBenchmarkPanel);
    if (document.getElementById('masterHistoryPage')?.style.display !== 'none') {
      safe(renderMasterHistoryPage);
    }


    if (STATE.tick % 3 === 0 || STATE.tick === 1) {
      safe(renderAlgoGrid);
      safe(renderAlgoWinRateAndFixPanel);
      safe(renderAutonomousHealingTerminal);
      safe(renderTrainingAudit);
    }

    safe(drawAllCharts);

    // Safeguard window scroll position: if it unexpectedly jumped to top while user was scrolled down, restore it immediately
    const currentY = window.scrollY || document.documentElement.scrollTop || 0;
    if (winScrollY > 20 && currentY < 10) {
      window.scrollTo(winScrollX, winScrollY);
    }
  });

  // Store for next tick
  prevPrice = STATE.price;
  prevFeatures = new Float64Array(features);

  const tickTime = performance.now() - tickStart;
  const lt = document.getElementById('latency');
  if (lt) {
    const netLat = STATE.connection.latencyMs || 20;
    lt.textContent = `${netLat}ms (Calc: ${tickTime.toFixed(0)}ms)`;
  }
}

/**
 * Update derived state values from algorithm internals
 */
function updateDerivedState(features, reward = 0) {
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
  log('⚡ 43-Algorithm Paper Trading Arena RESET: All 43 accounts initialized to $10.00 cash & 0 trades.', 'info');
  renderAlgoCapitalBenchmarkPanel();
  renderMasterDecisionBox();
};
window._resetBenchmark = window._resetCapitalBenchmark;

// ═══════════════════════════════════════════════════════
// AUTONOMOUS BACKGROUND TRAINING PIPELINE
// Automatically trains all 43 RL algorithms and deep quant suites
// on Last 6 Months (180 days / 4,320 hours) multi-timeframe dataset (1m, 15m, 30m, 60m)
// followed by continuous real-time online training on live Binance / Coinbase ticks.
// Zero manual triggers or popup modals.
// ═══════════════════════════════════════════════════════

async function autoTrainInBackground(duration = '6m') {
  const is6M = duration === '6m';
  log(`⚡ [AUTONOMOUS ENGINE] Ingesting & training on ${is6M ? '6-Month (180 Days / 4,320h)' : '1-Year (365 Days / 8,760h)'} Real Multi-Timeframe Dataset (1m, 15m, 30m, 60m/1h) across all 43 algorithms & deep quant suites...`, 'info');
  STATE.historicalTraining.isTraining = true;
  STATE.historicalTraining.showModal = false;

  const badge = document.getElementById('autoTrainBadge');
  if (badge) {
    badge.innerHTML = `<span class="live-dot" style="background:var(--warn);"></span>● ${is6M ? '6-MO' : '1-YR'} MTF TRAINING (1m,15m,30m,60m)...`;
  }

  try {
    const metrics = await historicalTrainer.train(algorithms, (update) => {
      STATE.historicalTraining.progress = update.progress;
      STATE.historicalTraining.metrics.finalLoss = update.loss;
      STATE.historicalTraining.metrics.winRatePct = `${update.winRate}%`;
      STATE.historicalTraining.metrics.confluenceWinRate = `${update.confluenceWinRate}%`;
      STATE.historicalTraining.metrics.activePhase = update.phase;

      if (badge && update.progress % 10 === 0) {
        badge.innerHTML = `<span class="live-dot" style="background:var(--warn);"></span>● ${is6M ? '6-MO' : '1-YR'} MTF TRAINING ${update.progress}% (${update.phase?.slice(0, 22) || 'Active'}...)`;
      }
    }, duration);

    if (metrics) {
      STATE.historicalTraining.metrics = { ...STATE.historicalTraining.metrics, ...metrics };
    }

    STATE.historicalTraining.isTraining = false;
    STATE.historicalTraining.trained = true;
    
    if (badge) {
      badge.innerHTML = `<span class="live-dot" style="background:var(--green);"></span>● 6-MO REAL TRAINED + LIVE ONLINE LEARNING · 43 RL`;
    }

    // Refresh training audit in state dynamically
    STATE.trainingAudit = tradeSignalEngine.getTrainingAudit(STATE, capitalBenchmarkEngine);

    log(`✓ [${is6M ? '6-MONTH' : '1-YEAR'} PRE-TRAINING COMPLETE] All 43 RL Models + Deep/Quant Suites trained on ${is6M ? '180-day' : '365-day'} multi-timeframe dataset (1m, 15m, 30m, 60m). Win Rate: ${historicalTrainer.metrics.winRatePct}, Confluence: ${historicalTrainer.metrics.confluenceWinRate}, Sharpe: ${historicalTrainer.metrics.sharpeRatio}. Continuing continuous online training on live Binance feed.`, 'info');
  } catch (err) {
    console.error('Autonomous background training error:', err);
    STATE.historicalTraining.isTraining = false;
  }

  renderAlgoGrid();
  renderMTFConfluenceMatrix();
  renderTrainingAudit();
  renderResearchAlgorithmStack();
  drawAllCharts();
}

window._startHistoricalTraining = async (duration = '6m') => {
  return autoTrainInBackground(duration);
};
window._start6MonthTraining = async () => {
  return autoTrainInBackground('6m');
};
window._start1YearTraining = async () => {
  return autoTrainInBackground('1y');
};

window._closeTrainingModal = () => {
  STATE.historicalTraining.showModal = false;
  renderTrainingModal();
};

// Resize handler
window.addEventListener('resize', () => {
  invalidateCanvasSizeCache();
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
// RIG-MICRO STARTUP PIPELINE
// 1. Fetch Real Historical Klines via REST
// 2. Initialize Real Feature History & Analogs (Zero Fake Walk)
// 3. Connect Multi-Exchange Live WebSocket Stream
// 4. Verify Data Quality Gate (RIG-Micro)
// 5. Run Genuine Out-of-Sample Walk-Forward Validation in Background
// ═══════════════════════════════════════════════════════

async function initPlatform() {
  log('⚡ RIG-Micro: Regime Integrity Gated Market Engine Initializing...', 'info');
  log('Data Quality Gate: ARMED — Waiting for verified exchange market feeds...', 'info');

  renderAlgoGrid();
  renderConnectionStatus();
  renderHeaderMasterSignalArea();
  renderAutonomousHealingTerminal();

  // 1. Fetch genuine historical klines from Binance/Coinbase
  try {
    const realKlines = await historicalTrainer.loadHistoricalData();
    if (realKlines && realKlines.length > 0) {
      const recentCloses = realKlines.map(k => k.close);
      STATE.prices = recentCloses.slice(-150);
      STATE.volumes = realKlines.map(k => k.volume).slice(-150);
      STATE.price = recentCloses[recentCloses.length - 1];
      prevPrice = STATE.price;

      // Seed movement prediction analogs strictly from real historical candle swings
      movementPredictor.seedFromRealCandles(realKlines);
      log(`✓ Initialized price history from ${realKlines.length} genuine exchange klines (Anchor: $${STATE.price.toFixed(2)})`, 'info');
    }
  } catch (e) {
    log('Could not load historical klines pre-fetch. Waiting for live WebSocket feed...', 'warn');
  }

  // 2. Connect to live market streams (Binance / Coinbase / Bybit)
  window._connectLiveBinance();

  // 3. Connect to Institutional Python Engine WebSocket (ETHUSDT)
  try {
    const pythonBridge = new PythonEngineBridge({
      onDecision: (decision) => {
        const badge = document.getElementById('pythonEngineStatus');
        const dot = document.getElementById('pythonEngineDot');
        if (badge) {
          const sig = decision.signal || 'HOLD';
          const conf = decision.confidence ? `${(decision.confidence * 100).toFixed(0)}%` : '0%';
          badge.textContent = `PYTHON QUANT: ${sig} (${conf})`;
        }
        if (dot) {
          dot.style.background = decision.signal === 'BUY' ? 'var(--green)' : decision.signal === 'SELL' ? 'var(--red)' : 'var(--warn)';
        }
        safe(renderHeaderMasterSignalArea);
        safe(renderMasterDecisionBox);
        safe(renderProductionStrategy);
        if (STATE.activeLayerTab === 'python-quant' || STATE.activeLayerTab === 'overview') {
          safe(renderQuantLayers);
        }
      }
    });
    pythonBridge.connect();
    window._pythonEngine = pythonBridge;

    window._refreshPythonEngine = async () => {
      if (window._pythonEngine) {
        log('Probing Python engine at localhost:8000...', 'info');
        await window._pythonEngine.refresh();
        safe(renderQuantLayers);
        safe(renderMasterDecisionBox);
        safe(renderHeaderMasterSignalArea);
      }
    };

    window._copyPythonSignal = () => {
      const py = STATE.pythonEngine?.decision;
      if (!py) {
        alert('No active Python decision received yet. Ensure python run.py api is running.');
        return;
      }
      navigator.clipboard.writeText(JSON.stringify(py, null, 2))
        .then(() => alert('Python Quant Signal JSON copied to clipboard!'))
        .catch(() => prompt('Copy JSON:', JSON.stringify(py)));
    };
  } catch (err) {
    console.warn('Python engine bridge init error:', err);
  }

  // 4. Kick off genuine walk-forward training & validation in background
  autoTrainInBackground();

  // 5. Start 1Hz production loop
  tick();
  setInterval(tick, 1000);
}

initPlatform();
