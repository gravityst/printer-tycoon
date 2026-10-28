// The quality governor: thresholds, windows and hysteresis, driven by synthetic frame times.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as G from '../docs/governor.js';

const FPS = 60, DT = 1 / FPS;
// Feed `seconds` of frames at a fixed cost (or a cost function of time) from t0; return the changes.
function run(g, t0, seconds, cost) {
  const out = [];
  const n = Math.round(seconds * FPS);
  for (let i = 0; i < n; i++) {
    const t = t0 + i * DT;
    const ms = typeof cost === 'function' ? cost(t, g.tier, i) : cost;
    const r = G.sample(g, t, ms);
    if (r) out.push({ ...r, at: t });
  }
  return { changes: out, end: t0 + n * DT };
}

test('governor.js is pure: no DOM, THREE, clock or randomness', () => {
  const code = readFileSync(new URL('../docs/governor.js', import.meta.url), 'utf8').replace(/\/\/[^\n]*/g, '');
  for (const banned of ['document.', 'window.', 'THREE', 'performance.', 'Date.now', 'Math.random', 'localStorage']) {
    assert.ok(!code.includes(banned), `governor.js uses ${banned}`);
  }
});

test('starts at high and stays there while frames are cheap', () => {
  const g = G.createGovernor();
  assert.equal(G.TIERS[g.tier], 'high');
  const { changes } = run(g, 0, 60, 4);
  assert.equal(changes.length, 0);
  assert.equal(g.tier, 2);
});

test('drops one tier when p90 goes over 18 ms, and only after watching for 2 s', () => {
  const g = G.createGovernor();
  // Slow from the very first frame: no decision before the tier has been watched for 2 s.
  const a = run(g, 0, 1.9, 25);
  assert.equal(a.changes.length, 0, 'decided before 2 s of watching');
  const b = run(g, a.end, 0.3, 25);
  assert.equal(b.changes.length, 1);
  assert.equal(b.changes[0].from, 2);
  assert.equal(b.changes[0].to, 1);
  assert.ok(b.changes[0].at >= 2 - 1e-9 && b.changes[0].at < 2.2, `dropped at ${b.changes[0].at}`);
});

test('an overload that starts mid-game drops a tier within 2 s', () => {
  const g = G.createGovernor();
  const warm = run(g, 0, 20, 4);
  const busy = run(g, warm.end, 2, 4 + 15);      // 15 ms of extra work per frame
  assert.ok(busy.changes.length >= 1, 'never dropped');
  assert.ok(busy.changes[0].at - warm.end <= 2, `took ${(busy.changes[0].at - warm.end).toFixed(2)} s`);
});

test('p90 exactly at or just under 18 ms holds the tier', () => {
  for (const ms of [17.9, 18]) {
    const g = G.createGovernor();
    assert.equal(run(g, 0, 30, ms).changes.length, 0, `${ms} ms dropped a tier`);
  }
});

test('a load that has just stopped does not drop a tier on the slow frames it left in the window', () => {
  const g = G.createGovernor();
  const warm = run(g, 0, 20, 4);
  // 20 ms frames from 20 s: a drop to medium at about 20.2 s. The load stops at 21.6 s; at 22.2 s,
  // when medium has been watched for 2 s, that window is still 70% slow, but the last half second
  // is fast, so it stays on medium.
  const slow = run(g, warm.end, 1.6, 20);
  assert.equal(slow.changes.length, 1, 'first drop');
  assert.equal(g.tier, 1);
  const after = run(g, slow.end, 3, 4);
  assert.equal(after.changes.length, 0, `dropped again at ${after.changes[0] && after.changes[0].at.toFixed(2)}`);
  assert.equal(g.tier, 1);
});

test('one long frame (a GC pause) or 5% slow frames do not drop a tier; 12.5% slow frames do', () => {
  const g = G.createGovernor();
  const pause = run(g, 0, 30, (t, tier, i) => (i === 900 ? 120 : 5));
  assert.equal(pause.changes.length, 0);
  const g2 = G.createGovernor();
  const few = run(g2, 0, 30, (t, tier, i) => (i % 20 === 0 ? 30 : 5));
  assert.equal(few.changes.length, 0, '5% slow frames dropped a tier');
  const g3 = G.createGovernor();
  const more = run(g3, 0, 4, (t, tier, i) => (i % 8 === 0 ? 30 : 5));    // 12.5% slow: p90 is a slow frame
  assert.equal(more.changes.length, 1);
});

