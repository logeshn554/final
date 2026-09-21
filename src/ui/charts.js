// ═══════════════════════════════════════════════════════
// CHARTS — Canvas rendering for all charts
// ═══════════════════════════════════════════════════════

import { STATE } from '../state.js';
import { fmtPrice, clamp, mean, rnd } from '../utils/math.js';

export function getCanvasDimensions(canvas, defaultW, defaultH) {
  let W = canvas._cachedW;
  if (!W) {
    W = canvas.offsetWidth || defaultW;
    if (W > 0) canvas._cachedW = W;
  }
  if (canvas.width !== W) canvas.width = W;
  if (canvas.height !== defaultH) canvas.height = defaultH;
  return { W, H: defaultH };
}

export function invalidateCanvasSizeCache() {
  const ids = [
    'sparkCanvas', 'priceChart', 'ensembleChart', 'worldModelChart',
    'gaeChart', 'statArbChart', 'acTrajectoryChart', 'attributionChart'
  ];
  ids.forEach(id => {
    const c = document.getElementById(id);
    if (c) c._cachedW = null;
  });
}

/** Draw sparkline */
export function drawSpark() {
  const canvas = document.getElementById('sparkCanvas');
  if (!canvas) return;
  const { W, H } = getCanvasDimensions(canvas, 200, 40);
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, W, H);

  const data = STATE.prices.slice(-30);
  if (data.length < 2) return;
  const mn = Math.min(...data);
  const mx = Math.max(...data);
  const rng = mx - mn || 1;

  ctx.beginPath();
  data.forEach((p, i) => {
    const x = i / (data.length - 1) * W;
    const y = H - ((p - mn) / rng) * (H - 4) - 2;
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  });
  ctx.strokeStyle = '#00d4ff';
  ctx.lineWidth = 1.5;
  ctx.stroke();

  const grad = ctx.createLinearGradient(0, 0, 0, H);
  grad.addColorStop(0, 'rgba(0,212,255,0.2)');
  grad.addColorStop(1, 'rgba(0,212,255,0)');
  ctx.lineTo(W, H);
  ctx.lineTo(0, H);
  ctx.closePath();
  ctx.fillStyle = grad;
  ctx.fill();
}

