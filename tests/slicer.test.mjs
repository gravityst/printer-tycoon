// The slicer worker's requests, run the way the main-thread fallback runs them: the part's layout,
// its meshes (a card's budget shared across a batch), one layer's toolpath, and the start of a print.
import test from 'node:test';
import assert from 'node:assert/strict';
import { handle, thinPlan } from '../docs/slicer-worker.js';
import * as S from '../docs/shapes.js';
import * as T from '../docs/toolpath.js';
import { cat } from './helpers/catalog.mjs';
import { smallestPrinter } from './helpers/printing.mjs';
import { densityOf } from '../docs/look.js';

const mid = (r) => (r[0] + r[1]) / 2;
const argsFor = (id, over = {}) => {
  const product = cat.products.find((p) => p.id === id);
  const pr = smallestPrinter(product);
  return { productId: id, heightMM: mid(product.heightMM), grams: mid(product.grams), density: densityOf(product.materials[0]), bedMM: pr.buildVolumeMM, tech: pr.tech, nozzleMM: 0.4, ...over };
};

test('spec: the layout the renderer instances (plates of placed units) and the layer count', async () => {
  const r = await handle({ op: 'spec', args: argsFor('custom-grip-batch') });
  assert.equal(r.spec.plates.flat().length, 50);
  assert.ok(r.spec.layers > 10 && r.spec.layerH === 0.2);
  for (const it of r.spec.plates[0]) assert.ok(r.spec.units[it.unit]);
  const none = await handle({ op: 'spec', args: { ...argsFor('plant-pot'), productId: 'no-such-thing' } });
  assert.ok(none.error);
});

test('loft: a card shares its triangle budget across a batch; a gallery tile gets the full budget per part', async () => {
  const card = await handle({ op: 'loft', args: argsFor('custom-grip-batch'), budget: 6000 });
  const u = card.units.part || Object.values(card.units)[0];
  assert.equal(u.copies, card.spec.plates[0].length, 'copies counted on the plate being printed');
  assert.ok(u.copies > 1 && u.triangles * u.copies <= 7500, `${u.triangles} x ${u.copies}`);
  const hero = await handle({ op: 'loft', args: argsFor('plant-pot'), budget: 8000, hero: true });
  const pot = hero.units.part;
  assert.ok(pot.triangles <= 8000 && pot.triangles > 500);
  assert.ok(pot.positions instanceof Float32Array && pot.index.length % 3 === 0);
  for (const c of pot.caps) assert.ok(c.outer instanceof Float32Array && (c.dir === 1 || c.dir === -1));
  assert.ok(hero.transfer.length >= 3, 'typed arrays are handed over, not copied');
});

test('plan and pre: one layer of toolpath on the bed, the purge line and the probing grid', async () => {
  const args = argsFor('phone-case');
  const r = await handle({ op: 'plan', args, layer: 3 });
  const [bx, by] = args.bedMM;
  assert.equal(r.plan.layer, 3);
  assert.ok(r.plan.pts.length >= 4 && r.plan.pen.length === r.plan.pts.length / 2 - 1);
  for (let i = 0; i < r.plan.pts.length; i += 2) assert.ok(Math.abs(r.plan.pts[i]) <= bx / 2 && Math.abs(r.plan.pts[i + 1]) <= by / 2);
  assert.ok(r.plan.outline.length > 0 && r.plan.outline[0] instanceof Float32Array);
  const pre = await handle({ op: 'pre', args, autoLevel: true });
  assert.equal(pre.probe.length, 32);
  assert.ok(pre.purge.pts.length >= 8);
  const resin = await handle({ op: 'plan', args: argsFor('jewelry-casting'), layer: 40 });
  assert.equal(resin.plan.kind, 'resin');
  assert.ok(resin.plan.outline.length > 0);
});

test('a plan thinned for drawing stays on the path: same runs, every dropped point within the tolerance', () => {
  const product = cat.products.find((p) => p.id === 'decorative-vase');
  const pr = smallestPrinter(product);
  const spec = S.partSpec(product.id, { heightMM: mid(product.heightMM), grams: mid(product.grams), density: densityOf('pla'), bedMM: pr.buildVolumeMM, tech: pr.tech, nozzleMM: 0.4 });
  for (const layer of [0, 40, 300]) {
    const p = T.layerPlan(S, spec, 0, layer, {});
    const t = thinPlan(p, 0.12);
    assert.ok(t.pen.length < p.pen.length * 0.8, `layer ${layer}: ${t.pen.length} of ${p.pen.length} steps`);
    // Extruded length barely changes; travel moves are all kept.
    const len = (q, pen) => { let a = 0; for (let i = 0; i < q.pen.length; i++) if (q.pen[i] === pen) a += Math.hypot(q.pts[i * 2 + 2] - q.pts[i * 2], q.pts[i * 2 + 3] - q.pts[i * 2 + 1]); return a; };
    assert.ok(Math.abs(len(t, 1) / len(p, 1) - 1) < 0.01);
    assert.equal(t.pen.filter((x) => !x).length, p.pen.filter((x) => !x).length);
    // Every original point is within 0.12 mm of the thinned path.
    const segs = [];
    for (let i = 0; i < t.pen.length; i++) segs.push([t.pts[i * 2], t.pts[i * 2 + 1], t.pts[i * 2 + 2], t.pts[i * 2 + 3]]);
    for (let i = 0; i < p.pts.length; i += 14) {
      const x = p.pts[i], y = p.pts[i + 1];
      let best = Infinity;
      for (const [ax, ay, bx, by] of segs) {
        const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy || 1e-12;
        const u = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / L2));
        best = Math.min(best, Math.hypot(x - ax - u * dx, y - ay - u * dy));
      }
      assert.ok(best <= 0.12 + 1e-4, `point ${i / 2} is ${best.toFixed(3)} mm off`);
    }
  }
});
