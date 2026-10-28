// =====================================================================
// Print3D toolpaths: what the head (or laser) does on one layer.
//
// Pure ES module: no DOM, no THREE, no imports. The shapes module is passed in (S) so every module
// keeps its own cache-buster. Units are millimetres in plate coordinates (the bed's centre is 0, 0;
// +y is the back of the machine).
//
// FDM layer, the way a slicer lays it out:
//   - two perimeters: the contours of the part's field at -w/2 and -3w/2 (inner one first, then
//     the outer one, each starting at a seam at the back);
//   - solid skin (100%, lines one width apart) wherever the part ends within 3 layers above or
//     below, so floors, roofs and the first layers print solid;
//   - sparse rectilinear infill everywhere else (15% unless the product says otherwise), lines
//     at +45 degrees on even layers and -45 on odd ones, anchored to the plate so layers cross;
//   - travels between islands (pen up).
// The first layer also gets a skirt 3 mm out. Before a print: a probing grid (machines that level
// themselves) and a purge line along the front of the bed.
// Resin, powder and metal layers return the cross-section (and laser hatching for SLS/DMLS).
// =====================================================================

const { abs, min, max, sqrt, cos, sin, floor, ceil, PI } = Math;

// Cross-section of one extruded line: a stadium of width w and height h.
export const lineArea = (w, h) => (w - h) * h + PI * h * h / 4;

export const TYPE = { outer: 0, inner: 1, sparse: 2, skin: 3, skirt: 4, purge: 5 };
const SKIN_LAYERS = 3;
const FILL_OVERLAP = 0.15;     // infill reaches 15% of a line into the inner perimeter

export function settingsFor(spec) {
  const w = spec.lineW, h = spec.layerH;
  const solid = (spec.infill ?? 0.15) >= 0.99;
  return {
    w, h, solid,
    isoOuter: -w / 2, isoInner: -1.5 * w, isoFill: -(2 - FILL_OVERLAP) * w,
    sparse: solid ? w : w / (spec.infill ?? 0.15), dense: w,
    skinDz: SKIN_LAYERS * h,
  };
}

// ---------------------------------------------------------------------
// Fields at a height for a box of the plate (every item printing there).
// ---------------------------------------------------------------------
function fieldOver(S, spec, plateIdx, box, z) {
  const items = (spec.plates[plateIdx] || []).filter((it) => {
    const u = spec.units[it.unit];
    if (z < it.z0 || z > it.z0 + u.H) return false;
    const b = S.itemBox(spec, it);
    return b[0] < box[2] && box[0] < b[2] && b[1] < box[3] && box[1] < b[3];
  });
  if (!items.length) return null;
  return S.groupField(spec, { items, box }, z);
}
const sameGrid = (g, v) => ({ ...g, v });
// A sliced 3D field is not an in-plane distance: near a rounded top its slope across the layer is
// far below 1, so an inset contour would vanish from a strip a slicer happily lays lines on. Divide
// by the in-plane slope (central differences) to get the in-plane distance near the outline,
// where perimeters live; flat ridges keep a floor on the slope.
export function inPlane(g) {
  const { nx, ny, cell, v } = g, out = new Float32Array(v.length);
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const k = j * nx + i;
      const gx = (v[k + (i < nx - 1 ? 1 : 0)] - v[k - (i > 0 ? 1 : 0)]) / (cell * ((i > 0 && i < nx - 1) ? 2 : 1));
      const gy = (v[k + (j < ny - 1 ? nx : 0)] - v[k - (j > 0 ? nx : 0)]) / (cell * ((j > 0 && j < ny - 1) ? 2 : 1));
      out[k] = v[k] / Math.max(0.15, Math.min(4, sqrt(gx * gx + gy * gy)));
    }
  }
  return { ...g, v: out };
}