/** Draw main price chart — Renders Japanese Candlesticks across 3m, 15m, 30m, 1h */
export function drawPriceChart() {
  const canvas = document.getElementById('priceChart');
  if (!canvas) return;
  const { W, H } = getCanvasDimensions(canvas, 500, 240);
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, W, H);

  const tf = STATE.selectedTimeframe || STATE.tf || '15m';
  const candles = STATE.mtfEngine ? STATE.mtfEngine.getCandles(tf) : [];

  // Grid
  ctx.strokeStyle = 'rgba(26,48,96,0.45)';
  ctx.lineWidth = 0.5;
  for (let i = 0; i <= 5; i++) {
    const y = i * H / 5;
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
  }
  for (let i = 0; i <= 8; i++) {
    const x = i * W / 8;
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
  }

  // If multi-timeframe candles are available, render full Japanese Candlesticks
  // If multi-timeframe candles are available, render full Japanese Candlesticks with pattern badges
  if (candles && candles.length >= 5) {
    const visible = candles.slice(-42);
    const lows = visible.map(c => c.low);
    const highs = visible.map(c => c.high);
    const mn = Math.min(...lows) - 2;
    const mx = Math.max(...highs) + 2;
    const rng = mx - mn || 1;
    const toY = (p) => H - ((p - mn) / rng) * (H - 55) - 28;
    const xStep = W / visible.length;
    const candleW = Math.max(3, Math.min(11, Math.floor(xStep * 0.72)));

    // ── Support & Resistance Horizontal Zones ──
    const resY1 = toY(mx - 1);
    const resY2 = toY(mx);
    ctx.fillStyle = 'rgba(239, 68, 68, 0.08)';
    ctx.fillRect(0, Math.min(resY1, resY2), W, Math.abs(resY1 - resY2) + 8);
    ctx.fillStyle = 'rgba(239, 68, 68, 0.4)';
    ctx.font = '8px JetBrains Mono, monospace';
    ctx.fillText('SUPPLY RESISTANCE ZONE', 10, Math.min(resY1, resY2) + 7);

    const supY1 = toY(mn);
    const supY2 = toY(mn + 1);
    ctx.fillStyle = 'rgba(16, 185, 129, 0.08)';
    ctx.fillRect(0, Math.min(supY1, supY2) - 8, W, Math.abs(supY1 - supY2) + 8);
    ctx.fillStyle = 'rgba(16, 185, 129, 0.4)';
    ctx.fillText('DEMAND SUPPORT ZONE', 10, Math.max(supY1, supY2) + 2);

    // Q-value overlay in background
    if (STATE.qValues.length > 5) {
      const qd = STATE.qValues.slice(-visible.length);
      const qmn = Math.min(...qd); const qmx = Math.max(...qd);
      const qrng = qmx - qmn || 1;
      ctx.beginPath();
      qd.forEach((q, i) => {
        const x = i * xStep + xStep / 2;
        const y = H - ((q - qmn) / qrng) * (H * 0.28) - 10;
        i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      });
      ctx.strokeStyle = 'rgba(245, 158, 11, 0.40)';
      ctx.lineWidth = 1;
      ctx.stroke();
    }

    // 9-period EMA overlay
    if (visible.length >= 9) {
      ctx.beginPath();
      let k = 2 / (9 + 1);
      let emaVal = visible[0].close;
      visible.forEach((c, i) => {
        emaVal = c.close * k + emaVal * (1 - k);
        const x = i * xStep + xStep / 2;
        const y = toY(emaVal);
        i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      });
      ctx.strokeStyle = 'rgba(0, 212, 255, 0.65)';
      ctx.lineWidth = 1.2;
      ctx.stroke();
    }

    // Draw Japanese Candlesticks with Anatomy Details (Wicks + Bodies + Rejections)
    visible.forEach((c, i) => {
      const xCenter = Math.floor(i * xStep + xStep / 2);
      const isBull = c.close >= c.open;
      const col = isBull ? '#10b981' : '#ef4444';
      const fillCol = isBull ? 'rgba(16, 185, 129, 0.90)' : 'rgba(239, 68, 68, 0.90)';

      const yHigh = toY(c.high);
      const yLow = toY(c.low);
      const yOpen = toY(c.open);
      const yClose = toY(c.close);

      // Wick (High-Low Line)
      ctx.beginPath();
      ctx.moveTo(xCenter, yHigh);
      ctx.lineTo(xCenter, yLow);
      ctx.strokeStyle = col;
      ctx.lineWidth = 1.2;
      ctx.stroke();

      // Real Body (Open-Close Rect)
      const topY = Math.min(yOpen, yClose);
      const bodyH = Math.max(2, Math.abs(yClose - yOpen));
      ctx.fillStyle = fillCol;
      ctx.fillRect(xCenter - Math.floor(candleW / 2), topY, candleW, bodyH);
      ctx.strokeStyle = col;
      ctx.lineWidth = 0.8;
      ctx.strokeRect(xCenter - Math.floor(candleW / 2), topY, candleW, bodyH);

      // Individual Wick Rejection Markers (> 2x body)
      const body = Math.abs(c.close - c.open);
      const upperWick = isBull ? c.high - c.close : c.high - c.open;
      const lowerWick = isBull ? c.open - c.low : c.close - c.low;

      if (upperWick >= Math.max(0.08, body * 2.0) && i > visible.length - 12) {
        // Bearish Upper Wick Rejection marker
        ctx.fillStyle = '#ef4444';
        ctx.font = 'bold 7px monospace';
        ctx.fillText('▼', xCenter - 3, yHigh - 3);
      }
      if (lowerWick >= Math.max(0.08, body * 2.0) && i > visible.length - 12) {
        // Bullish Lower Wick Rejection marker
        ctx.fillStyle = '#10b981';
        ctx.font = 'bold 7px monospace';
        ctx.fillText('▲', xCenter - 3, yLow + 8);
      }
    });

    // ── Multi-Candle Pattern Markers across Chart History ──
    if (STATE.candlestickEngine && visible.length >= 5) {
      const detected = STATE.candlestickEngine.scanVisibleCandles(visible);
      let lastMarkedIdx = -5;
      detected.forEach(d => {
        const i = d.index;
        const p = d.pattern;
        const isFiveStar = p.reliability === '★★★★★';
        // Avoid crowded overlap unless 5-star priority
        if (i - lastMarkedIdx < 2 && !isFiveStar) return;
        lastMarkedIdx = i;

        const c = visible[i];
        const xC = Math.floor(i * xStep + xStep / 2);
        const isBull = p.type === 'BULLISH' || (c.close >= c.open && p.category !== 'Continuation');
        const isIndecision = p.category === 'Indecision' || p.patternType === 'Indecision';
        const pCol = isIndecision ? '#f59e0b' : isBull ? '#10b981' : '#ef4444';
        const pTypeLabel = (p.patternType || p.category || 'REVERSAL').toUpperCase();

        const isAbove = !isBull && !isIndecision;
        const yAnchor = isAbove ? toY(c.high) - 14 : toY(c.low) + 14;

        // Directional Pointer Arrow
        ctx.fillStyle = pCol;
        ctx.font = 'bold 8px monospace';
        if (isAbove) {
          ctx.fillText('▼', xC - 3, toY(c.high) - 3);
        } else {
          ctx.fillText('▲', xC - 3, toY(c.low) + 9);
        }

        // Pattern Badge Box
        const pBadgeText = `${p.name.toUpperCase()} ${p.reliability} [${pTypeLabel}]`;
        ctx.font = 'bold 7.5px JetBrains Mono, monospace';
        const pbW = ctx.measureText(pBadgeText).width;
        const pbX = clamp(xC - pbW / 2 - 3, 6, W - pbW - 10);

        ctx.fillStyle = 'rgba(11, 19, 43, 0.94)';
        ctx.fillRect(pbX, yAnchor - 8, pbW + 6, 12);
        ctx.strokeStyle = pCol;
        ctx.lineWidth = 1;
        ctx.strokeRect(pbX, yAnchor - 8, pbW + 6, 12);

        ctx.fillStyle = pCol;
        ctx.fillText(pBadgeText, pbX + 3, yAnchor + 1);
      });
    }

    // Prominent Pattern Badges & Bearish/Bullish Indicators on the Latest Candles
    const tfData = STATE.mtfAnalysis?.timeframes?.[tf];
    const patterns = tfData?.patterns || STATE.candlestickAnalysis?.patterns || [];
    const lastIdx = visible.length - 1;
    const lastC = visible[lastIdx];
    const xCenter = lastIdx * xStep + xStep / 2;
    const isLatestBear = lastC.close < lastC.open;

    // Direct [BEARISH] or [BULLISH] Badge on Active Candle
    const verdictText = isLatestBear ? '▼ BEARISH' : '▲ BULLISH';
    const verdictCol = isLatestBear ? '#ef4444' : '#10b981';
    const verdictY = isLatestBear ? toY(lastC.high) - 20 : toY(lastC.low) + 20;

    ctx.fillStyle = verdictCol;
    ctx.font = 'bold 9px JetBrains Mono, monospace';
    const vTextW = ctx.measureText(verdictText).width;
    const vbx = clamp(xCenter - vTextW / 2 - 4, 10, W - vTextW - 12);
    ctx.fillRect(vbx, verdictY - 9, vTextW + 8, 13);
    ctx.fillStyle = '#050a14';
    ctx.fillText(verdictText, vbx + 4, verdictY + 1);

    // Active Detected Candlestick Pattern Name & Stars
    if (patterns && patterns.length > 0) {
      const p = patterns[0];
      const isBull = p.type === 'BULLISH';
      const patText = `${p.name.toUpperCase()} ${p.reliability || '★★★★☆'} [${(p.patternType || p.category || 'REVERSAL').toUpperCase()}]`;
      ctx.font = 'bold 8px JetBrains Mono, monospace';
      const pW = ctx.measureText(patText).width;
      const pbx = clamp(xCenter - pW / 2 - 4, 10, W - pW - 14);
      const patY = isLatestBear ? verdictY - 14 : verdictY + 14;

      ctx.fillStyle = 'rgba(15, 23, 42, 0.94)';
      ctx.fillRect(pbx, patY - 8, pW + 8, 12);
      ctx.strokeStyle = isBull ? '#10b981' : '#ef4444';
      ctx.lineWidth = 1;
      ctx.strokeRect(pbx, patY - 8, pW + 8, 12);

      ctx.fillStyle = isBull ? '#10b981' : '#ef4444';
      ctx.fillText(patText, pbx + 4, patY + 1);
    }

    // Top-Left Complete HUD: Timeframe + OHLC + Active Anatomy
    const last = visible[visible.length - 1];
    ctx.fillStyle = 'rgba(255, 255, 255, 0.9)';
    ctx.font = '9px JetBrains Mono, monospace';
    const chgPct = ((last.close / last.open - 1) * 100).toFixed(2);
    const chgCol = last.close >= last.open ? '#10b981' : '#ef4444';
    ctx.fillText(`TF: [${tf.toUpperCase()}]  O: ${fmtPrice(last.open)}  H: ${fmtPrice(last.high)}  L: ${fmtPrice(last.low)}  C: ${fmtPrice(last.close)}`, 8, 14);
    ctx.fillStyle = chgCol;
    ctx.fillText(`(${chgPct > 0 ? '+' : ''}${chgPct}%)`, 340, 14);

    // NEXUS-V Production Strategy Status Top HUD Badge
    if (STATE.productionStrategy) {
      const strat = STATE.productionStrategy;
      const stratText = `⚡ NEXUS-V: [${strat.action}] · CONF: ${strat.confluenceScore}%`;
      ctx.font = 'bold 8.5px JetBrains Mono, monospace';
      ctx.fillStyle = strat.confluenceScore >= 70 ? '#10b981' : 'rgba(0, 212, 255, 0.9)';
      const stW = ctx.measureText(stratText).width;
      ctx.fillText(stratText, W - stW - 12, 14);
    }

    // Current price horizontal dashed guide
    const cp = toY(STATE.price);
    ctx.beginPath();
    ctx.moveTo(0, cp);
    ctx.setLineDash([3, 3]);
    ctx.lineTo(W, cp);
    ctx.strokeStyle = 'rgba(0, 212, 255, 0.6)';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.setLineDash([]);

    // Price tag on right axis
    ctx.fillStyle = '#00d4ff';
    ctx.fillRect(W - 65, cp - 7, 65, 14);
    ctx.fillStyle = '#050a14';
    ctx.font = 'bold 9px JetBrains Mono, monospace';
    ctx.fillText(fmtPrice(STATE.price), W - 60, cp + 3);

    // ── Dynamic Trade Setup Overlays: STOP LOSS & TAKE PROFIT ──
    if (STATE.tradeSetup && STATE.tradeSetup.action !== 'NEUTRAL / ACCUMULATE') {
      const ts = STATE.tradeSetup;
      const curP = STATE.price || 2600;
      const posETH = ts.positionETH || (STATE.movementPrediction ? (STATE.movementPrediction.confidence > 70 ? '1.25' : '0.75') : '1.00');
      const mp = STATE.movementPrediction;
      const dynAtr = ts.atrValue || (curP * 0.005);
      const slDist = ts.slDistance || (mp?.adverseMovement?.expected ? parseFloat(mp.adverseMovement.expected) : (ts.stopLoss ? Math.abs(curP - ts.stopLoss) : dynAtr));
      const tp1Dist = ts.tp1Distance || (mp?.predictedMovement?.conservativeMove ? parseFloat(mp.predictedMovement.conservativeMove) : (ts.takeProfit1 ? Math.abs(ts.takeProfit1 - curP) : (ts.tpDistance ? ts.tpDistance * 0.6 : dynAtr)));
      const tp2Dist = ts.tp2Distance || ts.tpDistance || (mp?.predictedMovement?.mainMove ? parseFloat(mp.predictedMovement.mainMove) : (ts.takeProfit2 ? Math.abs(ts.takeProfit2 - curP) : dynAtr));

      const slPct = Math.abs(ts.slPercent || ((slDist / curP) * 100)).toFixed(2);
      const tp1Pct = Math.abs(ts.tp1Percent || ((tp1Dist / curP) * 100)).toFixed(2);
      const tp2Pct = Math.abs(ts.tp2Percent || ((tp2Dist / curP) * 100)).toFixed(2);

      const lossUSD = ts.maxLossUSD || (parseFloat(posETH) * slDist).toFixed(2);
      const gainTp1 = ts.tp1GainUSD || (parseFloat(posETH) * tp1Dist).toFixed(2);
      const gainTp2 = ts.potentialGainUSD || (parseFloat(posETH) * tp2Dist).toFixed(2);

      const isBuy = ts.isBuy !== undefined ? ts.isBuy : (ts.direction >= 0);
      const slAreaName = isBuy ? 'BUY SL AREA' : 'SELL SL AREA';
      const tp1AreaName = isBuy ? 'BUY TP1 AREA' : 'SELL TP1 AREA';
      const tpAreaName = isBuy ? 'BUY TP AREA' : 'SELL TP AREA';

      // Dynamic Stop Loss
      if (ts.stopLoss) {
        const slY = clamp(toY(ts.stopLoss), 15, H - 15);
        ctx.beginPath();
        ctx.setLineDash([4, 3]);
        ctx.moveTo(0, slY);
        ctx.lineTo(W, slY);
        ctx.strokeStyle = '#ef4444';
        ctx.lineWidth = 1.4;
        ctx.stroke();
        ctx.setLineDash([]);

        ctx.font = 'bold 8px JetBrains Mono, monospace';
        const slLabel = `${slAreaName} (-${slPct}%) ${fmtPrice(ts.stopLoss)} (-$${lossUSD} / ${posETH} ETH)`;
        const slWidth = ctx.measureText(slLabel).width + 10;
        ctx.fillStyle = '#ef4444';
        ctx.fillRect(W - slWidth - 5, slY - 7, slWidth, 14);
        ctx.fillStyle = '#ffffff';
        ctx.fillText(slLabel, W - slWidth, slY + 3);
      }

      // Dynamic Take Profit 1 (Scale-Out)
      if (ts.takeProfit1) {
        const tp1Y = clamp(toY(ts.takeProfit1), 15, H - 15);
        ctx.beginPath();
        ctx.setLineDash([4, 3]);
        ctx.moveTo(0, tp1Y);
        ctx.lineTo(W, tp1Y);
        ctx.strokeStyle = '#10b981';
        ctx.lineWidth = 1.0;
        ctx.stroke();
        ctx.setLineDash([]);

        ctx.font = 'bold 8px JetBrains Mono, monospace';
        const tp1Label = `${tp1AreaName} (+${tp1Pct}%) ${fmtPrice(ts.takeProfit1)} (+$${gainTp1} / ${posETH} ETH · Scale 50%)`;
        const tp1Width = ctx.measureText(tp1Label).width + 10;
        ctx.fillStyle = '#10b981';
        ctx.fillRect(W - tp1Width - 5, tp1Y - 7, tp1Width, 14);
        ctx.fillStyle = '#050a14';
        ctx.fillText(tp1Label, W - tp1Width, tp1Y + 3);
      }

      // Dynamic Take Profit 2 (Full Target)
      if (ts.takeProfit2) {
        const tp2Y = clamp(toY(ts.takeProfit2), 15, H - 15);
        ctx.beginPath();
        ctx.setLineDash([4, 3]);
        ctx.moveTo(0, tp2Y);
        ctx.lineTo(W, tp2Y);
        ctx.strokeStyle = '#10b981';
        ctx.lineWidth = 1.5;
        ctx.stroke();
        ctx.setLineDash([]);

        ctx.font = 'bold 8px JetBrains Mono, monospace';
        const tp2Label = `${tpAreaName} (+${tp2Pct}%) ${fmtPrice(ts.takeProfit2)} (+$${gainTp2} / ${posETH} ETH)`;
        const tp2Width = ctx.measureText(tp2Label).width + 10;
        ctx.fillStyle = '#10b981';
        ctx.fillRect(W - tp2Width - 5, tp2Y - 7, tp2Width, 14);
        ctx.fillStyle = '#050a14';
        ctx.fillText(tp2Label, W - tp2Width, tp2Y + 3);
      }

      // Breakeven Ratchet Overlay (when triggered by NEXUS-V Production Strategy)
      if (STATE.productionStrategy?.activeTrade?.ratchetEngaged) {
        const bePrice = STATE.productionStrategy.activeTrade.currentSLPrice;
        const beY = clamp(toY(bePrice), 15, H - 15);
        ctx.beginPath();
        ctx.setLineDash([2, 2]);
        ctx.moveTo(0, beY);
        ctx.lineTo(W, beY);
        ctx.strokeStyle = '#00d4ff';
        ctx.lineWidth = 1.3;
        ctx.stroke();
        ctx.setLineDash([]);

        ctx.font = 'bold 8px JetBrains Mono, monospace';
        const beLabel = `RATCHET ${fmtPrice(bePrice)} (+0.05% LOCKED)`;
        const beWidth = ctx.measureText(beLabel).width + 10;
        ctx.fillStyle = '#00d4ff';
        ctx.fillRect(W - beWidth - 5, beY - 7, beWidth, 14);
        ctx.fillStyle = '#050a14';
        ctx.fillText(beLabel, W - beWidth, beY + 3);
      }
    }

  } else {
    // Fallback Price Line if candles are initializing
    const data = STATE.prices.slice(-60);
    if (data.length < 2) return;
    const mn = Math.min(...data) - 5;
    const mx = Math.max(...data) + 5;
    const rng = mx - mn;
    const toY = (p) => H - ((p - mn) / rng) * (H - 20) - 10;
    const toX = (i) => i / (data.length - 1) * W;

    ctx.beginPath();
    data.forEach((p, i) => { i === 0 ? ctx.moveTo(toX(i), toY(p)) : ctx.lineTo(toX(i), toY(p)); });
    ctx.strokeStyle = '#00d4ff';
    ctx.lineWidth = 2;
    ctx.stroke();
  }
}

