// =====================================================================
// Print3D motion: how each class of machine moves, what its screen says, and the time-lapse that
// turns a quarter-second sim tick into something a player can watch.
//
// Pure ES module: no DOM, no THREE, no imports, no clock (callers pass the time in). Units are
// millimetres in bed coordinates (x right, y towards the back, z up; the bed's centre is 0, 0)
// and seconds of real time.
// =====================================================================

const { min, max, floor, round, sin, cos, sqrt, PI, abs } = Math;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const clamp01 = (v) => clamp(v, 0, 1);
const ease = (f) => 1 - (1 - clamp01(f)) * (1 - clamp01(f));
const smooth = (f) => { const x = clamp01(f); return x * x * (3 - 2 * x); };

// ---------------------------------------------------------------------
// Machine classes
// ---------------------------------------------------------------------
//   bedslinger  the bed slides in Y under a head that runs in X on a gantry that climbs in Z
//   cantilever  the same, with the X arm held from one column
//   corexy      the head runs in X and Y at the top; the bed drops in Z (zAxis 'gantry': the bed
//               stays put and the whole XY gantry climbs, Voron style)
//   idex        two heads on one X beam; the beam runs in Y, the bed drops in Z
//   vat         a build plate dips into a resin vat and climbs a layer at a time (prints hang upside down)
//   powder      a piston lowers the powder bed a layer at a time under a recoater and a laser or lamp
//   metal       bound-metal FFF (head XY, bed Z) with a wash station and a sintering furnace
export const KINEMATICS = ['bedslinger', 'cantilever', 'corexy', 'idex', 'vat', 'powder', 'metal'];
export const NOZZLE_KINDS = new Set(['bedslinger', 'cantilever', 'corexy', 'idex', 'metal']);

export function kinematicsOf(printer) {
  const k = printer && printer.kinematics;
  if (KINEMATICS.includes(k)) return k;
  const tech = printer && printer.tech;
  if (tech === 'MSLA' || tech === 'SLA') return 'vat';
  if (tech === 'SLS' || tech === 'MJF' || tech === 'DMLS') return 'powder';
  if (tech === 'ADAM') return 'metal';
  return printer && printer.enclosed ? 'corexy' : 'bedslinger';
}
// Which powder process a powder machine runs (the laser, the lamp, or a metal laser).
export function powderProcess(printer) {
  const t = printer && printer.tech;
  return t === 'MJF' ? 'mjf' : t === 'DMLS' ? 'dmls' : 'sls';
}

// Axis offsets (mm, from each axis' home) that put the nozzle tip at `tip` (bed coordinates; z is
// the height of the tip above the bed's surface). Every class moves only its own axes:
//   bedslinger/cantilever: headX, bedY, gantryZ   corexy/idex/metal: headX, headY, bedZ (or gantryZ)
export function poseFor(kin, tip, opts = {}) {
  const x = tip.x || 0, y = tip.y || 0, z = tip.z || 0;
  const pose = { headX: 0, headY: 0, bedY: 0, bedZ: 0, gantryZ: 0, plateZ: 0, pistonZ: 0, head2X: 0 };
  switch (kin) {
    case 'bedslinger':
    case 'cantilever':
      pose.headX = x; pose.bedY = -y; pose.gantryZ = z;
      break;
    case 'corexy':
    case 'idex':
    case 'metal':
      pose.headX = x; pose.headY = y;
      if (opts.zAxis === 'gantry') pose.gantryZ = z; else pose.bedZ = -z;
      break;
    case 'vat':
      pose.plateZ = z;
      break;
    case 'powder':
      pose.pistonZ = -z;
      break;
  }
  return pose;
}
// Where a pose leaves the nozzle tip, in bed coordinates (the inverse of poseFor for the nozzle
// classes): what the rig checks against the toolpath.
export function tipInBed(kin, pose, opts = {}) {
  switch (kin) {
    case 'bedslinger':
    case 'cantilever':
      return { x: pose.headX, y: -pose.bedY, z: pose.gantryZ };
    case 'corexy':
    case 'idex':
    case 'metal':
      return { x: pose.headX, y: pose.headY, z: opts.zAxis === 'gantry' ? pose.gantryZ : -pose.bedZ };
    default:
      return { x: 0, y: 0, z: pose.plateZ || -pose.pistonZ || 0 };
  }
}
// Where the head waits when it isn't printing: the back left, clear of the part; bed-slingers
// bring the bed forward to show the print off.
export function parkTip(kin, bed, partTop = 0) {
  const [bx, by] = bed;
  const z = partTop + 12;
  if (kin === 'bedslinger' || kin === 'cantilever') return { x: -bx / 2 + 6, y: by / 2 - 6, z };
  return { x: -bx / 2 + 6, y: by / 2 - 6, z };
}

