// The rules module is pure and deterministic: no DOM, no THREE, no Math.random, and the same
// seed with the same moves always plays out the same way.
import test from 'node:test';
import assert from 'node:assert/strict';
import { cat, Sim, readText } from './helpers/catalog.mjs';

const src = readText('docs/sim.js');
const code = src.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');   // comments may mention them

test('sim.js has no DOM, no THREE and no Math.random', () => {
  for (const banned of ['Math.random', 'document.', 'window.', 'THREE', 'localStorage', 'Date.now', 'performance.']) {
    assert.ok(!code.includes(banned), `sim.js uses ${banned}`);
  }
  assert.ok(!/^\s*import\s/m.test(code), 'sim.js imports nothing');
});

test('mulberry32 is seeded, in [0, 1), and its state lives in the holder', () => {
  const a = { rng: 42 }, b = { rng: 42 };
  const xs = Array.from({ length: 1000 }, () => Sim.rngNext(a));
  const ys = Array.from({ length: 1000 }, () => Sim.rngNext(b));
  assert.deepEqual(xs, ys);
  assert.ok(xs.every((x) => x >= 0 && x < 1));
  assert.equal(a.rng, b.rng);
  const mean = xs.reduce((s, x) => s + x, 0) / xs.length;
  assert.ok(Math.abs(mean - 0.5) < 0.03, `mean ${mean}`);
  assert.notDeepEqual(Array.from({ length: 5 }, () => Sim.rngNext({ rng: 43 })), xs.slice(0, 5));
});

function playScript(seed) {
  const s = Sim.newGame(cat, seed);
  const log = [];
  for (let i = 0; i < 24 * 12 * 2; i++) {
    const keep = (r) => { for (const e of r.events) log.push(e.type + ':' + (e.text || '')); };
    keep(Sim.step(cat, s, 0.5));
    s.printers.forEach((slot, idx) => {
      if (slot.phase === 'done') keep(Sim.collect(cat, s, idx));
      if (slot.phase === 'clogged') keep(Sim.coldPull(cat, s, idx));
      if (slot.phase === 'failed') keep(Sim.release(cat, s, idx));
    });
    for (const o of s.orders.slice()) {
      const idx = s.printers.findIndex((slot) => Sim.canAssign(cat, s, o, slot).ok);
      if (idx >= 0) keep(Sim.assign(cat, s, o.id, idx));
    }
  }
  return { s, log };
}

test('same seed, same moves: the same game', () => {
  const a = playScript(7), b = playScript(7), c = playScript(8);
  assert.deepEqual(a.s, b.s);
  assert.deepEqual(a.log, b.log);
  assert.notDeepEqual(a.log, c.log);
  assert.ok(a.log.some((l) => l.startsWith('shipped:')), 'something shipped in 12 days');
});

test('step returns events and dirty flags; the log keeps the newest 50', () => {
  const { s } = playScript(3);
  const out = Sim.step(cat, s, 24);
  assert.ok(Array.isArray(out.events));
  assert.equal(typeof out.dirty, 'object');
  assert.ok(out.events.some((e) => e.type === 'dayClosed'));
  const many = Array.from({ length: 80 }, (_, i) => ({ type: 'x', text: `line ${i}`, at: i }));
  Sim.appendLog(s, many);
  assert.equal(s.log.length, Sim.LOG_LIMIT);
  assert.equal(s.log[0].text, 'line 79');
});

test('a new game matches the v4 starting shop', () => {
  const s = Sim.newGame(cat, 1);
  assert.equal(s.money, 500);
  assert.equal(s.day, 1);
  assert.equal(s.hour, 8);
  assert.equal(s.printers.length, 1);
  assert.equal(s.printers[0].printerId, 'ender-3-v3-se');
  assert.deepEqual(s.inventory, { pla: 1000 });
  assert.equal(s.nextOrderInHours, 5);
  assert.equal(s.saveVersion, 5);
  assert.equal(s.graceJobs, 3);
});
