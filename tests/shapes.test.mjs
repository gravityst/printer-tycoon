// Part shapes: every product's cross-sections are valid outlines, its part fits the machines that
// take the order, and the sizing table makes resin, powder and metal parts weigh what orders say.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as S from '../docs/shapes.js';
import { densityOf } from '../docs/look.js';
import { cat } from './helpers/catalog.mjs';
import { checkLoops } from './helpers/geom-check.mjs';

const mid = (r) => (r[0] + r[1]) / 2;
// The smallest bed among the printers that can take a product (the tightest fit).
export function smallestBed(product) {
  const ok = cat.printers.filter((p) => product.tech.includes(p.tech) && p.buildVolumeMM.every((v, i) => v >= (product.minBuildVolumeMM?.[i] || 0)));
  ok.sort((a, b) => a.buildVolumeMM[0] * a.buildVolumeMM[1] - b.buildVolumeMM[0] * b.buildVolumeMM[1]);
  return ok.length ? ok[0] : null;
}
const specFor = (product, over = {}) => {
  const pr = smallestBed(product);
  return S.partSpec(product.id, { product, heightMM: mid(product.heightMM), grams: mid(product.grams), density: densityOf(product.materials[0]),
    tech: pr ? pr.tech : product.tech[0], bedMM: pr ? pr.buildVolumeMM : product.minBuildVolumeMM, ...over });
};

test('shapes.js is pure: no imports, DOM, THREE, clock or randomness', () => {
  const code = readFileSync(new URL('../docs/shapes.js', import.meta.url), 'utf8').replace(/\/\/[^\n]*/g, '');
  assert.ok(!/^\s*import\s/m.test(code), 'shapes.js imports something');
  for (const banned of ['document.', 'window.', 'THREE', 'performance.', 'Date.now', 'Math.random', 'localStorage']) {
    assert.ok(!code.includes(banned), `shapes.js uses ${banned}`);
  }
});

test('every product has a shape and a sizing entry, and nothing else does', () => {
  const ids = cat.products.map((p) => p.id).sort();
  assert.deepEqual(Object.keys(S.PRODUCTS).sort(), ids);
  assert.deepEqual(Object.keys(S.SIZING).sort(), ids);
  for (const p of cat.products) assert.ok(smallestBed(p), `no printer can take ${p.id}`);
});

test('every outline is closed, simple and consistently wound at 20 heights (all 30 products)', () => {
  for (const product of cat.products) {
    const spec = specFor(product);
    for (let pl = 0; pl < Math.min(2, spec.plates.length); pl++) {
      for (let i = 0; i < 20; i++) {
        const z = (i + 0.5) * spec.H / 20;
        const loops = S.plateContours(spec, pl, z, [0])[0];
        const r = checkLoops(loops);
        assert.ok(r.ok, `${product.id} plate ${pl} z=${z.toFixed(2)}: ${r.problems.slice(0, 3).join('; ')}`);
      }
      assert.ok(S.plateContours(spec, pl, spec.H * 0.05, [0])[0].length > 0, `${product.id}: nothing on the bed`);
    }
  }
});

test('outlines stay valid at the ends of every size knob', () => {
  for (const product of cat.products) {
    const def = S.PRODUCTS[product.id];
    for (const k of def.knob) {
      const spec = specFor(product, { k });
      for (let i = 0; i < 8; i++) {
        const z = (i + 0.5) * spec.H / 8;
        const r = checkLoops(S.plateContours(spec, 0, z, [0])[0]);
        assert.ok(r.ok, `${product.id} k=${k} z=${z.toFixed(2)}: ${r.problems.slice(0, 2).join('; ')}`);
      }
    }
  }
});

test('inset contours (perimeters) nest inside the outline: wound the same way and never outside', () => {
  for (const id of ['phone-case', 'plant-pot', 'robot-enclosure', 'drone-frame', 'functional-gear', 'cosplay-helmet']) {
    const product = cat.products.find((p) => p.id === id);
    const spec = specFor(product);
    for (const f of [0.1, 0.5, 0.9]) {
      const c = S.plateContours(spec, 0, spec.H * f, [0, -0.225, -0.675]);
      for (const iso of [-0.225, -0.675]) {
        assert.ok(checkLoops(c[iso]).ok, `${id} iso ${iso}`);
        for (const l of c[iso]) for (let i = 0; i < l.length; i += 8) {
          const inside = S.insideLoops(c[0], l[i], l[i + 1]);
          assert.ok(inside || S.distToLoops(c[0], l[i], l[i + 1]) < 0.3, `${id}: inset point outside the outline`);
        }
      }
    }
  }
});