// ---------------------------------------------------------------------
// Temperatures and the start of a print
// ---------------------------------------------------------------------
const mid = (r, d) => (Array.isArray(r) && r.length ? (r[0] + r[1]) / 2 : d);
export const AMBIENT_C = 24;
// Targets for a material: FDM nozzle and bed; powder machines heat the chamber; vats warm the resin.
export function targetsFor(kin, material) {
  if (NOZZLE_KINDS.has(kin)) {
    return { nozzle: round(mid(material && material.printTempC, 210) / 5) * 5, bed: round(mid(material && material.bedTempC, 60) / 5) * 5 };
  }
  if (kin === 'powder') {
    const metal = material && /^metal-/.test(material.id || '');
    return { chamber: metal ? 80 : material && /mjf/.test(material.id || '') ? 180 : 170 };
  }
  return { resin: 30 };
}
// Temperatures a fraction f of the way through heating: the nozzle overshoots nothing and the bed
// lags it (a bed warms slower than a hotend).
export function tempsAt(targets, f) {
  const out = {};
  if (targets.nozzle != null) out.nozzle = round(AMBIENT_C + (targets.nozzle - AMBIENT_C) * ease(f * 1.15));
  if (targets.bed != null) out.bed = round(AMBIENT_C + (targets.bed - AMBIENT_C) * ease(f));
  if (targets.chamber != null) out.chamber = round(AMBIENT_C + (targets.chamber - AMBIENT_C) * ease(f));
  if (targets.resin != null) out.resin = round(AMBIENT_C + (targets.resin - AMBIENT_C) * ease(f));
  return out;
}

// The start of a print plays in real time (the sim's few minutes of heating pass in a fraction of
// a second): heat, probe the bed (machines that level themselves), purge a line, then print. It
// takes up to 3.6 s, and never more than 12% of the job's own real-time length, so a quick job
// skips straight to printing.
export const START_MAX_S = 3.6;
export function startLength(jobRealSeconds) {
  const s = min(START_MAX_S, 0.12 * Math.max(0, jobRealSeconds || 0));
  return s < 1 ? 0 : s;
}
// Stage of the start sequence `t` seconds in: { stage: 'heat'|'probe'|'purge'|'print', f }.
export function startStage(t, length, opts = {}) {
  if (!(length > 0) || t >= length) return { stage: 'print', f: 1 };
  const nozzle = opts.nozzle !== false;
  const probe = nozzle && opts.autoLevel !== false;
  // Shares: heat 40%, probe 35%, purge 25% (heat takes the probe's share without auto-levelling).
  const parts = nozzle ? (probe ? [['heat', 0.4], ['probe', 0.35], ['purge', 0.25]] : [['heat', 0.75], ['purge', 0.25]]) : [['heat', 1]];
  let at = 0;
  const u = clamp01(t / length);
  for (const [stage, share] of parts) {
    if (u < at + share) return { stage, f: (u - at) / share };
    at += share;
  }
  return { stage: 'print', f: 1 };
}

