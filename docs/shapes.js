// =====================================================================
// Print3D part shapes: every product as a stack of cross-sections.
//
// Pure ES module: no DOM, no THREE, no imports. Each product is a signed distance field in
// millimetres (negative inside) built from a few exact 2D/3D primitives. A cross-section at height
// z is the field's zero contour, traced by marching squares, so every outline is closed, simple and
// wound the same way: outer boundaries counter-clockwise, holes clockwise. The same field gives the
// toolpath's perimeters (contours at -w/2 and -3w/2, see toolpath.js) and the renderer's lofted
// mesh (loft.js).
//
// A spec is one order's part: the product's shape at the order's height, a size knob picked so the
// printed part weighs what the order says (see SIZING), and where its units sit on each plate.
// =====================================================================

const { abs, min, max, sqrt, sin, cos, atan2, PI, floor, ceil } = Math;
const TAU = PI * 2;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const len = (x, y) => sqrt(x * x + y * y);
const smoothstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

// ---------------------------------------------------------------------
// Distance primitives (2D unless the name ends in 3)
// ---------------------------------------------------------------------
export const sd = {
  circle: (x, y, r) => len(x, y) - r,
  // Rounded rectangle with half extents hx, hy and corner radius r.
  box(x, y, hx, hy, r = 0) {
    r = min(r, hx, hy);
    const qx = abs(x) - hx + r, qy = abs(y) - hy + r;
    return len(max(qx, 0), max(qy, 0)) + min(max(qx, qy), 0) - r;
  },
  // Distance to the segment a-b (subtract a radius for a capsule).
  seg(x, y, ax, ay, bx, by) {
    const pax = x - ax, pay = y - ay, bax = bx - ax, bay = by - ay;
    const h = clamp((pax * bax + pay * bay) / (bax * bax + bay * bay || 1), 0, 1);
    return len(pax - bax * h, pay - bay * h);
  },
  // Ellipse with semi-axes a, b (a first-order distance, close to exact near the curve).
  ellipse(x, y, a, b) {
    const k0 = len(x / a, y / b), k1 = len(x / (a * a), y / (b * b));
    return k1 > 1e-9 ? k0 * (k0 - 1) / k1 : -min(a, b);
  },
  // Inigo Quilez's heart: tip at the origin pointing down, about 1.2 wide and 1.06 tall.
  heart(x, y) {
    x = abs(x);
    if (y + x > 1) return len(x - 0.25, y - 0.75) - Math.SQRT2 / 4;
    const s = 0.5 * max(x + y, 0);
    return sqrt(min(x * x + (y - 1) * (y - 1), (x - s) * (x - s) + (y - s) * (y - s))) * Math.sign(x - y);
  },
  seg3(x, y, z, ax, ay, az, bx, by, bz) {
    const px = x - ax, py = y - ay, pz = z - az, ux = bx - ax, uy = by - ay, uz = bz - az;
    const h = clamp((px * ux + py * uy + pz * uz) / (ux * ux + uy * uy + uz * uz || 1), 0, 1);
    return sqrt((px - ux * h) ** 2 + (py - uy * h) ** 2 + (pz - uz * h) ** 2);
  },
  sphere3: (x, y, z, r) => sqrt(x * x + y * y + z * z) - r,
  // Ellipsoid with semi-axes a, b, c (first-order distance).
  ellipsoid3(x, y, z, a, b, c) {
    const k0 = sqrt((x / a) ** 2 + (y / b) ** 2 + (z / c) ** 2), k1 = sqrt((x / (a * a)) ** 2 + (y / (b * b)) ** 2 + (z / (c * c)) ** 2);
    return k1 > 1e-9 ? k0 * (k0 - 1) / k1 : -min(a, b, c);
  },
  // Torus around the unit axis (ax, ay, az): major radius R, tube radius r.
  torus3(x, y, z, ax, ay, az, R, r) {
    const along = x * ax + y * ay + z * az;
    const px = x - ax * along, py = y - ay * along, pz = z - az * along;
    return len(sqrt(px * px + py * py + pz * pz) - R, along) - r;
  },
};
export const smin = (a, b, k) => { const h = clamp(0.5 + 0.5 * (b - a) / k, 0, 1); return b + (a - b) * h - k * h * (1 - h); };
// A shell of thickness t on the inside of the surface of d.
const shellIn = (d, t) => max(d, -(d + t));
// Signed angle from the nearest of n evenly spaced directions starting at a0.
const sector = (th, n, a0 = 0) => { const step = TAU / n; let u = (th - a0) % step; if (u < 0) u += step; return u > step / 2 ? u - step : u; };
const CORNERS = [[1, 1], [1, -1], [-1, 1], [-1, -1]];

// ---------------------------------------------------------------------
// Marching squares
// ---------------------------------------------------------------------
// Sample f over a padded box. The rim is forced outside so every contour closes inside the box.
export function sampleGrid(f, bounds, cell) {
  const pad = cell * 2;
  const x0 = bounds[0] - pad, y0 = bounds[1] - pad;
  const nx = Math.max(3, ceil((bounds[2] - bounds[0] + 2 * pad) / cell) + 1);
  const ny = Math.max(3, ceil((bounds[3] - bounds[1] + 2 * pad) / cell) + 1);
  const v = new Float32Array(nx * ny);
  for (let j = 0; j < ny; j++) {
    const y = y0 + j * cell;
    const row = j * nx;
    for (let i = 0; i < nx; i++) v[row + i] = f(x0 + i * cell, y);
  }
  const rim = cell * 4;
  for (let i = 0; i < nx; i++) { v[i] = max(v[i], rim); v[(ny - 1) * nx + i] = max(v[(ny - 1) * nx + i], rim); }
  for (let j = 0; j < ny; j++) { v[j * nx] = max(v[j * nx], rim); v[j * nx + nx - 1] = max(v[j * nx + nx - 1], rim); }
  return { x0, y0, nx, ny, cell, v };
}

// Contour loops of grid at iso (inside = value < iso), each a flat [x0, y0, x1, y1, ...] array.
// Segments run with the inside on their left, so outer loops come out counter-clockwise and holes
// clockwise. Values exactly on the iso level count as outside, so no loop passes through a grid
// point and two loops never touch.
export function contours(grid, iso = 0, simplifyTol = 0.05) {
  const { x0, y0, nx, ny, cell, v } = grid;
  const next = new Int32Array(2 * nx * ny).fill(-1);
  const val = (k) => { const d = v[k] - iso; return d === 0 ? 1e-7 : d; };
  for (let j = 0; j < ny - 1; j++) {
    for (let i = 0; i < nx - 1; i++) {
      const k00 = j * nx + i;
      const a = val(k00), b = val(k00 + 1), c = val(k00 + nx + 1), d = val(k00 + nx);
      const code = (a < 0 ? 1 : 0) | (b < 0 ? 2 : 0) | (c < 0 ? 4 : 0) | (d < 0 ? 8 : 0);
      if (code === 0 || code === 15) continue;
      // Edge ids: bottom = 2*k00, left = 2*k00+1, top = 2*(k00+nx), right = 2*(k00+1)+1.
      const B = 2 * k00, T = 2 * (k00 + nx), L = 2 * k00 + 1, R = 2 * (k00 + 1) + 1;
      switch (code) {
        case 1: next[B] = L; break;
        case 2: next[R] = B; break;
        case 3: next[R] = L; break;
        case 4: next[T] = R; break;
        case 5: if (a + b + c + d < 0) { next[B] = R; next[T] = L; } else { next[B] = L; next[T] = R; } break;
        case 6: next[T] = B; break;
        case 7: next[T] = L; break;
        case 8: next[L] = T; break;
        case 9: next[B] = T; break;
        case 10: if (a + b + c + d < 0) { next[L] = B; next[R] = T; } else { next[R] = B; next[L] = T; } break;
        case 11: next[R] = T; break;
        case 12: next[L] = R; break;
        case 13: next[B] = R; break;
        case 14: next[L] = B; break;
      }
    }
  }
  const point = (e, out) => {
    const k = e >> 1, i = k % nx, j = (k - i) / nx;
    const va = val(k);
    if (e & 1) { const vb = val(k + nx); const t = va / (va - vb); out.push(x0 + i * cell, y0 + (j + t) * cell); }
    else { const vb = val(k + 1); const t = va / (va - vb); out.push(x0 + (i + t) * cell, y0 + j * cell); }
  };
  const seen = new Uint8Array(next.length);
  const loops = [];
  for (let e0 = 0; e0 < next.length; e0++) {
    if (next[e0] < 0 || seen[e0]) continue;
    const pts = [];
    let e = e0, guard = 0;
    while (e >= 0 && !seen[e] && guard++ < 4e6) {
      seen[e] = 1;
      point(e, pts);
      // A contour through a grid corner gives the same point twice: keep one.
      const m = pts.length;
      if (m >= 4 && Math.abs(pts[m - 1] - pts[m - 3]) < 1e-9 && Math.abs(pts[m - 2] - pts[m - 4]) < 1e-9) pts.length = m - 2;
      e = next[e];
    }
    while (pts.length >= 4 && Math.abs(pts[0] - pts[pts.length - 2]) < 1e-9 && Math.abs(pts[1] - pts[pts.length - 1]) < 1e-9) pts.length -= 2;
    if (pts.length >= 6) {
      const s = simplifyTol > 0 ? simplify(pts, simplifyTol * cell) : pts;
      if (s.length >= 6 && abs(area(s)) > cell * cell * 0.25) loops.push(s);
    }
  }
  return loops;
}