test('climbs back after a full 10 s under 10 ms, not before', () => {
  const g = G.createGovernor({ tier: 1 });
  const a = run(g, 0, 9.8, 5);
  assert.equal(a.changes.length, 0, 'climbed before 10 s');
  const b = run(g, a.end, 0.6, 5);
  assert.equal(b.changes.length, 1);
  assert.equal(b.changes[0].to, 2);
  assert.ok(b.changes[0].at >= 10 - 1e-9 && b.changes[0].at <= 10.4);
});

test('10-18 ms is a dead band: neither drops nor climbs', () => {
  for (const ms of [10, 11, 14, 17]) {
    const g = G.createGovernor({ tier: 1 });
    const { changes } = run(g, 0, 120, ms);
    assert.equal(changes.length, 0, `${ms} ms moved the tier`);
  }
});

test('p90 under 10 ms needs 90% of the window fast: 12.5% slow frames block a climb', () => {
  const g = G.createGovernor({ tier: 0 });
  const { changes } = run(g, 0, 40, (t, tier, i) => (i % 8 === 0 ? 14 : 4));
  assert.equal(changes.length, 0);
});

test('busy loop then removal: drops within 2 s, climbs back within about 12 s of removal', () => {
  const g = G.createGovernor();
  const warm = run(g, 0, 15, 5);
  // A 12 ms busy loop on top of a 7 ms frame at high (the frame also gets cheaper one tier down).
  const frame = (tier) => [3, 4.5, 7][tier];
  const busy = run(g, warm.end, 6, (t, tier) => frame(tier) + 12);
  assert.ok(busy.changes.length >= 1);
  assert.ok(busy.changes[0].at - warm.end <= 2, 'slow to drop');
  assert.equal(g.tier, 1, 'one tier down holds at 16.5 ms (inside the dead band)');
  const after = run(g, busy.end, 14, (t, tier) => frame(tier));
  assert.equal(after.changes.length, 1);
  const back = after.changes[0].at - busy.end;
  // The 10 s window must be 90% fast: the busy frames age out of it 9-10 s after removal.
  assert.ok(back >= 8.9 && back <= 12, `climbed back after ${back.toFixed(2)} s`);
  assert.equal(g.tier, 2);
});

test('hysteresis: a tier that is too slow is retried less and less often instead of flapping', () => {
  // High costs 20 ms, medium 6 ms: a naive governor would bounce every 10-12 s for ever.
  const g = G.createGovernor();
  const { changes } = run(g, 0, 600, (t, tier) => [3, 6, 20][tier]);
  const climbs = changes.filter((c) => c.to === 2).map((c) => c.at);
  const drops = changes.filter((c) => c.from === 2).map((c) => c.at);
  assert.ok(drops.length >= 1 && climbs.length >= 1);
  // Waits before each retry of high: 10 s, then 20, 40, 80, 160 and the 32x cap (320 s) after that.
  const gaps = climbs.map((c, i) => c - drops[i]);
  for (let i = 1; i < gaps.length; i++) assert.ok(gaps[i] >= gaps[i - 1] - 1e-6, `retry wait shrank: ${gaps.map((x) => x.toFixed(1))}`);
  assert.ok(gaps[0] >= 9.9 && gaps[0] <= 10.5, `first retry after ${gaps[0]}`);
  assert.ok(gaps[1] >= 19.9 && gaps[1] <= 20.5, `second retry after ${gaps[1]}`);
  assert.ok(gaps[gaps.length - 1] >= 159.9, `last retry after ${gaps[gaps.length - 1]}`);
  // In 10 minutes it changes tier a handful of times, not 50.
  assert.ok(changes.length <= 12, `${changes.length} changes`);
  // It never goes below medium: medium is fast enough.
  assert.ok(changes.every((c) => c.to >= 1));
});

test('a pause longer than a second restarts the watch (hidden tab), and gaps are not frame times', () => {
  const g = G.createGovernor();
  run(g, 0, 1.5, 30);
  G.sample(g, 60, 30);                // a minute later (tab was hidden)
  assert.equal(g.samples.length, 1);
  assert.equal(g.since, 60);
  assert.equal(g.tier, 2, 'the pause itself is not slowness');
  const r = run(g, 60 + DT, 2.2, 30);
  assert.equal(r.changes.length, 1, 'still drops once the new watch has 2 s');
});

test('setTier picks a tier by hand and restarts the watch', () => {
  const g = G.createGovernor();
  const r = G.setTier(g, 0, 5);
  assert.equal(r.to, 0);
  assert.equal(g.tier, 0);
  assert.equal(g.samples.length, 0);
  assert.equal(G.setTier(g, 0, 6), null);
  assert.equal(G.setTier(g, 9, 7).to, 2, 'clamped to the top tier');
});