// ---------------------------------------------------------------------
// What the machine's own screen says
// ---------------------------------------------------------------------
// Game hours as h:mm ("1:12").
export function hm(hours) {
  const m = Math.max(0, round((hours || 0) * 60));
  return `${floor(m / 60)}:${String(m % 60).padStart(2, '0')}`;
}
const FAIL_LCD = { spaghetti: 'Spaghetti!', detach: 'Part came loose', warp: 'Corners lifted', resin: 'Stuck to the film', powder: 'Recoat error', metal: 'Recoater bump' };
const FINISH_LCD = { wash: 'Washing', cure: 'Curing', cool: 'Cooling down', depowder: 'Depowdering', relief: 'Stress relief', sinter: 'Sintering' };
// A machine that watches its prints (camera, layer monitor) notices a failure a few minutes before
// it stops the job: its screen asks first.
const SUSPECT_LCD = { spaghetti: 'Spaghetti?', detach: 'Part moving?', warp: 'Corners lifting?', resin: 'Peel trouble?', powder: 'Recoat trouble?', metal: 'Recoat trouble?' };
// v: { kin, phase, stage (start sequence stage or null), stageF, targets, progress (0..1),
//      hoursLeft, layer, layers, failKind, suspect (a failure kind the machine has spotted while
//      still printing, or null), finishing ({id, hoursLeft} or null), model, damp,
//      probeIndex, probeCount, material (label), timer (hours) }
// Returns { title, line, tone ('ok'|'busy'|'warn'|'done'|'idle'), bar (0..1 or null) }: the
// title alone tells the state, so it reads without colour.
export function lcdText(v) {
  const pct = floor(clamp01(v.progress || 0) * 100);
  const phase = v.phase || 'idle';
  const t = v.targets || {};
  const temps = (f) => tempsAt(t, f);
  if (phase === 'idle' && v.finishing) {
    const name = FINISH_LCD[v.finishing.id] || 'Finishing';
    return { title: name, line: `${hm(v.finishing.hoursLeft)} left`, tone: 'busy', bar: null };
  }
  switch (phase) {
    case 'heating':
    case 'prep':
    case 'printing': {
      // The real-time start sequence, when one is playing, says what the machine is doing.
      const stage = v.stage && v.stage !== 'print' ? v.stage : null;
      if (stage === 'heat' || (!stage && (phase === 'heating' || phase === 'prep'))) {
        const f = stage === 'heat' ? v.stageF : (v.heatF ?? 0.5);
        const c = temps(f);
        if (t.nozzle != null) return { title: `Heating ${c.nozzle}/${t.nozzle} °C`, line: `Bed ${c.bed}/${t.bed} °C`, tone: 'busy', bar: clamp01(f) };
        if (t.chamber != null) return { title: `Heating ${c.chamber}/${t.chamber} °C`, line: 'Warming the chamber', tone: 'busy', bar: clamp01(f) };
        return { title: phase === 'prep' ? 'Getting ready' : 'Warming resin', line: `Resin ${c.resin}/${t.resin} °C`, tone: 'busy', bar: clamp01(f) };
      }
      if (stage === 'probe') return { title: 'Probing bed', line: `Point ${min(v.probeCount || 16, (v.probeIndex || 0) + 1)}/${v.probeCount || 16}`, tone: 'busy', bar: null };
      if (stage === 'purge') return { title: 'Purging', line: v.material ? `Priming ${v.material}` : 'Priming the nozzle', tone: 'busy', bar: null };
      if (v.suspect) return { title: SUSPECT_LCD[v.suspect] || 'Checking the print', line: 'Checking the print…', tone: 'warn', bar: clamp01(v.progress || 0) };
      const line = v.damp ? 'Damp spool: stringy' : v.layers ? `Layer ${min(v.layers, (v.layer || 0) + 1)}/${v.layers}` : '';
      return { title: `Printing ${pct}% · ${hm(v.hoursLeft)} left`, line, tone: v.damp ? 'warn' : 'ok', bar: clamp01(v.progress || 0) };
    }
    case 'done': return { title: 'Done', line: v.kin === 'powder' || v.kin === 'vat' || v.kin === 'metal' ? 'Collect for finishing' : 'Take the part off', tone: 'done', bar: 1 };
    case 'clogged': return { title: 'Clog: cold pull', line: `Stopped at ${pct}%`, tone: 'warn', bar: null };
    case 'coldpull': return { title: 'Cold pull', line: `Nozzle ${round(90 + 40 * clamp01(v.stageF ?? 0.5))} °C`, tone: 'busy', bar: null };
    case 'failed': return { title: FAIL_LCD[v.failKind] || 'Print stopped', line: 'Reprint or release', tone: 'warn', bar: null };
    case 'cleaning': return { title: 'Cleaning bed', line: 'Wipe and level', tone: 'busy', bar: null };
    default:
      if (v.bedDirty) return { title: 'Bed needs a clean', line: v.model || '', tone: 'idle', bar: null };
      if (v.nozzleWorn) return { title: 'Ready', line: 'Nozzle worn', tone: 'idle', bar: null };
      return { title: 'Ready', line: v.model || '', tone: 'idle', bar: null };
  }
}