test('parts sit on the bed: centred, inside the smallest bed that takes them, and as tall as the order', () => {
  for (const product of cat.products) {
    const pr = smallestBed(product);
    const spec = specFor(product);
    const [bx, by, bz] = pr.buildVolumeMM;
    for (let pl = 0; pl < spec.plates.length; pl++) {
      let b = [Infinity, Infinity, -Infinity, -Infinity];
      for (let i = 0; i < 10; i++) {
        const loops = S.plateContours(spec, pl, (i + 0.5) * spec.H / 10, [0], { cell: Math.max(spec.cell, 0.5) })[0];
        if (!loops.length) continue;
        const q = S.loopBounds(loops);
        b = [Math.min(b[0], q[0]), Math.min(b[1], q[1]), Math.max(b[2], q[2]), Math.max(b[3], q[3])];
      }
      assert.ok(b[0] >= -bx / 2 && b[2] <= bx / 2 && b[1] >= -by / 2 && b[3] <= by / 2,
        `${product.id} plate ${pl} spans ${b.map((v) => v.toFixed(1))} on a ${bx} x ${by} bed (${pr.id})`);
    }
    assert.ok(spec.H <= bz, `${product.id} is ${spec.H} mm tall on a ${bz} mm machine`);
    // Parts are built at the order's height (batches nest through it; crowns and minis count supports).
    assert.ok(spec.H <= spec.orderH + 0.5 && spec.H >= spec.orderH * 0.6, `${product.id}: ${spec.H} mm for a ${spec.orderH} mm order`);
  }
});

test('a batch is laid out as its order says: copies on as few plates as the bed allows', () => {
  const counts = { 'wall-hook': 4, 'miniature-batch': 16, 'custom-grip-batch': 50, 'drone-propeller': 10, 'dental-crown-wax': 4, 'sls-production-batch': 50, 'mjf-connector-batch': 200 };
  for (const [id, n] of Object.entries(counts)) {
    const product = cat.products.find((p) => p.id === id);
    const spec = specFor(product);
    const items = spec.plates.flat().filter((it) => !it.unit.startsWith('raft'));
    assert.equal(items.length, n, `${id}: ${items.length} copies`);
  }
  // The same order on a bigger bed needs no more plates.
  const grips = cat.products.find((p) => p.id === 'custom-grip-batch');
  assert.ok(specFor(grips, { bedMM: [350, 350, 350] }).plates.length <= specFor(grips, { bedMM: [220, 220, 250] }).plates.length);
});

test('sizing: the table rises with the knob, and knobFor finds the knob that prints a volume', () => {
  for (const product of cat.products) {
    const s = S.SIZING[product.id], def = S.PRODUCTS[product.id];
    for (const row of s.V) for (let j = 1; j < row.length; j++) assert.ok(row[j] >= row[j - 1], `${product.id} not rising: ${row}`);
    for (const H of [s.Hs[0], mid(s.Hs.slice(0, 2)), s.Hs[2]]) {
      const v = (S.sizedVolume(s, H, def.knob[0]) + S.sizedVolume(s, H, def.knob[1])) / 2;
      const k = S.knobFor(def, s, H, v);
      assert.ok(Math.abs(S.sizedVolume(s, H, k) / v - 1) < 0.01, `${product.id}: round trip`);
    }
  }
});

test('resin, powder and metal parts weigh what the order says, within 15%', () => {
  for (const product of cat.products) {
    if (S.techKind(product.tech[0]) === 'fdm') continue;
    // The lightest and heaviest order in its first material, the middle one in its last.
    const cases = [[product.materials[0], product.grams[0]], [product.materials[0], product.grams[1]],
      [product.materials[product.materials.length - 1], mid(product.grams)]];
    for (const [material, grams] of cases) {
      const spec = specFor(product, { grams, density: densityOf(material) });
      const got = S.solidVolume(spec, 10, spec.cell * 1.2) * densityOf(material);
      assert.ok(Math.abs(got / grams - 1) <= 0.15, `${product.id} in ${material}: ${got.toFixed(1)} g for a ${grams} g order`);
    }
  }
});