// The stage's per-frame sample: the frame's cost, or the gap before it when a refresh was missed.
// Jitter: a vsync-paced 60 Hz loop as WebKit delivers it (gaps 15-19 ms, mean 16.7).
const JITTER = [16.7, 15.2, 18.9, 16.4, 17.1, 19.0, 14.6, 16.9, 18.2, 15.4, 16.6, 17.6];
const gapsOf = (n, fn) => Array.from({ length: n }, (_, i) => fn(i));

test('frameSample: jitter of a 60 Hz loop is never "late", so a healthy page never drops a tier', () => {
  const g = G.createGovernor();
  const gaps = [];
  let t = 0;
  for (let i = 0; i < 60 * 60; i++) {
    const gap = JITTER[i % JITTER.length];
    t += gap / 1000;
    gaps.push(gap); if (gaps.length > 60) gaps.shift();
    const ms = G.frameSample(gaps, gap, 3);
    assert.equal(ms, 3, `gap ${gap} counted as late`);
    assert.equal(G.sample(g, t, ms), null);
  }
  assert.equal(g.tier, 2);
});

test('frameSample: a burst of quick catch-up frames after a stall does not make normal gaps late', () => {
  const gaps = [...gapsOf(50, (i) => JITTER[i % JITTER.length]), 2, 1.5, 3, 2.2, 1.8];
  for (const gap of [16.7, 19, 22]) assert.equal(G.frameSample(gaps, gap, 2.5), 2.5, `${gap} ms read as late`);
});

test('frameSample: a missed refresh counts as its gap; long gaps and 120 Hz drops are handled', () => {
  const g60 = gapsOf(60, (i) => JITTER[i % JITTER.length]);
  assert.equal(G.frameSample(g60, 33.4, 4), 33.4, 'a dropped frame at 60 Hz');
  assert.equal(G.frameSample(g60, 33.4, 40), 40, 'cost wins when it is bigger');
  assert.equal(G.frameSample(g60, 465, 4), 4, 'a long stall is not a frame time');
  const g120 = gapsOf(60, () => 8.33);
  assert.equal(G.frameSample(g120, 16.7, 3), 16.7, 'a dropped frame at 120 Hz');
  assert.ok(G.frameSample(g120, 16.7, 3) <= G.DEFAULTS.dropMs, '120 Hz falling to 60 Hz is still fine');
  // A late gap after a frame that drew nothing isn't the drawing's fault.
  assert.equal(G.frameSample(g60, 41, 0.5, false), 0.5);
  assert.equal(G.frameSample(g60, 41, 0.5, true), 41);
  // Before a dozen gaps have been seen it assumes 60 Hz.
  assert.equal(G.frameSample([16.7, 16.7], 30, 2), 30);
  assert.equal(G.frameSample([16.7, 16.7], 20, 2), 2);
  assert.equal(G.frameSample([], 0, undefined), 0);
});

test('frameSample + governor: a page that keeps missing refreshes drops a tier within 2 s', () => {
  const g = G.createGovernor();
  const gaps = [];
  let t = 0, dropAt = null;
  for (let i = 0; i < 60 * 12 && dropAt === null; i++) {
    // From 8 s on, every third frame misses a refresh (about 45 fps).
    const gap = t > 8 && i % 3 === 0 ? 33.4 : JITTER[i % JITTER.length];
    t += gap / 1000;
    gaps.push(gap); if (gaps.length > 60) gaps.shift();
    const r = G.sample(g, t, G.frameSample(gaps, gap, 6));
    if (r && r.changed) dropAt = t;
  }
  assert.ok(dropAt !== null, 'never dropped');
  assert.ok(dropAt - 8 <= 2, `took ${(dropAt - 8).toFixed(2)} s`);
});

test('capTier: steps down to the cap and never climbs above it again', () => {
  const g = G.createGovernor();
  run(g, 0, 5, 4);
  const r = G.capTier(g, 1, 5);
  assert.equal(r.to, 1);
  assert.equal(r.why, 'cap');
  assert.equal(g.tier, 1);
  const { changes } = run(g, 5, 120, 3);            // two minutes of fast frames
  assert.equal(changes.length, 0, 'climbed past the cap');
  assert.equal(g.tier, 1);
  assert.equal(G.capTier(g, 2, 130), null, 'a cap only ever comes down');
  assert.equal(g.cap, 1);
  // Below the cap it still drops and climbs as usual.
  const slow = run(g, 130, 3, 25);
  assert.equal(slow.changes.length, 1);
  assert.equal(g.tier, 0);
  const back = run(g, slow.end, 12, 3);
  assert.equal(back.changes.length, 1);
  assert.equal(g.tier, 1);
});

test('quantile matches the nearest-rank definition', () => {
  assert.equal(G.quantile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.9), 9);
  assert.equal(G.quantile([5], 0.9), 5);
  assert.equal(G.quantile([], 0.9), 0);
});