// Drop points that sit within tol of the chord between their neighbours. Every other point is a
// candidate on each pass, so a dropped point's neighbours are never dropped in the same pass.
export function simplify(p, tol) {
  let pts = p;
  for (let pass = 0; pass < 6; pass++) {
    const n = pts.length / 2;
    if (n <= 8) return pts;
    const out = [];
    let dropped = false;
    for (let i = 0; i < n; i++) {
      const bx = pts[i * 2], by = pts[i * 2 + 1];
      if ((i & 1) === (pass & 1) && i > 0 && i < n - 1) {
        const ax = pts[(i - 1) * 2], ay = pts[(i - 1) * 2 + 1], cx = pts[(i + 1) * 2], cy = pts[(i + 1) * 2 + 1];
        const L = len(cx - ax, cy - ay);
        const dev = L > 1e-12 ? abs((cx - ax) * (ay - by) - (ax - bx) * (cy - ay)) / L : len(bx - ax, by - ay);
        if (dev < tol) { dropped = true; continue; }
      }
      out.push(bx, by);
    }
    pts = out;
    if (!dropped) break;
  }
  return pts;
}
// Douglas-Peucker on a closed loop, for meshes (keeps at least minPts points).
export function simplifyDP(p, tol, minPts = 8) {
  const n = p.length / 2;
  if (n <= minPts) return p.slice();
  // Split the loop at the vertex farthest from vertex 0, then simplify both chains.
  let far = 0, fd = -1;
  for (let i = 1; i < n; i++) { const d = len(p[i * 2] - p[0], p[i * 2 + 1] - p[1]); if (d > fd) { fd = d; far = i; } }
  const keep = new Uint8Array(n);
  keep[0] = keep[far] = 1;
  const stack = [[0, far], [far, n]];
  while (stack.length) {
    const [a, b] = stack.pop();
    const ax = p[a * 2], ay = p[a * 2 + 1], bi = b % n, bx = p[bi * 2], by = p[bi * 2 + 1];
    const L = len(bx - ax, by - ay);
    let best = -1, bd = tol;
    for (let i = a + 1; i < b; i++) {
      const px = p[i * 2], py = p[i * 2 + 1];
      const d = L > 1e-12 ? abs((bx - ax) * (ay - py) - (ax - px) * (by - ay)) / L : len(px - ax, py - ay);
      if (d > bd) { bd = d; best = i; }
    }
    if (best >= 0) { keep[best] = 1; stack.push([a, best], [best, b]); }
  }
  let out = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(p[i * 2], p[i * 2 + 1]);
  if (out.length / 2 < minPts) {   // too coarse: fall back to even sampling
    out = [];
    const step = n / minPts;
    for (let i = 0; i < minPts; i++) { const k = floor(i * step); out.push(p[k * 2], p[k * 2 + 1]); }
  }
  return out;
}
export function area(p) {
  let a = 0;
  const n = p.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) a += (p[j * 2] * p[i * 2 + 1] - p[i * 2] * p[j * 2 + 1]);
  return a / 2;
}
export function perimeter(p) {
  let s = 0;
  const n = p.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) s += len(p[i * 2] - p[j * 2], p[i * 2 + 1] - p[j * 2 + 1]);
  return s;
}
export function pointInLoop(p, x, y) {
  let inside = false;
  const n = p.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = p[i * 2], yi = p[i * 2 + 1], xj = p[j * 2], yj = p[j * 2 + 1];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
// Inside a set of loops by the even-odd rule (holes are loops inside loops).
export function insideLoops(loops, x, y) {
  let c = 0;
  for (const l of loops) if (pointInLoop(l, x, y)) c++;
  return (c & 1) === 1;
}
// Distance from (x, y) to the nearest edge of any loop.
export function distToLoops(loops, x, y) {
  let best = Infinity;
  for (const p of loops) {
    const n = p.length / 2;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const d = sd.seg(x, y, p[j * 2], p[j * 2 + 1], p[i * 2], p[i * 2 + 1]);
      if (d < best) best = d;
    }
  }
  return best;
}
// Group loops into islands: each outer (counter-clockwise) loop with the holes it directly holds.
export function islands(loops) {
  const outers = [], holes = [];
  for (const l of loops) (area(l) > 0 ? outers : holes).push(l);
  const res = outers.map((o) => ({ outer: o, holes: [], a: area(o) }));
  for (const h of holes) {
    let best = null;
    for (const r of res) if ((!best || r.a < best.a) && pointInLoop(r.outer, h[0], h[1])) best = r;
    if (best) best.holes.push(h);
  }
  return res.map(({ outer, holes: hs }) => ({ outer, holes: hs }));
}
export function loopBounds(loops) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const l of loops) for (let i = 0; i < l.length; i += 2) {
    if (l[i] < x0) x0 = l[i]; if (l[i] > x1) x1 = l[i];
    if (l[i + 1] < y0) y0 = l[i + 1]; if (l[i + 1] > y1) y1 = l[i + 1];
  }
  return [x0, y0, x1, y1];
}
// Place a loop: mirror x (walking the loop backwards keeps its winding), rotate by a, translate.
export function placeLoop(p, x, y, a = 0, mirror = false) {
  const c = cos(a), s = sin(a), n = p.length / 2, out = new Array(p.length);
  for (let i = 0; i < n; i++) {
    const k = mirror ? n - 1 - i : i;
    const px = mirror ? -p[k * 2] : p[k * 2], py = p[k * 2 + 1];
    out[i * 2] = x + px * c - py * s;
    out[i * 2 + 1] = y + px * s + py * c;
  }
  return out;
}
// A point from plate coordinates into an item's own unit coordinates (placeLoop undone).
export function toUnit(it, x, y) {
  const dx = x - it.x, dy = y - it.y, c = cos(it.a), s = sin(it.a);
  const ux = dx * c + dy * s, uy = -dx * s + dy * c;
  return [it.mirror ? -ux : ux, uy];
}

// ---------------------------------------------------------------------
// Layouts
// ---------------------------------------------------------------------
const single = (unit = 'part') => () => ({ plates: [[{ unit, x: 0, y: 0, z0: 0, a: 0, mirror: false }]] });
// n copies of a w x d footprint on as few plates as the bed allows, centred; every other copy is
// turned half a turn when opts.alternate.
export function gridPlates(n, w, d, bedX, bedY, unit = 'part', gap = 4, opts = {}) {
  const margin = opts.margin ?? 6;
  const cols = Math.max(1, floor((bedX - 2 * margin + gap) / (w + gap)));
  const rows = Math.max(1, floor((bedY - 2 * margin + gap) / (d + gap)));
  const per = Math.max(1, Math.min(n, cols * rows));
  const count = ceil(n / per);
  const plates = [];
  let left = n;
  for (let p = 0; p < count; p++) {
    const here = Math.min(left, ceil(left / (count - p)));
    left -= here;
    const c = Math.min(cols, here), r = ceil(here / c);
    const items = [];
    for (let i = 0; i < here; i++) {
      const ci = i % c, ri = floor(i / c);
      const inRow = ri === r - 1 ? here - ri * c : c;
      items.push({ unit, x: (ci - (inRow - 1) / 2) * (w + gap), y: ((r - 1) / 2 - ri) * (d + gap), z0: opts.z0 || 0,
        a: opts.alternate && (i % 2) ? PI : 0, mirror: false });
    }
    plates.push(items);
  }
  return { plates };
}
// n copies nested through a powder bed: a grid per layer, layers spread up the build height, odd
// layers shifted half a pitch so their parts sit over the gaps below.
export function nest3D(n, w, d, h, bedX, bedY, H, unit, gap = 4) {
  const margin = 6;
  const fit = (span, size, extra) => Math.max(1, floor((span - 2 * margin - extra + gap) / (size + gap)));
  const cols = fit(bedX, w, 0), rows = fit(bedY, d, 0);
  // Odd layers shift half a pitch (parts over the gaps below) when the bed has room for it.
  const stagger = fit(bedX, w, (w + gap) / 2) === cols && fit(bedY, d, (d + gap) / 2) === rows;
  const per = cols * rows, layers = ceil(n / per);
  const zm = 4, pitchZ = layers > 1 ? Math.max(h + gap, (H - h - 2 * zm) / (layers - 1)) : 0;
  const items = [];
  for (let i = 0; i < n; i++) {
    const L = floor(i / per), j = i % per, ci = j % cols, ri = floor(j / cols);
    const shift = stagger ? (L % 2) * 0.5 - 0.25 : 0;
    items.push({ unit, x: (ci - (cols - 1) / 2 + shift) * (w + gap), y: (ri - (rows - 1) / 2 + shift) * (d + gap),
      z0: zm + L * pitchZ, a: 0, mirror: false });
  }
  return { plates: [items] };
}

