// =====================================================================
// Print3D quality governor: picks the render tier from rolling frame times.
//
// Pure ES module: no DOM, no THREE, no clock of its own. The stage feeds it one sample per frame
// (a timestamp in seconds and that frame's time in ms, from frameSample) and applies whatever tier
// it returns.
//
// - Drops a tier when the 90th percentile of the last 2 s is over 18 ms, once the current tier has
//   been watched for 2 s, and the last half second is still that slow.
// - Climbs a tier when the 90th percentile of a full 10 s window is under 10 ms.
// - Hysteresis: the 10-18 ms band holds the tier; the drop and climb windows are uneven; and a climb
//   that has to be undone soon after doubles the wait before that tier is tried again (up to 32x,
//   about 5 minutes),
//   so a machine on the edge of a tier settles instead of flapping.
// - A gap of over a second between samples (hidden tab, debugger, sleep) starts the watch again.
// =====================================================================

export const TIERS = ['low', 'medium', 'high'];
export const DEFAULTS = {
  dropMs: 18,          // p90 above this for dropWindowS: step down
  climbMs: 10,         // p90 below this for climbWindowS: step up
  dropWindowS: 2,
  tailS: 0.5,          // ...and the last half second must be slow too (the load is still there)
  climbWindowS: 10,
  quantile: 0.9,
  minSamples: 12,      // never decide on a handful of frames
  flapWindowS: 30,     // a drop this soon after a climb into that tier counts as a flap
  maxBackoff: 32,      // the climb wait grows to at most 32x (5 min 20 s)
  gapS: 1,             // a longer pause between samples restarts the watch
};

export function createGovernor(opts = {}) {
  const cfg = { ...DEFAULTS, ...opts };
  const top = TIERS.length - 1;
  return {
    cfg,
    tier: Math.max(0, Math.min(top, opts.tier ?? top)),
    samples: [],          // [{ t, ms }] in arrival order
    since: null,          // when the current watch began (tier change, start or a gap)
    lastT: null,
    backoff: TIERS.map(() => 1),   // climb-wait multiplier per destination tier
    lastClimb: null,      // { to, at }
    changes: [],          // [{ at, from, to, why, p90 }]
    cap: top,             // the highest tier it may climb to (capTier lowers it)
  };
}

// Never go above `tier` again (a tier this browser can't draw, e.g. a shader that won't link).
// Returns the change when the current tier is above the cap, else null.
export function capTier(g, tier, t) {
  g.cap = Math.max(0, Math.min(g.cap, tier | 0));
  if (g.tier <= g.cap) return null;
  return change(g, t ?? g.lastT ?? 0, g.cap, 'cap', 0);
}

export function quantile(values, q) {
  if (!values.length) return 0;
  const s = values.slice().sort((a, b) => a - b);
  const i = Math.min(s.length - 1, Math.max(0, Math.ceil(q * s.length) - 1));
  return s[i];
}

// One frame's sample: its cost (ms of work, GPU included), or the gap before it when that gap is at
// least one refresh late. The refresh period is the median of the recent gaps (oldest first, in ms),
// so the ordinary jitter of a vsync-paced loop (15-19 ms at 60 Hz) never reads as slow, and a gap of
// 100 ms or more (a throttled page, a stall the window already restarts on) adds nothing. A late gap
// only counts after a frame that drew (drew = false: the stage drew nothing, so whatever held the
// page up wasn't drawing, and a lower quality wouldn't help).
export function frameSample(gaps, gap, cost, drew = true) {
  const period = gaps.length >= 12 ? Math.max(6, Math.min(40, quantile(gaps, 0.5))) : 1000 / 60;
  const late = drew && gap > period * 1.6 && gap < 100 ? gap : 0;
  return Math.max(cost || 0, late);
}

function restart(g, t) { g.samples.length = 0; g.since = t; }

function change(g, t, to, why, p90) {
  const from = g.tier;
  g.tier = to;
  g.changes.push({ at: t, from, to, why, p90: +p90.toFixed(2) });
  if (to > from) g.lastClimb = { to, at: t };
  restart(g, t);
  return { changed: true, from, to, tier: to, why, p90 };
}

// Feed one frame. Returns { changed: true, from, to, why, p90 } when the tier moved, else null.
export function sample(g, t, ms) {
  const { cfg } = g;
  if (!(ms >= 0) || !Number.isFinite(t)) return null;
  if (g.lastT !== null && (t - g.lastT > cfg.gapS || t < g.lastT)) restart(g, t);
  g.lastT = t;
  if (g.since === null) g.since = t;
  g.samples.push({ t, ms });
  const oldest = t - Math.max(cfg.dropWindowS, cfg.climbWindowS);
  while (g.samples.length && g.samples[0].t < oldest) g.samples.shift();

  const watched = t - g.since;
  // Step down: the last dropWindowS seconds are too slow.
  if (g.tier > 0 && watched >= cfg.dropWindowS - 1e-9) {
    const recent = [];
    for (let i = g.samples.length - 1; i >= 0 && g.samples[i].t >= t - cfg.dropWindowS; i--) recent.push(g.samples[i].ms);
    if (recent.length >= cfg.minSamples) {
      const p = quantile(recent, cfg.quantile);
      // A load that has just gone away (the window still full of its frames) is no reason to step down.
      const tail = [];
      for (let i = g.samples.length - 1; i >= 0 && g.samples[i].t >= t - cfg.tailS; i--) tail.push(g.samples[i].ms);
      if (p > cfg.dropMs && tail.length >= 3 && quantile(tail, cfg.quantile) > cfg.dropMs) {
        const from = g.tier;
        // Undoing a recent climb into this tier: wait longer before trying it again.
        if (g.lastClimb && g.lastClimb.to === from && t - g.lastClimb.at <= cfg.flapWindowS) {
          g.backoff[from] = Math.min(cfg.maxBackoff, g.backoff[from] * 2);
        }
        return change(g, t, from - 1, 'slow', p);
      }
    }
  }
  // Step up: a full climb window (stretched by any backoff) of fast frames.
  if (g.tier < Math.min(TIERS.length - 1, g.cap ?? TIERS.length - 1)) {
    const need = cfg.climbWindowS * g.backoff[g.tier + 1];
    if (watched >= need - 1e-9) {
      const span = [];
      for (let i = g.samples.length - 1; i >= 0 && g.samples[i].t >= t - cfg.climbWindowS; i--) span.push(g.samples[i].ms);
      const covered = g.samples.length && g.samples[0].t <= t - cfg.climbWindowS + 0.25;
      if (covered && span.length >= cfg.minSamples) {
        const p = quantile(span, cfg.quantile);
        if (p < cfg.climbMs) return change(g, t, g.tier + 1, 'fast', p);
      }
    }
  }
  return null;
}

// A tier picked by hand (settings, ?quality=) or forced by the stage. Restarts the watch.
export function setTier(g, tier, t) {
  const to = Math.max(0, Math.min(TIERS.length - 1, tier | 0));
  if (to === g.tier) { restart(g, t ?? g.lastT ?? 0); return null; }
  return change(g, t ?? g.lastT ?? 0, to, 'set', 0);
}

// The current window, for the ?fps=1 readout.
export function summary(g) {
  const ms = g.samples.map((s) => s.ms);
  const mean = ms.length ? ms.reduce((a, b) => a + b, 0) / ms.length : 0;
  return { tier: TIERS[g.tier], n: ms.length, mean, p90: quantile(ms, g.cfg.quantile), changes: g.changes.length, backoff: g.backoff.slice() };
}