/** Draw ensemble history chart */
export function drawEnsembleChart() {
  const canvas = document.getElementById('ensembleChart');
  if (!canvas) return;
  const { W, H } = getCanvasDimensions(canvas, 200, 70);
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, W, H);

  const data = STATE.ensembleHistory.slice(-40);
  if (data.length < 2) return;

  const toY = v => H - ((v + 1) / 2) * (H - 10) - 5;

  // Zero line
  ctx.beginPath();
  ctx.moveTo(0, toY(0));
  ctx.lineTo(W, toY(0));
  ctx.strokeStyle = 'rgba(100,116,139,0.4)';
  ctx.lineWidth = 1;
  ctx.setLineDash([3, 3]);
  ctx.stroke();
  ctx.setLineDash([]);

  // Fill bars
  for (let i = 1; i < data.length; i++) {
    const x1 = (i - 1) / (data.length - 1) * W;
    const x2 = i / (data.length - 1) * W;
    const v = data[i];
    ctx.fillStyle = v > 0 ? 'rgba(34,197,94,0.2)' : 'rgba(239,68,68,0.2)';
    ctx.fillRect(x1, Math.min(toY(v), toY(0)), x2 - x1, Math.abs(toY(v) - toY(0)));
  }

  // Line
  ctx.beginPath();
  data.forEach((v, i) => {
    const x = i / (data.length - 1) * W;
    const y = toY(v);
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  });
  ctx.strokeStyle = STATE.ensemble > 0 ? '#22c55e' : '#ef4444';
  ctx.lineWidth = 1.5;
  ctx.stroke();
}