// ---------------------------------------------------------------------
// Products. build({ H, k }) returns { units, arrange(bedX, bedY) }:
//   units: { name: { H, bounds: [x0, y0, x1, y1], at(z) -> (x, y) -> distance } }
//   arrange -> { plates: [[{ unit, x, y, z0, a, mirror }]], units?: extra units }
// knob: the range of k (a wall, a radius or a scale); SIZING turns weight into k.
// infill: the sparse infill a slicer would use (15% unless it is load-bearing or a lithophane).
// cell: the slicing grid in mm, fine enough for the thinnest wall.
// ---------------------------------------------------------------------
export const PRODUCTS = {
  // Phone case: back plate with a camera cut-out, walls, a lip that holds the phone, a button slot.
  'phone-case': {
    knob: [1, 3.6], infill: 1, cell: 0.4,
    build({ H, k }) {
      const W = 72, Lp = 148, r = 9, t = k, back = 1.2 + 0.3 * k;
      const camX = -W / 2 + 18, camY = Lp / 2 - 20;
      return { units: { part: { H, bounds: [-W / 2 - t, -Lp / 2 - t, W / 2 + t, Lp / 2 + t], at(z) {
        const lip = z > H - 1.3, slot = z > back + 2 && z < back + 6.5;
        return (x, y) => {
          const outer = sd.box(x, y, W / 2 + t, Lp / 2 + t, r + t);
          if (z < back) return max(outer, -sd.box(x - camX, y - camY, 11, 11, 5));
          let d = max(outer, -(lip ? sd.box(x, y, W / 2 - 1.4, Lp / 2 - 1.4, r - 1.4) : sd.box(x, y, W / 2, Lp / 2, r)));
          if (slot) d = max(d, -sd.box(x - W / 2 - t / 2, y - 28, t, 13, 1));
          return d;
        };
      } } }, arrange: single() };
    },
  },
  // Heart cookie cutter: a thin wall with a sharp top edge on a wide flange.
  'cookie-cutter': {
    knob: [0.8, 4.2], infill: 1, cell: 0.25,
    build({ H, k }) {
      const s = 42, t = k;
      const heart = (x, y) => sd.heart(x / s, (y + 0.52 * s) / s) * s;
      return { units: { part: { H, bounds: [-32, -29, 32, 28], at(z) {
        const flange = z < 2.4;
        const edge = z > H - 3 ? 0.45 + 0.55 * (H - z) / 3 : 1;
        return (x, y) => {
          const h = heart(x, y);
          return flange ? abs(h + 1) - (t / 2 + 2.4) : abs(h) - (t / 2) * edge;
        };
      } } }, arrange: single() };
    },
  },
  // Tapered plant pot: fluted sides, a rim band and a drain hole.
  'plant-pot': {
    knob: [0.9, 8], infill: 0.35, cell: 0.45,
    build({ H, k }) {
      const Rb = 34, Rt = 44, t = k, base = 2.4;
      return { units: { part: { H, bounds: [-50, -50, 50, 50], at(z) {
        const R = Rb + (Rt - Rb) * z / H + (z > H - 12 ? 3 : 0);
        const fluted = z < H - 12;
        return (x, y) => {
          const rho = len(x, y);
          const flute = fluted ? 1.3 * max(0, cos(12 * atan2(y, x))) ** 6 : 0;
          const outer = rho - R - flute;
          if (z < base) return max(outer, -(rho - 5.5));
          return max(outer, -(rho - (R - t)));
        };
      } } }, arrange: single() };
    },
  },
  // Four J-hooks printed standing, each with a screw hole in its back plate.
  'wall-hook': {
    knob: [3, 8], infill: 0.3, cell: 0.35,
    build({ H, k }) {
      const a = k / 2, w = 5 + k, R = 9;
      const zc = R + a, tipH = Math.max(zc + 4, 0.42 * H), y0 = -(R + 2 * a), zHole = 0.72 * H;
      const profile = (y, z) => {
        y -= y0;   // the hook's own coordinates start at its back
        const back = sd.seg(y, z, a, H - a, a, zc);
        const tip = sd.seg(y, z, a + 2 * R, zc, a + 2 * R, tipH);
        const arc = z < zc ? abs(len(y - (a + R), z - zc) - R) : min(len(y - a, z - zc), len(y - a - 2 * R, z - zc));
        return min(back, tip, arc) - a;
      };
      const hook = { H, bounds: [-w, y0, w, -y0], at(z) {
        const hole = abs(z - zHole) < 2.2;
        return (x, y) => {
          const d = max(abs(x) - w, profile(y, z));
          return hole ? max(d, -(len(x, z - zHole) - 2.2)) : d;
        };
      } };
      return { units: { hook }, arrange: (bx, by) => gridPlates(4, 2 * w, -2 * y0, bx, by, 'hook', 5) };
    },
  },
  // Segmented caterpillar: six body segments, stubby feet, eyes and antennas.
  'articulated-toy': {
    knob: [0.55, 1.3], infill: 0.85, cell: 0.45,
    build({ H, k }) {
      const n = 6, step = 15;
      const seg = Array.from({ length: n }, (_, i) => ({
        x: (i - (n - 1) / 2) * step, y: 6 * sin(i * 1.1), rx: step * 0.64 * (1 + 0.05 * i), ry: (14 + 2 * i) * k,
      }));
      const head = seg[n - 1];
      const rz = Math.max(6, (H - 10) / 2);
      const eyeZ = rz * 1.62;
      return { units: { part: { H, bounds: [-56, -38, 58, 38], at(z) {
        const zz = Math.max(z, 1.4) - rz;          // the bottom is flattened where it meets the bed
        const s2 = 1 - (zz / rz) ** 2;
        const s = s2 > 0 ? sqrt(s2) : 0;
        const feet = z < 3.2, cord = abs(zz) < 0.6 * rz, antenna = z > eyeZ;
        return (x, y) => {
          let d = 1e9;
          for (let i = 0; i < n; i++) {
            const g = seg[i];
            if (s > 0.02) {
              let e = sd.ellipse(x - g.x, y - g.y, g.rx * s, g.ry * s);
              if (i < n - 1) { const h = seg[i + 1]; e = max(e, -sd.ellipse(x - h.x, y - h.y, h.rx * s + 0.9, h.ry * s + 0.9)); }
              d = min(d, e);
            }
            if (feet) for (const sy of [-1, 1]) d = min(d, sd.circle(x - g.x, y - g.y - sy * (g.ry - 3), 2.8 * k));
          }
          if (cord) d = min(d, sd.seg(x, y, seg[0].x, seg[0].y, head.x, head.y) - 2.6);
          for (const sy of [-1, 1]) d = min(d, sd.sphere3(x - head.x - head.rx * 0.5, y - head.y - sy * head.ry * 0.36, z - eyeZ, 3.4 * k));
          if (antenna) for (const sy of [-1, 1]) {
            const u = clamp((z - eyeZ) / Math.max(1, H - 2.4 - eyeZ), 0, 1);
            const ax = head.x + 1 + 6 * u, ay = head.y + sy * (5 + 4 * u);
            d = min(d, sd.circle(x - ax, y - ay, 1.3), sd.sphere3(x - (head.x + 7), y - (head.y + sy * 9), z - (H - 2.4), 2.4));
          }
          return d;
        };
      } } }, arrange: single() };
    },
  },
  // RC car body shell: hollow body, cabin with side windows, wheel arches and a rear wing.
  'rc-car-body': {
    knob: [2.5, 10], infill: 0.9, cell: 0.55,
    build({ H, k }) {
      const hxB = 100, hyB = 50, t = k;
      return { units: { part: { H, bounds: [-104, -53, 104, 53], at(z) {
        const s = smoothstep(0.42 * H, 0.95 * H, z);
        const hx = hxB - (hxB - 52) * s, hy = hyB - (hyB - 38) * s, cx = -14 * s;
        const nose = 1 - 0.18 * smoothstep(0, 0.45 * H, z);
        const roof = z > H - t * 1.2;
        const win = z > 0.6 * H && z < 0.86 * H;
        const posts = z > 0.5 * H && z <= 0.8 * H, wing = z > 0.8 * H && z < 0.87 * H;
        return (x, y) => {
          const yy = x > 30 ? y / (1 - (1 - nose) * (x - 30) / 70) : y;
          const outer = sd.box(x - cx, yy, hx, hy, min(20, hy - 1));
          let d = roof ? outer : shellIn(outer, t);
          for (const wx of [-62, 62]) d = max(d, -max(len(x - wx, z) - 24, (hy - 16) - abs(y)));
          if (win) d = max(d, -max(sd.box(x + 10, 0, 30, 1e3, 0), (hy - 9) - abs(y)));
          if (posts) for (const py of [-28, 28]) d = min(d, sd.box(x + 88, y - py, 3, 2.4, 1));
          if (wing) d = min(d, sd.box(x + 89, y, 9, 44, 2));
          return d;
        };
      } } }, arrange: single() };
    },
  },
  // X-frame FPV drone: bottom plate with arms and motor pads, standoffs, top plate.
  'drone-frame': {
    knob: [3, 12], infill: 1, cell: 0.4,
    build({ H, k }) {
      const aw = 14 + k, P = 66, plate = k, top = Math.max(2, 0.5 * k);
      const so = [[-20, -20], [20, -20], [-20, 20], [20, 20]];
      return { units: { part: { H, bounds: [-80, -80, 80, 80], at(z) {
        if (z < plate) return (x, y) => {
          let d = sd.box(x, y, 26, 26, 8);
          for (const [sx, sy] of CORNERS) d = min(d, sd.seg(x, y, sx * 14, sy * 14, sx * P, sy * P) - aw / 2, sd.circle(x - sx * P, y - sy * P, 13));
          for (const [sx, sy] of CORNERS) {
            d = max(d, -sd.circle(x - sx * P, y - sy * P, 3.4));
            for (let b = 0; b < 4; b++) { const a = b * PI / 2 + PI / 4; d = max(d, -sd.circle(x - sx * P - 8 * cos(a), y - sy * P - 8 * sin(a), 1.5)); }
            d = max(d, -(sd.seg(x, y, sx * 28, sy * 28, sx * 48, sy * 48) - aw * 0.18));
            d = max(d, -sd.circle(x - sx * 20, y - sy * 20, 1.6));
          }
          return d;
        };
        if (z < H - top) return (x, y) => {
          let d = 1e9;
          for (const [sx, sy] of so) d = min(d, max(sd.circle(x - sx, y - sy, 2.8), -sd.circle(x - sx, y - sy, 1.4)));
          return d;
        };
        return (x, y) => {
          let d = sd.box(x, y, 25, 33, 6);
          for (const [sx, sy] of so) d = max(d, -sd.circle(x - sx, y - sy, 1.6));
          return max(d, -sd.box(x, y, 6, 14, 3));
        };
      } } }, arrange: single() };
    },
  },
  // Twisted vase: a six-lobed section that turns a third of a turn on its way up.
  'decorative-vase': {
    knob: [1.6, 14], infill: 0.5, cell: 0.5,
    build({ H, k }) {
      const t = k, base = 2.4;
      return { units: { part: { H, bounds: [-60, -60, 60, 60], at(z) {
        const u = z / H;
        const R = 27 + 24 * sin(PI * (0.1 + 0.78 * u)) ** 1.4 + 4 * smoothstep(0.86, 1, u);
        const tw = (TAU / 3) * u;
        return (x, y) => {
          const outer = (len(x, y) - R * (1 + 0.075 * cos(6 * atan2(y, x) + tw))) * 0.93;
          return z < base ? outer : max(outer, -(outer + t));
        };
      } } }, arrange: single() };
    },
  },
  // Lithophane panel: a curved panel whose thickness draws mountains, a sun and a pine tree, on a
  // foot. Printed solid, as lithophanes are.
  'lithophane-lamp': {
    knob: [1.4, 6], infill: 1, cell: 0.3,
    build({ H, k }) {
      const Ra = 56, span = 72 * PI / 180, depth = k;
      const img = (u, v) => {
        if (abs(u) > 0.9 || v < 0.06 || v > 0.94) return 1;          // the frame
        const sun = len((u - 0.36) * 1.6, v - 0.72) - 0.13;
        if (sun < 0) return 0;
        let g = sun < 0.08 ? 0.14 * sun / 0.08 : 0.14;                 // sky, brighter round the sun
        const m = 0.36 + 0.2 * max(0, 1 - abs(u + 0.25) / 0.36) + 0.13 * max(0, 1 - abs(u - 0.45) / 0.3);
        if (v < m) g = 0.78;                                            // mountains
        if (v > 0.2 && v < 0.58 && abs(u + 0.62) < 0.13 * (1 - (v - 0.2) / 0.38)) g = 0.96;   // pine tree
        if (v < 0.18 + 0.04 * sin(5 * u)) g = 1;                        // ground
        return g;
      };
      return { units: { part: { H, bounds: [-64, -64, 64, -8], at(z) {
        const v = z / H, foot = z < 7;
        return (x, y) => {
          const rho = len(x, y), th = atan2(x, -y);
          const ends = (abs(th) - span) * rho;
          if (foot) return max(max(Ra - 2 - rho, rho - (Ra + 6)), ends);
          return max(max(Ra - rho, rho - (Ra + 0.8 + depth * img(th / span, v))), ends);
        };
      } } }, arrange: single() };
    },
  },
  // Crown: a ridged band with jewels and seven tapering points, a ball on each point.
  'cosplay-accessory': {
    knob: [3, 15], infill: 0.55, cell: 0.5,
    build({ H, k }) {
      const Rc = 62, t = k, n = 7, hb = 0.36 * H, ball = 5.5, tipZ = H - ball * 1.6;
      return { units: { part: { H, bounds: [-73, -73, 73, 73], at(z) {
        const ridge = z < 4 || (z > hb - 4 && z < hb);
        const w = z < hb ? 0 : (PI / n) * 0.92 * clamp(1 - (z - hb) / (tipZ - hb), 0, 1);
        return (x, y) => {
          const rho = len(x, y), th = atan2(y, x);
          let d = abs(rho - Rc) - t / 2 - (ridge ? 1.6 : 0);
          if (z >= hb) d = max(d, rho * (abs(sector(th, n, PI / 2)) - w));
          const a = PI / 2 + Math.round((th - PI / 2) / (TAU / n)) * (TAU / n);
          d = min(d, sd.sphere3(x - Rc * cos(a), y - Rc * sin(a), z - (H - ball), ball));
          d = min(d, sd.sphere3(x - (Rc + t / 2) * cos(a), y - (Rc + t / 2) * sin(a), z - hb / 2, 4.2));
          return d;
        };
      } } }, arrange: single() };
    },
  },
  // Sixteen resin minis, each on a raft pad and supports: four kinds of adventurer waving hello.
  'miniature-batch': {
    knob: [0.6, 1.5], infill: 1, cell: 0.3,
    build({ H, k }) {
      const raftH = 1.2, sup = raftH + 5, baseH = 2.5, fh = Math.max(16, H - sup - baseH);
      const s = fh / 32;                         // figures are drawn 32 mm tall, then scaled
      const R = Math.max(7, 6.5 * s);             // base disc
      const half = Math.max(R + 1.6, 9.5 * s * k) + 1;
      const mini = (variant) => ({ H: sup + baseH + fh, bounds: [-half, -half, half, half], at(z) {
        if (z < raftH) return (x, y) => sd.circle(x, y, R + 1.6 - (z > raftH - 0.4 ? 0.4 : 0));
        if (z < sup) return (x, y) => {
          let d = sd.circle(x, y, 0.9);
          for (let i = 0; i < 4; i++) d = min(d, sd.circle(x - 0.62 * R * cos(i * PI / 2 + PI / 4), y - 0.62 * R * sin(i * PI / 2 + PI / 4), 0.7));
          return d;
        };
        if (z < sup + baseH) return (x, y) => sd.circle(x, y, R - (z > sup + baseH - 0.6 ? 0.6 : 0));
        const q = (z - sup - baseH) / s;           // height up the 32 mm figure
        return (x, y) => {
          const X = x / s, Y = y / s, K = k;
          let d = 1e9;
          for (const sx of [-1, 1]) d = min(d, sd.seg3(X, Y, q, sx * 2.2 * K, 0, 0.8, sx * 2.0 * K, 0, 11) - 2.2 * K);   // legs
          d = min(d, sd.ellipsoid3(X, Y, q - 15.5, 5.2 * K, 3.7 * K, 6.2));                                             // body
          d = min(d, sd.seg3(X, Y, q, 5 * K, 0, 19.5, 8.5 * K, 0.6, 27.5) - 1.6 * K);                                  // waving arm
          d = min(d, sd.seg3(X, Y, q, -5 * K, 0, 19.5, -6.8 * K, 0.8, 11.5) - 1.6 * K);                                // other arm
          d = min(d, sd.sphere3(X, Y, q - 24.5, 4.1 * K));                                                            // head
          if (variant === 0) d = min(d, max(len(X, Y) - 5 * K * clamp((33 - q) / 6, 0, 1), 26.8 - q));                 // pointed hat
          else if (variant === 1) d = min(d, max(sd.sphere3(X, Y, q - 25.2, 4.5 * K), 24.6 - q));                       // round helmet
          else if (variant === 2) d = min(d, max(sd.ellipsoid3(X + 0.8, Y, q - 25, 5 * K, 4.8 * K, 5.5), 22.5 - q, -(sd.sphere3(X - 1.6 * K, Y, q - 24.2, 3.4 * K))));   // hood
          else d = min(d, sd.sphere3(X + 3.4 * K, Y, q - 27.6, 2.3 * K));                                               // hair bun
          return d * s;
        };
      } });
      const units = { mini0: mini(0), mini1: mini(1), mini2: mini(2), mini3: mini(3) };
      return { units, arrange(bx, by) {
        const g = gridPlates(16, 2 * half, 2 * half, bx, by, 'mini0', 2.5, { margin: 4 });
        g.plates.forEach((items, p) => items.forEach((it, i) => { it.unit = 'mini' + ((i + p) % 4); }));
        return g;
      } };
    },
  },
  // Fifty pop grips (a base disc, an accordion body and a cap). Big batches need more plates.
  'custom-grip-batch': {
    knob: [13, 25], infill: 1, cell: 0.4,
    build({ H, k }) {
      const r = k, cap = 3;
      const grip = { H, bounds: [-r, -r, r, r], at(z) {
        if (z < 2.6) return (x, y) => sd.circle(x, y, r);
        if (z > H - cap) return (x, y) => max(sd.circle(x, y, r - (z > H - 0.8 ? 0.8 : 0)), -sd.circle(x, y, r * 0.18));
        const fold = abs(((z - 2.6) / 3.2) % 2 - 1);
        return (x, y) => max(sd.circle(x, y, r * (0.6 + 0.24 * fold)), -sd.circle(x, y, r * 0.3));
      } };
      return { units: { grip }, arrange: (bx, by) => gridPlates(50, 2 * r, 2 * r, bx, by, 'grip', 3) };
    },
  },
  // Ring tree for lost-wax casting: a sprue with ten rings on short branches, a stone on each.
  'jewelry-casting': {
    knob: [0.8, 2.3], infill: 1, cell: 0.2,
    build({ H, k }) {
      const n = 10, Rr = 8.5, rt = 1.1 * k;
      const rings = Array.from({ length: n }, (_, i) => {
        const a = i * 2.4 + 0.4, zc = 0.3 * H + i * (0.56 * H / (n - 1)), dc = 2.4 + 1.4 + Rr;
        return { a, zc, cx: dc * cos(a), cy: dc * sin(a), tx: -sin(a), ty: cos(a), bx: 3.8 * cos(a), by: 3.8 * sin(a) };
      });
      return { units: { part: { H, bounds: [-24, -24, 24, 24], at(z) {
        const near = rings.filter((g) => abs(z - g.zc) < Rr + rt + 4.5);
        return (x, y) => {
          let d = z < 2 ? sd.circle(x, y, 9) : sd.circle(x, y, 2.4 - 0.6 * z / H);
          for (const g of near) {
            d = min(d, sd.torus3(x - g.cx, y - g.cy, z - g.zc, g.tx, g.ty, 0, Rr, rt));
            d = min(d, sd.seg3(x, y, z, 0, 0, g.zc - 3, g.bx, g.by, g.zc) - 0.9);
            d = min(d, sd.sphere3(x - g.cx, y - g.cy, z - g.zc - Rr - rt, 1.9 * k));
          }
          return d;
        };
      } } }, arrange: single() };
    },
  },
  // Spur gear pair: a 30-tooth gear with lightening holes and a keyway, meshing with a pinion.
  'functional-gear': {
    knob: [0.7, 1.04], infill: 0.7, cell: 0.4,
    build({ H, k }) {
      const Rp = 44 * k, Nt = 30, m = 2 * Rp / Nt, Rs = m * 14 / 2;
      const cxB = -24, cxS = cxB + Rp + Rs + 0.4;
      const gear = (x, y, R, N, ph) => (len(x, y) - (R + m * clamp(1.7 * cos(N * atan2(y, x) + ph) + 0.35, -1.25, 1))) * 0.8;
      return { units: { part: { H, bounds: [cxB - Rp - m - 2, -Rp - m - 2, cxS + Rs + m + 2, Rp + m + 2], at(z) {
        return (x, y) => {
          const bx = x - cxB, sx = x - cxS;
          let big = gear(bx, y, Rp, Nt, 0);
          for (let i = 0; i < 5; i++) { const a = i * TAU / 5; big = max(big, -sd.circle(bx - 0.6 * Rp * cos(a), y - 0.6 * Rp * sin(a), 0.2 * Rp)); }
          big = max(big, -sd.circle(bx, y, 6), -sd.box(bx, y - 6, 1.6, 2, 0));
          let small = gear(sx, y, Rs, 14, PI);
          small = max(small, -max(sd.circle(sx, y, 4.2), -(sx + 3.4)));      // a D-shaped bore
          return min(big, small);
        };
      } } }, arrange: single() };
    },
  },
  // Vented electronics enclosure: floor with mounting holes, louvred walls, a display window, a
  // sensor port, standoffs and a ledge for the lid.
  'robot-enclosure': {
    knob: [1, 7], infill: 0.4, cell: 0.5,
    build({ H, k }) {
      const hx = 100, hy = 95, t = k, floorT = 2.2;
      return { units: { part: { H, bounds: [-hx, -hy, hx, hy], at(z) {
        const vent = z > 0.25 * H && z < 0.75 * H && ((z - 0.25 * H) % 9) < 4;
        const win = z > 0.45 * H && z < 0.75 * H, ledge = z > H - 4, boss = z < 12;
        const port = abs(z - 0.6 * H) < 13;
        return (x, y) => {
          const outer = sd.box(x, y, hx, hy, 10);
          if (z < floorT) {
            let d = max(outer, -sd.circle(x - 70, y + 70, 7));
            for (const [sx, sy] of CORNERS) d = max(d, -sd.circle(x - sx * 88, y - sy * 83, 2));
            return d;
          }
          let d = shellIn(outer, t + (ledge ? 1.6 : 0));
          if (vent) d = max(d, -max(abs(y) - 60, (hx - t - 1) - abs(x)));
          if (win) d = max(d, -max(abs(x + 36) - 34, y + hy - t - 1));
          if (port) d = max(d, -max(len(x - 46, z - 0.6 * H) - 13, (hy - t - 1) - y));
          if (boss) for (const [sx, sy] of CORNERS) d = min(d, max(sd.circle(x - sx * 80, y - sy * 75, 4), -sd.circle(x - sx * 80, y - sy * 75, 1.6)));
          return d;
        };
      } } }, arrange: single() };
    },
  },
  // Full helmet: a domed shell with a visor slot, brow ridge, ear vents and a crest.
  'cosplay-helmet': {
    knob: [3, 16], infill: 0.4, cell: 0.7,
    build({ H, k }) {
      const a = 106, b = 122, t = k, z0 = 0.42 * H, zt = 0.95 * H;
      const radii = (z) => (z < z0 ? 0.93 + 0.07 * z / z0 : sqrt(max(0, 1 - ((z - z0) / (zt - z0)) ** 2)));
      return { units: { part: { H, bounds: [-112, -133, 112, 133], at(z) {
        const s = radii(z);
        const visor = z > 0.36 * H && z < 0.56 * H, brow = z > 0.56 * H && z < 0.63 * H;
        const ear = z > 0.28 * H && z < 0.4 * H, closed = z > zt - t * 1.1, crestZ = z > z0 + 0.3 * H;
        return (x, y) => {
          const outer = s > 0.02 ? sd.ellipse(x, y, a * s, b * s) : 1e9;
          const th = atan2(x, -y), rho = len(x, y);
          let d = closed ? outer : shellIn(outer, t);
          if (brow && abs(th) < 0.95) d = min(d, max(outer - 3.5, -(outer + t)));
          if (visor) d = max(d, -((abs(th) - 0.84) * rho));
          if (ear) d = max(d, -((abs(abs(th) - PI / 2) - 0.12) * rho));
          if (crestZ) d = min(d, max(abs(x) - 3.5, sd.ellipse(y, z - z0, b + 9, H - z0), -(outer + 1)));
          return d;
        };
      } } }, arrange: single() };
    },
  },
  // Ten two-blade propellers: twisted, tapered blades round a hub with a bore.
  'drone-propeller': {
    knob: [1, 5.2], infill: 1, cell: 0.3,
    build({ H, k }) {
      const R = 64, c0 = 15 + 6 * k, tau = 1.6 + 1.2 * k, hubR = 8, zc = H / 2;
      const blade = (x, y, z) => {
        const r = abs(x);
        const c = c0 * (1 - 0.55 * (r / R) ** 2) * (r < 9 ? 0.6 + 0.4 * r / 9 : 1);
        const alpha = Math.min(Math.asin(clamp((H - 3) / (c + 0.01), 0, 0.95)), Math.atan(70 / (TAU * max(r, 6))));
        const sa = x > 0 ? sin(alpha) : -sin(alpha), ca = cos(alpha);
        const v = y * ca + (z - zc) * sa, nn = -y * sa + (z - zc) * ca;
        return max(abs(nn) - tau / 2, abs(v) - c / 2, r - R);
      };
      const prop = { H, bounds: [-R - 1, -c0, R + 1, c0], at(z) {
        return (x, y) => max(min(blade(x, y, z), sd.circle(x, y, hubR)), -sd.circle(x, y, 2.6));
      } };
      return { units: { prop }, arrange: (bx, by) => gridPlates(10, 2 * R + 2, 2 * c0, bx, by, 'prop', 3, { alternate: true }) };
    },
  },
  // Fixture plate: slotted base, a V-block, a clamp tower with gussets and locating pins.
  'engineering-fixture': {
    knob: [3, 24], infill: 0.3, cell: 0.5,
    build({ H, k }) {
      const plateT = k, rib = 8, zv = plateT + 0.45 * (H - plateT);
      return { units: { part: { H, bounds: [-96, -71, 96, 71], at(z) {
        const pins = z < 32;
        return (x, y) => {
          if (z < plateT) {
            let d = sd.box(x, y, 95, 70, 6);
            for (const [sx, sy] of CORNERS) d = max(d, -(sd.seg(x, y, sx * 70, sy * 57, sx * 84, sy * 57) - 4.2));
            return max(d, -sd.circle(x - 30, y + 55, 3), -sd.circle(x + 10, y + 55, 3));
          }
          let d = max(sd.box(x - 22, y, 28, 30, 3), -(abs(y) - max(0, z - zv)));       // V-block
          d = min(d, max(sd.box(x + 70, y, 13, 22, 2), -(len(y, z - 0.7 * H) - 5)));    // clamp tower, bolt hole
          for (const sy of [-1, 1]) d = min(d, max(abs(y - sy * 15) - rib / 2, -(x + 57) - 0.5, (x + 57) - 28 * (H - z) / (H - plateT)));
          if (pins) for (const [px, py] of [[52, -52], [52, 52], [-20, 52]]) d = min(d, sd.circle(x - px, y - py, 3.2));
          return d;
        };
      } } }, arrange: single() };
    },
  },
  // Ribbed L-bracket: a counterbored flange, an upright web with two holes, three gussets.
  'end-use-bracket': {
    knob: [1.5, 14], infill: 0.4, cell: 0.5,
    build({ H, k }) {
      const flange = 4 + 0.4 * k, web = k, wy = -50;
      return { units: { part: { H, bounds: [-81, -56, 81, 56], at(z) {
        const cb = z > flange * 0.6;
        const reach = (110 - web) * clamp(1 - (z - flange) / (H - flange - 4), 0, 1);
        return (x, y) => {
          if (z < flange) {
            let d = sd.box(x, y, 80, 55, 8);
            for (const [sx, sy] of CORNERS) d = max(d, -sd.circle(x - sx * 62, y - sy * 38, cb ? 7 : 4));
            return d;
          }
          const corner = z > H - 14 ? 14 - len(max(0, abs(x) - 61), z - (H - 14)) : 1;
          let d = max(sd.box(x, y - wy - web / 2, 75, web / 2, 0), -corner);
          for (const hx of [-35, 35]) d = max(d, -(len(x - hx, z - 0.62 * H) - 6));
          for (const rx of [-55, 0, 55]) d = min(d, max(abs(x - rx) - web * 0.35, (y - wy - web) - reach, -(y - wy)));
          return d;
        };
      } } }, arrange: single() };
    },
  },
  // Surgical drill guide: a horseshoe channel over the teeth with four drill sleeves.
  'surgical-guide': {
    knob: [1.2, 8.5], infill: 1, cell: 0.3,
    build({ H, k }) {
      const wb = k, sleeveH = 7, topZ = H - sleeveH;
      const pts = Array.from({ length: 11 }, (_, i) => { const x = -38 + i * 7.6; return [x, 30 - 0.032 * x * x]; });
      const arch = (x, y) => { let d = 1e9; for (let i = 0; i < pts.length - 1; i++) d = min(d, sd.seg(x, y, pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1])); return d; };
      const sleeves = [-28, -14, 14, 28].map((sx) => [sx, 30 - 0.032 * sx * sx]);
      return { units: { part: { H, bounds: [-47, -25, 47, 39], at(z) {
        const channel = z < topZ - 3, roof = z <= topZ, sleeve = z > topZ - 0.5;
        return (x, y) => {
          const a = arch(x, y);
          let d = roof ? (channel ? max(a - wb, -(a - wb + 2.2)) : a - wb) : 1e9;
          for (const [sx, sy] of sleeves) {
            if (sleeve) d = min(d, sd.circle(x - sx, y - sy, 4.6));
            d = max(d, -sd.circle(x - sx, y - sy, 2.6));
          }
          return d;
        };
      } } }, arrange: single() };
    },
  },
  // Four wax crowns (molars) on long supports. Supports touch the biting surface, so the inside
  // of each crown (which has to fit the tooth) stays clean.
  'dental-crown-wax': {
    knob: [0.65, 1.35], infill: 1, cell: 0.15,
    build({ H, k }) {
      const pad = 0.6, hc = 8 * k, sup = Math.max(2, H - hc), wall = 1.0;
      const cusps = [[2.4, 2.2], [-2.4, 2.2], [2.4, -2.2], [-2.4, -2.2]];
      const crown = { H: sup + hc, bounds: [-7.6, -7, 7.6, 7], at(z) {
        if (z < pad) return (x, y) => sd.box(x, y, 5.2 * k, 4.8 * k, 3);
        if (z < sup) return (x, y) => { let d = 1e9; for (const [cx, cy] of cusps) d = min(d, sd.circle(x - cx * k, y - cy * k, 0.55)); return d; };
        const u = (z - sup) / hc;
        const bulge = 1 + 0.1 * sin(PI * clamp(u, 0, 1));
        return (x, y) => {
          const outer = sd.box(x, y, 5.6 * k * bulge, 5.1 * k * bulge, 3.4 * k);
          if (u < 0.22) {                                   // cusps, growing from the support tips
            let c = 1e9;
            for (const [cx, cy] of cusps) c = min(c, sd.circle(x - cx * k, y - cy * k, 0.6 + 2.6 * k * sqrt(u / 0.22)));
            return max(outer, c);
          }
          if (u < 0.42) return outer;
          return shellIn(outer, wall);                      // the open cup for the tooth
        };
      } };
      return { units: { crown }, arrange: () => ({ plates: [[[-8.5, -8], [8.5, -8], [-8.5, 8], [8.5, 8]].map(([x, y]) => ({ unit: 'crown', x, y, z0: 0, a: 0, mirror: false }))] }) };
    },
  },
  // Insole (orthotic): a heel cup, a raised rim and an arch support on a thin base. Solid powder.
  'custom-orthotic': {
    knob: [2.5, 11], infill: 1, cell: 0.6,
    build({ H, k }) {
      const base = k, rise = Math.max(4, H - base);
      const outline = (x, y) => smin(sd.circle(x + 94, y + 2, 31), sd.ellipse(x - 50, y - 4, 70, 46), 46);
      const shape = (x, y) => {
        const heel = smoothstep(-60, -120, x) * 0.42;
        const rim = smoothstep(-6, -1, outline(x, y)) * smoothstep(-20, -70, x) * 0.58;
        const arch = 0.55 * Math.exp(-(((x + 18) / 40) ** 2 + ((y - 26) / 20) ** 2));
        return min(1, heel + rim + arch);
      };
      return { units: { insole: { H: base + rise, bounds: [-126, -52, 122, 52], at(z) {
        if (z < base) return (x, y) => outline(x, y);
        const need = (z - base) / rise;
        return (x, y) => max(outline(x, y), (need - shape(x, y)) * rise);
      } } }, arrange: () => ({ plates: [[{ unit: 'insole', x: -2, y: 0, z0: 0, a: 0, mirror: false }]] }) };
    },
  },
  // Fifty knurled control knobs (a skirt, a knurled grip, a pointer groove and a D-bore) nested
  // through a powder bed in layers.
  'sls-production-batch': {
    knob: [0.8, 1.6], infill: 1, cell: 0.4,
    build({ H, k }) {
      const s = k, r = 18 * s, h = 26 * s, skirt = 3 * s;
      const knob = { H: h, bounds: [-r - 1, -r - 1, r + 1, r + 1], at(z) {
        const top = z > h - 2.5 * s, bore = z < 0.62 * h;
        return (x, y) => {
          const rho = len(x, y), th = atan2(y, x);
          const R = z < skirt ? r : (r - 2 * s) * (top ? 1 - 0.18 * (z - (h - 2.5 * s)) / (2.5 * s) : 1) + 0.9 * s * cos(24 * th);
          let d = rho - R;
          if (top) d = max(d, -max(abs(x) - 0.9 * s, -y, y - 0.6 * R));               // pointer groove
          if (bore) d = max(d, -max(sd.circle(x, y, 3.2 * s), y - 2.2 * s));          // D-shaped bore
          return d;
        };
      } };
      return { units: { knob }, arrange: (bx, by) => nest3D(50, 2 * r + 2, 2 * r + 2, h, bx, by, H, 'knob', 3) };
    },
  },
  // Two hundred pipe elbows nested in an MJF powder cake.
  'mjf-connector-batch': {
    knob: [1.0, 2.2], infill: 1, cell: 0.5,
    build({ H, k }) {
      const s = k, ro = 8 * s, ri = 5.2 * s, armL = 22 * s;
      const elbow = { H: 2 * ro, bounds: [-ro, -ro, armL + 0.01, armL + 0.01], at(z) {
        const zz = z - ro;
        return (x, y) => {
          const r = min(sd.seg3(x, y, zz, 0, 0, 0, armL, 0, 0), sd.seg3(x, y, zz, 0, 0, 0, 0, armL, 0));
          return max(r - ro, -(r - ri), x - armL, y - armL);
        };
      } };
      return { units: { elbow }, arrange: (bx, by) => nest3D(200, armL + ro, armL + ro, 2 * ro, bx, by, H, 'elbow', 5) };
    },
  },
  // Wearable sensor cuff: an open C band with a sensor pod and breathing holes.
  'biocompatible-device': {
    knob: [1.5, 6.5], infill: 1, cell: 0.4,
    build({ H, k }) {
      const a = 40, b = 32, t = k;
      const rows = [0.25, 0.5, 0.75].map((f) => f * H);
      const dirs = [0.95, 1.6, 2.25, -0.95, -1.6, -2.25].map((g) => [sin(g), -cos(g)]);
      return { units: { part: { H, bounds: [-a - t - 1, -b - t - 1, a + t + 1, b + t + 14], at(z) {
        const pod = z > 0.15 * H && z < 0.85 * H;
        const holes = rows.filter((zr) => abs(z - zr) < 2.4);
        return (x, y) => {
          let d = abs(sd.ellipse(x, y, a + t / 2, b + t / 2)) - t / 2;
          d = max(d, (0.62 - abs(atan2(x, -y))) * len(x, y));               // the opening at the front
          if (pod) d = min(d, sd.box(x, y - b - t - 5, 16, 8, 3));
          for (const zr of holes) for (const [ux, uy] of dirs) {
            if (x * ux + y * uy < 0) continue;
            d = max(d, -(len(abs(x * uy - y * ux), z - zr) - 2.4));
          }
          return d;
        };
      } } }, arrange: single() };
    },
  },
  // Lightweighted titanium bracket: a pocketed base frame with bolt bosses, a strut lattice and a
  // lug with a cross hole.
  'aerospace-bracket': {
    knob: [0.8, 5], infill: 1, cell: 0.45,
    build({ H, k }) {
      const rs = k, lugZ = H - 28;
      const feet = [[-70, -40], [70, -40], [70, 40], [-70, 40]];
      const tops = [[-9, -6], [9, -6], [9, 6], [-9, 6]];
      const struts = [];
      for (let i = 0; i < 4; i++) {
        const j = (i + 1) % 4;
        struts.push([...feet[i], 6, ...tops[i], lugZ + 2, rs]);
        struts.push([...feet[i], 6, (feet[i][0] + feet[j][0]) * 0.18, (feet[i][1] + feet[j][1]) * 0.18, lugZ * 0.5, rs * 0.75]);
      }
      return { units: { part: { H, bounds: [-86, -56, 86, 56], at(z) {
        const base = z < 2 + 0.5 * k, boss = z < 6 + k, lug = z > lugZ;
        const near = struts.filter((q) => z >= min(q[2], q[5]) - q[6] - 1 && z <= max(q[2], q[5]) + q[6] + 1);
        return (x, y) => {
          let d = base ? max(sd.box(x, y, 85, 55, 10), -sd.box(x, y, 70, 40, 8)) : 1e9;     // frame round a pocket
          if (base) d = min(d, max(abs(x) - 4, abs(y) - 50), max(abs(y) - 4, abs(x) - 80));    // cross ribs
          if (boss) for (const [fx, fy] of feet) d = min(d, sd.circle(x - fx, y - fy, 9));
          if (lug) d = min(d, max(sd.box(x, y, 13, 9, 3), -(len(x, z - (H - 13)) - 6)));
          let st = 1e9;
          for (const q of near) st = min(st, sd.seg3(x, y, z, q[0], q[1], q[2], q[3], q[4], q[5]) - q[6]);
          d = smin(d, st, 3);
          for (const [fx, fy] of feet) d = max(d, -sd.circle(x - fx, y - fy, 4.5));
          return d;
        };
      } } }, arrange: single() };
    },
  },
  // Coolant manifold: a main pipe between two bolted flanges with three branch pipes.
  'engine-cooling-channel': {
    knob: [1, 4.5], infill: 1, cell: 0.5,
    build({ H, k }) {
      const ro = 18, ri = ro - k, rb = 9, rbi = rb - min(k, 6);
      const branches = [0, 1, 2].map((i) => { const a = i * TAU / 3 + 0.3; return { z: (0.3 + 0.2 * i) * H, ex: cos(a), ey: sin(a) }; });
      return { units: { part: { H, bounds: [-82, -82, 82, 82], at(z) {
        const bottom = z < 6, top = z > H - 6;
        const near = branches.filter((b) => abs(z - b.z) < 16);
        return (x, y) => {
          const rho = len(x, y);
          let d = bottom ? rho - 34 : top ? rho - 26 : rho - ro;
          if (bottom) for (let i = 0; i < 6; i++) d = max(d, -sd.circle(x - 28 * cos(i * PI / 3), y - 28 * sin(i * PI / 3), 3.2));
          if (top) for (let i = 0; i < 4; i++) d = max(d, -sd.circle(x - 21 * cos(i * PI / 2 + PI / 4), y - 21 * sin(i * PI / 2 + PI / 4), 2.6));
          let inner = rho - ri;
          for (const b of near) {
            const along = x * b.ex + y * b.ey, side = abs(-x * b.ey + y * b.ex);
            const r = along > 0 ? len(side, z - b.z) : 1e9;
            d = min(d, max(r - rb, along - 66));
            d = min(d, max(abs(along - 63) - 3, len(side, z - b.z) - 15));        // branch flange
            inner = min(inner, max(r - rbi, along - 70));
          }
          return max(d, -inner);
        };
      } } }, arrange: single() };
    },
  },
  // Mould core insert: a bolted flange, a tall core with a stepped moulding face and a conformal
  // cooling channel spiralling inside it.
  'tooling-die': {
    knob: [7, 17], infill: 1, cell: 0.4,
    build({ H, k }) {
      const half = k, flangeH = 16, face = 20;
      return { units: { part: { H, bounds: [-34, -34, 34, 34], at(z) {
        const helixA = (z / 26) * TAU, hr = half * 0.55;
        const step = z > H - face ? floor((z - (H - face)) / (face / 3)) : -1;
        const s = step < 0 ? half : half * (0.86 - 0.22 * step);
        const channel = z >= flangeH && z < H - face - 4;
        return (x, y) => {
          if (z < flangeH) {
            let d = sd.box(x, y, 32, 32, 4);
            for (const [sx, sy] of CORNERS) d = max(d, -sd.circle(x - sx * 24, y - sy * 24, 4.5));
            return max(d, -sd.circle(x - hr, y, 3), -sd.circle(x + hr, y, 3));
          }
          const d = sd.box(x, y, s, s, 3);
          return channel ? max(d, -sd.circle(x - hr * cos(helixA), y - hr * sin(helixA), 3)) : d;
        };
      } } }, arrange: single() };
    },
  },
  // Finned heat exchanger: a channelled core with 12 twisted radial fins and two flanges.
  'heat-exchanger': {
    knob: [0.4, 2], infill: 1, cell: 0.35,
    build({ H, k }) {
      const tf = k, n = 12;
      return { units: { part: { H, bounds: [-62, -62, 62, 62], at(z) {
        const flange = z < 6 || z > H - 6;
        const rf = 58 - 8 * abs(cos(PI * z / H)), tw = 0.6 * z / H;
        return (x, y) => {
          const rho = len(x, y);
          let d = flange ? rho - 30 : rho - 18;
          if (!flange) d = min(d, max(abs(rho * sin(sector(atan2(y, x), n, tw))) - tf / 2, rho - rf, 17 - rho));
          d = max(d, -(rho - 14.5));
          for (let i = 0; i < 6; i++) d = max(d, -sd.circle(x - 16.3 * cos(i * PI / 3), y - 16.3 * sin(i * PI / 3), 0.9));
          if (flange) for (let i = 0; i < 4; i++) d = max(d, -sd.circle(x - 25 * cos(i * PI / 2), y - 25 * sin(i * PI / 2), 2.2));
          return d;
        };
      } } }, arrange: single() };
    },
  },
  // Patient-matched curved plate (a cranial patch), printed standing: part of a spherical shell
  // with a rounded outline and a grid of fixation holes.
  'surgical-implant': {
    knob: [1.8, 6], infill: 1, cell: 0.3,
    build({ H, k }) {
      const R = 95, t = k, hw = 52, cy = -R + 12, pitch = 7.5;
      return { units: { part: { H, bounds: [-hw - 2, -R + 10, hw + 2, 14 + t], at(z) {
        const zz = z - H / 2;
        const Rin = R, Rout = R + t;
        const v = zz / (H / 2);                         // -1..1 up the patch
        const halfU = hw * sqrt(max(0, 1 - v * v));       // arc half-width at this height (an ellipse)
        const row = Math.round(zz / pitch), dz = zz - row * pitch, holeRow = abs(dz) < 1.7 && abs(v) < 0.86;
        return (x, y) => {
          const rho = len(x, y - cy), u = atan2(x, y - cy) * Rin;
          let d = max(max(Rin - rho, rho - Rout), abs(u) - halfU);
          if (holeRow) {
            const col = Math.round(u / pitch - ((row & 1) ? 0.5 : 0)) + ((row & 1) ? 0.5 : 0);
            if (abs(col * pitch) < halfU - 4) d = max(d, -(len(u - col * pitch, dz) - 1.7));
          }
          return d;
        };
      } } }, arrange: single() };
    },
  },
};

