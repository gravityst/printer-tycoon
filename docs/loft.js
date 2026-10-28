// =====================================================================
// Print3D part meshes: lofted from the same cross-sections the toolpath prints.
//
// Pure ES module: no DOM, no THREE, no imports; the shapes module is passed in (S). One mesh per
// unit (a batch of identical parts is drawn as instances of it).
//
// Sections are taken at a few heights, then more are added where the shape changes: wherever a
// section's outline count changes (bisected to within a fraction of a millimetre) and wherever the
// middle of an interval is not the average of its ends (curves). Between two sections with the
// same outlines the walls are lofted (both loops evaluated at the union of their vertices' arc
// positions, so corners stay sharp); where the outlines change the walls step, with a cap facing
// up for the lower section and one facing down for the upper. Caps are returned as polygons for
// the renderer to triangulate (earcut), with their triangle count already known (n + 2h - 2).
// =====================================================================

const { abs, min, max, sqrt, floor, round } = Math;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

function centroid(S, l) {
  let cx = 0, cy = 0, a = 0;
  const n = l.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const f = l[j * 2] * l[i * 2 + 1] - l[i * 2] * l[j * 2 + 1];
    cx += (l[j * 2] + l[i * 2]) * f; cy += (l[j * 2 + 1] + l[i * 2 + 1]) * f; a += f;
  }
  return a ? [cx / (3 * a), cy / (3 * a)] : [l[0], l[1]];
}

// A section: simplified loops with their areas, centroids and perimeters.
function section(S, unit, z, cell, tol) {
  const f = unit.at(clamp(z, 0, unit.H));
  const loops = S.contours(S.sampleGrid(f, unit.bounds, cell), 0, 0)
    .map((l) => S.simplifyDP(l, tol, 6))
    .filter((l) => abs(S.area(l)) > cell * cell * 2);
  return { z, loops: loops.map((l) => ({ p: l, a: S.area(l), c: centroid(S, l), len: S.perimeter(l) })) };
}

// Pair the loops of two sections: { pairs, aOnly (vanish going up), bOnly (appear going up) }.
// Loops pair when they wind the same way, sit in the same place and are about the same size.
function match(A, B) {
  const used = new Set(), pairs = [], aOnly = [];
  for (const la of A.loops) {
    let best = -1, bd = Infinity;
    B.loops.forEach((lb, j) => {
      if (used.has(j) || (la.a > 0) !== (lb.a > 0)) return;
      const ratio = abs(lb.a) / abs(la.a), size = sqrt(max(abs(la.a), abs(lb.a)));
      const d = sqrt((la.c[0] - lb.c[0]) ** 2 + (la.c[1] - lb.c[1]) ** 2);
      if (ratio < 0.55 || ratio > 1 / 0.55 || d > 0.35 * size) return;
      if (d < bd) { bd = d; best = j; }
    });
    if (best < 0) { aOnly.push(la); continue; }
    used.add(best);
    pairs.push([la, B.loops[best]]);
  }
  const bOnly = B.loops.filter((_, j) => !used.has(j));
  return { pairs, aOnly, bOnly, same: !aOnly.length && !bOnly.length };
}

// How far a section is from the average of its neighbours (0 = on the line between them).
function deviation(A, M, B) {
  const sum = (s, k) => s.loops.reduce((t, l) => t + abs(l[k]), 0);
  const da = abs(sum(M, 'a') - (sum(A, 'a') + sum(B, 'a')) / 2) / max(1e-6, sum(M, 'a'), sum(A, 'a'), sum(B, 'a'));
  const dl = abs(sum(M, 'len') - (sum(A, 'len') + sum(B, 'len')) / 2) / max(1e-6, sum(M, 'len'), sum(A, 'len'), sum(B, 'len'));
  return max(da, dl);
}