// The contours a layer needs for one group, in plate coordinates.
function groupLayer(S, spec, plateIdx, group, z, st, cell, cache) {
  // A unit printing on its own (nothing else above or below in its box) is sliced in its own
  // coordinates, cached, then placed: a plate of identical parts costs one slice.
  const lone = group.items.length === 1 && [z + st.skinDz, z - st.skinDz].every((zz) => {
    const items = (spec.plates[plateIdx] || []).filter((it) => it !== group.items[0] && zz >= it.z0 && zz <= it.z0 + spec.units[it.unit].H);
    return items.every((it) => { const b = S.itemBox(spec, it); return !(b[0] < group.box[2] && group.box[0] < b[2] && b[1] < group.box[3] && group.box[1] < b[3]); });
  });
  const compute = (f, fUp, fDn, bounds) => {
    const g = inPlane(S.sampleGrid(f, bounds, cell));
    const up = fUp ? S.sampleGrid(fUp, bounds, cell) : null;
    const dn = fDn ? S.sampleGrid(fDn, bounds, cell) : null;
    const n = g.v.length, skin = new Float32Array(n), sparse = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const inner = g.v[i] - st.isoFill;                       // < 0 inside the infill region
      const cover = max(up ? up.v[i] : 1e3, dn ? dn.v[i] : 1e3); // < 0 where the part is above and below
      skin[i] = max(inner, -cover);
      sparse[i] = max(inner, cover);
    }
    return {
      outline: S.contours(g, 0), outer: S.contours(g, st.isoOuter), inner: S.contours(g, st.isoInner),
      skin: S.contours(sameGrid(g, skin), 0), sparse: st.solid ? [] : S.contours(sameGrid(g, sparse), 0),
      solidFill: st.solid ? S.contours(g, st.isoFill) : null,
    };
  };
  if (lone) {
    const it = group.items[0], u = spec.units[it.unit], zl = z - it.z0;
    const key = 'L|' + it.unit + '|' + zl.toFixed(4) + '|' + cell;
    let c = cache && cache.get(key);
    if (!c) {
      const at = (zz) => (zz >= 0 && zz <= u.H ? u.at(zz) : null);
      c = compute(u.at(zl), at(zl + st.skinDz), at(zl - st.skinDz), u.bounds);
      if (cache) cache.set(key, c);
    }
    const place = (loops) => (loops ? loops.map((l) => S.placeLoop(l, it.x, it.y, it.a, it.mirror)) : null);
    return { outline: place(c.outline), outer: place(c.outer), inner: place(c.inner), skin: place(c.skin), sparse: place(c.sparse), solidFill: place(c.solidFill) };
  }
  const f = S.groupField(spec, group, z);
  return compute(f, fieldOver(S, spec, plateIdx, group.box, z + st.skinDz), fieldOver(S, spec, plateIdx, group.box, z - st.skinDz), group.box);
}

// ---------------------------------------------------------------------
// Hatching: parallel lines at `angle` and `spacing`, clipped to loops by the even-odd rule.
// Lines sit at fixed offsets from the plate origin, so the same angle lines up layer to layer.
// Returns { c, s, lines: [{ v, segs: [u0, u1, u0, u1, ...] }] } in rotated coordinates
// (u along the line, v across), lines in order of v.
// ---------------------------------------------------------------------
export function hatch(loops, angle, spacing) {
  const c = cos(angle), s = sin(angle);
  const edges = [];
  let vmin = Infinity, vmax = -Infinity;
  for (const p of loops) {
    const n = p.length / 2;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const ua = p[j * 2] * c + p[j * 2 + 1] * s, va = -p[j * 2] * s + p[j * 2 + 1] * c;
      const ub = p[i * 2] * c + p[i * 2 + 1] * s, vb = -p[i * 2] * s + p[i * 2 + 1] * c;
      if (va === vb) continue;
      edges.push(ua, va, ub, vb);
      vmin = min(vmin, va, vb); vmax = max(vmax, va, vb);
    }
  }
  const out = { c, s, spacing, lines: [] };
  if (!edges.length) return out;
  const k0 = ceil(vmin / spacing), k1 = floor(vmax / spacing);
  if (k1 < k0) return out;
  const hits = new Array(k1 - k0 + 1);
  for (let e = 0; e < edges.length; e += 4) {
    const va = edges[e + 1], vb = edges[e + 3];
    const lo = min(va, vb), hi = max(va, vb);
    // Half-open in v so a line through a vertex counts it once.
    for (let k = max(k0, ceil(lo / spacing)); k <= k1 && k * spacing < hi; k++) {
      const t = (k * spacing - va) / (vb - va);
      (hits[k - k0] || (hits[k - k0] = [])).push(edges[e] + (edges[e + 2] - edges[e]) * t);
    }
  }
  for (let i = 0; i < hits.length; i++) {
    const us = hits[i];
    if (!us || us.length < 2) continue;
    us.sort((a, b) => a - b);
    const segs = [];
    for (let j = 0; j + 1 < us.length; j += 2) if (us[j + 1] - us[j] >= 0.05) segs.push(us[j], us[j + 1]);
    if (segs.length) out.lines.push({ v: (k0 + i) * spacing, segs });
  }
  return out;
}
// Group hatch segments into strips a head can zig-zag along: each next line's segment overlaps
// the last one (like a slicer's monotonic infill), so travel stays short. Returns strips as lists
// of [x0, y0, x1, y1] in drawing order.
export function strips(h) {
  const { c, s, lines } = h;
  const used = lines.map((L) => new Uint8Array(L.segs.length / 2));
  const xy = (u, v) => [u * c - v * s, u * s + v * c];
  const out = [];
  for (let li = 0; li < lines.length; li++) {
    for (let si = 0; si < used[li].length; si++) {
      if (used[li][si]) continue;
      const strip = [];
      let u0 = lines[li].segs[si * 2], u1 = lines[li].segs[si * 2 + 1], L = li, flip = false;
      used[li][si] = 1;
      for (;;) {
        const v = lines[L].v;
        const a = xy(flip ? u1 : u0, v), b = xy(flip ? u0 : u1, v);
        strip.push([a[0], a[1], b[0], b[1]]);
        const nl = L + 1;
        if (nl >= lines.length || lines[nl].v - v > h.spacing * 1.5) break;     // never across a gap
        // The unused segment on the next line that overlaps this one most.
        let best = -1, bestO = 0;
        const segs = lines[nl].segs;
        for (let j = 0; j < used[nl].length; j++) {
          if (used[nl][j]) continue;
          const o = min(u1, segs[j * 2 + 1]) - max(u0, segs[j * 2]);
          if (o > bestO) { bestO = o; best = j; }
        }
        if (best < 0) break;
        used[nl][best] = 1;
        u0 = segs[best * 2]; u1 = segs[best * 2 + 1]; L = nl; flip = !flip;
      }
      out.push(strip);
    }
  }
  return out;
}

