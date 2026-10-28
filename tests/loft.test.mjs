// Part meshes: every product's model is at most 8k triangles, sound (finite, in range, unit normals)
// and the same size as the part it stands for.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as S from '../docs/shapes.js';
import * as Loft from '../docs/loft.js';
import { densityOf } from '../docs/look.js';
import { cat } from './helpers/catalog.mjs';
import { smallestPrinter } from './helpers/printing.mjs';

const mid = (r) => (r[0] + r[1]) / 2;

test('loft.js is pure: no imports, DOM, THREE, clock or randomness', () => {
  const code = readFileSync(new URL('../docs/loft.js', import.meta.url), 'utf8').replace(/\/\/[^\n]*/g, '');
  assert.ok(!/^\s*import\s/m.test(code));
  for (const banned of ['document.', 'window.', 'THREE', 'performance.', 'Date.now', 'Math.random', 'localStorage']) assert.ok(!code.includes(banned));
});

test('every product mesh is at most 8k triangles, sound, and the size of its part', () => {
  const report = [];
  for (const product of cat.products) {
    const printer = smallestPrinter(product);
    const spec = S.partSpec(product.id, { product, heightMM: mid(product.heightMM), grams: mid(product.grams), density: densityOf(product.materials[0]),
      tech: printer.tech, bedMM: printer.buildVolumeMM });
    const meshes = Loft.loftSpec(S, spec);
    let total = 0;
    for (const [name, m] of Object.entries(meshes)) {
      const unit = spec.units[name];
      assert.ok(m.triangles <= 8000, `${product.id}/${name}: ${m.triangles} triangles`);
      assert.ok(m.triangles >= 12, `${product.id}/${name}: empty mesh`);
      const nv = m.positions.length / 3;
      for (let i = 0; i < m.index.length; i++) assert.ok(m.index[i] < nv);
      const [x0, y0, x1, y1] = unit.bounds, pad = 2;
      for (let i = 0; i < m.positions.length; i += 3) {
        const x = m.positions[i], y = m.positions[i + 1], z = m.positions[i + 2];
        assert.ok(Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z));
        assert.ok(x >= x0 - pad && x <= x1 + pad && y >= y0 - pad && y <= y1 + pad && z >= -1e-6 && z <= unit.H + 1e-6, `${product.id}/${name}: vertex outside the part`);
        const l = Math.hypot(m.normals[i], m.normals[i + 1], m.normals[i + 2]);
        assert.ok(Math.abs(l - 1) < 1e-3, `${product.id}/${name}: normal of length ${l}`);
      }
      // A cap's triangle count is what earcut will make of it.
      for (const c of m.caps) assert.equal(c.tris, c.outer.length / 2 + c.holes.reduce((t, h) => t + h.length / 2, 0) + 2 * c.holes.length - 2);
      const copies = spec.plates[0].filter((it) => it.unit === name).length;
      total += m.triangles * copies;
    }
    report.push(`${product.id}: ${total}`);
  }
});

test('the mesh stands as tall as the part and covers its footprint', () => {
  for (const id of ['plant-pot', 'cosplay-helmet', 'functional-gear', 'surgical-implant']) {
    const product = cat.products.find((p) => p.id === id);
    const spec = S.partSpec(id, { product, heightMM: mid(product.heightMM), grams: mid(product.grams), density: densityOf(product.materials[0]), tech: product.tech[0] });
    const unit = spec.units.part, m = Loft.loftUnit(S, unit);
    let zmax = 0, xmin = Infinity, xmax = -Infinity;
    for (let i = 0; i < m.positions.length; i += 3) { zmax = Math.max(zmax, m.positions[i + 2]); xmin = Math.min(xmin, m.positions[i]); xmax = Math.max(xmax, m.positions[i]); }
    assert.ok(Math.abs(zmax - unit.H) < 1e-6, `${id}: top at ${zmax} of ${unit.H}`);
    // The part's outline in its own coordinates (plates are centred on the bed).
    const it = spec.plates[0][0];
    const loops = S.plateContours(spec, 0, unit.H * 0.3, [0])[0].map((l) => S.placeLoop(l, -it.x, -it.y));
    const b = S.loopBounds(loops);
    assert.ok(xmin <= b[0] + 1.5 && xmax >= b[2] - 1.5, `${id}: mesh ${xmin.toFixed(1)}..${xmax.toFixed(1)} vs part ${b[0].toFixed(1)}..${b[2].toFixed(1)}`);
  }
});
