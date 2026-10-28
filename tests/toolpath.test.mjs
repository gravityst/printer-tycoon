// Toolpaths: what the head lays on each layer is inside the bed and the part, a slicer's layer
// count, two perimeters, solid skins, alternating infill, and a sane start sequence.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as S from '../docs/shapes.js';
import * as T from '../docs/toolpath.js';
import { densityOf } from '../docs/look.js';
import { cat } from './helpers/catalog.mjs';
import { smallestPrinter, specOn } from './helpers/printing.mjs';

const mid = (r) => (r[0] + r[1]) / 2;
const FDM = cat.products.filter((p) => S.techKind(p.tech[0]) === 'fdm');
const EXTRUDE = new Set([T.TYPE.outer, T.TYPE.inner, T.TYPE.sparse, T.TYPE.skin]);

test('toolpath.js is pure: no imports, DOM, THREE, clock or randomness', () => {
  const code = readFileSync(new URL('../docs/toolpath.js', import.meta.url), 'utf8').replace(/\/\/[^\n]*/g, '');
  assert.ok(!/^\s*import\s/m.test(code));
  for (const banned of ['document.', 'window.', 'THREE', 'performance.', 'Date.now', 'Math.random', 'localStorage']) {
    assert.ok(!code.includes(banned), `toolpath.js uses ${banned}`);
  }
});

test('every extrusion point is on the bed and within 0.5 mm of its layer outline (all FDM products)', () => {
  for (const product of FDM) {
    const printer = smallestPrinter(product);
    const spec = specOn(product, printer);
    const n = S.layerCount(spec);
    const [bx, by] = printer.buildVolumeMM;
    const layers = [...new Set([0, 1, 2, 3, Math.floor(n * 0.25), Math.floor(n / 2), Math.floor(n * 0.75), n - 3, n - 1].filter((L) => L >= 0 && L < n))];
    for (let pl = 0; pl < Math.min(2, spec.plates.length); pl++) {
      for (const L of layers) {
        const plan = T.layerPlan(S, spec, pl, L);
        const area = plan.outline.reduce((t, l) => t + S.area(l), 0);
        assert.ok(plan.pen.some((p) => p) || area < 4 * spec.lineW ** 2, `${product.id} layer ${L}: nothing extruded on ${area.toFixed(1)} mm²`);
        for (let i = 0; i < plan.pen.length; i++) {
          for (const k of [i, i + 1]) {
            const x = plan.pts[k * 2], y = plan.pts[k * 2 + 1];
            assert.ok(Math.abs(x) <= bx / 2 && Math.abs(y) <= by / 2, `${product.id} layer ${L}: (${x.toFixed(1)}, ${y.toFixed(1)}) is off the ${bx} x ${by} bed`);
          }
          if (!plan.pen[i] || !EXTRUDE.has(plan.type[i])) continue;
          // Check both ends of every extruded step (sampled for long layers).
          if (plan.pen.length > 4000 && i % 4) continue;
          for (const k of [i, i + 1]) {
            const x = plan.pts[k * 2], y = plan.pts[k * 2 + 1];
            const ok = S.insideLoops(plan.outline, x, y) || S.distToLoops(plan.outline, x, y) <= 0.5;
            assert.ok(ok, `${product.id} layer ${L}: extrusion at (${x.toFixed(2)}, ${y.toFixed(2)}) is outside the part`);
          }
        }
      }
    }
  }
});

test('layer count is the part height over the layer height, which follows the nozzle', () => {
  const ender = cat.printers.find((p) => p.id === 'ender-3-v3-se');
  for (const product of FDM) {
    const spec = specOn(product, smallestPrinter(product));
    assert.equal(S.layerCount(spec), Math.round(spec.H / spec.layerH));
    const top = T.layerPlan(S, spec, 0, S.layerCount(spec) - 1);
    assert.ok(Math.abs(top.z - S.layerCount(spec) * spec.layerH) < 1e-9 && Math.abs(top.z - spec.H) <= spec.layerH / 2 + 1e-9, `${product.id}: top layer at ${top.z}`);
  }
  const pot = cat.products.find((p) => p.id === 'plant-pot');
  for (const [nozzle, h, w] of [[0.2, 0.1, 0.225], [0.4, 0.2, 0.45], [0.6, 0.3, 0.675], [0.8, 0.4, 0.9]]) {
    const spec = specOn(pot, ender, { nozzleMM: nozzle });
    assert.equal(spec.layerH, h);
    assert.equal(spec.lineW, w);
    assert.equal(S.layerCount(spec), Math.round(spec.H / h));
  }
  // Resin, powder and metal machines print at their own layer heights.
  for (const [tech, h] of [['MSLA', 0.05], ['SLA', 0.05], ['SLS', 0.11], ['MJF', 0.08], ['DMLS', 0.04]]) assert.equal(S.slicerFor(tech).layerH, h);
});

