#!/usr/bin/env node
/*
 * Backtest the shipped presets on Binance USDT-M BTCUSDT 15m candles.
 *
 *   node backtest.js <klines.csv>
 *
 * CSV rows: openTime(ms),open,high,low,close,volume  — the format of the files at
 *   https://data.binance.vision/data/futures/um/monthly/klines/BTCUSDT/15m/
 * (unzip, concatenate, drop header lines).
 *
 * Assumptions: enter at the signal candle's close; if stop and target are both
 * inside one candle the stop is counted; fees 0.05% taker / 0.02% maker plus
 * slippage (see SMC.FEES); results are in R (1R = the amount risked per trade).
 */
const fs = require('fs');
const SMC = require('./smc-engine.js');

const file = process.argv[2];
if (!file) { console.error('usage: node backtest.js <klines.csv>'); process.exit(1); }
const bars = fs.readFileSync(file, 'utf8').trim().split('\n').map(l => l.split(','))
  .filter(a => /^\d+$/.test(a[0]))
  .map(a => ({ t: +a[0], o: +a[1], h: +a[2], l: +a[3], c: +a[4], v: +a[5] }));

function stats(trades) {
  const s = { n: trades.length, tp: 0, sl: 0, timeout: 0, totR: 0, grossR: 0, maxDD: 0, maxLosingStreak: 0 };
  let eq = 0, peak = 0, streak = 0, pos = 0, neg = 0;
  for (const t of trades) {
    const r = SMC.netR(t);
    s[t.reason === 'tp' ? 'tp' : t.reason === 'timeout' ? 'timeout' : 'sl']++;
    s.totR += r; s.grossR += t.r;
    if (r > 0) { pos += r; streak = 0; } else { neg -= r; streak++; s.maxLosingStreak = Math.max(s.maxLosingStreak, streak); }
    eq += r; peak = Math.max(peak, eq); s.maxDD = Math.max(s.maxDD, peak - eq);
  }
  s.winPct = s.n ? s.tp / s.n * 100 : 0;
  s.avgR = s.n ? s.totR / s.n : 0;
  s.profitFactor = neg ? pos / neg : 0;
  return s;
}
const f = (x, d = 2) => x.toFixed(d);
const day = t => new Date(t).toISOString().slice(0, 10);

console.log(`candles: ${bars.length}  ${day(bars[0].t)} .. ${day(bars[bars.length - 1].t)}`);
for (const name of Object.keys(SMC.PRESETS)) {
  const e = SMC.createEngine(SMC.PRESETS[name]);
  for (const b of bars) e.onBar(b);
  const tr = e.trades, s = stats(tr);
  const months = (bars[bars.length - 1].t - bars[0].t) / (30.44 * 86400000);
  console.log(`\n=== preset "${name}" ${JSON.stringify(SMC.PRESETS[name])}`);
  console.log(`trades ${s.n} (${f(s.n / months, 1)}/month)  TP ${s.tp}  SL ${s.sl}  timeout ${s.timeout}  win ${f(s.winPct, 1)}%`);
  console.log(`net ${f(s.totR, 1)}R  avg ${f(s.avgR, 3)}R/trade  before fees ${f(s.grossR, 1)}R  profit factor ${f(s.profitFactor)}`);
  console.log(`max drawdown ${f(s.maxDD, 1)}R  longest losing streak ${s.maxLosingStreak}`);
  const byHalf = new Map();
  for (const t of tr) { const d = new Date(t.entryT); const k = d.getUTCFullYear() + (d.getUTCMonth() < 6 ? ' H1' : ' H2'); if (!byHalf.has(k)) byHalf.set(k, []); byHalf.get(k).push(t); }
  for (const [k, v] of byHalf) { const x = stats(v); console.log(`  ${k}: ${String(x.n).padStart(3)} trades  ${f(x.totR, 1).padStart(6)}R  win ${f(x.winPct, 0)}%`); }
  const rp = tr.map(t => t.riskPct).sort((a, b) => a - b), hold = tr.map(t => (t.exitT - t.entryT) / 3600000).sort((a, b) => a - b);
  console.log(`  median stop distance ${f(rp[rp.length >> 1])}%  median holding time ${f(hold[hold.length >> 1], 1)}h`);
}