/** Draw world model imagined trajectories */
export function drawWorldModel() {
  const canvas = document.getElementById('worldModelChart');
  if (!canvas) return;
  const { W, H } = getCanvasDimensions(canvas, 180, 80);
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, W, H);

  const steps = 10;
  const ens = STATE.ensemble;

  for (let t = 0; t < 8; t++) {
    ctx.beginPath();
    let p = STATE.price;
    for (let s = 0; s <= steps; s++) {
      p += rnd(-8, 12) + ens * 5;
      const x = s / steps * W;
      const y = H / 2 - ((p - STATE.price) / STATE.price) * H * 6;
      const yc = clamp(y, 4, H - 4);
      s === 0 ? ctx.moveTo(x, H / 2) : ctx.lineTo(x, yc);
    }
    const col = ens > 0 ? `rgba(34,197,94,${0.1 + t * 0.05})` : `rgba(239,68,68,${0.1 + t * 0.05})`;
    ctx.strokeStyle = col;
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  // Mean trajectory
  ctx.beginPath();
  ctx.moveTo(0, H / 2);
  let p2 = STATE.price;
  for (let s = 1; s <= steps; s++) {
    p2 += ens * 8;
    const x = s / steps * W;
    const y = H / 2 - ((p2 - STATE.price) / STATE.price) * H * 6;
    ctx.lineTo(x, clamp(y, 4, H - 4));
  }
  ctx.strokeStyle = ens > 0 ? '#22c55e' : '#ef4444';
  ctx.lineWidth = 2;
  ctx.stroke();

  ctx.fillStyle = 'rgba(100,116,139,0.7)';
  ctx.font = '8px JetBrains Mono, monospace';
  ctx.fillText('NOW', 2, H / 2 - 2);
  ctx.fillText('+5t', W - 22, H / 2 - 2);
}