// ---------------------------------------------------------------------
// Sizing: printed volume (cm³) on a grid of heights x knob values, measured offline by
// tests/helpers/size-shapes.mjs (FDM: the extruded volume of the 0.4 mm toolpath; resin, powder
// and metal: the solid volume). knobFor() inverts it, so a part weighs what its order says.
// ---------------------------------------------------------------------
export const SIZING = {
  'phone-case': { Hs: [10, 12, 14], ks: [1, 1.52, 2.04, 2.56, 3.08, 3.6], V: [[20.68, 23.72, 26.76, 29.68, 33.15, 35.16], [22.38, 25.63, 28.86, 31.91, 35.68, 38.13], [24.08, 27.54, 30.96, 34.15, 38.21, 41.07]] },
  'cookie-cutter': { Hs: [12, 16, 20], ks: [0.8, 1.48, 2.16, 2.84, 3.52, 4.2], V: [[4.03, 4.75, 5.36, 6.08, 7.12, 8.16], [5.04, 5.91, 6.7, 7.69, 9.13, 10.57], [6.05, 7.08, 8.05, 9.3, 11.14, 12.98]] },
  'plant-pot': { Hs: [110, 125, 140], ks: [0.9, 2.32, 3.74, 5.16, 6.58, 8], V: [[48.86, 56.79, 65.88, 76.04, 85.73, 95], [54.65, 63.86, 74.19, 85.74, 96.77, 107.31], [60.69, 70.92, 82.48, 95.42, 107.81, 119.61]] },
  'wall-hook': { Hs: [30, 40, 50], ks: [3, 4, 5, 6, 7, 8], V: [[6.61, 8.62, 10.9, 13.42, 16.11, 18.99], [8.24, 10.66, 13.32, 16.27, 19.36, 22.75], [10.15, 13.18, 16.51, 20.09, 23.99, 28.08]] },
  'articulated-toy': { Hs: [20, 40, 60], ks: [0.55, 0.7, 0.85, 1, 1.15, 1.3], V: [[13.31, 16.66, 20.19, 23.81, 27.5, 31.24], [31.89, 39.71, 47.88, 56.15, 64.49, 72.91], [52.64, 65.51, 78.91, 92.45, 106.09, 119.81]] },
  'rc-car-body': { Hs: [70, 85, 100], ks: [2.5, 4, 5.5, 7, 8.5, 10], V: [[93.74, 127.47, 165.81, 202.38, 237.3, 274.24], [112.28, 152.07, 197.94, 241.89, 283.85, 328.23], [130.8, 176.83, 230.3, 281.56, 330.53, 382.66]] },
  'drone-frame': { Hs: [20, 27.5, 35], ks: [3, 4.8, 6.6, 8.4, 10.2, 12], V: [[26.55, 40.36, 56.71, 74.04, 92.71, 112.21], [27.92, 41.73, 57.57, 75.4, 93.57, 113.58], [28.25, 42.06, 58.41, 75.73, 94.4, 113.9]] },
  'decorative-vase': { Hs: [180, 210, 240], ks: [1.6, 4.08, 6.56, 9.04, 11.52, 14], V: [[102.51, 142.02, 192.81, 240.08, 283.64, 323.76], [118.87, 165.04, 224.4, 279.48, 330.46, 377.33], [135.44, 188.04, 255.85, 318.96, 377.23, 430.84]] },
  'lithophane-lamp': { Hs: [130, 150, 170], ks: [1.4, 2.32, 3.24, 4.16, 5.08, 6], V: [[43.52, 49.39, 57.07, 64.76, 72.58, 80.54], [49.42, 56.3, 65.26, 74.32, 83.49, 92.81], [55.29, 63.2, 73.46, 83.86, 94.38, 105.05]] },
  'cosplay-accessory': { Hs: [80, 110, 140], ks: [3, 5.4, 7.8, 10.2, 12.6, 15], V: [[53.6, 76.3, 99.68, 122.64, 146.13, 169.19], [71.48, 103.32, 136.18, 168.39, 201.3, 233.66], [89.36, 130.38, 172.65, 214.16, 256.57, 298.27]] },
  'miniature-batch': { Hs: [35, 47.5, 60], ks: [0.6, 0.78, 0.96, 1.14, 1.32, 1.5], V: [[14.88, 17.93, 21.95, 26.96, 33.03, 40.18], [26.36, 36.18, 49.06, 65.14, 84.58, 107.56], [52.34, 75.03, 104.77, 141.98, 186.95, 240.09]] },
  'custom-grip-batch': { Hs: [15, 22.5, 30], ks: [13, 15.4, 17.8, 20.2, 22.6, 25], V: [[231.98, 325.2, 434.19, 558.93, 699.42, 855.57], [308.75, 432.61, 577.42, 743.11, 929.73, 1137.15], [387.83, 543, 724.41, 931.92, 1165.6, 1425.28]] },
  'jewelry-casting': { Hs: [20, 30, 40], ks: [0.8, 1.1, 1.4, 1.7, 2, 2.3], V: [[1.85, 2.82, 4.08, 5.6, 7.32, 9.18], [2.18, 3.34, 4.9, 6.84, 9.11, 11.66], [2.38, 3.61, 5.27, 7.38, 9.89, 12.75]] },
  'functional-gear': { Hs: [10, 20, 30], ks: [0.7, 0.768, 0.836, 0.904, 0.972, 1.04], V: [[22.06, 26.42, 31.17, 36.36, 41.92, 47.89], [43.39, 51.93, 61.22, 71.36, 82.24, 93.92], [64.72, 77.42, 91.27, 106.36, 122.57, 139.95]] },
  'robot-enclosure': { Hs: [180, 200, 220], ks: [1, 2.2, 3.4, 4.6, 5.8, 7], V: [[273.39, 297.31, 333.9, 385.47, 431.32, 484.82], [299.75, 326.85, 367.46, 426.97, 475.61, 533.22], [318.34, 347.7, 389.12, 450.38, 510.96, 580.21]] },
  'cosplay-helmet': { Hs: [240, 260, 280], ks: [3, 5.6, 8.2, 10.8, 13.4, 16], V: [[297.31, 407.88, 523.28, 636.01, 745.92, 852.06], [321.61, 440.68, 565.38, 687.02, 805.46, 918.96], [346.15, 474.05, 607.93, 738.14, 865, 987.7]] },
  'drone-propeller': { Hs: [10, 20, 30], ks: [1, 1.84, 2.68, 3.52, 4.36, 5.2], V: [[67.75, 102.32, 144.68, 193.63, 247.44, 304.91], [83.61, 117.84, 161.73, 214.57, 276.31, 346.03], [100.3, 133.85, 176.31, 227.83, 290.06, 361.7]] },
  'engineering-fixture': { Hs: [80, 100, 120], ks: [3, 7.2, 11.4, 15.6, 19.8, 24], V: [[135.27, 162.52, 189.77, 217.2, 244.61, 271.86], [154.69, 182.02, 209.35, 236.69, 264.02, 291.35], [174.94, 202.33, 229.73, 257.19, 284.53, 311.96]] },
  'end-use-bracket': { Hs: [40, 55, 70], ks: [1.5, 4, 6.5, 9, 11.5, 14], V: [[58.96, 69.56, 82.38, 94.78, 106.5, 117.4], [67.7, 80.09, 96.79, 111.98, 127.18, 141.21], [75.9, 91.19, 110.29, 129.06, 147.48, 164.55]] },
  'surgical-guide': { Hs: [30, 45, 60], ks: [1.2, 2.66, 4.12, 5.58, 7.04, 8.5], V: [[7.22, 13.21, 15.82, 17.72, 19.39, 21.11], [11.06, 20.79, 24.49, 26.89, 28.85, 30.88], [14.9, 28.36, 33.15, 36.06, 38.33, 40.66]] },
  'dental-crown-wax': { Hs: [10, 17.5, 25], ks: [0.65, 0.79, 0.93, 1.07, 1.21, 1.35], V: [[0.8, 1.24, 1.84, 2.6, 3.56, 4.45], [0.91, 1.36, 1.95, 2.71, 3.65, 4.52], [1.02, 1.46, 2.06, 2.81, 3.76, 4.63]] },
  'custom-orthotic': { Hs: [25, 32.5, 40], ks: [2.5, 4.2, 5.9, 7.6, 9.3, 11], V: [[69.3, 88.89, 108.43, 127.98, 147.56, 167.1], [81.47, 101.04, 120.59, 140.16, 159.73, 179.27], [93.64, 113.19, 132.77, 152.31, 171.89, 191.44]] },
  'sls-production-batch': { Hs: [180, 230, 280], ks: [0.8, 0.96, 1.12, 1.28, 1.44, 1.6], V: [[530.46, 916.81, 1456.28, 2173.88, 3095.1, 4246.06], [530.7, 916.98, 1456.27, 2174, 3095.59, 4246.06], [530.43, 916.85, 1455.95, 2174.07, 3093.44, 4245.68]] },
  'mjf-connector-batch': { Hs: [300, 340, 380], ks: [1, 1.24, 1.48, 1.72, 1.96, 2.2], V: [[999.13, 1905.18, 3239.67, 5088.48, 7528.85, 10650.41], [999.03, 1905.25, 3240.26, 5088.59, 7528.85, 10650.41], [998.95, 1905.17, 3239.49, 5088.66, 7529.31, 10650.41]] },
  'biocompatible-device': { Hs: [30, 45, 60], ks: [1.5, 2.5, 3.5, 4.5, 5.5, 6.5], V: [[17.72, 22.85, 28.45, 34.29, 40.28, 46.43], [26.84, 34.7, 43.26, 52.19, 61.35, 70.73], [35.96, 46.55, 58.07, 70.08, 82.4, 95.02]] },
  'aerospace-bracket': { Hs: [110, 130, 150], ks: [0.8, 1.64, 2.48, 3.32, 4.16, 5], V: [[37.16, 44.75, 54.73, 67.13, 81.66, 98.56], [37.18, 45.32, 56.16, 69.55, 85.59, 104.19], [37.32, 45.97, 57.59, 72.2, 89.8, 110.19]] },
  'engine-cooling-channel': { Hs: [240, 280, 320], ks: [1, 1.7, 2.4, 3.1, 3.8, 4.5], V: [[62.45, 84.7, 105.89, 125.97, 144.88, 162.71], [66.84, 92.03, 116.04, 138.74, 160.25, 180.5], [71.25, 99.38, 126.12, 151.56, 175.62, 198.31]] },
  'tooling-die': { Hs: [180, 215, 250], ks: [7, 9, 11, 13, 15, 17], V: [[85, 104.56, 129.01, 158.35, 192.58, 231.65], [90.58, 114.61, 144.67, 180.72, 222.8, 270.81], [96.2, 124.72, 160.37, 203.14, 253.06, 310.02]] },
  'heat-exchanger': { Hs: [240, 280, 320], ks: [0.4, 0.72, 1.04, 1.36, 1.68, 2], V: [[139.57, 172.31, 203.01, 233.7, 264.41, 295.11], [159.61, 198.08, 234.14, 270.2, 306.27, 342.33], [179.66, 223.84, 265.27, 306.69, 348.13, 389.55]] },
  'surgical-implant': { Hs: [60, 90, 120], ks: [1.8, 2.64, 3.48, 4.32, 5.16, 6], V: [[7.64, 11.27, 14.93, 18.62, 22.34, 26.1], [11.47, 16.91, 22.41, 27.95, 33.53, 39.16], [15.33, 22.6, 29.94, 37.34, 44.8, 52.33]] },
};