// Arc-length positions (0..1) of a loop's vertices, starting at vertex `start`.
function params(p, start) {
  const n = p.length / 2, t = new Float64Array(n);
  let s = 0;
  for (let k = 1; k < n; k++) {
    const i = (start + k) % n, j = (start + k - 1) % n;
    s += sqrt((p[i * 2] - p[j * 2]) ** 2 + (p[i * 2 + 1] - p[j * 2 + 1]) ** 2);
    t[k] = s;
  }
  const i0 = start, il = (start + n - 1) % n;
  const total = s + sqrt((p[i0 * 2] - p[il * 2]) ** 2 + (p[i0 * 2 + 1] - p[il * 2 + 1]) ** 2);
  for (let k = 0; k < n; k++) t[k] /= total || 1;
  return t;
}
// The point at arc position u (0..1) along a loop that starts at vertex `start`.
function pointAt(p, start, t, u) {
  const n = p.length / 2;
  let lo = 0, hi = n;
  while (lo < hi) { const m = (lo + hi) >> 1; if (t[m] <= u) lo = m + 1; else hi = m; }
  const k = max(0, lo - 1);
  const t0 = t[k], t1 = k + 1 < n ? t[k + 1] : 1;
  const f = t1 > t0 ? (u - t0) / (t1 - t0) : 0;
  const i = (start + k) % n, j = (start + k + 1) % n;
  return [p[i * 2] + (p[j * 2] - p[i * 2]) * f, p[i * 2 + 1] + (p[j * 2 + 1] - p[i * 2 + 1]) * f];
}
// Start vertex of B that lines up best with vertex 0 of A.
function alignStart(pa, pb) {
  const nb = pb.length / 2, ta = params(pa, 0);
  const probes = 24;
  const A = Array.from({ length: probes }, (_, i) => pointAt(pa, 0, ta, i / probes));
  let best = 0, bd = Infinity;
  const step = Math.max(1, floor(nb / 64));
  const tryStart = (s) => {
    const tb = params(pb, s);
    let d = 0;
    for (let i = 0; i < probes; i++) { const q = pointAt(pb, s, tb, i / probes); d += (q[0] - A[i][0]) ** 2 + (q[1] - A[i][1]) ** 2; if (d >= bd) return; }
    bd = d; best = s;
  };
  for (let s = 0; s < nb; s += step) tryStart(s);
  for (let s = best - step; s <= best + step; s++) tryStart(((s % nb) + nb) % nb);
  return best;
}

function meshBuilder() {
  const pos = [], idx = [];
  return {
    pos, idx,
    v(x, y, z) { pos.push(x, y, z); return pos.length / 3 - 1; },
    tri(a, b, c) { idx.push(a, b, c); },
  };
}

// Walls between two matched loops: both evaluated at the union of their vertices' arc positions.
function loftPair(mb, pa, za, pb, zb, sharpCos) {
  const sb = alignStart(pa, pb);
  const ta = params(pa, 0), tb = params(pb, sb);
  const us = Array.from(new Set([...ta, ...tb].map((u) => +u.toFixed(5)))).sort((a, b) => a - b);
  const ring = us.map((u) => [pointAt(pa, 0, ta, u), pointAt(pb, sb, tb, u)]);
  strip(mb, ring, za, zb, sharpCos);
}
// A vertical wall: one loop from za up to zb.
function prism(mb, p, za, zb, sharpCos) {
  const n = p.length / 2, ring = [];
  for (let i = 0; i < n; i++) ring.push([[p[i * 2], p[i * 2 + 1]], [p[i * 2], p[i * 2 + 1]]]);
  strip(mb, ring, za, zb, sharpCos);
}
// A closed band of quads. Columns at sharp corners are doubled so the shading keeps the edge.
function strip(mb, ring, za, zb, sharpCos) {
  const n = ring.length;
  if (n < 3) return;
  // A column is sharp when the outline turns by more than the threshold there (on either loop).
  const sharp = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    for (const k of [0, 1]) {
      const p = ring[(i + n - 1) % n][k], q = ring[i][k], r = ring[(i + 1) % n][k];
      const ax = q[0] - p[0], ay = q[1] - p[1], bx = r[0] - q[0], by = r[1] - q[1];
      const la = sqrt(ax * ax + ay * ay), lb = sqrt(bx * bx + by * by);
      if (la > 1e-9 && lb > 1e-9 && (ax * bx + ay * by) / (la * lb) < sharpCos) sharp[i] = 1;
    }
  }
  // Vertex pairs per column: [bottom, top] for the quad on its left and on its right.
  const left = new Array(n), right = new Array(n);
  for (let i = 0; i < n; i++) {
    const [a, b] = ring[i];
    const pair = [mb.v(a[0], a[1], za), mb.v(b[0], b[1], zb)];
    right[i] = pair;
    left[i] = sharp[i] ? [mb.v(a[0], a[1], za), mb.v(b[0], b[1], zb)] : pair;
  }
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const [a0, a1] = right[i], [b0, b1] = left[j];
    mb.tri(a0, b0, b1);
    mb.tri(a0, b1, a1);
  }
}