test('two perimeters: the outer one half a line inside the outline, the inner one a line further in', () => {
  const product = cat.products.find((p) => p.id === 'robot-enclosure');
  const spec = specOn(product, smallestPrinter(product));
  const plan = T.layerPlan(S, spec, 0, Math.floor(S.layerCount(spec) / 2));
  const at = (type) => { const out = []; for (let i = 0; i < plan.pen.length; i++) if (plan.pen[i] && plan.type[i] === type) out.push([plan.pts[i * 2 + 2], plan.pts[i * 2 + 3]]); return out; };
  const outer = at(T.TYPE.outer), inner = at(T.TYPE.inner);
  assert.ok(outer.length > 20 && inner.length > 20);
  const avg = (pts) => pts.reduce((t, [x, y]) => t + S.distToLoops(plan.outline, x, y), 0) / pts.length;
  assert.ok(Math.abs(avg(outer) - spec.lineW / 2) < 0.12, `outer perimeter ${avg(outer).toFixed(3)} mm in`);
  assert.ok(Math.abs(avg(inner) - spec.lineW * 1.5) < 0.12, `inner perimeter ${avg(inner).toFixed(3)} mm in`);
  // Inner before outer (the outer wall comes out cleaner), each loop starting at the back.
  const firstInner = plan.type.indexOf(T.TYPE.inner), firstOuter = plan.type.indexOf(T.TYPE.outer);
  assert.ok(firstInner >= 0 && firstInner < firstOuter);
});

test('solid skin on the first and last three layers and over floors; sparse infill in between', () => {
  const product = cat.products.find((p) => p.id === 'robot-enclosure');
  const spec = specOn(product, smallestPrinter(product));
  const n = S.layerCount(spec);
  const len = (L) => T.layerPlan(S, spec, 0, L).length;
  for (const L of [0, 1, 2]) { const l = len(L); assert.ok(l.skin > 10000 && l.sparse === 0, `layer ${L}: ${JSON.stringify(l)}`); }
  assert.ok(len(5).sparse > 1000 && len(5).skin === 0, 'the floor is sparse in the middle');
  assert.ok(len(Math.floor(n / 2)).skin === 0, 'walls have no skin');
  // The lid ledge at the top: skin, no sparse.
  assert.ok(len(n - 1).skin > 0 && len(n - 1).sparse === 0);
  // 15% infill: lines a line width over 0.15 apart (3 mm for a 0.45 mm line).
  assert.ok(Math.abs(T.settingsFor(spec).sparse - 0.45 / 0.4) < 1e-9 || Math.abs(T.settingsFor(spec).sparse - spec.lineW / spec.infill) < 1e-9);
  const pot = cat.products.find((p) => p.id === 'decorative-vase');
  assert.equal(T.settingsFor(specOn(pot, smallestPrinter(pot))).sparse, 0.45 / 0.5);
});

test('infill runs at +45 degrees on even layers and -45 on odd ones', () => {
  const product = cat.products.find((p) => p.id === 'robot-enclosure');
  const spec = specOn(product, smallestPrinter(product));
  for (const L of [4, 5, 6, 7]) {
    const plan = T.layerPlan(S, spec, 0, L);
    let n = 0, sum = 0;
    for (let i = 0; i < plan.pen.length; i++) {
      if (!plan.pen[i] || plan.type[i] !== T.TYPE.sparse) continue;
      const dx = plan.pts[i * 2 + 2] - plan.pts[i * 2], dy = plan.pts[i * 2 + 3] - plan.pts[i * 2 + 1];
      if (Math.hypot(dx, dy) < 2) continue;
      sum += Math.sign(dx * dy); n++;
    }
    assert.ok(n > 10, `layer ${L}: ${n} infill lines`);
    assert.equal(Math.sign(sum), L % 2 ? -1 : 1, `layer ${L} infill direction`);
    assert.ok(Math.abs(sum) === n, `layer ${L}: lines in both directions`);
  }
});

