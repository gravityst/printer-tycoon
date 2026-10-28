// Shared by the toolpath tests: the smallest machine that takes a product, and its part there.
import * as S from '../../docs/shapes.js';
import { densityOf } from '../../docs/look.js';
import { cat } from './catalog.mjs';

const mid = (r) => (r[0] + r[1]) / 2;
export function smallestPrinter(product) {
  const ok = cat.printers.filter((p) => product.tech.includes(p.tech) && p.buildVolumeMM.every((v, i) => v >= (product.minBuildVolumeMM?.[i] || 0)));
  ok.sort((a, b) => a.buildVolumeMM[0] * a.buildVolumeMM[1] - b.buildVolumeMM[0] * b.buildVolumeMM[1]);
  return ok[0];
}
export const specOn = (product, printer, over = {}) => S.partSpec(product.id, {
  product, heightMM: mid(product.heightMM), grams: mid(product.grams), density: densityOf(product.materials[0]),
  tech: printer.tech, bedMM: printer.buildVolumeMM, nozzleMM: 0.4, ...over,
});