// ---------------------------------------------------------------------
// The time-lapse: one layer traced at a readable speed, then a jump to where the print really is
// ---------------------------------------------------------------------
// Readable head speed while tracing (travels are three times faster, as in the toolpath timeline).
export const TRACE_MM_S = 260;
// Seconds to trace a layer whose timeline length is `len` (toolpath.timeline total, mm), by class.
export function traceSeconds(kin, len) {
  if (kin === 'vat') return 1.8;
  if (kin === 'powder') return 2.2;
  return clamp((len || 0) / TRACE_MM_S, 1.1, 2.6);
}
// The layer a print is really on.
export function layerOf(progress, layers) {
  if (!(layers > 0)) return 0;
  return clamp(floor(clamp01(progress) * layers), 0, layers - 1);
}
// A view's time-lapse: the layer shown and when its trace began.
export function createLapse() { return { layer: -1, t0: 0, dur: 0 }; }
// Whether the shown layer has been traced (or nothing is shown yet).
export function lapseDone(lapse, now) { return lapse.layer < 0 || now - lapse.t0 >= lapse.dur; }
// Move to a newly sliced layer once the current trace is done. Layers only go up (a print never
// unprints); a reprint starts a new lapse. Returns true when it jumped.
export function lapseJump(lapse, now, layer, dur) {
  if (!lapseDone(lapse, now) || !(layer > lapse.layer)) return false;
  lapse.layer = layer; lapse.t0 = now; lapse.dur = dur;
  return true;
}
// How far through its trace the shown layer is.
export function lapseF(lapse, now) { return lapse.layer < 0 || !(lapse.dur > 0) ? 0 : clamp01((now - lapse.t0) / lapse.dur); }
// The layer to slice next: where the print will be once the current trace ends.
export function lapseWant(lapse, now, progress, layers, progressPerSecond) {
  const left = lapse.layer < 0 ? 0 : Math.max(0, lapse.t0 + lapse.dur - now);
  const p = clamp01(progress + Math.max(0, progressPerSecond || 0) * left);
  return Math.max(lapse.layer + 1, layerOf(p, layers));
}

// Resin peel cycle, a fraction f through one shown layer: the plate comes down to the film, the
// screen flashes UV, the plate peels up and waits. plateZ is mm above the film for the part's
// bottom (lift: how far it peels).
export function peelAt(f, layerZ, lift = 6) {
  const u = clamp01(f);
  if (u < 0.2) return { plateZ: layerZ + lift * (1 - smooth(u / 0.2)), uv: 0 };
  if (u < 0.55) return { plateZ: layerZ, uv: sin(PI * (u - 0.2) / 0.35) > 0 ? 1 : 0 };
  if (u < 0.85) return { plateZ: layerZ + lift * smooth((u - 0.55) / 0.3), uv: 0 };
  return { plateZ: layerZ + lift, uv: 0 };
}
// Powder cycle, a fraction f through one shown layer:
//   sls / dmls: the piston drops, the recoater sweeps fresh powder across, the laser scans
//   mjf: the carriage sweeps (recoating and jetting agent), then the fusing lamp passes
// recoater: 0..1 across the bed (null when parked), scan: 0..1 of the laser's path, agent: 0..1 of
// the jetted area, lamp: 0..1 across the bed (null when parked), drop: 0..1 of the layer drop.
export function powderAt(f, process) {
  const u = clamp01(f);
  if (process === 'mjf') {
    if (u < 0.5) return { drop: smooth(u / 0.1), recoater: smooth(u / 0.46), agent: smooth(u / 0.46), lamp: null, scan: 0 };
    return { drop: 1, recoater: null, agent: 1, lamp: smooth((u - 0.5) / 0.45), scan: 0 };
  }
  if (u < 0.32) return { drop: smooth(u / 0.08), recoater: smooth(u / 0.3), scan: 0, agent: 0, lamp: null };
  return { drop: 1, recoater: null, scan: smooth((u - 0.34) / 0.62), agent: 0, lamp: null };
}

