// ═══════════════════════════════════════════════════════
// CONFIGURATION — Algorithm Definitions & Hyperparameters
// ═══════════════════════════════════════════════════════

export const ALGORITHMS = [
  // VALUE-BASED
  { id:1,  name:'Markov Chain',     cat:'value',    tag:'MC',       desc:'Transition probs' },
  { id:2,  name:'MDP',              cat:'value',    tag:'MDP',      desc:'State transitions' },
  { id:3,  name:'Rewards/Returns',  cat:'value',    tag:'RET',      desc:'Cumulative G_t' },
  { id:4,  name:'Value Fn V(s)',    cat:'value',    tag:'VFN',      desc:'State value est' },
  { id:5,  name:'Bellman Eq',       cat:'value',    tag:'BEL',      desc:'Optimality check' },
  { id:6,  name:'Dynamic Prog',    cat:'value',    tag:'DP',       desc:'Policy iteration' },
  { id:7,  name:'Monte Carlo',     cat:'value',    tag:'MCR',      desc:'Episode returns' },
  { id:8,  name:'TD Learning',     cat:'value',    tag:'TD',       desc:'TD(λ) error' },
  { id:9,  name:'SARSA',           cat:'value',    tag:'SARSA',    desc:'On-policy Q' },
  { id:10, name:'Q-Learning',      cat:'value',    tag:'QL',       desc:'Off-policy Q*' },
  { id:11, name:'Exploration',     cat:'value',    tag:'EXP',      desc:'ε-greedy/UCB/NE' },
  { id:12, name:'DQN',             cat:'value',    tag:'DQN',      desc:'Deep Q-network' },
  { id:13, name:'Double/Dueling',  cat:'value',    tag:'D3QN',     desc:'Overestim. fix' },
  // POLICY-BASED
  { id:14, name:'Policy Gradient', cat:'policy',   tag:'PG',       desc:'REINFORCE ∇J(θ)' },
  { id:15, name:'Actor-Critic',    cat:'policy',   tag:'AC',       desc:'V baseline' },
  { id:16, name:'A2C/A3C',         cat:'policy',   tag:'A3C',      desc:'Async workers' },
  { id:17, name:'GAE',             cat:'policy',   tag:'GAE',      desc:'Adv estimation' },
  { id:18, name:'PPO',             cat:'policy',   tag:'PPO',      desc:'Clip ratio π' },
  { id:19, name:'DDPG',            cat:'policy',   tag:'DDPG',     desc:'Deterministic PG' },
  { id:20, name:'TD3',             cat:'policy',   tag:'TD3',      desc:'Twin critic' },
  { id:21, name:'SAC',             cat:'policy',   tag:'SAC',      desc:'Max entropy' },
  // MODEL-BASED
  { id:22, name:'Model-Based RL',  cat:'model',    tag:'MBRL',     desc:'Env dynamics' },
  { id:23, name:'POMDP',           cat:'model',    tag:'POMDP',    desc:'Partial obs' },
  { id:24, name:'Offline RL',      cat:'model',    tag:'ORL',      desc:'Historical data' },
  { id:25, name:'Imitation Learn', cat:'model',    tag:'IL',       desc:'Expert trades' },
  // ADVANCED
  { id:26, name:'Multi-Agent RL',  cat:'advanced', tag:'MARL',     desc:'Market makers' },
  { id:27, name:'Hierarchical RL', cat:'advanced', tag:'HRL',      desc:'Goal hierarchy' },
  { id:28, name:'Distributional',  cat:'advanced', tag:'C51',      desc:'Return dist' },
  { id:29, name:'Risk-Sensitive',  cat:'advanced', tag:'RSRL',     desc:'CVaR/VaR risk' },
  { id:30, name:'Meta-RL',         cat:'advanced', tag:'MAML',     desc:'Fast adapt' },
  { id:31, name:'World Models',    cat:'advanced', tag:'WM',       desc:'Dreamer rollout' },
  { id:32, name:'Multi-Objective', cat:'advanced', tag:'MORL',     desc:'Pareto front' },
  { id:33, name:'Safe RL',         cat:'advanced', tag:'SRL',      desc:'Constraint sat' },
  { id:34, name:'Transformer RL',  cat:'advanced', tag:'GTrXL',    desc:'Seq attention' },
  // RESEARCH-GRADE EXTENDED SUITE (35-43)
  { id:35, name:'QR-DQN',          cat:'advanced', tag:'QRDQN',    desc:'Quantile regression' },
  { id:36, name:'IQN',             cat:'advanced', tag:'IQN',      desc:'Implicit quantiles' },
  { id:37, name:'FQF',             cat:'advanced', tag:'FQF',      desc:'Fraction proposal' },
  { id:38, name:'IQL',             cat:'model',    tag:'IQL',      desc:'In-sample expectile' },
  { id:39, name:'Conservative Q',  cat:'model',    tag:'CQL',      desc:'OOD Q-penalty' },
  { id:40, name:'Decision Xformer',cat:'advanced', tag:'DT',       desc:'Return-to-go causal' },
  { id:41, name:'TD-MPC2',         cat:'model',    tag:'TDMPC2',   desc:'Latent planning' },
  { id:42, name:'CPO Lagrangian',  cat:'advanced', tag:'CPO',      desc:'Constrained policy' },
  { id:43, name:'Option-Critic',   cat:'advanced', tag:'OC',       desc:'Hierarchical options' },
];

// Trading actions
export const ACTIONS = {
  BUY: 0,
  HOLD: 1,
  SELL: 2,
};

export const ACTION_NAMES = ['BUY', 'HOLD', 'SELL'];
export const NUM_ACTIONS = 3;

// Feature configuration
export const FEATURE_DIM = 20;

export const HYPERPARAMS = {
  // General
  gamma: 0.99,           // Discount factor
  lambda: 0.95,          // GAE lambda
  lr: 0.001,             // Learning rate
  tau: 0.005,            // Target network soft update rate

  // Exploration
  epsilonStart: 1.0,
  epsilonEnd: 0.05,
  epsilonDecay: 0.995,

  // Buffer
  bufferSize: 10000,
  batchSize: 32,
  minBufferSize: 64,

  // PPO
  ppoClipRatio: 0.2,
  ppoEpochs: 4,

  // SAC
  sacAlpha: 0.2,         // Entropy coefficient

  // Network sizes
  hiddenSize1: 32,
  hiddenSize2: 16,

  // Risk
  maxPositionETH: 5.0,
  maxDrawdownPct: 5.0,
  riskFreeRate: 0.04,

  // Ensemble
  ensembleWeightDecay: 0.01,

  // Discretization (for tabular methods)
  numDiscreteStates: 50,
  numPriceBins: 10,

  // Autonomous Self-Healing & Dynamic Adaptation
  healing: {
    autoFixEnabled: true,
    errorSensitivity: 0.15,
    minTradesForEvaluation: 3,
    quarantineThresholdLosses: 4,
    recalibrationBoostPct: 0.08,
    volatilityExpansionBuffer: 1.25,
    chopConfidenceHurdle: 0.58,
  },
};

// Dynamic Market Instrument Configuration
export const MARKET_CONFIG = {
  defaultSymbol: 'ETHUSDT',
  benchmarkSymbol: 'BTCUSDT',
  baseAsset: 'ETH',
  quoteAsset: 'USDT',
};
