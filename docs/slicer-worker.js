// =====================================================================
// Print3D slicer worker: part meshes and toolpaths off the main thread.
//
// Runs as a module worker (new Worker(url, { type: 'module' })); the same file is imported on the
// main thread as a fallback, where `handle` is called directly. Requests:
//   { op: 'spec', args }                          the part's layout: plates, units, height, layers
//   { op: 'loft', args, budget, hero, limit }     meshes for every unit on the first plate
//   { op: 'plan', args, plate, layer, from }      one layer's toolpath (FDM) or section (vat/powder)
//   { op: 'pre', args, autoLevel }                the purge line and the probing grid
// args: { productId, heightMM, grams, density, bedMM, tech, nozzleMM } (S.partSpec's options).
// =====================================================================

const VERSION = (() => { try { return new URL(import.meta.url).searchParams.get('v') || 'dev'; } catch (e) { return 'dev'; } })();
let mods = null;
function load() {
  if (!mods) {
    const q = '?v=' + encodeURIComponent(VERSION);
    mods = Promise.all([import('./shapes.js' + q), import('./toolpath.js' + q), import('./loft.js' + q)])
      .then(([S, T, Loft]) => ({ S, T, Loft }));
  }
  return mods;
}

// Specs (with their contour caches) for the last few parts asked about.
const specs = new Map();
const keyOf = (a) => [a.productId, (+a.heightMM || 0).toFixed(2), (+a.grams || 0).toFixed(2), a.density, (a.bedMM || []).join('x'), a.tech, a.nozzleMM].join('|');
function specFor(S, args) {
  const key = keyOf(args);
  let e = specs.get(key);
  if (e) { specs.delete(key); specs.set(key, e); return e; }
  const spec = S.partSpec(args.productId, { heightMM: args.heightMM, grams: args.grams, density: args.density, bedMM: args.bedMM, tech: args.tech, nozzleMM: args.nozzleMM });
  if (!spec) return null;
  e = { spec, cache: new Map(), key };
  specs.set(key, e);
  while (specs.size > 24) specs.delete(specs.keys().next().value);
  return e;
}

function summary(S, spec) {
  const units = {};
  for (const [name, u] of Object.entries(spec.units)) units[name] = { H: u.H, bounds: u.bounds.slice() };
  return {
    productId: spec.productId, H: spec.H, orderH: spec.orderH, layerH: spec.layerH, lineW: spec.lineW, kind: spec.kind, nozzle: spec.nozzle,
    layers: S.layerCount(spec), bounds: spec.bounds.slice(), bed: spec.bed.slice(), infill: spec.infill,
    plates: spec.plates.map((items) => items.map((it) => ({ unit: it.unit, x: it.x, y: it.y, a: it.a || 0, mirror: !!it.mirror, z0: it.z0 || 0 }))),
    units,
  };
}

// Meshes for the units on plate 0. A card shares `budget` triangles across every copy it shows
// (a plate of 50 grips is small on screen; `limit` caps how many copies the card draws); `hero`
// gives each unit its own budget (galleries).
function loftPlate(S, Loft, spec, budget, hero, limit) {
  const items = spec.plates[0] || [];
  const count = {};
  for (const it of items) count[it.unit] = (count[it.unit] || 0) + 1;
  const kinds = Object.keys(count);
  // Every copy shown shares the budget (a raft pad counts a quarter).
  const weight = (name) => (name.startsWith('raft') ? 0.25 : 1);
  const shownShare = limit > 0 && items.length > limit ? limit / items.length : 1;
  let copies = 0;
  for (const name of kinds) copies += count[name] * weight(name) * shownShare;
  const out = {}, transfer = [];
  for (const name of kinds) {
    const per = hero ? budget : Math.max(name.startsWith('raft') ? 24 : 60, Math.floor(budget * weight(name) / Math.max(1, copies)));
    const m = Loft.loftUnit(S, spec.units[name], { budget: Math.min(8000, per), maxCell: (spec.cell || 0.5) * (hero ? 2.5 : 4), minSections: hero || per >= 1500 ? 14 : 4 });
    const caps = m.caps.map((c) => ({ z: c.z, dir: c.dir, outer: Float32Array.from(c.outer), holes: c.holes.map((h) => Float32Array.from(h)), tris: c.tris }));
    out[name] = { positions: m.positions, normals: m.normals, index: m.index, caps, triangles: m.triangles, copies: count[name] };
    transfer.push(m.positions.buffer, m.normals.buffer, m.index.buffer);
    for (const c of caps) { transfer.push(c.outer.buffer); for (const h of c.holes) transfer.push(h.buffer); }
  }
  return { units: out, transfer };
}

const flat = (loops) => loops.map((l) => Float32Array.from(l));