// ---------------------------------------------------------------------
// Specs
// ---------------------------------------------------------------------
export function techKind(tech) {
  return { FDM: 'fdm', FFF: 'fdm', ADAM: 'fdm', MSLA: 'resin', SLA: 'resin', SLS: 'powder', MJF: 'powder', DMLS: 'metal' }[tech] || 'fdm';
}
// Layer height and line width: extrusion follows its nozzle, everything else its technology.
export function slicerFor(tech, nozzleMM = 0.4) {
  const kind = techKind(tech);
  if (kind === 'fdm') {
    const n = nozzleMM || 0.4;
    return { kind, layerH: +(n * 0.5).toFixed(3), lineW: +(n * 1.125).toFixed(3), nozzle: n };
  }
  const layerH = { MSLA: 0.05, SLA: 0.05, SLS: 0.11, MJF: 0.08, DMLS: 0.04 }[tech] || 0.1;
  return { kind, layerH, lineW: kind === 'metal' ? 0.1 : kind === 'powder' ? 0.3 : 0.05, nozzle: 0 };
}

const mid = (r, d) => (Array.isArray(r) ? (r[0] + r[1]) / 2 : r ?? d);
// Printed volume at height H and knob k from a SIZING entry (linear in H between rows, in k
// between columns; proportional to H outside the measured heights).
export function sizedVolume(s, H, k) {
  const row = (i) => {
    const ks = s.ks, V = s.V[i];
    if (k <= ks[0]) return V[0] + (V[1] - V[0]) * (k - ks[0]) / (ks[1] - ks[0]);
    for (let j = 1; j < ks.length; j++) if (k <= ks[j]) return V[j - 1] + (V[j] - V[j - 1]) * (k - ks[j - 1]) / (ks[j] - ks[j - 1]);
    const n = ks.length - 1;
    return V[n] + (V[n] - V[n - 1]) * (k - ks[n]) / (ks[n] - ks[n - 1]);
  };
  const Hs = s.Hs;
  if (H <= Hs[0]) return row(0) * H / Hs[0];
  if (H >= Hs[Hs.length - 1]) return row(Hs.length - 1) * H / Hs[Hs.length - 1];
  for (let i = 1; i < Hs.length; i++) if (H <= Hs[i]) { const f = (H - Hs[i - 1]) / (Hs[i] - Hs[i - 1]); return row(i - 1) * (1 - f) + row(i) * f; }
  return row(0);
}
// The knob that prints `volume` cm³ at height H (the table rises with k).
export function knobFor(def, s, H, volume) {
  if (!s) return mid(def.knob);
  let lo = def.knob[0], hi = def.knob[1];
  if (sizedVolume(s, H, lo) >= volume) return lo;
  if (sizedVolume(s, H, hi) <= volume) return hi;
  for (let i = 0; i < 40; i++) { const m = (lo + hi) / 2; if (sizedVolume(s, H, m) < volume) lo = m; else hi = m; }
  return (lo + hi) / 2;
}