/** Draw GAE advantage chart */
export function drawGAEChart() {
  const canvas = document.getElementById('gaeChart');
  if (!canvas) return;
  const { W, H } = getCanvasDimensions(canvas, 180, 60);
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, W, H);

  const data = STATE.gaeValues.slice(-40);
  if (data.length < 2) return;
  const mid = H / 2;

  ctx.beginPath();
  ctx.moveTo(0, mid);
  ctx.lineTo(W, mid);
  ctx.strokeStyle = 'rgba(100,116,139,0.3)';
  ctx.lineWidth = 0.5;
  ctx.stroke();

  ctx.beginPath();
  data.forEach((v, i) => {
    const x = i / (data.length - 1) * W;
    const y = mid - v * H * 0.4;
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  });
  ctx.strokeStyle = '#7c3aed';
  ctx.lineWidth = 1.5;
  ctx.stroke();
}

/** Draw Stat-Arb Z-Score Spread Chart with ±2.0σ Bollinger Bands */
export function drawStatArbChart() {
  const canvas = document.getElementById('statArbChart');
  if (!canvas) return;
  const { W, H } = getCanvasDimensions(canvas, 220, 75);
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, W, H);

  const zData = STATE.layer2?.statArb?.zHistory || [];
  if (zData.length < 2) return;

  const toY = (z) => H / 2 - (z / 3.2) * (H / 2 - 6);

  // ±2.0 sigma threshold bands
  const yUpper = toY(2.0);
  const yLower = toY(-2.0);
  const yMid = toY(0);

  // Upper band (+2.0σ SELL SPREAD)
  ctx.beginPath();
  ctx.moveTo(0, yUpper); ctx.lineTo(W, yUpper);
  ctx.strokeStyle = 'rgba(239, 68, 68, 0.6)';
  ctx.setLineDash([3, 3]); ctx.lineWidth = 1; ctx.stroke();

  // Lower band (-2.0σ BUY SPREAD)
  ctx.beginPath();
  ctx.moveTo(0, yLower); ctx.lineTo(W, yLower);
  ctx.strokeStyle = 'rgba(34, 197, 94, 0.6)';
  ctx.setLineDash([3, 3]); ctx.lineWidth = 1; ctx.stroke();

  // Zero line
  ctx.beginPath();
  ctx.moveTo(0, yMid); ctx.lineTo(W, yMid);
  ctx.strokeStyle = 'rgba(100, 116, 139, 0.4)';
  ctx.setLineDash([2, 2]); ctx.lineWidth = 0.5; ctx.stroke();
  ctx.setLineDash([]);

  // Labels
  ctx.fillStyle = 'rgba(239, 68, 68, 0.7)';
  ctx.font = '7px JetBrains Mono, monospace';
  ctx.fillText('+2.0σ', 4, yUpper - 2);

  ctx.fillStyle = 'rgba(34, 197, 94, 0.7)';
  ctx.fillText('-2.0σ', 4, yLower + 8);

  // Z-Score Line
  ctx.beginPath();
  zData.forEach((z, i) => {
    const x = (i / (zData.length - 1)) * W;
    const y = toY(clamp(z, -3.2, 3.2));
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  });
  ctx.strokeStyle = '#fbbf24';
  ctx.lineWidth = 1.5;
  ctx.stroke();
}

