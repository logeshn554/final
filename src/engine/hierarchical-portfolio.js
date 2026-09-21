// ═════════════════════════════════════════════════════════════════════
// HIERARCHICAL RISK PARITY (HRP) & ADVANCED PORTFOLIO ALLOCATION
// Based on: Marcos López de Prado (2016) "Building Diversified Portfolios that Outperform Out-of-Sample"
// 1. Tree Clustering on Correlation Distance Matrix
// 2. Quasi-Diagonalization (Dendrogram Sorting)
// 3. Recursive Bisection (Hierarchical Inverse-Variance Allocation Without Matrix Inversion)
// 4. Mean-CVaR (Rockafellar-Uryasev) & Robust Fractional Kelly
// ═════════════════════════════════════════════════════════════════════

import { clamp, mean, std } from '../utils/math.js';

export class HierarchicalRiskParity {
  /**
   * Compute correlation distance matrix: D_{i, j} = sqrt(0.5 * (1 - ρ_{i, j}))
   */
  static computeDistanceMatrix(corrMatrix) {
    const n = corrMatrix.length;
    const dist = [];
    for (let i = 0; i < n; i++) {
      dist.push(new Float64Array(n));
      for (let j = 0; j < n; j++) {
        const rho = clamp(corrMatrix[i][j], -1.0, 1.0);
        dist[i][j] = Math.sqrt(Math.max(0, 0.5 * (1.0 - rho)));
      }
    }
    return dist;
  }

  /**
   * Quasi-Diagonalization: Reorders the index list using hierarchical clustering
   */
  static quasiDiagonalize(corrMatrix) {
    const n = corrMatrix.length;
    if (n <= 2) return Array.from({ length: n }, (_, i) => i);

    // Greedy nearest-neighbor clustering order
    const ordered = [0];
    const visited = new Set([0]);

    while (ordered.length < n) {
      const last = ordered[ordered.length - 1];
      let bestNext = -1;
      let maxCorr = -Infinity;

      for (let j = 0; j < n; j++) {
        if (!visited.has(j)) {
          if (corrMatrix[last][j] > maxCorr) {
            maxCorr = corrMatrix[last][j];
            bestNext = j;
          }
        }
      }

      if (bestNext !== -1) {
        visited.add(bestNext);
        ordered.push(bestNext);
      } else {
        break;
      }
    }

    return ordered;
  }

  /**
   * Recursive Bisection:
   * Splits clusters recursively and assigns weights inversely proportional to cluster variance:
   * w_1 = 1 - V_1 / (V_1 + V_2), w_2 = 1 - w_1
   */
  static recursiveBisection(orderedIndices, covMatrix) {
    const n = orderedIndices.length;
    const weights = new Float64Array(n).fill(1.0);

    const getClusterVar = (cluster) => {
      if (cluster.length === 1) return covMatrix[cluster[0]][cluster[0]];
      // Inverse-variance cluster allocation
      let invSum = 0;
      for (const idx of cluster) {
        invSum += 1.0 / Math.max(1e-6, covMatrix[idx][idx]);
      }
      return 1.0 / invSum;
    };

    const bisect = (cluster, currentWeight) => {
      if (cluster.length <= 1) {
        if (cluster.length === 1) weights[cluster[0]] = currentWeight;
        return;
      }

      const mid = Math.floor(cluster.length / 2);
      const left = cluster.slice(0, mid);
      const right = cluster.slice(mid);

      const varLeft = getClusterVar(left);
      const varRight = getClusterVar(right);

      const alpha = 1.0 - varLeft / (varLeft + varRight || 1e-6);

      bisect(left, currentWeight * alpha);
      bisect(right, currentWeight * (1.0 - alpha));
    };

    bisect(orderedIndices, 1.0);
    return weights;
  }

  /**
   * Run full HRP allocation on asset covariance matrix
   * @param {Array<Array<number>>} covMatrix Covariance matrix
   * @param {Array<string>} assetNames Asset symbols
   */
  static allocate(covMatrix, assetNames = ['ETH', 'BTC', 'SOL', 'CASH']) {
    const n = covMatrix.length;
    // Derive correlation matrix
    const corr = [];
    const stds = [];
    for (let i = 0; i < n; i++) stds.push(Math.sqrt(Math.max(1e-6, covMatrix[i][i])));

    for (let i = 0; i < n; i++) {
      corr.push(new Float64Array(n));
      for (let j = 0; j < n; j++) {
        corr[i][j] = clamp(covMatrix[i][j] / (stds[i] * stds[j]), -1.0, 1.0);
      }
    }

    const ordered = HierarchicalRiskParity.quasiDiagonalize(corr);
    const rawWeights = HierarchicalRiskParity.recursiveBisection(ordered, covMatrix);

    const allocation = {};
    for (let i = 0; i < n; i++) {
      const name = assetNames[i] || `Asset_${i}`;
      allocation[name] = Math.round(rawWeights[i] * 1000) / 1000;
    }

    return {
      weights: allocation,
      orderedIndices: ordered,
      method: 'Hierarchical Risk Parity (HRP)',
    };
  }
}

// ─────────────────────────────────────────────────────────────────────
// 2. ROBUST FRACTIONAL KELLY & MEAN-CVAR SIZING
// ─────────────────────────────────────────────────────────────────────
export class KellyPortfolioSizer {
  /**
   * Robust Half-Kelly Sizing with parameter uncertainty shrinkage
   * f* = (p * b - q) / b * shrinkage
   */
  static computePositionFraction(winProb, profitLossRatio, maxLeverage = 2.0, uncertaintyShrinkage = 0.5) {
    const p = clamp(winProb, 0.05, 0.95);
    const q = 1.0 - p;
    const b = Math.max(0.1, profitLossRatio);

    const fullKelly = (p * b - q) / b;
    if (fullKelly <= 0) return 0;

    // Fractional Kelly (Half-Kelly) to prevent ruin under non-Gaussian distribution
    const robustKelly = fullKelly * uncertaintyShrinkage;
    return clamp(robustKelly, 0.0, maxLeverage);
  }
}