// ---------------------------------------------------------------------
// Path building
// ---------------------------------------------------------------------
function pathBuilder() {
  const pts = [], pen = [], type = [];
  let x = null, y = null;
  return {
    pts, pen, type,
    get x() { return x; }, get y() { return y; },
    move(nx, ny) { if (x === null) { pts.push(nx, ny); x = nx; y = ny; return; } if (nx === x && ny === y) return; pts.push(nx, ny); pen.push(0); type.push(255); x = nx; y = ny; },
    line(nx, ny, t) { if (x === null) this.move(nx, ny); pts.push(nx, ny); pen.push(1); type.push(t); x = nx; y = ny; },
  };
}
// Rotate a loop so it starts at its seam: the point furthest to the back (largest y).
function seamStart(p) {
  const n = p.length / 2;
  let best = 0;
  for (let i = 1; i < n; i++) if (p[i * 2 + 1] > p[best * 2 + 1] + 1e-9 || (abs(p[i * 2 + 1] - p[best * 2 + 1]) <= 1e-9 && p[i * 2] < p[best * 2])) best = i;
  return best;
}
function drawLoop(b, p, t) {
  const n = p.length / 2, s = seamStart(p);
  b.move(p[s * 2], p[s * 2 + 1]);
  for (let k = 1; k <= n; k++) { const i = (s + k) % n; b.line(p[i * 2], p[i * 2 + 1], t); }
}
// Draw hatch strips nearest-first from the head; each strip is a zig-zag, either way round.
function drawStrips(b, list, t) {
  const left = list.slice();
  while (left.length) {
    let bi = 0, rev = false;
    if (b.x !== null) {
      let bd = Infinity;
      left.forEach((st, i) => {
        const f = st[0], l = st[st.length - 1];
        const d0 = (f[0] - b.x) ** 2 + (f[1] - b.y) ** 2;
        // Walking a strip backwards starts at the end of its last segment.
        const d1 = (l[2] - b.x) ** 2 + (l[3] - b.y) ** 2;
        if (d0 < bd) { bd = d0; bi = i; rev = false; }
        if (d1 < bd) { bd = d1; bi = i; rev = true; }
      });
    }
    const st = left.splice(bi, 1)[0];
    const segs = rev ? st.slice().reverse().map(([x0, y0, x1, y1]) => [x1, y1, x0, y0]) : st;
    for (const [x0, y0, x1, y1] of segs) { b.move(x0, y0); b.line(x1, y1, t); }
  }
}
// Which island (outer loop + holes) a point is in, by the even-odd rule over the island's loops.
function inIsland(S, isl, x, y) {
  if (!S.pointInLoop(isl.outer, x, y)) return false;
  for (const h of isl.holes) if (S.pointInLoop(h, x, y)) return false;
  return true;
}

