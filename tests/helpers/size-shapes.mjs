// Regenerates shapes.js's SIZING table: the printed volume (cm³) of every product on a grid of
// heights (the product's min, middle and max) x six knob values across its range. FDM volumes are
// the 0.4 mm toolpath's extruded volume; resin, powder and metal parts are solid.
//
//   node tests/helpers/size-shapes.mjs            print the table (paste it into shapes.js)
//   node tests/helpers/size-shapes.mjs --check    also show which order weights each product reaches
import * as S from '../../docs/shapes.js';
import * as T from '../../docs/toolpath.js';
import { densityOf } from '../../docs/look.js';
import { readFileSync } from 'node:fs';

const products = JSON.parse(readFileSync(new URL('../../docs/data/products.json', import.meta.url), 'utf8')).products;
const only = process.argv.find((a) => a.startsWith('--only='))?.slice(7);
const check = process.argv.includes('--check');
export const SAMPLES = 48;
export const bedFor = (p) => [256, 256, 256].map((v, i) => Math.max(v, (p.minBuildVolumeMM?.[i] || 0) + 24));

export function measure(p, H, k) {
  const spec = S.partSpec(p.id, { product: p, heightMM: H, k, tech: p.tech[0], bedMM: bedFor(p) });
  return T.printedVolume(S, spec, { samples: SAMPLES });
}

const table = {};
for (const p of products) {
  if (only && p.id !== only) continue;
  const def = S.PRODUCTS[p.id];
  const Hs = [p.heightMM[0], (p.heightMM[0] + p.heightMM[1]) / 2, p.heightMM[1]];
  const ks = Array.from({ length: 6 }, (_, j) => +(def.knob[0] + (def.knob[1] - def.knob[0]) * j / 5).toFixed(3));
  const t0 = Date.now();
  const V = Hs.map((H) => ks.map((k) => +measure(p, H, k).toFixed(2)));
  table[p.id] = { Hs, ks, V };
  if (check) {
    const dens = p.materials.map(densityOf);
    const need = [p.grams[0] / Math.max(...dens), p.grams[1] / Math.min(...dens)];
    const reach = [V[1][0], V[1][5]];
    const ok = reach[0] <= need[0] * 1.0 && reach[1] >= need[1];
    process.stderr.write(`${ok ? '  ' : '!!'} ${p.id.padEnd(24)} need ${need.map((v) => v.toFixed(1)).join('-')} cm3, reach at mid height ${reach.map((v) => v.toFixed(1)).join('-')}  rows ${V.map((r) => r[0].toFixed(0) + '..' + r[5].toFixed(0)).join(' | ')}  (${Date.now() - t0} ms)\n`);
  }
}
const lines = Object.entries(table).map(([id, s]) => `  '${id}': { Hs: [${s.Hs.join(', ')}], ks: [${s.ks.join(', ')}], V: [${s.V.map((r) => '[' + r.join(', ') + ']').join(', ')}] },`);
console.log('export const SIZING = {\n' + lines.join('\n') + '\n};');
