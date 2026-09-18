// ═══════════════════════════════════════════════════════
// ALGORITHM REGISTRY — Instantiate and manage all 34 algorithms
// ═══════════════════════════════════════════════════════

import {
  MarkovChainAlgo, MDPAlgo, RewardsReturnsAlgo, ValueFunctionAlgo,
  BellmanAlgo, DynamicProgAlgo, MonteCarloAlgo, TDLearningAlgo,
  SARSAAlgo, QLearningAlgo, ExplorationAlgo, DQNAlgo, DoubleDuelingDQNAlgo,
} from './value-based.js';

import {
  PolicyGradientAlgo, ActorCriticAlgo, A2CA3CAlgo, GAEAlgo,
  PPOAlgo, DDPGAlgo, TD3Algo, SACAlgo,
} from './policy-based.js';

import {
  ModelBasedRLAlgo, POMDPAlgo, OfflineRLAlgo, ImitationLearningAlgo,
} from './model-based.js';

import {
  MultiAgentRLAlgo, HierarchicalRLAlgo, DistributionalRLAlgo,
  RiskSensitiveRLAlgo, MetaRLAlgo, WorldModelsAlgo,
  MultiObjectiveRLAlgo, SafeRLAlgo, TransformerRLAlgo,
} from './advanced.js';

/** Create all 34 algorithm instances */
export function createAlgorithms() {
  return [
    new MarkovChainAlgo(),        // 1
    new MDPAlgo(),                // 2
    new RewardsReturnsAlgo(),     // 3
    new ValueFunctionAlgo(),      // 4
    new BellmanAlgo(),            // 5
    new DynamicProgAlgo(),        // 6
    new MonteCarloAlgo(),         // 7
    new TDLearningAlgo(),         // 8
    new SARSAAlgo(),              // 9
    new QLearningAlgo(),          // 10
    new ExplorationAlgo(),        // 11
    new DQNAlgo(),                // 12
    new DoubleDuelingDQNAlgo(),   // 13
    new PolicyGradientAlgo(),     // 14
    new ActorCriticAlgo(),        // 15
    new A2CA3CAlgo(),             // 16
    new GAEAlgo(),                // 17
    new PPOAlgo(),                // 18
    new DDPGAlgo(),               // 19
    new TD3Algo(),                // 20
    new SACAlgo(),                // 21
    new ModelBasedRLAlgo(),       // 22
    new POMDPAlgo(),              // 23
    new OfflineRLAlgo(),          // 24
    new ImitationLearningAlgo(),  // 25
    new MultiAgentRLAlgo(),       // 26
    new HierarchicalRLAlgo(),     // 27
    new DistributionalRLAlgo(),   // 28
    new RiskSensitiveRLAlgo(),    // 29
    new MetaRLAlgo(),             // 30
    new WorldModelsAlgo(),        // 31
    new MultiObjectiveRLAlgo(),   // 32
    new SafeRLAlgo(),             // 33
    new TransformerRLAlgo(),      // 34
  ];
}