// Convex hull (monotone chain) of a flat point list.
function hull(flat) {
  const P = [];
  for (let i = 0; i < flat.length; i += 2) P.push([flat[i], flat[i + 1]]);
  P.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (P.length < 3) return P;
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo = [], up = [];
  for (const p of P) { while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], p) <= 0) lo.pop(); lo.push(p); }
  for (let i = P.length - 1; i >= 0; i--) { const p = P[i]; while (up.length >= 2 && cross(up[up.length - 2], up[up.length - 1], p) <= 0) up.pop(); up.push(p); }
  return lo.slice(0, -1).concat(up.slice(0, -1));
}
// A skirt: the hull of the first layer, pushed out by `gap` mm (a loop, counter-clockwise).
export function skirtLoop(outline, gap = 3) {
  const pts = [];
  for (const l of outline) for (let i = 0; i < l.length; i += 2) for (let a = 0; a < 8; a++) pts.push(l[i] + gap * cos(a * PI / 4), l[i + 1] + gap * sin(a * PI / 4));
  const h = hull(pts);
  return h.length >= 3 ? h.flat() : null;
}

// ---------------------------------------------------------------------
// One layer
// ---------------------------------------------------------------------
// layer: 0-based. Returns
//   { layer, z (top of the layer), kind, w, h,
//     outline: loops at the middle of the layer,
//     pts: Float32Array [x, y, ...] the head's path, pen: Uint8Array per step (1 = extruding),
//     type: Uint8Array per step (TYPE; 255 = travel),
//     length: { outer, inner, sparse, skin, skirt, travel }, volume: mm³ of part extruded }
export function layerPlan(S, spec, plateIdx, layer, opts = {}) {
  const h = spec.layerH, z = (layer + 0.5) * h;
  const cell = opts.cell || spec.cell;
  const cache = opts.cache || null;
  const kind = spec.kind || 'fdm';
  const groups = S.activeGroups(spec, plateIdx, z);
  if (kind !== 'fdm') return beamLayer(S, spec, plateIdx, layer, z, groups, cell, cache, opts);
  const st = settingsFor(spec);
  const parts = groups.map((g) => groupLayer(S, spec, plateIdx, g, z, st, cell, cache));
  const outline = [], b = pathBuilder();
  for (const p of parts) outline.push(...p.outline);
  if (opts.from) b.move(opts.from[0], opts.from[1]);
  // The skirt goes round the whole first layer.
  if (layer === 0 && outline.length && opts.skirt !== false) {
    const sk = skirtLoop(outline, 3);
    if (sk) drawLoop(b, sk, TYPE.skirt);
  }
  const angle = (layer % 2 ? -1 : 1) * PI / 4;
  // Islands of the outer perimeter; inner perimeters and infill are handed to the island they sit in.
  const isl = [];
  for (const p of parts) {
    for (const island of S.islands(p.outer)) isl.push({ ...island, inner: [], fills: [] });
    const home = (l) => isl.find((I) => inIsland(S, I, l[0], l[1]));
    for (const l of p.inner) { const I = home(l); if (I) I.inner.push(l); }
    const fillSets = st.solid ? [[p.solidFill, st.dense, TYPE.skin]] : [[p.skin, st.dense, TYPE.skin], [p.sparse, st.sparse, TYPE.sparse]];
    for (const [loops, spacing, t] of fillSets) {
      for (const fi of S.islands(loops)) {
        const I = home(fi.outer);
        if (I) I.fills.push({ loops: [fi.outer, ...fi.holes], spacing, t });
      }
    }
  }
  // Visit islands nearest-first from wherever the head is.
  const left = isl.slice();
  while (left.length) {
    let bi = 0;
    if (b.x !== null) {
      let bd = Infinity;
      left.forEach((I, i) => { const s = seamStart(I.outer); const d = (I.outer[s * 2] - b.x) ** 2 + (I.outer[s * 2 + 1] - b.y) ** 2; if (d < bd) { bd = d; bi = i; } });
    }
    const I = left.splice(bi, 1)[0];
    for (const l of I.inner) drawLoop(b, l, TYPE.inner);
    drawLoop(b, I.outer, TYPE.outer);
    for (const hl of I.holes) drawLoop(b, hl, TYPE.outer);
    for (const f of I.fills) drawStrips(b, strips(hatch(f.loops, angle, f.spacing)), f.t);
  }
  return finish(b, { layer, z: (layer + 1) * h, kind, w: st.w, h, outline }, st.w, h);
}

