/*
 * SMC (Smart Money Concepts) signal engine — BTC 15m
 *
 * Model: trend filter -> liquidity sweep -> market structure shift (MSS) -> entry, fixed R:R.
 *   LONG : price is above EMA200 (uptrend), dips below a prior major swing low
 *          (takes sell-side liquidity), then a candle closes back above the last
 *          minor swing high (bullish MSS). Enter at that close, stop below the
 *          sweep low, target 2R.
 *   SHORT: mirror image.
 *
 * Backtests (see backtest.js) showed counter-trend signals lose money, so the
 * default only trades with the trend.
 *
 * The same code runs in the browser app and in the Node backtest, so what the
 * app alerts on is exactly what was backtested.
 *
 * Feed CLOSED candles through onBar(). For real-time fills/exits between closes,
 * call onPrice() with the high/low traded since the last call.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SMC = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var DEFAULTS = {
    model: 'reversal',   // 'reversal' = sweep + MSS | 'bos' = break of structure, with trend
    pivot: 12,           // swing point = high/low with N lower/higher bars on both sides
    sweepLookback: 96,   // only swing points from the last N bars count as liquidity
    minSwingAge: 0,      // swing must be at least N bars old when swept
    sweepValid: 8,       // MSS must come within N bars of the sweep
    msPivot: 2,          // strength of the minor swing used for the MSS level
    msLookback: 30,      // how far back to look for that minor swing
    dispBody: 0,         // MSS candle body must be >= x * ATR (displacement)
    needFvg: false,      // require a fair value gap in the displacement leg
    fvgMin: 0.05,        // min FVG size, x * ATR
    entryMode: 'market', // 'market' | 'fvg' | 'retrace'
    retrace: 0.5,        // for 'retrace': fraction of the leg to pull back
    pendBars: 8,         // limit order lifetime (bars)
    slMode: 'ext',       // 'ext' = beyond sweep/leg extreme | 'bar' = beyond signal candle | 'fvg'
    slBuf: 0.1,          // stop buffer, x * ATR
    rr: 2,               // take-profit = rr * risk
    minRiskPct: 0.25,    // skip if stop distance < x % of price (fees eat it)
    maxRiskPct: 1.2,     // skip if stop distance > x % of price
    bias: 'with',        // 'none' | 'with' | 'counter'  (vs EMA trend)
    emaLen: 200,
    atrLen: 14,
    volMin: 0,           // require ATR >= x * its own average (skip dead markets); 0 = off
    volMax: 0,           // require ATR <= x * its own average; 0 = off
    volLen: 672,         // bars in that average (672 = 7 days)
    maxHold: 96,         // time stop (bars); 0 = off
    beAt: 0,             // move stop to entry once price reaches x R; 0 = off
    hours: null,         // allowed UTC hours for new setups, e.g. [7,8,...]; null = all
    longs: true,
    shorts: true
  };

  function createEngine(userParams) {
    var p = {};
    var k;
    for (k in DEFAULTS) p[k] = DEFAULTS[k];
    if (userParams) for (k in userParams) p[k] = userParams[k];

    var T = [], O = [], H = [], L = [], C = [];
    var ATR = [], EMA = [], ATRS = [];
    var atrSum = 0;
    var swingHighs = [], swingLows = [];
    var marks = [];                 // chart annotations
    var sweepUp = null, sweepDn = null;
    var pending = null, position = null;
    var trades = [];
    var hourSet = null;
    if (p.hours) { hourSet = {}; for (k = 0; k < p.hours.length; k++) hourSet[p.hours[k]] = true; }

    function isPivotHigh(i, n) {
      if (i - n < 0 || i + n >= H.length) return false;
      var v = H[i];
      for (var j = 1; j <= n; j++) if (H[i - j] >= v || H[i + j] > v) return false;
      return true;
    }
    function isPivotLow(i, n) {
      if (i - n < 0 || i + n >= L.length) return false;
      var v = L[i];
      for (var j = 1; j <= n; j++) if (L[i - j] <= v || L[i + j] < v) return false;
      return true;
    }

    function closeTrade(reason, price, t, events) {
      var pos = position;
      var dir = pos.side === 'long' ? 1 : -1;
      var r = dir * (price - pos.entry) / pos.risk;
      var tr = {
        side: pos.side, entry: pos.entry, sl: pos.sl0, tp: pos.tp, risk: pos.risk,
        riskPct: pos.risk / pos.entry * 100, entryT: pos.entryT, exitT: t, exit: price,
        reason: reason, r: r, entryType: pos.entryType, setupT: pos.setupT,
        level: pos.level, extreme: pos.extreme
      };
      trades.push(tr);
      position = null;
      events.push({ type: 'exit', trade: tr, t: t });
    }

    // Manage pending order + open position against a traded range [lo, hi].
    // barT = open time of the bar this range belongs to.
    function manage(hi, lo, t, barT, events) {
      if (pending) {
        var touched = pending.side === 'long' ? lo < pending.entry : hi > pending.entry;
        // price ran to target without us: setup is spent
        var ran = pending.side === 'long' ? hi >= pending.tp : lo <= pending.tp;
        if (touched) {
          position = {
            side: pending.side, entry: pending.entry, sl: pending.sl, sl0: pending.sl,
            tp: pending.tp, risk: Math.abs(pending.entry - pending.sl), entryT: t,
            fillBarT: barT, entryType: 'limit', setupT: pending.setupT, bars: 0,
            level: pending.level, extreme: pending.extreme
          };
          pending = null;
          events.push({ type: 'entry', position: position, t: t });
        } else if (ran) {
          events.push({ type: 'cancel', why: 'missed', pending: pending, t: t });
          pending = null;
        }
      }
      if (position) {
        var pos = position;
        var long = pos.side === 'long';
        var slHit = long ? lo <= pos.sl : hi >= pos.sl;
        var tpHit = long ? hi >= pos.tp : lo <= pos.tp;
        // On the bar a limit order filled we cannot know whether the bar's
        // favourable extreme came before or after the fill -> never count TP there.
        if (pos.fillBarT === barT && pos.entryType === 'limit') tpHit = false;
        if (slHit) {                       // both hit in one range -> assume stop first
          closeTrade(pos.sl === pos.sl0 ? 'sl' : 'be', pos.sl, t, events);
        } else if (tpHit) {
          closeTrade('tp', pos.tp, t, events);
        } else if (p.beAt > 0 && pos.sl === pos.sl0) {
          var trig = long ? pos.entry + p.beAt * pos.risk : pos.entry - p.beAt * pos.risk;
          if (long ? hi >= trig : lo <= trig) {
            pos.sl = pos.entry;
            events.push({ type: 'breakeven', position: pos, t: t });
          }
        }
      }
    }

    function findFvg(side, from, to) {
      // most recent 3-candle imbalance inside the displacement leg
      for (var j = to; j >= from + 1 && j >= 2; j--) {
        if (side === 'long' && L[j] > H[j - 2] && L[j] - H[j - 2] >= p.fvgMin * ATR[to])
          return { top: L[j], bottom: H[j - 2], i: j };
        if (side === 'short' && H[j] < L[j - 2] && L[j - 2] - H[j] >= p.fvgMin * ATR[to])
          return { top: L[j - 2], bottom: H[j], i: j };
      }
      return null;
    }

    // the minor swing before the sweep extreme: closing beyond it = structure shift
    function findRef(side, sw, i) {
      var long = side === 'long';
      for (var kk = sw.extI - 1; kk >= Math.max(0, sw.extI - p.msLookback); kk--) {
        if (kk + p.msPivot > i) continue;
        if (long ? isPivotHigh(kk, p.msPivot) : isPivotLow(kk, p.msPivot)) return long ? H[kk] : L[kk];
      }
      return null;
    }

    function trySetup(side, sw, i, events, isBos) {
      var long = side === 'long';
      var c = C[i], atr = ATR[i];
      var ref = null;
      if (isBos) ref = sw.level;
      else {
        ref = findRef(side, sw, i);
        if (ref === null) return false;
        if (long ? !(c > ref && c > sw.level) : !(c < ref && c < sw.level)) return false;
      }
      // --- structure has shifted; from here the sweep is consumed either way
      if (Math.abs(c - O[i]) < p.dispBody * atr) return true;
      if (p.bias !== 'none') {
        var up = c > EMA[i];
        var want = p.bias === 'with' ? long : !long;
        if (up !== want) return true;
      }
      if (hourSet && !hourSet[new Date(T[i]).getUTCHours()]) return true;
      var vr = ATR[i] / ATRS[i];
      if (p.volMin > 0 && vr < p.volMin) return true;
      if (p.volMax > 0 && vr > p.volMax) return true;
      var fvg = findFvg(side, sw.extI, i);
      if (p.needFvg && !fvg) return true;

      var entry;
      if (p.entryMode === 'market') entry = c;
      else if (p.entryMode === 'fvg') {
        if (!fvg) return true;
        entry = long ? fvg.top : fvg.bottom;
      } else {
        var legEnd = long ? -Infinity : Infinity, j;
        for (j = sw.extI; j <= i; j++) legEnd = long ? Math.max(legEnd, H[j]) : Math.min(legEnd, L[j]);
        entry = legEnd - p.retrace * (legEnd - sw.ext);
      }
      var base = sw.ext;
      if (p.slMode === 'bar') base = long ? Math.min(L[i], L[i - 1]) : Math.max(H[i], H[i - 1]);
      else if (p.slMode === 'fvg' && fvg) base = long ? fvg.bottom : fvg.top;
      var sl = long ? base - p.slBuf * atr : base + p.slBuf * atr;
      var risk = Math.abs(entry - sl);
      var riskPct = risk / entry * 100;
      if (!(long ? entry > sl : entry < sl)) return true;
      if (riskPct < p.minRiskPct || riskPct > p.maxRiskPct) {
        events.push({ type: 'skip', side: side, why: riskPct < p.minRiskPct ? 'stop-too-tight' : 'stop-too-wide', riskPct: riskPct, t: T[i] });
        return true;
      }
      var tp = long ? entry + p.rr * risk : entry - p.rr * risk;
      var setup = {
        side: side, entry: entry, sl: sl, tp: tp, risk: risk, riskPct: riskPct,
        setupT: T[i], level: sw.level, extreme: sw.ext, ref: ref, fvg: fvg,
        sweepT: T[sw.i0], extT: T[sw.extI], mode: p.entryMode
      };
      marks.push({ kind: isBos ? 'bos' : 'mss', side: side, t: T[i], price: ref, fromT: isBos ? sw.levelT : T[sw.extI] });
      if (fvg) marks.push({ kind: 'fvg', side: side, t: T[fvg.i - 2], top: fvg.top, bottom: fvg.bottom });
      if (p.entryMode === 'market') {
        position = {
          side: side, entry: entry, sl: sl, sl0: sl, tp: tp, risk: risk, entryT: T[i] + barMs(),
          fillBarT: T[i], entryType: 'market', setupT: T[i], bars: 0,
          level: sw.level, extreme: sw.ext
        };
        events.push({ type: 'signal', setup: setup, t: T[i] });
        events.push({ type: 'entry', position: position, t: T[i] });
      } else {
        if (pending) events.push({ type: 'cancel', why: 'replaced', pending: pending, t: T[i] });
        pending = setup;
        pending.expireI = i + p.pendBars;
        events.push({ type: 'signal', setup: setup, t: T[i] });
      }
      return true;
    }

    function barMs() { return T.length > 1 ? T[1] - T[0] : 900000; }

    // ---- public: a candle has CLOSED
    // opts.managed = true  -> fills/exits for this bar were already handled via onPrice()
    function onBar(bar, opts) {
      var events = [];
      var i = T.length;
      if (i > 0 && bar.t <= T[i - 1]) return events;      // ignore duplicates / out of order
      T.push(bar.t); O.push(bar.o); H.push(bar.h); L.push(bar.l); C.push(bar.c);

      // indicators
      var pc = i > 0 ? C[i - 1] : bar.c;
      var tr = Math.max(bar.h - bar.l, Math.abs(bar.h - pc), Math.abs(bar.l - pc));
      ATR.push(i === 0 ? tr : i < p.atrLen ? (ATR[i - 1] * i + tr) / (i + 1) : (ATR[i - 1] * (p.atrLen - 1) + tr) / p.atrLen);
      atrSum += ATR[i];
      if (i >= p.volLen) atrSum -= ATR[i - p.volLen];
      ATRS.push(atrSum / Math.min(i + 1, p.volLen));
      var ke = 2 / (p.emaLen + 1);
      EMA.push(i === 0 ? bar.c : EMA[i - 1] + ke * (bar.c - EMA[i - 1]));

      // 1) orders & position against this bar's range (safety net when live)
      manage(bar.h, bar.l, bar.t + barMs(), bar.t, events);
      if (position && position.fillBarT !== bar.t) position.bars++;
      if (position && p.maxHold > 0 && position.bars >= p.maxHold) closeTrade('timeout', bar.c, bar.t + barMs(), events);
      if (pending && i >= pending.expireI) {
        events.push({ type: 'cancel', why: 'expired', pending: pending, t: bar.t + barMs() });
        pending = null;
      }
      if (pending) {
        var bad = pending.side === 'long' ? bar.c < pending.sl : bar.c > pending.sl;
        if (bad) { events.push({ type: 'cancel', why: 'invalidated', pending: pending, t: bar.t + barMs() }); pending = null; }
      }

      // 2) confirm swing points (known only p.pivot bars later)
      var kq = i - p.pivot;
      if (kq >= 0) {
        if (isPivotHigh(kq, p.pivot)) swingHighs.push({ i: kq, t: T[kq], price: H[kq], swept: false });
        if (isPivotLow(kq, p.pivot)) swingLows.push({ i: kq, t: T[kq], price: L[kq], swept: false });
      }

      // 3) liquidity sweeps
      var s, n, lvl = null;
      for (n = swingLows.length - 1; n >= 0; n--) {
        s = swingLows[n];
        if (i - s.i > p.sweepLookback) break;
        if (!s.swept && i - s.i >= p.minSwingAge && bar.l < s.price) {
          s.swept = true; s.sweptT = bar.t;
          if (lvl === null || s.price < lvl) lvl = s.price;
          marks.push({ kind: 'sweep', side: 'long', t: bar.t, price: s.price, fromT: s.t });
        }
      }
      if (lvl !== null) {
        if (sweepUp) { sweepUp.i0 = i; sweepUp.level = Math.min(sweepUp.level, lvl); }
        else sweepUp = { i0: i, level: lvl, ext: bar.l, extI: i };
      }
      lvl = null;
      for (n = swingHighs.length - 1; n >= 0; n--) {
        s = swingHighs[n];
        if (i - s.i > p.sweepLookback) break;
        if (!s.swept && i - s.i >= p.minSwingAge && bar.h > s.price) {
          s.swept = true; s.sweptT = bar.t;
          if (lvl === null || s.price > lvl) lvl = s.price;
          marks.push({ kind: 'sweep', side: 'short', t: bar.t, price: s.price, fromT: s.t });
        }
      }
      if (lvl !== null) {
        if (sweepDn) { sweepDn.i0 = i; sweepDn.level = Math.max(sweepDn.level, lvl); }
        else sweepDn = { i0: i, level: lvl, ext: bar.h, extI: i };
      }
      if (sweepUp) {
        if (bar.l < sweepUp.ext) { sweepUp.ext = bar.l; sweepUp.extI = i; }
        if (i - sweepUp.i0 > p.sweepValid) sweepUp = null;
      }
      if (sweepDn) {
        if (bar.h > sweepDn.ext) { sweepDn.ext = bar.h; sweepDn.extI = i; }
        if (i - sweepDn.i0 > p.sweepValid) sweepDn = null;
      }

      // 4) structure shift -> setup
      if (p.model === 'bos') {
        var hitS = null, e0, j0;
        for (n = swingHighs.length - 1; n >= 0; n--) {
          s = swingHighs[n];
          if (i - s.i > p.sweepLookback) break;
          if (!s.broken && bar.c > s.price) { s.broken = true; if (!hitS) hitS = s; }
        }
        if (hitS && !position && p.longs) {
          e0 = Infinity; j0 = i;
          for (n = hitS.i; n <= i; n++) if (L[n] < e0) { e0 = L[n]; j0 = n; }
          trySetup('long', { i0: i, level: hitS.price, levelT: hitS.t, ext: e0, extI: j0 }, i, events, true);
        }
        hitS = null;
        for (n = swingLows.length - 1; n >= 0; n--) {
          s = swingLows[n];
          if (i - s.i > p.sweepLookback) break;
          if (!s.broken && bar.c < s.price) { s.broken = true; if (!hitS) hitS = s; }
        }
        if (hitS && !position && p.shorts) {
          e0 = -Infinity; j0 = i;
          for (n = hitS.i; n <= i; n++) if (H[n] > e0) { e0 = H[n]; j0 = n; }
          trySetup('short', { i0: i, level: hitS.price, levelT: hitS.t, ext: e0, extI: j0 }, i, events, true);
        }
      } else if (!position) {
        if (sweepUp && p.longs && i > sweepUp.extI && trySetup('long', sweepUp, i, events)) sweepUp = null;
        if (!position && sweepDn && p.shorts && i > sweepDn.extI && trySetup('short', sweepDn, i, events)) sweepDn = null;
      }
      return events;
    }

    // ---- public: live price range traded since the last call (within the forming bar)
    function onPrice(hi, lo, t, barT) {
      var events = [];
      manage(hi, lo, t, barT, events);
      return events;
    }

    // what the engine is waiting for right now (for the UI)
    function watch() {
      var i = T.length - 1, out = [];
      function add(side, sw) {
        if (!sw) return;
        var ref = findRef(side, sw, i);
        var trig = ref === null ? null : side === 'long' ? Math.max(ref, sw.level) : Math.min(ref, sw.level);
        out.push({ side: side, level: sw.level, extreme: sw.ext, trigger: trig, barsLeft: p.sweepValid - (i - sw.i0), fresh: sw.i0 === i });
      }
      add('long', sweepUp); add('short', sweepDn);
      return out;
    }

    return {
      params: p,
      watch: watch,
      onBar: onBar,
      onPrice: onPrice,
      get position() { return position; },
      get pending() { return pending; },
      get trades() { return trades; },
      get marks() { return marks; },
      get sweepUp() { return sweepUp; },
      get sweepDn() { return sweepDn; },
      get swingHighs() { return swingHighs; },
      get swingLows() { return swingLows; },
      get series() { return { T: T, O: O, H: H, L: L, C: C, EMA: EMA, ATR: ATR }; },
      get length() { return T.length; },
      get atr() { return ATR[ATR.length - 1]; },
      get volRatio() { return ATR[ATR.length - 1] / ATRS[ATRS.length - 1]; },
      get ema() { return EMA[EMA.length - 1]; },
      get lastClose() { return C[C.length - 1]; },
      get lastT() { return T[T.length - 1]; }
    };
  }

  // Net result in R after exchange fees. Fees in % of notional per side.
  var FEES = { taker: 0.05, maker: 0.02, slipMarket: 0.01, slipStop: 0.02 };
  function netR(tr, fees) {
    var f = fees || FEES;
    var inFee = tr.entryType === 'market' ? f.taker + f.slipMarket : f.maker;
    var outFee = tr.reason === 'tp' ? f.maker : tr.reason === 'timeout' ? f.taker + f.slipMarket : f.taker + f.slipStop;
    return tr.r - (inFee + outFee) / tr.riskPct;
  }

  // Shipped presets. Everything not listed uses DEFAULTS.
  var PRESETS = {
    strict: { pivot: 12, sweepValid: 8, bias: 'with' },
    normal: { pivot: 8, sweepValid: 8, bias: 'with' }
  };

  return { createEngine: createEngine, DEFAULTS: DEFAULTS, PRESETS: PRESETS, FEES: FEES, netR: netR };
});