// Smooth normals from the faces round each vertex (vertices at sharp edges are already split).
function normals(pos, idx) {
  const nrm = new Float32Array(pos.length);
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3;
    const ux = pos[b] - pos[a], uy = pos[b + 1] - pos[a + 1], uz = pos[b + 2] - pos[a + 2];
    const vx = pos[c] - pos[a], vy = pos[c + 1] - pos[a + 1], vz = pos[c + 2] - pos[a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    for (const k of [a, b, c]) { nrm[k] += nx; nrm[k + 1] += ny; nrm[k + 2] += nz; }
  }
  for (let i = 0; i < nrm.length; i += 3) {
    const l = sqrt(nrm[i] ** 2 + nrm[i + 1] ** 2 + nrm[i + 2] ** 2) || 1;
    nrm[i] /= l; nrm[i + 1] /= l; nrm[i + 2] /= l;
  }
  return nrm;
}

// Caps for a set of loops at height z facing dir (+1 up, -1 down): islands, each { outer, holes }
// with its triangle count. Holes outside every outer loop in the set (a hole opening or closing
// inside a wall that carries on) are capped on their own, facing the other way: the floor or
// ceiling of the hole.
function capsOf(S, loops, z, dir) {
  const ps = loops.map((l) => l.p || l);
  const isl = S.islands(ps);
  const inIsland = new Set();
  for (const I of isl) for (const h of I.holes) inIsland.add(h);
  const caps = isl.map((I) => ({ z, dir, outer: I.outer, holes: I.holes }));
  for (const p of ps) if (S.area(p) < 0 && !inIsland.has(p)) {
    const n = p.length / 2, rev = new Array(p.length);
    for (let i = 0; i < n; i++) { rev[i * 2] = p[(n - 1 - i) * 2]; rev[i * 2 + 1] = p[(n - 1 - i) * 2 + 1]; }
    caps.push({ z, dir: -dir, outer: rev, holes: [] });
  }
  for (const c of caps) c.tris = c.outer.length / 2 + c.holes.reduce((t, h) => t + h.length / 2, 0) + 2 * c.holes.length - 2;
  return caps;
}

// Mesh one unit. opts: { budget (triangles, default 8000), cell, tol (mm), base (initial sections),
// minSections (default 14: a copy in a big batch can go as low as 4) }.
// Returns { positions, normals, index, caps, wallTris, capTris, triangles, sections }.
export function loftUnit(S, unit, opts = {}) {
  const budget = opts.budget || 8000;
  const [bx0, by0, bx1, by1] = unit.bounds;
  const size = max(bx1 - bx0, by1 - by0, unit.H);
  let cell = opts.cell || clamp(size / 200, 0.15, 1.6);
  let tol = opts.tol || max(0.08, size / 500);
  let out = null;
  let maxSections = opts.maxSections || 90;
  const minSections = opts.minSections || 14;
  let base = opts.base || 10;
  const attempts = minSections < 14 ? 9 : 6;
  for (let attempt = 0; attempt < attempts; attempt++) {
    out = build(S, unit, cell, tol, min(base, maxSections - 1), maxSections);
    if (out.triangles <= budget) break;
    // Too heavy: coarser outlines, then fewer sections, then a coarser grid.
    const over = out.triangles / budget;
    tol *= Math.min(2.2, 1.2 + over * 0.4);
    if (attempt >= 1) maxSections = Math.max(minSections, Math.round(maxSections / Math.min(2, over)));
    if (attempt >= 3) cell = Math.min(cell * 1.3, opts.maxCell || 2.4);
    if (attempt >= 4 && minSections < 10) base = max(3, minSections - 1);
  }
  return out;
}