/** Draw Almgren-Chriss Optimal Execution Trajectory vs Slices */
export function drawExecutionTrajectoryChart() {
  const canvas = document.getElementById('acTrajectoryChart');
  if (!canvas) return;
  const { W, H } = getCanvasDimensions(canvas, 220, 75);
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, W, H);

  const traj = STATE.layer4?.acTrajectory || [];
  if (traj.length < 2) return;

  const maxVal = Math.max(...traj, 0.1);

  // Grid
  ctx.strokeStyle = 'rgba(26,48,96,0.4)';
  ctx.lineWidth = 0.5;
  ctx.strokeRect(0, 0, W, H);

  // Hyperbolic curve
  ctx.beginPath();
  traj.forEach((val, i) => {
    const x = (i / (traj.length - 1)) * W;
    const y = H - (val / maxVal) * (H - 12) - 6;
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  });
  ctx.strokeStyle = '#00d4ff';
  ctx.lineWidth = 2;
  ctx.stroke();

  // Shaded area under trajectory
  ctx.lineTo(W, H);
  ctx.lineTo(0, H);
  ctx.closePath();
  ctx.fillStyle = 'rgba(0, 212, 255, 0.08)';
  ctx.fill();

  // Text label
  ctx.fillStyle = 'rgba(0, 212, 255, 0.7)';
  ctx.font = '8px JetBrains Mono, monospace';
  ctx.fillText('Optimal Slices', 4, 10);
  ctx.fillText('T=0', 4, H - 4);
  ctx.fillText('T=Horizon', W - 50, H - 4);
}