// One order's part. opts: { product, heightMM, grams, density (g/cm³), bedMM, tech, nozzleMM, k }.
export function partSpec(productId, opts = {}) {
  const def = PRODUCTS[productId];
  if (!def) return null;
  const product = opts.product || null;
  const H = clamp(opts.heightMM || mid(product && product.heightMM, 50), 4, 600);
  const grams = opts.grams || mid(product && product.grams, 50);
  const density = opts.density || 1.2;
  const k = opts.k ?? knobFor(def, SIZING[productId], H, grams / density);
  const built = def.build({ H, k });
  const bed = opts.bedMM || [256, 256, 256];
  const placed = built.arrange(bed[0], bed[1]);
  const units = { ...built.units, ...(placed.units || {}) };
  const sl = opts.slicer || slicerFor(opts.tech || 'FDM', opts.nozzleMM || 0.4);
  const plates = placed.plates;
  // Each plate is centred on the bed, then measured (for framing and the bed check) along with the
  // height actually printed.
  const boxOf = (it) => {
    const [ux0, uy0, ux1, uy1] = units[it.unit].bounds;
    let b = [Infinity, Infinity, -Infinity, -Infinity];
    for (const [px, py] of [[ux0, uy0], [ux1, uy0], [ux1, uy1], [ux0, uy1]]) {
      const qx = it.mirror ? -px : px;
      const wx = it.x + qx * cos(it.a) - py * sin(it.a), wy = it.y + qx * sin(it.a) + py * cos(it.a);
      b = [min(b[0], wx), min(b[1], wy), max(b[2], wx), max(b[3], wy)];
    }
    return b;
  };
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, top = 0;
  for (const items of plates) {
    let b = [Infinity, Infinity, -Infinity, -Infinity];
    for (const it of items) { const q = boxOf(it); b = [min(b[0], q[0]), min(b[1], q[1]), max(b[2], q[2]), max(b[3], q[3])]; }
    const dx = -(b[0] + b[2]) / 2, dy = -(b[1] + b[3]) / 2;
    for (const it of items) { it.x += dx; it.y += dy; top = max(top, it.z0 + units[it.unit].H); }
    x0 = min(x0, b[0] + dx); x1 = max(x1, b[2] + dx); y0 = min(y0, b[1] + dy); y1 = max(y1, b[3] + dy);
  }
  return {
    productId, H: top, orderH: H, k, grams, density, units, plates, infill: def.infill ?? 0.15, cell: def.cell || 0.5,
    kind: sl.kind, layerH: sl.layerH, lineW: sl.lineW, nozzle: sl.nozzle, bounds: [x0, y0, x1, y1], bed: bed.slice(),
  };
}