// Thin a plan for drawing: within each run of steps with the same pen and type, drop points that
// sit within `tol` mm of the line through their neighbours (Douglas-Peucker). Travels and line
// ends are kept, so the head still visits every island and the reveal stays step for step.
export function thinPlan(p, tol) {
  const n = p.pen.length;
  if (n < 8) return p;
  const keep = new Uint8Array(n + 1);
  keep[0] = 1; keep[n] = 1;
  const dp = (a, b) => {
    // points a..b (inclusive) along one run
    let idx = -1, dmax = 0;
    const ax = p.pts[a * 2], ay = p.pts[a * 2 + 1], bx = p.pts[b * 2], by = p.pts[b * 2 + 1];
    const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy || 1e-12;
    for (let i = a + 1; i < b; i++) {
      const px = p.pts[i * 2] - ax, py = p.pts[i * 2 + 1] - ay;
      const t = Math.max(0, Math.min(1, (px * dx + py * dy) / L2));
      const d = Math.hypot(px - t * dx, py - t * dy);
      if (d > dmax) { dmax = d; idx = i; }
    }
    if (dmax > tol && idx > 0) { keep[idx] = 1; dp(a, idx); dp(idx, b); }
  };
  let s = 0;
  for (let i = 1; i <= n; i++) {
    if (i === n || p.pen[i] !== p.pen[s] || p.type[i] !== p.type[s] || !p.pen[i]) {
      keep[s] = 1; keep[i] = 1;
      if (p.pen[s] && i - s > 2) dp(s, i);
      s = i;
    }
  }
  const idx = [];
  for (let i = 0; i <= n; i++) if (keep[i]) idx.push(i);
  const pts = new Float32Array(idx.length * 2), pen = new Uint8Array(idx.length - 1), type = new Uint8Array(idx.length - 1);
  idx.forEach((k, j) => { pts[j * 2] = p.pts[k * 2]; pts[j * 2 + 1] = p.pts[k * 2 + 1]; });
  for (let j = 0; j + 1 < idx.length; j++) { pen[j] = p.pen[idx[j]]; type[j] = p.type[idx[j]]; }
  return { ...p, pts, pen, type, thinned: n - pen.length };
}

export async function handle(msg) {
  const { S, T, Loft } = await load();
  const e = specFor(S, msg.args);
  if (!e) return { error: 'no shape for ' + msg.args.productId };
  const spec = e.spec;
  switch (msg.op) {
    case 'spec':
      return { spec: summary(S, spec) };
    case 'loft': {
      const r = loftPlate(S, Loft, spec, msg.budget || 6000, !!msg.hero, msg.limit | 0);
      return { spec: summary(S, spec), units: r.units, transfer: r.transfer };
    }
    case 'plan': {
      const layer = Math.max(0, Math.min(S.layerCount(spec) - 1, msg.layer | 0));
      const raw = T.layerPlan(S, spec, msg.plate || 0, layer, { cache: e.cache, from: msg.from || null, skirt: msg.skirt !== false, mjf: !!msg.mjf });
      const p = msg.thin ? thinPlan(raw, msg.thin) : raw;
      // Big contour caches are dropped now and then (a tall part slices thousands of heights).
      if (e.cache.size > 4000) e.cache.clear();
      const outline = flat(p.outline);
      return {
        plan: { layer: p.layer, z: p.z, kind: p.kind, w: p.w, h: p.h, pts: p.pts, pen: p.pen, type: p.type, outline, length: p.length, volume: p.volume },
        transfer: [p.pts.buffer, p.pen.buffer, p.type.buffer, ...outline.map((l) => l.buffer)],
      };
    }
    case 'pre': {
      const [bx, by] = spec.bed;
      const purge = T.purgeLine(bx, by, spec.lineW, spec.layerH);
      const probe = msg.autoLevel ? T.probeGrid(bx, by, spec.bounds, 4) : new Float32Array(0);
      return { purge: { pts: purge.pts, pen: purge.pen, type: purge.type }, probe, transfer: [purge.pts.buffer, purge.pen.buffer, purge.type.buffer, probe.buffer] };
    }
  }
  return { error: 'unknown op ' + msg.op };
}

// In a worker: answer messages. (On the main thread this file is only imported for `handle`.)
if (typeof WorkerGlobalScope !== 'undefined' && typeof self !== 'undefined' && self instanceof WorkerGlobalScope) {
  self.onmessage = async (ev) => {
    const msg = ev.data;
    try {
      const r = await handle(msg);
      const transfer = r.transfer || [];
      delete r.transfer;
      self.postMessage({ id: msg.id, ...r }, transfer);
    } catch (err) {
      self.postMessage({ id: msg.id, error: String(err && err.message || err) });
    }
  };
}