// Resin, powder and metal: the cross-section, plus laser hatching for SLS and DMLS (drawn wider
// than the real 0.1 mm hatch so it reads at card size; the angle turns 67 degrees a layer).
function beamLayer(S, spec, plateIdx, layer, z, groups, cell, cache, opts) {
  const outline = [];
  for (const g of groups) {
    if (g.items.length === 1) {
      const it = g.items[0], u = spec.units[it.unit], zl = z - it.z0;
      const key = 'B|' + it.unit + '|' + zl.toFixed(4) + '|' + cell;
      let loops = cache && cache.get(key);
      if (!loops) { loops = S.contours(S.sampleGrid(u.at(zl), u.bounds, cell), 0); if (cache) cache.set(key, loops); }
      for (const l of loops) outline.push(S.placeLoop(l, it.x, it.y, it.a, it.mirror));
    } else {
      for (const l of S.contours(S.sampleGrid(S.groupField(spec, g, z), g.box, cell), 0)) outline.push(l);
    }
  }
  const b = pathBuilder();
  const laser = spec.kind === 'powder' && !opts.mjf || spec.kind === 'metal';
  if (laser && outline.length) {
    const angle = (layer * 67 * PI) / 180;
    for (const isl of S.islands(outline)) {
      drawLoop(b, isl.outer, TYPE.outer);
      for (const hl of isl.holes) drawLoop(b, hl, TYPE.outer);
      drawStrips(b, strips(hatch([isl.outer, ...isl.holes], angle, opts.hatch || 2.5)), TYPE.skin);
    }
  }
  return finish(b, { layer, z: (layer + 1) * spec.layerH, kind: spec.kind, w: spec.lineW, h: spec.layerH, outline }, spec.lineW, spec.layerH);
}

function finish(b, out, w, h) {
  const n = b.pen.length;
  const length = { outer: 0, inner: 0, sparse: 0, skin: 0, skirt: 0, purge: 0, travel: 0 };
  const names = ['outer', 'inner', 'sparse', 'skin', 'skirt', 'purge'];
  for (let i = 0; i < n; i++) {
    const d = sqrt((b.pts[i * 2 + 2] - b.pts[i * 2]) ** 2 + (b.pts[i * 2 + 3] - b.pts[i * 2 + 1]) ** 2);
    if (b.pen[i]) length[names[b.type[i]]] += d; else length.travel += d;
  }
  const partLen = length.outer + length.inner + length.sparse + length.skin;
  return {
    ...out,
    pts: Float32Array.from(b.pts), pen: Uint8Array.from(b.pen), type: Uint8Array.from(b.type),
    length, volume: partLen * lineArea(w, h),
  };
}

// ---------------------------------------------------------------------
// Following the head along a layer
// ---------------------------------------------------------------------
// Time weights: travels move three times faster than extrusion.
export function timeline(plan, travelFactor = 3) {
  const n = plan.pen.length, t = new Float32Array(n + 1), ext = new Uint32Array(n + 1);
  for (let i = 0; i < n; i++) {
    const d = sqrt((plan.pts[i * 2 + 2] - plan.pts[i * 2]) ** 2 + (plan.pts[i * 2 + 3] - plan.pts[i * 2 + 1]) ** 2);
    t[i + 1] = t[i] + (plan.pen[i] ? d : d / travelFactor);
    ext[i + 1] = ext[i] + plan.pen[i];
  }
  return { t, ext, total: t[n] };
}
// Where the head is a fraction f (0..1) through a layer: { x, y, step, frac, extruded, pen }.
// `extruded` counts whole extrusion steps done; the step under way is `step` (its share `frac`).
export function headAt(plan, tl, f) {
  const n = plan.pen.length;
  if (!n) return { x: plan.pts[0] || 0, y: plan.pts[1] || 0, step: 0, frac: 0, extruded: 0, pen: 0 };
  const target = Math.max(0, Math.min(1, f)) * tl.total;
  let lo = 0, hi = n;
  while (lo < hi) { const m = (lo + hi) >> 1; if (tl.t[m + 1] < target) lo = m + 1; else hi = m; }
  const i = Math.min(lo, n - 1);
  const span = tl.t[i + 1] - tl.t[i];
  const frac = span > 0 ? Math.max(0, Math.min(1, (target - tl.t[i]) / span)) : 1;
  const x = plan.pts[i * 2] + (plan.pts[i * 2 + 2] - plan.pts[i * 2]) * frac;
  const y = plan.pts[i * 2 + 1] + (plan.pts[i * 2 + 3] - plan.pts[i * 2 + 1]) * frac;
  return { x, y, step: i, frac, extruded: tl.ext[i], pen: plan.pen[i] };
}