// Layers a plate of this spec prints.
export function layerCount(spec) { return Math.max(1, Math.round(spec.H / spec.layerH)); }

// An item's box on the plate (its unit's bounds, turned and moved).
export function itemBox(spec, it) {
  const [ux0, uy0, ux1, uy1] = spec.units[it.unit].bounds;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [px, py] of [[ux0, uy0], [ux1, uy0], [ux1, uy1], [ux0, uy1]]) {
    const qx = it.mirror ? -px : px;
    const wx = it.x + qx * cos(it.a) - py * sin(it.a), wy = it.y + qx * sin(it.a) + py * cos(it.a);
    x0 = min(x0, wx); x1 = max(x1, wx); y0 = min(y0, wy); y1 = max(y1, wy);
  }
  return [x0, y0, x1, y1];
}
// The items printing at height z, grouped where their boxes overlap (a raft under its minis):
// [{ items, box }]. Separate items are sliced on their own; a group is sliced as one union.
export function activeGroups(spec, plateIdx, z) {
  const items = (spec.plates[plateIdx] || []).filter((it) => z >= it.z0 && z <= it.z0 + spec.units[it.unit].H);
  const boxes = items.map((it) => itemBox(spec, it));
  const parent = items.map((_, i) => i);
  const find = (i) => { while (parent[i] !== i) i = parent[i] = parent[parent[i]]; return i; };
  for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length; j++) {
    const a = boxes[i], b = boxes[j];
    if (a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3]) parent[find(i)] = find(j);
  }
  const groups = new Map();
  items.forEach((it, i) => {
    const r = find(i);
    if (!groups.has(r)) groups.set(r, { items: [], box: [Infinity, Infinity, -Infinity, -Infinity] });
    const g = groups.get(r), b = boxes[i];
    g.items.push(it);
    g.box = [min(g.box[0], b[0]), min(g.box[1], b[1]), max(g.box[2], b[2]), max(g.box[3], b[3])];
  });
  return [...groups.values()];
}
// The union field of a group at height z, in plate coordinates.
export function groupField(spec, group, z) {
  const parts = group.items.map((it) => ({ it, f: spec.units[it.unit].at(z - it.z0), box: itemBox(spec, it) }));
  if (parts.length === 1 && !parts[0].it.a && !parts[0].it.mirror) {
    const { it, f } = parts[0];
    return (x, y) => f(x - it.x, y - it.y);
  }
  return (x, y) => {
    let d = 1e9;
    for (const p of parts) {
      const b = p.box;
      if (x < b[0] || x > b[2] || y < b[1] || y > b[3]) continue;
      const [ux, uy] = toUnit(p.it, x, y);
      const v = p.f(ux, uy);
      if (v < d) d = v;
    }
    return d;
  };
}