/** Draw PnL Attribution Breakdown Bar Chart */
export function drawAttributionChart() {
  const canvas = document.getElementById('attributionChart');
  if (!canvas) return;
  const { W, H } = getCanvasDimensions(canvas, 220, 45);
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, W, H);

  const attr = STATE.layer6?.attribution || { alphaPct: 70, betaPct: 20, executionPct: 10 };
  const aW = (attr.alphaPct / 100) * W;
  const bW = (attr.betaPct / 100) * W;
  const eW = W - aW - bW;

  const barH = 16;
  const barY = 6;

  // Alpha segment (Green)
  ctx.fillStyle = '#22c55e';
  ctx.fillRect(0, barY, aW, barH);

  // Beta segment (Cyan / Accent)
  ctx.fillStyle = '#00d4ff';
  ctx.fillRect(aW, barY, bW, barH);

  // Execution segment (Purple)
  ctx.fillStyle = '#7c3aed';
  ctx.fillRect(aW + bW, barY, eW, barH);

  // Labels below
  ctx.font = '8px JetBrains Mono, monospace';
  ctx.fillStyle = '#22c55e';
  ctx.fillText(`Alpha: ${attr.alphaPct}%`, 2, barY + barH + 14);

  ctx.fillStyle = '#00d4ff';
  ctx.fillText(`Beta: ${attr.betaPct}%`, Math.max(70, aW - 10), barY + barH + 14);

  ctx.fillStyle = '#7c3aed';
  ctx.fillText(`Exec: ${attr.executionPct}%`, W - 60, barY + barH + 14);
}

/** Redraw all charts */
export function drawAllCharts() {
  drawSpark();
  drawPriceChart();
  drawEnsembleChart();
  drawWorldModel();
  drawGAEChart();
  drawStatArbChart();
  drawExecutionTrajectoryChart();
  drawAttributionChart();
}
