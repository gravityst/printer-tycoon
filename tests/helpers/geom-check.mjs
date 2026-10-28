// Checks that a set of contour loops is a valid cross-section: every loop closed (at least three
// distinct points, non-zero area), simple (no edge crosses another edge of any loop), and wound
// consistently with its nesting (outer boundaries counter-clockwise, holes clockwise).
import { area, pointInLoop } from '../../docs/shapes.js';

const orient = (ax, ay, bx, by, cx, cy) => (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);

function segsCross(ax, ay, bx, by, cx, cy, dx, dy) {
  const d1 = orient(cx, cy, dx, dy, ax, ay), d2 = orient(cx, cy, dx, dy, bx, by);
  const d3 = orient(ax, ay, bx, by, cx, cy), d4 = orient(ax, ay, bx, by, dx, dy);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return true;
  return false;
}

export function checkLoops(loops) {
  const problems = [];
  // Closed: at least three points, no repeated consecutive point, some area.
  loops.forEach((l, li) => {
    const n = l.length / 2;
    if (n < 3) problems.push(`loop ${li}: only ${n} points`);
    for (let i = 0, j = n - 1; i < n; j = i++) {
      if (l[i * 2] === l[j * 2] && l[i * 2 + 1] === l[j * 2 + 1]) { problems.push(`loop ${li}: repeated point ${i}`); break; }
    }
    if (!(Math.abs(area(l)) > 0)) problems.push(`loop ${li}: no area`);
  });
  // Simple: bucket every edge, test pairs that share a bucket.
  const segs = [];
  loops.forEach((l, li) => {
    const n = l.length / 2;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      segs.push({ li, i, n, ax: l[i * 2], ay: l[i * 2 + 1], bx: l[j * 2], by: l[j * 2 + 1] });
    }
  });
  if (segs.length) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, totalLen = 0;
    for (const s of segs) {
      x0 = Math.min(x0, s.ax, s.bx); x1 = Math.max(x1, s.ax, s.bx); y0 = Math.min(y0, s.ay, s.by); y1 = Math.max(y1, s.ay, s.by);
      totalLen += Math.hypot(s.bx - s.ax, s.by - s.ay);
    }
    const cs = Math.max(1e-3, (totalLen / segs.length) * 2);
    const nx = Math.max(1, Math.ceil((x1 - x0) / cs) + 1);
    const buckets = new Map();
    segs.forEach((s, si) => {
      const i0 = Math.floor((Math.min(s.ax, s.bx) - x0) / cs), i1 = Math.floor((Math.max(s.ax, s.bx) - x0) / cs);
      const j0 = Math.floor((Math.min(s.ay, s.by) - y0) / cs), j1 = Math.floor((Math.max(s.ay, s.by) - y0) / cs);
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
        const key = j * nx + i;
        let b = buckets.get(key);
        if (!b) buckets.set(key, (b = []));
        b.push(si);
      }
    });
    const seenPair = new Set();
    for (const b of buckets.values()) {
      for (let p = 0; p < b.length; p++) for (let q = p + 1; q < b.length; q++) {
        const s = segs[b[p]], t = segs[b[q]];
        if (s.li === t.li && (Math.abs(s.i - t.i) === 1 || Math.abs(s.i - t.i) === s.n - 1)) continue;   // neighbours share a point
        const key = b[p] < b[q] ? b[p] * 1e7 + b[q] : b[q] * 1e7 + b[p];
        if (seenPair.has(key)) continue;
        seenPair.add(key);
        if (segsCross(s.ax, s.ay, s.bx, s.by, t.ax, t.ay, t.bx, t.by)) {
          problems.push(`edges cross: loop ${s.li}#${s.i} and loop ${t.li}#${t.i} near (${s.ax.toFixed(2)}, ${s.ay.toFixed(2)})`);
          if (problems.length > 20) return { ok: false, problems };
        }
      }
    }
  }
  // Consistent winding: a loop inside an even number of others is an outer boundary (CCW).
  loops.forEach((l, li) => {
    let depth = 0;
    loops.forEach((m, mi) => { if (mi !== li && pointInLoop(m, l[0], l[1])) depth++; });
    const ccw = area(l) > 0;
    if ((depth % 2 === 0) !== ccw) problems.push(`loop ${li}: depth ${depth} but ${ccw ? 'counter-clockwise' : 'clockwise'}`);
  });
  return { ok: problems.length === 0, problems };
}