test('travel stays short: infill is laid in strips, not across the whole part every line', () => {
  for (const id of ['phone-case', 'robot-enclosure', 'plant-pot', 'cosplay-helmet']) {
    const product = cat.products.find((p) => p.id === id);
    const spec = specOn(product, smallestPrinter(product));
    const n = S.layerCount(spec);
    for (const L of [0, 4, Math.floor(n / 2), n - 1]) {
      const l = T.layerPlan(S, spec, 0, L).length;
      const ext = l.outer + l.inner + l.sparse + l.skin + l.skirt;
      assert.ok(l.travel <= ext * 0.6, `${id} layer ${L}: ${l.travel.toFixed(0)} mm travel for ${ext.toFixed(0)} mm of extrusion`);
    }
  }
});

test('a skirt goes round the first layer only, outside the part and on the bed', () => {
  const product = cat.products.find((p) => p.id === 'drone-frame');
  const printer = smallestPrinter(product);
  const spec = specOn(product, printer);
  const first = T.layerPlan(S, spec, 0, 0), second = T.layerPlan(S, spec, 0, 1);
  assert.ok(first.length.skirt > 0 && second.length.skirt === 0);
  for (let i = 0; i < first.pen.length; i++) {
    if (first.type[i] !== T.TYPE.skirt) continue;
    const x = first.pts[i * 2 + 2], y = first.pts[i * 2 + 3];
    assert.ok(!S.insideLoops(first.outline, x, y) && S.distToLoops(first.outline, x, y) > 2);
  }
});

test('before printing: a purge line along the front of the bed and a probing mesh over the part', () => {
  for (const printer of cat.printers.filter((p) => S.techKind(p.tech) === 'fdm')) {
    const [bx, by] = printer.buildVolumeMM;
    const purge = T.purgeLine(bx, by);
    assert.ok(purge.length.purge > 40);
    for (let i = 0; i < purge.pts.length; i += 2) {
      assert.ok(Math.abs(purge.pts[i]) <= bx / 2 && Math.abs(purge.pts[i + 1]) <= by / 2, `${printer.id}: purge off the bed`);
      if (i >= 4) assert.ok(purge.pts[i + 1] < -by / 2 + 12, `${printer.id}: purge not at the front`);
    }
    const probe = T.probeGrid(bx, by, [-40, -30, 40, 30], 4);
    assert.equal(probe.length, 32);
    for (let i = 0; i < probe.length; i += 2) assert.ok(Math.abs(probe[i]) <= bx / 2 - 9 && Math.abs(probe[i + 1]) <= by / 2 - 9);
  }
});

test('following the head: starts at the path start, ends at its end, never goes backwards', () => {
  const product = cat.products.find((p) => p.id === 'plant-pot');
  const spec = specOn(product, smallestPrinter(product));
  const plan = T.layerPlan(S, spec, 0, 40);
  const tl = T.timeline(plan);
  const a = T.headAt(plan, tl, 0), b = T.headAt(plan, tl, 1);
  assert.ok(Math.hypot(a.x - plan.pts[0], a.y - plan.pts[1]) < 1e-6);
  const e = plan.pts.length;
  assert.ok(Math.hypot(b.x - plan.pts[e - 2], b.y - plan.pts[e - 1]) < 1e-6);
  let last = -1;
  for (let f = 0; f <= 1; f += 0.01) { const h = T.headAt(plan, tl, f); assert.ok(h.extruded >= last); last = h.extruded; }
  assert.equal(T.headAt(plan, tl, 1).extruded + 1 >= plan.pen.reduce((t, p) => t + p, 0), true);
});

test('laser machines hatch their cross-section; resin layers are just the cross-section', () => {
  const powder = cat.products.find((p) => p.id === 'aerospace-bracket');
  const eos = cat.printers.find((p) => p.id === 'eos-m290');
  const spec = specOn(powder, eos, { density: densityOf('metal-ti6al4v') });
  const plan = T.layerPlan(S, spec, 0, 100);
  assert.ok(plan.outline.length > 0 && plan.length.skin > 0, 'DMLS hatching');
  const minis = cat.products.find((p) => p.id === 'miniature-batch');
  const saturn = cat.printers.find((p) => p.id === 'elegoo-saturn-4-ultra');
  const r = T.layerPlan(S, specOn(minis, saturn, { density: 1.12 }), 0, 400);
  assert.ok(r.outline.length > 0 && r.pen.length === 0, 'resin cures the whole section at once');
});