// ---------------------------------------------------------------------
// Before the print
// ---------------------------------------------------------------------
// A purge line along the front of the bed: out to the right, a step back, and back again.
export function purgeLine(bedX, bedY, w = 0.45, h = 0.2) {
  const y0 = -bedY / 2 + 4, x0 = -bedX / 2 + 8, x1 = Math.min(bedX / 2 - 8, x0 + Math.max(40, bedX * 0.45));
  const b = pathBuilder();
  b.move(x0, y0 + 6);
  b.move(x0, y0);
  b.line(x1, y0, TYPE.purge);
  b.line(x1, y0 + 0.6, TYPE.purge);
  b.line(x0 + 10, y0 + 0.6, TYPE.purge);
  return finish(b, { layer: -1, z: h, kind: 'fdm', w, h, outline: [] }, w, h);
}
// Probe points: an n x n mesh over the part's footprint (plus a margin), kept on the bed.
export function probeGrid(bedX, bedY, bounds, n = 4) {
  const m = 10;
  const x0 = Math.max(-bedX / 2 + m, (bounds ? bounds[0] : -bedX / 2) - 10), x1 = Math.min(bedX / 2 - m, (bounds ? bounds[2] : bedX / 2) + 10);
  const y0 = Math.max(-bedY / 2 + m, (bounds ? bounds[1] : -bedY / 2) - 10), y1 = Math.min(bedY / 2 - m, (bounds ? bounds[3] : bedY / 2) + 10);
  const pts = [];
  for (let j = 0; j < n; j++) {
    const row = [];
    for (let i = 0; i < n; i++) row.push(x0 + (x1 - x0) * i / (n - 1), y0 + (y1 - y0) * j / (n - 1));
    if (j % 2) for (let i = row.length - 2; i >= 0; i -= 2) pts.push(row[i], row[i + 1]);   // serpentine
    else pts.push(...row);
  }
  return Float32Array.from(pts);
}

// ---------------------------------------------------------------------
// Volume
// ---------------------------------------------------------------------
// Printed volume of a spec in cm³. FDM is the extruded volume of its toolpath: the per-layer
// volume is sampled every few layers and bisected wherever neighbouring samples differ (floors,
// roofs, vents), so thin features are found instead of aliased. Resin, powder and metal are solid.
export function printedVolume(S, spec, opts = {}) {
  if (spec.kind !== 'fdm') return S.solidVolume(spec, opts.layers || 48, opts.cell);
  const n = Math.max(1, Math.round(spec.H / spec.layerH));
  const base = Math.max(1, Math.ceil(n / (opts.samples || 64)));
  const tol = opts.tol ?? 0.03;
  const cache = new Map();
  let total = 0;
  for (let p = 0; p < spec.plates.length; p++) {
    const memo = new Map();
    const v = (L) => {
      let r = memo.get(L);
      if (r === undefined) { r = layerPlan(S, spec, p, L, { cell: opts.cell, cache, skirt: false }).volume; memo.set(L, r); }
      return r;
    };
    const xs = [];
    for (let L = 0; L < n; L += base) xs.push(L);
    if (xs[xs.length - 1] !== n - 1) xs.push(n - 1);
    let scale = 0;
    for (const L of xs) scale = max(scale, v(L));
    const eps = tol * scale;
    // Sum of v over layers a .. b-1, bisecting where the ends disagree or the middle is not
    // their average (two solid skins with sparse layers between them look alike from the ends).
    const sum = (a, b) => {
      if (b - a <= 1) return v(a);
      const m = (a + b) >> 1;
      if (abs(v(a) - v(b)) <= eps && (b - a < 4 || abs(v(m) - (v(a) + v(b)) / 2) <= eps)) return (b - a) * (v(a) + v(b)) / 2;
      return sum(a, m) + sum(m, b);
    };
    for (let i = 0; i + 1 < xs.length; i++) total += sum(xs[i], xs[i + 1]);
    total += v(n - 1);
  }
  return total / 1000;
}