// Contours of every unit on a plate at height z, at each iso level (mm; negative = inset), in plate
// coordinates: { [iso]: loops }. A unit on its own is sliced once per local height and then placed,
// so a batch of identical parts costs one slice; overlapping units are sliced as their union.
export function plateContours(spec, plateIdx, z, isos = [0], opts = {}) {
  const cell = opts.cell || spec.cell;
  const cache = opts.cache || new Map();
  const tol = opts.simplify ?? 0.05;
  const out = {};
  for (const iso of isos) out[iso] = [];
  for (const g of activeGroups(spec, plateIdx, z)) {
    if (g.items.length === 1) {
      const it = g.items[0], u = spec.units[it.unit], zl = z - it.z0;
      const key = it.unit + '|' + zl.toFixed(4) + '|' + cell + '|' + isos.join(',');
      let per = cache.get(key);
      if (!per) {
        const grid = sampleGrid(u.at(zl), u.bounds, cell);
        per = {};
        for (const iso of isos) per[iso] = contours(grid, iso, tol);
        cache.set(key, per);
      }
      for (const iso of isos) for (const l of per[iso]) out[iso].push(placeLoop(l, it.x, it.y, it.a, it.mirror));
    } else {
      const grid = sampleGrid(groupField(spec, g, z), g.box, cell);
      for (const iso of isos) for (const l of contours(grid, iso, tol)) out[iso].push(l);
    }
  }
  return out;
}

// Solid volume of a spec in cm³ (resin, powder and metal parts print solid): the cross-section's
// area integrated up the part, sampled `layers` times and bisected wherever the area jumps or
// bends, so thin plates and bosses are found rather than missed between samples.
export function solidVolume(spec, layers = 24, cell) {
  let vol = 0;
  const cache = new Map();
  const c = cell || spec.cell;
  for (let p = 0; p < spec.plates.length; p++) {
    const memo = new Map();
    const A = (z) => {
      const key = +z.toFixed(5);
      let a = memo.get(key);
      if (a === undefined) {
        a = 0;
        for (const l of plateContours(spec, p, key, [0], { cell: c, cache })[0]) a += area(l);
        memo.set(key, a);
      }
      return a;
    };
    const H = spec.H, step = H / layers, minDz = Math.max(0.1, H / 400);
    const zs = Array.from({ length: layers + 1 }, (_, i) => Math.min(H - 1e-4, Math.max(1e-4, i * step)));
    let scale = 0;
    for (const z of zs) scale = max(scale, A(z));
    const eps = 0.01 * scale;
    const integ = (a, b, fa, fb) => {
      const m = (a + b) / 2, fm = A(m);
      if (b - a <= minDz || (abs(fa - fb) <= eps && abs(fm - (fa + fb) / 2) <= eps)) return (b - a) * (fa + 2 * fm + fb) / 4;
      return integ(a, m, fa, fm) + integ(m, b, fm, fb);
    };
    for (let i = 0; i < layers; i++) vol += integ(zs[i], zs[i + 1], A(zs[i]), A(zs[i + 1]));
  }
  return vol / 1000;
}
