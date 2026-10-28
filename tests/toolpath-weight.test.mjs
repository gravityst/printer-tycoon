// The toolpath's extruded length tracks the order's weight: an FDM part sliced on the smallest
// machine that takes it weighs what the order says, within 15%. (Its own file: it is the slow one,
// and node runs test files side by side.)
import test from 'node:test';
import assert from 'node:assert/strict';
import * as S from '../docs/shapes.js';
import * as T from '../docs/toolpath.js';
import { densityOf } from '../docs/look.js';
import { cat } from './helpers/catalog.mjs';
import { smallestPrinter, specOn } from './helpers/printing.mjs';

const mid = (r) => (r[0] + r[1]) / 2;
const FDM = cat.products.filter((p) => S.techKind(p.tech[0]) === 'fdm');

test('path length x line area x density tracks grams within 15%, for every FDM product', () => {
  const rows = [];
  for (const product of FDM) {
    const printer = smallestPrinter(product);
    const grams = mid(product.grams), density = densityOf(product.materials[0]);
    const spec = specOn(product, printer, { grams, density });
    const got = T.printedVolume(S, spec, { samples: 24 }) * density;
    rows.push(`${product.id} ${got.toFixed(1)}/${grams}`);
    assert.ok(Math.abs(got / grams - 1) <= 0.15, `${product.id}: ${got.toFixed(1)} g for a ${grams} g order`);
  }
});

test('the lightest and heaviest orders of a spread of products also track their grams', () => {
  for (const id of ['phone-case', 'plant-pot', 'robot-enclosure', 'custom-grip-batch', 'end-use-bracket', 'drone-propeller']) {
    const product = cat.products.find((p) => p.id === id);
    const printer = smallestPrinter(product);
    for (const [grams, material] of [[product.grams[0], product.materials[0]], [product.grams[1], product.materials[product.materials.length - 1]]]) {
      const density = densityOf(material);
      const spec = specOn(product, printer, { grams, density });
      const got = T.printedVolume(S, spec, { samples: 24 }) * density;
      assert.ok(Math.abs(got / grams - 1) <= 0.15, `${id} in ${material}: ${got.toFixed(1)} g for a ${grams} g order`);
    }
  }
});

test('weight grows with the order: heavier orders lay more path', () => {
  const product = cat.products.find((p) => p.id === 'decorative-vase');
  const printer = smallestPrinter(product);
  const vol = (grams) => T.printedVolume(S, specOn(product, printer, { grams }), { samples: 16 });
  assert.ok(vol(200) < vol(290) && vol(290) < vol(380));
});