// ---------------------------------------------------------------------
// Goofy failures: deterministic for a job, so a reload draws the same noodles
// ---------------------------------------------------------------------
export function rng(seed) {
  let a = (seed >>> 0) || 1;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
// A seed from a job's order id and start time.
export function seedOf(...parts) {
  let h = 2166136261;
  for (const p of parts) for (const ch of String(p)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
// A spaghetti nest: a curly 3D walk that falls from the nozzle and piles up around (cx, cy), on the
// bed or (opts.base) on whatever it lands on, such as the top of the part that went wrong.
// Returns [x, y, z, ...] mm for `count` points; the first k points of any longer nest are the
// same k points, so the nest grows by revealing more of one curve.
export const NEST_POINTS = 720;
export function spaghetti(seed, count = NEST_POINTS, opts = {}) {
  const r = rng(seed);
  const R = opts.radius || 26, Hn = opts.height || 18, from = opts.from || [0, 0, Hn * 1.6];
  const cx = opts.cx || 0, cy = opts.cy || 0, base = opts.base || 0;
  const n = Math.max(0, Math.min(count, NEST_POINTS));
  const out = new Float32Array(n * 3);
  let x = from[0], y = from[1], z = from[2];
  let th = r() * 2 * PI, ph = -0.6, curl = 0.35 + r() * 0.3;
  const step = opts.step || 1.6;
  for (let i = 0; i < n; i++) {
    // Curl: the heading turns steadily (loops), wobbling at random; the pile pulls it home.
    curl += (r() - 0.5) * 0.18; curl = clamp(curl, 0.18, 0.75);
    th += curl * (r() < 0.5 ? 1 : 1.25);
    ph += (r() - 0.5) * 0.5;
    const dx = cx - x, dy = cy - y;
    const d = sqrt(dx * dx + dy * dy);
    if (d > R * 0.6) th += 0.25 * Math.sign(Math.sin(Math.atan2(dy, dx) - th));
    // Falling: strands sag onto the growing pile; the pile is a dome over (cx, cy).
    const pile = base + Hn * Math.max(0, 1 - (d / R) ** 2) * (0.25 + 0.75 * (i / NEST_POINTS));
    ph = clamp(ph, -1.1, 0.6);
    x += cos(th) * cos(ph) * step;
    y += sin(th) * cos(ph) * step;
    z += sin(ph) * step - (z > pile + 2 ? 0.45 : 0);
    if (z < pile) { z = pile + r() * 0.8; ph = Math.abs(ph) * 0.5; }
    if (z < base + 0.4) z = base + 0.4;
    out[i * 3] = x; out[i * 3 + 1] = y; out[i * 3 + 2] = z;
  }
  return out;
}
// Strings from damp filament: thin sagging strands across the top of a part's outline box.
// Returns segments [x1, y1, z1, x2, y2, z2, ...] (each strand is three segments).
export function strings(seed, box, z, count = 7) {
  const r = rng(seed);
  const [x0, y0, x1, y1] = box;
  const out = [];
  for (let s = 0; s < count; s++) {
    const ax = x0 + (x1 - x0) * r(), ay = y0 + (y1 - y0) * r();
    const bx = x0 + (x1 - x0) * r(), by = y0 + (y1 - y0) * r();
    const len = sqrt((bx - ax) ** 2 + (by - ay) ** 2);
    const sag = Math.min(4, 0.12 * len) * (0.5 + r() * 0.5);
    let px = ax, py = ay, pz = z;
    for (let k = 1; k <= 3; k++) {
      const f = k / 3;
      const qx = ax + (bx - ax) * f, qy = ay + (by - ay) * f, qz = z + 0.4 - sag * 4 * f * (1 - f);
      out.push(px, py, pz, qx, qy, qz);
      px = qx; py = qy; pz = qz;
    }
  }
  return Float32Array.from(out);
}
// Popping specks from damp filament at time t (s) near the nozzle: [x, y, z, size, ...] mm.
export function specks(seed, t, count = 6) {
  const out = new Float32Array(count * 4);
  for (let i = 0; i < count; i++) {
    const r = rng(seed + i * 7919);
    const period = 0.5 + r() * 0.7, phase = r() * period;
    const life = ((t + phase) % period) / period;
    const k = floor((t + phase) / period);
    const rr = rng(seed + i * 104729 + k * 31);
    const a = rr() * 2 * PI, sp = 3 + rr() * 6;
    out[i * 4] = cos(a) * sp * life;
    out[i * 4 + 1] = sin(a) * sp * life;
    out[i * 4 + 2] = 1 + 5 * life - 6 * life * life;
    out[i * 4 + 3] = life < 0.75 ? 1 : (1 - life) * 4;
  }
  return out;
}
// Warp: how far the corners have curled, 0..1, a fraction of the way from the fault to its end.
export function warpAt(f) { return smooth(clamp01(f)); }
// A detached part's tilt (radians) and slide (mm), from the fault onward.
export function detachAt(f) { const u = smooth(clamp01(f * 3)); return { tilt: 0.42 * u, slide: 9 * u }; }

// ---------------------------------------------------------------------
// One job's visible progress at a moment
// ---------------------------------------------------------------------
// The printed fraction at game hour t into a job (the heating phase prints nothing).
export function printedAt(job, t) {
  if (!job) return 0;
  const heatH = job.phases && job.phases.length > 1 ? job.phases[0].h : 0;
  const printH = job.printHours ?? ((job.hoursTotal || 0) - heatH);
  return printH > 0 ? clamp01((t - heatH) / printH) : 1;
}
// Where a failing print visibly is at hour t: { grows (the part's printed fraction), fault (0..1
// of the way from the fault to when it stopped, or null before the fault) }.
export function failureAt(job, t) {
  const f = job && job.fail;
  const p = printedAt(job, t);
  if (!f || !(f.atT != null)) return { grows: p, fault: null };
  if (t < f.atT) return { grows: p, fault: null };
  const span = Math.max(1e-6, (f.stopT ?? f.atT) - f.atT);
  return { grows: clamp01(f.u ?? printedAt(job, f.atT)), fault: clamp01((t - f.atT) / span) };
}