function build(S, unit, cell, tol, base, maxSections) {
  const H = unit.H, eps = min(0.05, H / 400);
  const secs = new Map();
  const at = (z) => { const k = +z.toFixed(4); let s = secs.get(k); if (!s) { s = section(S, unit, k, cell, tol); secs.set(k, s); } return s; };
  const minStep = max(H / 300, 0.08);
  // Uniform start, then refine: bisect where a loop appears or vanishes (to find its height),
  // split where the middle is not the average of the ends (curves).
  let zs = Array.from({ length: base + 1 }, (_, i) => eps + (H - 2 * eps) * i / base);
  for (let pass = 0; pass < 12 && zs.length < maxSections; pass++) {
    const next = [zs[0]];
    let added = 0;
    for (let i = 0; i + 1 < zs.length; i++) {
      const za = zs[i], zb = zs[i + 1];
      if (zb - za > minStep * 2 && zs.length + added < maxSections) {
        const A = at(za), B = at(zb), zm = (za + zb) / 2;
        if (!match(A, B).same || deviation(A, at(zm), B) > 0.025) { next.push(zm); added++; }
      }
      next.push(zb);
    }
    zs = next;
    if (!added) break;
  }
  const mb = meshBuilder();
  const sharpCos = Math.cos(38 * Math.PI / 180);
  const list = zs.map(at);
  const caps = capsOf(S, list[0].loops, 0, -1);
  for (const l of list[0].loops) prism(mb, l.p, 0, list[0].z, sharpCos);
  for (let i = 0; i + 1 < list.length; i++) {
    const A = list[i], B = list[i + 1], m = match(A, B);
    for (const [la, lb] of m.pairs) loftPair(mb, la.p, A.z, lb.p, B.z, sharpCos);
    if (m.aOnly.length || m.bOnly.length) {
      const zm = (A.z + B.z) / 2;
      for (const l of m.aOnly) prism(mb, l.p, A.z, zm, sharpCos);
      for (const l of m.bOnly) prism(mb, l.p, zm, B.z, sharpCos);
      caps.push(...capsOf(S, m.aOnly, zm, 1), ...capsOf(S, m.bOnly, zm, -1));
    }
  }
  const last = list[list.length - 1];
  for (const l of last.loops) prism(mb, l.p, last.z, H, sharpCos);
  caps.push(...capsOf(S, last.loops, H, 1));
  const wallTris = mb.idx.length / 3, capTris = caps.reduce((t, c) => t + max(0, c.tris), 0);
  const positions = Float32Array.from(mb.pos);
  const index = mb.pos.length / 3 > 65535 ? Uint32Array.from(mb.idx) : Uint16Array.from(mb.idx);
  return { positions, normals: normals(positions, index), index, caps, wallTris, capTris, triangles: wallTris + capTris, sections: zs.length, cell, tol };
}

// Meshes for every distinct unit on a spec's plates: { [unit]: mesh }.
export function loftSpec(S, spec, opts = {}) {
  const names = new Set();
  for (const items of spec.plates) for (const it of items) names.add(it.unit);
  const out = {};
  const budget = opts.budget || 8000;
  // A batch shares the budget across its distinct units (minis come in four kinds).
  // Copies of a unit share the budget too, by the square root of their count, so a plate of 50
  // grips stays a few tens of thousands of triangles.
  const kinds = [...names].filter((n) => !n.startsWith('raft'));
  const count = {};
  for (const items of spec.plates.slice(0, 1)) for (const it of items) count[it.unit] = (count[it.unit] || 0) + 1;
  const maxCell = (spec.cell || 0.5) * 2.5;
  for (const name of names) {
    const per = Math.max(400, Math.floor(budget / Math.max(1, kinds.length) / Math.sqrt(count[name] || 1)));
    out[name] = loftUnit(S, spec.units[name], { ...opts, maxCell, budget: name.startsWith('raft') ? 200 : Math.min(budget, per) });
  }
  return out;
}
