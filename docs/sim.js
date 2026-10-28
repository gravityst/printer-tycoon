// =====================================================================
// Print3D rules: orders, jobs, failures, moisture, power and money.
//
// Pure ES module: no DOM, no THREE, no Math.random. Every random draw comes from the save's own
// mulberry32 state (state.rng), so a save replays the same way and node tests are deterministic.
// Functions mutate the state they are given and return events; game.js turns events into toasts
// and log lines. Time is game hours. A random draw only happens at a moment (an order arriving,
// a job starting, midnight), never per tick, so the outcome never depends on tick size.
// =====================================================================

export const SIM_VERSION = 5;

export const KWH_PRICE = 0.17;            // USD per kWh, EIA US residential average (late 2025)
export const ORDER_SPAWN_BASE_HOURS = 45; // Curtis's order rate (branch speed-up-orders)
export const TIER_UNLOCK_REP = { garage: 0, hobbyist: 5, studio: 25, pro: 75, industrial: 150, endgame: 300 };
export const STARTING = { printer: 'ender-3-v3-se', money: 500, material: 'pla', grams: 1000, firstOrderHours: 5 };
export const GRACE_JOBS = 3;              // a new game's first jobs can't fail
export const LOG_LIMIT = 50;
export const DETECT_STOP_HOURS = 10 / 60; // a camera or monitor stops a failed print within 10 game minutes
export const BED_CLEAN_HOURS = 0.1;       // Clean & level bed: free, 6 game minutes
export const COLD_PULL_HOURS = 0.15;      // 9 game minutes
export const DRYER_W = 60;                // a desktop filament dryer's average draw (estimate)
export const DAMP_AT = 0.5;               // wetness at which a spool counts as damp
export const POWDER_PACKING = 0.15;       // packing density in Formlabs' Fuse cooldown test
const FAIL_SHAPE = Math.log(0.5) / Math.log(0.1); // failure point u ~ G(u) = u^0.301: half of failures in the first 10%
const WARP_K = 1.68;                      // calibrates an RC body in ABS on an open Prusa MK4S to ~50%
const BED_K = 1.0;
const NOZZLE_K = 0.6;
const DAMP_K = 0.12;
const EPS = 1e-9;

// ---------------------------------------------------------------------
// Nozzles. Size sets speed, detail and a little reliability; the metal sets how fast abrasive
// filament wears it and how well it conducts heat (hardened steel flows a little less).
// ---------------------------------------------------------------------
export const NOZZLE_TYPES = [
  { id: 'b02', size: 0.2, metal: 'brass',     cost: 25, label: '0.2 mm brass',          desc: 'Fine detail, slow' },
  { id: 'b04', size: 0.4, metal: 'brass',     cost: 5,  label: '0.4 mm brass',          desc: 'The everyday nozzle' },
  { id: 'b06', size: 0.6, metal: 'brass',     cost: 10, label: '0.6 mm brass',          desc: 'Faster, less detail' },
  { id: 'b08', size: 0.8, metal: 'brass',     cost: 18, label: '0.8 mm brass',          desc: 'Big parts, low detail' },
  { id: 's04', size: 0.4, metal: 'stainless', cost: 15, label: '0.4 mm stainless',      desc: 'Wears 3x slower than brass' },
  { id: 'h04', size: 0.4, metal: 'hardened',  cost: 20, label: '0.4 mm hardened steel', desc: 'Lasts for kilograms of carbon fiber' },
  { id: 'h06', size: 0.6, metal: 'hardened',  cost: 22, label: '0.6 mm hardened steel', desc: 'Fast and carbon-fiber proof' },
  { id: 'h08', size: 0.8, metal: 'hardened',  cost: 24, label: '0.8 mm hardened steel', desc: 'Big, fast, carbon-fiber proof' },
  { id: 'r04', size: 0.4, metal: 'ruby',      cost: 90, label: '0.4 mm ruby tip',       desc: 'Carbon-fiber proof and flows like brass' },
];
export const NOZZLE_EFFECTS = {
  0.2: { speed: 0.3,  precision: 1.18, reliability: 0.95 },
  0.4: { speed: 1.0,  precision: 1.0,  reliability: 1.0 },
  0.6: { speed: 1.55, precision: 0.88, reliability: 1.0 },
  0.8: { speed: 2.10, precision: 0.78, reliability: 0.92 },
};
// Wear per gram of abrasive filament (brass gone in ~333 g of PA-CF; E3D/CNC Kitchen saw 250-360 g).
export const NOZZLE_METALS = {
  brass:     { wearPerG: 0.003,   flow: 1.0 },
  stainless: { wearPerG: 0.001,   flow: 0.95 },
  hardened:  { wearPerG: 0.00004, flow: 0.9 },
  ruby:      { wearPerG: 0.00001, flow: 1.0 },
};

export const SERVICE_OPTIONS = [
  { id: 'tune',    label: 'Quick tune-up',  cost: 30,  reduceWear: 60,   desc: 'Bed level, belt tension, lube rails' },
  { id: 'service', label: 'Full service',   cost: 90,  reduceWear: 200,  desc: 'Replace PTFE, clean hot end, recalibrate' },
  { id: 'rebuild', label: 'Major overhaul', cost: 220, reduceWear: 9999, desc: 'Restore as-new wear; bearings, belts, PEI sheet' },
];

// Generic upgrades at game prices (no brands).
export const UPGRADES = [
  { id: 'enclosure', scope: 'printer', cost: 80,  name: 'Enclosure kit',       short: 'Stops ABS and nylon curling', desc: 'A warm box around an open-frame printer, so ABS, ASA and nylon corners stop curling.' },
  { id: 'camera',    scope: 'printer', cost: 45,  name: 'Print camera',        short: 'Stops a failed print early', desc: 'Spots spaghetti and stops the print within 10 minutes, so only the printed part is lost.' },
  { id: 'dryer',     scope: 'shop',    cost: 60,  name: 'Filament dryer',      short: 'Dries a damp spool', desc: 'Dries one spool at a time to its spec (TPU: 70 °C for 8 h). Billed as power.' },
  { id: 'drybox',    scope: 'shop',    cost: 35,  name: 'Dry box',             short: 'Spools stay dry 6x longer', desc: 'Sealed storage with desiccant: spools soak up water 6x slower.' },
  { id: 'washcure',  scope: 'shop',    cost: 160, name: 'Wash & cure station', short: 'Resin parts finish in 25 min', desc: 'Resin parts finish in 25 minutes instead of an hour by hand.' },
];

const NAMES = ['Mia', 'Leo', 'Ava', 'Noah', 'Zoe', 'Sam', 'Priya', 'Kai', 'Lena', 'Omar', 'Ivy', 'Theo', 'Nora', 'Ravi',
  'Lucy', 'Hugo', 'Elena', 'Yuki', 'Ben', 'Ada', 'Finn', 'June', 'Milo', 'Rosa', 'Tess', 'Arlo', 'Jade', 'Owen', 'Sana',
  'Luca', 'Maya', 'Eli', 'Felix', 'Amara', 'Jonah', 'Wren'];
const PLACE_FOR = { medical: 'clinic', aerospace: 'flight lab', tooling: 'tool shop', production: 'factory', engineering: 'lab', jewelry: 'jewelry studio' };

// Customer colours: the hexes of look.js's named filament palette, in the same order (look.js
// names them, and maps the 18 older hexes saves may still hold).
export const MODEL_PALETTE = [
  '#c62d2d', '#ee6a1f', '#f0a020', '#f2cf1d', '#86b83a', '#2f9a46', '#1a9b7a', '#138c8c', '#3fb3d2', '#4a9ad8',
  '#2a52be', '#3f3d9e', '#8a6cc9', '#7d3fa6', '#b8378e', '#ec79aa', '#efebe2', '#47494d', '#1d1e20', '#a7abb0',
];
export const FIXED_COLORS = {
  'dental-crown-wax': '#fef3c7', 'jewelry-casting': '#facc15', 'surgical-guide': '#fafafa', 'surgical-implant': '#cbd5e1',
  'aerospace-bracket': '#94a3b8', 'engine-cooling-channel': '#fde68a', 'tooling-die': '#475569', 'heat-exchanger': '#cbd5e1',
  'biocompatible-device': '#fafafa',
};

// ---------------------------------------------------------------------
// Seeded randomness (mulberry32). The state lives in the save as state.rng.
// ---------------------------------------------------------------------
export function rngNext(holder) {
  let a = (holder.rng >>> 0) || 1;
  a = (a + 0x6D2B79F5) >>> 0;
  let t = Math.imul(a ^ (a >>> 15), 1 | a);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  holder.rng = a;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
export function seedFrom(...nums) {
  let h = 0x811C9DC5;
  for (const n of nums) { h = Math.imul(h ^ (Math.floor(Math.abs(n)) >>> 0), 0x01000193) >>> 0; h ^= h >>> 13; }
  return (h >>> 0) || 1;
}

// ---------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------
export function makeCatalog(printersJson, materialsJson, productsJson) {
  const printers = printersJson.printers || printersJson;
  const materials = materialsJson.materials || materialsJson;
  const products = productsJson.products || productsJson;
  const pm = new Map(printers.map((p) => [p.id, p]));
  const mm = new Map(materials.map((m) => [m.id, m]));
  const prm = new Map(products.map((p) => [p.id, p]));
  const unknown = new Map();
  return {
    printers, materials, products,
    printer(id) {
      const p = pm.get(id);
      if (p) return p;
      if (!unknown.has(id)) unknown.set(id, unknownPrinter(id));
      return unknown.get(id);
    },
    printerKnown: (id) => pm.has(id),
    material: (id) => mm.get(id) || null,
    product: (id) => prm.get(id) || null,
  };
}
function unknownPrinter(id) {
  return { id, unknown: true, brand: '', model: 'Unknown machine', tech: 'UNKNOWN', tier: 'garage', price: 0,
    buildVolumeMM: [0, 0, 0], materials: [], enclosed: false, multiMaterialColors: 0, baseReliability: 0.9, precision: 0,
    powerW: 0, released: '', notes: 'This machine is no longer in the catalog. It can still be sold.' };
}

// ---------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------
const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const lerp = (range, r) => (Array.isArray(range) ? range[0] + r * (range[1] - range[0]) : range || 0);
const sumH = (list) => list.reduce((s, p) => s + p.h, 0);
export const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);
export const aAn = (s) => `${/^[aeiou]/i.test(s) ? 'an' : 'a'} ${s}`;

export function now(state) { return (state.day - 1) * 24 + state.hour; }
function setNow(state, t) {
  const d = Math.floor(t / 24 + 1e-12);
  state.day = d + 1;
  state.hour = Math.max(0, t - d * 24);
}

export function fmtMoney(n) {
  const a = Math.abs(n);
  const s = a >= 1e6 ? `$${(a / 1e6).toFixed(2)}M` : a >= 1e4 ? `$${(a / 1000).toFixed(1)}k` : `$${a.toFixed(2)}`;
  return n < 0 ? '-' + s : s;
}
export function fmtDuration(h) {
  if (!(h > 0)) return '0 m';
  const mins = Math.round(h * 60);
  if (mins < 1) return 'under a minute';
  if (mins < 60) return `${mins} m`;
  const hrs = Math.floor(mins / 60), m = mins % 60;
  if (hrs < 24) return m ? `${hrs} h ${m} m` : `${hrs} h`;
  const d = Math.floor(hrs / 24), hh = hrs % 24;
  return hh ? `${d} d ${hh} h` : `${d} d`;
}
export function fmtGrams(g) { return g >= 1000 ? `${(g / 1000).toFixed(g >= 10000 ? 0 : 1)} kg` : `${Math.max(1, Math.ceil(g))} g`; }

export function materialLabel(cat, id) { const m = cat.material(id); return m ? (m.label || m.name) : 'a material the shop no longer sells'; }
export function materialName(cat, id) { const m = cat.material(id); return m ? m.name : 'Unknown material'; }
export function printerName(cat, id) { return cat.printer(id).model; }
const possessive = (who) => (who ? `${who}'s` : "A customer's");
const article = (t) => (t === 'DMLS' ? 'a' : 'an');
function techNeedText(list) { return `Needs ${article(list[0])} ${list.join(' or ')} printer`; }

// ---------------------------------------------------------------------
// Technologies
// ---------------------------------------------------------------------
export function techClass(printer) {
  switch (printer && printer.tech) {
    case 'FDM': case 'FFF': case 'ADAM': return 'fdm';  // extrusion: a nozzle, timed by grams
    case 'MSLA': case 'SLA': return 'resin';            // vat: timed by height
    case 'SLS': case 'MJF': return 'powder';            // powder bed: timed by build height
    case 'DMLS': return 'metal';                        // metal powder bed: timed by build height
    default: return 'unknown';
  }
}
export const usesNozzle = (printer) => techClass(printer) === 'fdm';
export function hardwareLabel(printer) {
  return { MSLA: 'Resin vat · LCD light', SLA: 'Resin vat · laser', SLS: 'Laser · powder bed', MJF: 'Fusing lamps · powder bed', DMLS: 'Laser · metal powder bed' }[printer.tech] || '';
}
export function shipsOnCollect(printer) { return printer.tech === 'FDM' || printer.tech === 'FFF' || printer.unknown; }

export function nozzleType(id) { return NOZZLE_TYPES.find((n) => n.id === id) || null; }
export function v4NozzleId(size, hardened) {
  const code = { 0.2: '02', 0.4: '04', 0.6: '06', 0.8: '08' }[size] || '04';
  const id = (hardened ? 'h' : 'b') + code;
  return nozzleType(id) ? id : (hardened ? 'h04' : 'b04');
}
export function slotNozzle(slot) { return nozzleType(slot.nozzleType) || nozzleType(v4NozzleId(slot.nozzleSize, slot.nozzleHardened)); }
const hardenedMetal = (noz) => noz.metal === 'hardened' || noz.metal === 'ruby';
export const isAbrasive = (mat) => !!(mat && mat.needsHardenedNozzle);
export const isFiber = (mat) => !!(mat && mat.category === 'fiber');
const isHot = (mat) => !!(mat && mat.bedTempC && mat.bedTempC[1] >= 90);
const costPerKg = (mat) => (mat ? (mat.costPerKg ?? (mat.costPerLiter != null ? mat.costPerLiter / 1.1 : 0)) : 0);

export function hasShopUpgrade(state, id) { return (state.shopUpgrades || []).includes(id); }
export function hasUpgrade(slot, id) { return (slot.upgrades || []).includes(id); }
export function warmthOf(printer, slot) {
  if (printer.chamberC) return 0.9;
  if (printer.enclosed) return 0.6;
  return hasUpgrade(slot, 'enclosure') ? 0.55 : 0;
}
export function detects(printer, slot) {
  const tc = techClass(printer);
  if (tc === 'powder' || tc === 'metal') return true;            // industrial machines monitor every layer
  if (tc === 'fdm') return !!printer.failureDetection || hasUpgrade(slot, 'camera');
  return false;                                                  // a resin printer never knows
}
export function upgradeApplies(cat, slot, id) {
  const p = cat.printer(slot.printerId);
  if (p.unknown || techClass(p) !== 'fdm') return false;
  if (id === 'enclosure') return !p.enclosed;
  if (id === 'camera') return !p.failureDetection;
  return false;
}

export function effectivePrecision(printer, slot) {
  const p = printer.precision || 0;
  if (!usesNozzle(printer)) return p;
  return p * (NOZZLE_EFFECTS[slotNozzle(slot).size] || NOZZLE_EFFECTS[0.4]).precision;
}
function nozzleFlow(printer, slot, mat) {
  if (!usesNozzle(printer) || isFiber(mat)) return 1;
  const noz = slotNozzle(slot);
  return (NOZZLE_EFFECTS[noz.size] || NOZZLE_EFFECTS[0.4]).speed * (NOZZLE_METALS[noz.metal] || NOZZLE_METALS.brass).flow;
}
export function nozzleWearPerGram(slot, mat) {
  if (!isAbrasive(mat)) return 0;
  return (NOZZLE_METALS[slotNozzle(slot).metal] || NOZZLE_METALS.brass).wearPerG;
}
function nozzleHealthMid(slot, mat, grams) {
  return clamp01((slot.nozzleHealth ?? 1) - nozzleWearPerGram(slot, mat) * grams / 2);
}
export function powderFactor(printer, mat) {
  if (techClass(printer) !== 'powder' || !mat || !(mat.refreshRate > 0)) return 1;
  return Math.max(1, mat.refreshRate / POWDER_PACKING);
}
export function wetOf(state, matId) { return clamp01((state.wet || {})[matId] || 0); }
function warpiness(mat) { return mat ? Math.max(0, (mat.warpFactor || 0) - 0.1) / 0.9 : 0; }

// The part's box: footprint from the order, height as sampled (never below the order's minimum).
export function orderHeight(cat, order) {
  if (order.heightMM > 0) return order.heightMM;
  const p = cat.product(order.productId);
  if (p && p.heightMM) return (p.heightMM[0] + p.heightMM[1]) / 2;
  const bv = order.minBuildVolumeMM;
  return bv && bv[2] > 0 ? bv[2] : 50;
}
export function partBox(cat, order) {
  const bv = order.minBuildVolumeMM || [0, 0, 0];
  return [bv[0] || 0, bv[1] || 0, Math.max(bv[2] || 0, orderHeight(cat, order))];
}
// Height as built, or null if it doesn't fit. Extrusion and vat machines may turn a part on the
// plate; a powder bed can stand it any way up (so a 280 mm insole fits the Fuse's 300 mm height).
export function buildHeight(printer, box) {
  const [X, Y, Z] = printer.buildVolumeMM || [0, 0, 0];
  const [x, y, z] = box;
  const flat = (a, b) => (a <= X + EPS && b <= Y + EPS) || (b <= X + EPS && a <= Y + EPS);
  const tc = techClass(printer);
  if (tc === 'powder' || tc === 'metal') {
    let best = null;
    for (const [a, b, up] of [[x, y, z], [x, z, y], [y, z, x]]) {
      if (up <= Z + EPS && flat(a, b)) best = best === null ? up : Math.min(best, up);
    }
    return best;
  }
  return z <= Z + EPS && flat(x, y) ? z : null;
}

// ---------------------------------------------------------------------
// Can this printer take this order right now?
// ---------------------------------------------------------------------
const no = (code, reason, extra) => ({ ok: false, code, reason, ...extra });
export function busyText(slot) {
  return {
    heating: 'Busy heating up', prep: 'Busy getting ready', printing: 'Busy printing', done: 'Part waiting: collect it first',
    clogged: 'Clogged: do a cold pull', failed: 'Failed print: reprint or release it', cleaning: 'Cleaning the bed', coldpull: 'Doing a cold pull',
  }[slot.phase] || 'Busy';
}
function nozzleCheck(cat, printer, slot, materialId) {
  if (!usesNozzle(printer)) return { ok: true };
  const mat = cat.material(materialId);
  if (isAbrasive(mat) && !isFiber(mat) && slotNozzle(slot).size <= 0.2 + EPS) {
    return no('nozzle', `${cap(materialLabel(cat, materialId))} can't run on a 0.2 mm nozzle (fit 0.4 mm or bigger)`);
  }
  return { ok: true };
}
// Machine-level fit for one material, ignoring busy and stock (used by order spawning too).
function fitsMaterial(cat, printer, slot, order, m) {
  if (printer.unknown) return false;
  if (order.techRequired && order.techRequired.length && !order.techRequired.includes(printer.tech)) return false;
  if (!printer.materials.includes(m)) return false;
  if (order.minPrecision && effectivePrecision(printer, slot) + EPS < order.minPrecision) return false;
  if (buildHeight(printer, partBox(cat, order)) === null) return false;
  return nozzleCheck(cat, printer, slot, m).ok;
}
export function canAssign(cat, state, order, slot) {
  const printer = cat.printer(slot.printerId);
  if (printer.unknown) return no('unknown', 'Unknown machine: it can no longer take orders');
  if ((slot.phase || 'idle') !== 'idle') return no('busy', busyText(slot));
  if (order.techRequired && order.techRequired.length && !order.techRequired.includes(printer.tech)) return no('tech', techNeedText(order.techRequired));
  const opts = order.materialOptions && order.materialOptions.length ? order.materialOptions : [order.materialId];
  const supported = opts.filter((m) => printer.materials.includes(m));
  if (!supported.length) {
    return no('material', cat.material(opts[0]) ? `Can't run ${materialLabel(cat, opts[0])}` : 'Needs a material the shop no longer sells');
  }
  const prec = effectivePrecision(printer, slot);
  if (order.minPrecision && prec + EPS < order.minPrecision) {
    return no('precision', `Not precise enough (${prec.toFixed(2)} of ${order.minPrecision} needed)`);
  }
  if (buildHeight(printer, partBox(cat, order)) === null) return no('volume', 'Part is too big for this printer');
  const nozOK = supported.filter((m) => nozzleCheck(cat, printer, slot, m).ok);
  if (!nozOK.length) return nozzleCheck(cat, printer, slot, supported[0]);
  for (const m of nozOK) {   // v4 orders list several materials: take the first one in stock
    const need = (order.grams || 0) * powderFactor(printer, cat.material(m));
    if ((state.inventory[m] || 0) + 1e-6 >= need) return { ok: true, materialId: m, needGrams: need };
  }
  const m = nozOK[0];
  const need = (order.grams || 0) * powderFactor(printer, cat.material(m));
  return no('stock', `Needs ${fmtGrams(need - (state.inventory[m] || 0))} more ${materialLabel(cat, m)}`, { materialId: m, needGrams: need });
}
const REASON_SHORT = { busy: 'busy', tech: 'wrong type', material: "can't run it", precision: 'not precise enough', volume: 'too small', nozzle: 'nozzle too fine', unknown: 'unknown machine' };
export function shortReason(check) {
  if (!check || check.ok) return '';
  if (check.code === 'stock') return check.reason.replace(/^Needs /, 'needs ');
  return REASON_SHORT[check.code] || check.reason;
}
// Cheapest fix first: buy material < change nozzle < another machine.
export const REASON_PRIORITY = ['stock', 'nozzle', 'precision', 'volume', 'material', 'tech', 'unknown'];

// ---------------------------------------------------------------------
// How long, how much, what's left over
// ---------------------------------------------------------------------
function fdmHeatHours(printer, slot, mat) {
  const bed = mat && mat.bedTempC ? mat.bedTempC[1] : 60;
  let min = Math.max(1.5, (bed - 22) / 15);              // the bed warms ~15 C a minute; the nozzle heats alongside
  if (printer.autoLevel) min += 1.5;                     // probing the bed
  if (warmthOf(printer, slot) > 0 && isHot(mat)) min += printer.chamberC ? 12 : 8;   // let the chamber soak
  return min / 60;
}
export function qualityMult(qualityValue, quality) { const qv = qualityValue || 0; return 1 - qv + qv * quality; }
function expectedQuality(cat, state, printer, slot, mat, grams) {
  let q = Math.min(1, effectivePrecision(printer, slot));
  if (usesNozzle(printer) && mat && !isFiber(mat)) {
    q *= 1 - (mat.stringFactor || 0) * wetOf(state, mat.id);   // damp filament strings
    q *= 0.85 + 0.15 * nozzleHealthMid(slot, mat, grams);     // a worn nozzle prints rougher
  }
  return clamp01(q);
}
export function lateFactor(hoursLate) { return hoursLate <= EPS ? 1 : hoursLate <= 24 ? 0.75 : 0.5; }

export function estimateJob(cat, state, slot, order, materialId) {
  const printer = cat.printer(slot.printerId);
  const tc = techClass(printer);
  const matId = materialId || order.materialId || (order.materialOptions || [])[0];
  const mat = cat.material(matId);
  const grams = order.grams || 0;
  const height = buildHeight(printer, partBox(cat, order)) ?? partBox(cat, order)[2];
  const phases = [], finish = [];
  let printHours = 0;
  if (tc === 'fdm') {
    printHours = grams / ((printer.throughputGPH || 30) * nozzleFlow(printer, slot, mat) * ((mat && mat.speedFactor) || 1));
    phases.push({ id: 'heat', h: fdmHeatHours(printer, slot, mat) }, { id: 'print', h: printHours });
    if (printer.tech === 'ADAM') {   // Markforged: wash 12-72 h by part mass, then the furnace
      finish.push({ id: 'wash', h: 12 + 60 * clamp01(grams / 1500), w: 300 }, { id: 'sinter', h: 30, w: 3000 });
    }
  } else if (tc === 'resin') {
    printHours = height / ((printer.verticalMMPerHour || 20) * ((mat && mat.speedFactor) || 1));
    phases.push({ id: 'prep', h: printer.autoLevel ? 0.1 : 0.15 }, { id: 'print', h: printHours });
    const station = hasShopUpgrade(state, 'washcure');
    finish.push({ id: 'wash', h: station ? 10 / 60 : 0.4, w: station ? 40 : 0 }, { id: 'cure', h: station ? 15 / 60 : 0.6, w: station ? 60 : 0 });
  } else if (tc === 'powder' || tc === 'metal') {
    printHours = height / (printer.verticalMMPerHour || 10);
    phases.push({ id: 'heat', h: 1 }, { id: 'print', h: printHours });
    if (printer.tech === 'SLS') finish.push({ id: 'cool', h: 0.4 * printHours, w: 0 }, { id: 'depowder', h: 1, w: 200 });
    else if (printer.tech === 'MJF') finish.push({ id: 'cool', h: Math.min(30, 1.5 * printHours), w: 0 }, { id: 'depowder', h: 1.5, w: 1000 });
    else finish.push({ id: 'relief', h: 5, w: 4000 });   // DMLS stress relief in a furnace (estimate)
  }
  const usedGrams = grams * powderFactor(printer, mat);
  const matCost = usedGrams / 1000 * costPerKg(mat);
  const watts = tc === 'fdm' && isHot(mat) && printer.powerHotW ? printer.powerHotW : (printer.powerW || 0);
  const machineHours = sumH(phases), finishHours = sumH(finish);
  const kwh = watts * machineHours / 1000 + finish.reduce((s, f) => s + (f.w || 0) * f.h, 0) / 1000;
  const powerCost = kwh * KWH_PRICE;
  const quality = expectedQuality(cat, state, printer, slot, mat, grams);
  const totalHours = machineHours + finishHours;
  const hoursLate = order.dueAt != null ? now(state) + totalHours - order.dueAt : -1;
  const late = lateFactor(hoursLate);
  const payout = (order.basePrice || 0) * qualityMult(order.qualityValue, quality) * late;
  return { tech: printer.tech, techClass: tc, materialId: matId, phases, finish, printHours, machineHours, finishHours, totalHours,
    heightMM: height, grams, usedGrams, matCost, watts, kwh, powerCost, quality, payout, keep: payout - matCost - powerCost,
    lateFactor: late };
}

// ---------------------------------------------------------------------
// Risk: named factors become one success chance. Each is a hazard; chance = exp(-sum).
// ---------------------------------------------------------------------
export function jobRisk(cat, state, slot, order, est, opts = {}) {
  const printer = cat.printer(slot.printerId);
  const tc = techClass(printer);
  const mat = cat.material(est.materialId);
  const label = cap(materialLabel(cat, est.materialId));
  const factors = [];
  const base = -Math.log(Math.max(0.01, Math.min(0.999, printer.baseReliability || 0.9)));
  factors.push({ id: 'machine', h: base * (0.5 + est.printHours / 8) });   // first layers + every hour after
  factors.push({ id: 'wear', h: Math.min(0.5, 0.0008 * (slot.wearHours || 0)), text: 'printer is worn', fix: 'service it', show: (slot.wearHours || 0) >= 80 });
  if (tc === 'fdm' || tc === 'resin') {
    const bed = clamp01(slot.bed ?? 1);
    factors.push({ id: 'bed', h: BED_K * (1 - bed) ** 2, text: tc === 'resin' ? 'build plate needs cleaning' : 'bed needs cleaning', fix: 'clean & level it' });
  }
  let clogChance = 0;
  if (tc === 'fdm') {
    const noz = slotNozzle(slot);
    const fiber = isFiber(mat);
    if (!fiber) {
      const rel = (NOZZLE_EFFECTS[noz.size] || NOZZLE_EFFECTS[0.4]).reliability;
      factors.push({ id: 'nozzleSize', h: -Math.log(rel), text: `${noz.size} mm nozzle is less reliable`, fix: 'fit a 0.4 or 0.6 mm' });
    }
    const box = partBox(cat, order);
    const warmth = warmthOf(printer, slot);
    const footprint = Math.min(1, (box[0] * box[1]) / 40000);
    const canEnclose = !printer.enclosed && !hasUpgrade(slot, 'enclosure');
    factors.push({ id: 'warp', h: WARP_K * warpiness(mat) * footprint * (1 - warmth) ** 2,
      text: `${label} may warp${warmth > 0 ? '' : ' on an open frame'}`, fix: canEnclose ? 'add an enclosure' : 'try PLA or PETG' });
    const hMid = fiber ? 1 : nozzleHealthMid(slot, mat, order.grams || 0);
    if (!fiber) factors.push({ id: 'nozzle', h: NOZZLE_K * (1 - hMid) ** 2, text: 'nozzle is worn', fix: 'fit a new one' });
    const wet = mat && mat.dampHours55 ? wetOf(state, mat.id) : 0;
    if (mat && mat.dampHours55) factors.push({ id: 'damp', h: DAMP_K * wet, text: `${label} is damp`, fix: 'dry it', show: wet >= 0.3 });
    if (!fiber) {
      const heatCreep = !isHot(mat) && warmth >= 0.6 && mat && (mat.id === 'pla' || mat.id === 'pla-plus') ? 0.01 : 0;
      clogChance = Math.min(0.5, 0.01 + 0.25 * (1 - hMid) + (noz.size <= 0.2 + EPS ? 0.06 : 0) + 0.04 * wet + heatCreep);
    }
  }
  const grace = !!opts.grace || (opts.grace === undefined && (state.graceJobs || 0) > 0);
  const hazard = factors.reduce((s, f) => s + f.h, 0);
  const chance = grace ? 1 : Math.exp(-hazard);
  const top = grace ? null : factors.filter((f) => f.fix && f.h >= 0.02 && f.show !== false).sort((a, b) => b.h - a.h)[0] || null;
  const pct = Math.round(chance * 100);
  const text = grace ? '100% · starter job, it can\'t fail' : top ? `${pct}% · ${top.text} (${top.fix})` : `${pct}%`;
  return { chance, hazard, factors, top, text, clogChance: grace ? 0 : clogChance, grace };
}

// Pre-sample when, if ever, this job fails or clogs. Always six draws, so the RNG stream only
// depends on how many jobs started, not on what they were.
function rollJob(state, printer, slot, est, risk) {
  const r = [rngNext(state), rngNext(state), rngNext(state), rngNext(state), rngNext(state), rngNext(state)];
  const heatH = est.phases[0] ? est.phases[0].h : 0;
  const machineH = est.machineHours;
  let fail = null;
  if (!risk.grace && r[0] >= risk.chance) {
    const u = r[1] ** (1 / FAIL_SHAPE);
    const atT = heatH + u * est.printHours;
    const detected = detects(printer, slot);
    const stopT = detected ? Math.min(machineH, atT + r[2] * DETECT_STOP_HOURS) : machineH;
    const tc = techClass(printer);
    const dominant = risk.factors.filter((f) => f.id !== 'machine').sort((a, b) => b.h - a.h)[0];
    let kind = tc === 'resin' ? 'resin' : tc === 'powder' ? 'powder' : tc === 'metal' ? 'metal' : (r[5] < 0.6 ? 'spaghetti' : 'detach');
    if (tc === 'fdm' && dominant && dominant.id === 'warp' && dominant.h > 0.05) kind = 'warp';
    fail = { u, atT, stopT, detected, kind };
  }
  const clogT = !risk.grace && r[3] < risk.clogChance ? heatH + r[4] * est.printHours : null;
  return { fail, clogT };
}

// ---------------------------------------------------------------------
// Slots and new games
// ---------------------------------------------------------------------
export function makeSlot(cat, printerId, slotId, purchasePrice) {
  const p = cat.printer(printerId);
  const nozId = usesNozzle(p) ? (nozzleType(p.stockNozzle) ? p.stockNozzle : 'b04') : null;
  const noz = nozId ? nozzleType(nozId) : null;
  return {
    printerId, slotId, state: 'idle', job: null,
    nozzleSize: noz ? noz.size : 0.4, nozzleHardened: noz ? hardenedMetal(noz) : false,
    totalHours: 0, wearHours: 0, purchasePrice: purchasePrice ?? p.price ?? 200,
    nozzleType: nozId, nozzleHealth: 1, bed: 1, upgrades: [], phase: 'idle',
  };
}
export function newLedger(day, owed = 0) { return { day, income: 0, materials: 0, kwh: 0, scrap: 0, owed }; }
export function newGame(cat, seed) {
  const p = cat.printer(STARTING.printer);
  return {
    saveVersion: SIM_VERSION,
    money: STARTING.money, day: 1, hour: 8, reputation: 0, shipped: 0,
    printers: [makeSlot(cat, STARTING.printer, 1, p.price)],
    inventory: { [STARTING.material]: STARTING.grams },
    orders: [], nextOrderInHours: STARTING.firstOrderHours, nextOrderId: 1, nextSlotId: 2,
    rng: (seed >>> 0) || 1,
    humidity: { rh: 45, base: 45, daysLeft: 2 },
    wet: {}, stations: [], nextStationId: 1, ledger: newLedger(1), log: [],
    shopUpgrades: [], dryer: null, graceJobs: GRACE_JOBS,
  };
}
function setPhase(slot, phase) { slot.phase = phase; slot.state = phase === 'idle' ? 'idle' : 'printing'; }

export function calcSellPrice(cat, slot) {
  const printer = cat.printer(slot.printerId);
  const basePrice = slot.purchasePrice ?? (printer.price || 200);
  const ageDep = Math.min(0.40, (slot.totalHours || 0) * 0.0003);
  const wearDep = Math.min(0.30, (slot.wearHours || 0) * 0.0008);
  return Math.round(basePrice * Math.max(0.15, 0.75 - ageDep - wearDep));
}

// ---------------------------------------------------------------------
// Orders
// ---------------------------------------------------------------------
// Checked at the tallest size the product comes in, so any order it spawns fits.
function productOrderShape(product) {
  return { techRequired: product.tech, minPrecision: product.minPrecision, minBuildVolumeMM: product.minBuildVolumeMM,
    heightMM: product.heightMM ? product.heightMM[1] : undefined, productId: product.id };
}
export function productRunnable(cat, product, slot) {
  const printer = cat.printer(slot.printerId);
  const shape = productOrderShape(product);
  return product.materials.some((m) => fitsMaterial(cat, printer, slot, shape, m));
}
// Can any machine in the catalog (with the best nozzle for the job) make this product in this
// material? Orders are never spawned for a pairing nothing can print (onyx fixtures too wide
// for the Mark Two's 132 mm bed, H13 tool steel with no machine).
export function catalogRunnable(cat, product, materialId) {
  cat._runnable = cat._runnable || new Map();
  const key = product.id + '|' + materialId;
  if (cat._runnable.has(key)) return cat._runnable.get(key);
  const shape = productOrderShape(product);
  let ok = false;
  for (const p of cat.printers) {
    const nozzles = usesNozzle(p) ? NOZZLE_TYPES : [null];
    for (const n of nozzles) {
      const slot = makeSlot(cat, p.id, 0, p.price);
      if (n) { slot.nozzleType = n.id; slot.nozzleSize = n.size; slot.nozzleHardened = hardenedMetal(n); }
      if (fitsMaterial(cat, p, slot, shape, materialId)) { ok = true; break; }
    }
    if (ok) break;
  }
  cat._runnable.set(key, ok);
  return ok;
}
const printableSomewhere = (cat, product) => product.materials.some((m) => catalogRunnable(cat, product, m));
function pickWeighted(items, r) {
  const total = items.reduce((s, x) => s + (x.demandWeight || 1), 0);
  let x = r * total;
  for (const it of items) { x -= (it.demandWeight || 1); if (x <= 0) return it; }
  return items[items.length - 1];
}
export function valueRatio(cat, product, materialId) {
  const vm = (id) => (cat.material(id) && cat.material(id).valueMultiplier) || 1;
  return vm(materialId) / vm(product.materials[0]);
}
export function customerFor(product, r) {
  const name = NAMES[Math.floor(r * NAMES.length) % NAMES.length];
  if (product.customerTier === 'consumer' || product.customerTier === 'hobbyist') return name;
  return `${name}'s ${PLACE_FOR[product.category] || 'workshop'}`;
}
export function customerForId(id) { return NAMES[Math.abs(id | 0) % NAMES.length]; }

// One new order. Ten draws, always, whatever gets picked.
export function spawnOrder(cat, state) {
  const r = Array.from({ length: 10 }, () => rngNext(state));
  const repOK = (p) => p.unlockReputation <= state.reputation;
  const runnable = (p) => state.printers.some((slot) => productRunnable(cat, p, slot));
  const eligible = cat.products.filter((p) => printableSomewhere(cat, p) && (repOK(p) || runnable(p)));
  if (!eligible.length) return null;
  // Starter orders (while the first jobs can't fail) are always ones the shop can print right
  // now, from what is on the shelf; after that, mostly what the shop can make.
  const starter = (state.graceJobs || 0) > 0;
  const onShelf = (p) => state.printers.some((slot) => p.materials.some((m) => (state.inventory[m] || 0) > 0 &&
    fitsMaterial(cat, cat.printer(slot.printerId), slot, productOrderShape(p), m)));
  const compatible = eligible.filter(starter ? onShelf : runnable);
  const pool = compatible.length && (starter || r[0] < 0.9) ? compatible : eligible;
  const product = pickWeighted(pool, r[1]);
  // One material, leaning toward what the shop can run and has on the shelf.
  const shape = productOrderShape(product);
  const can = product.materials.map((m) => catalogRunnable(cat, product, m) &&
    state.printers.some((slot) => fitsMaterial(cat, cat.printer(slot.printerId), slot, shape, m)));
  const stocked = product.materials.map((m, i) => can[i] && (state.inventory[m] || 0) > 0);
  const weights = product.materials.map((m, i) => {
    if (!catalogRunnable(cat, product, m)) return 0;
    if (starter && stocked.some(Boolean)) return stocked[i] ? 1 : 0;
    return can[i] ? (stocked[i] ? 8 : 4) : 1;
  });
  let x = r[2] * weights.reduce((a, b) => a + b, 0), materialId = null;
  for (let i = 0; i < weights.length; i++) {
    if (weights[i] <= 0) continue;
    materialId = product.materials[i];
    x -= weights[i];
    if (x <= 0) break;
  }
  const t = now(state);
  const deadline = lerp(product.deadlineHours, r[6]);
  const order = {
    id: state.nextOrderId++,
    productId: product.id, productName: product.name, category: product.category,
    materialId, materialOptions: [materialId],
    grams: lerp(product.grams, r[3]),
    baseHours: lerp(product.printHours, r[9]),     // v4 field, kept so an older build can still read the save
    basePrice: product.basePrice * (0.85 + r[5] * 0.45) * valueRatio(cat, product, materialId),
    minPrecision: product.minPrecision, minBuildVolumeMM: product.minBuildVolumeMM, techRequired: product.tech,
    deadlineHours: deadline, qualityValue: product.qualityValue, batchSize: product.batchSize || 1,
    v: SIM_VERSION, heightMM: lerp(product.heightMM || [50, 50], r[4]), arrivedAt: t, dueAt: t + deadline,
    customer: customerFor(product, r[7]),
    color: FIXED_COLORS[product.id] || MODEL_PALETTE[Math.floor(r[8] * MODEL_PALETTE.length) % MODEL_PALETTE.length],
  };
  state.orders.push(order);
  return { type: 'orderArrived', at: t, orderId: order.id, kind: 'info',
    text: `New order from ${order.customer}: ${product.name} in ${materialLabel(cat, materialId)}, due in ${fmtDuration(deadline)}` };
}
function nextOrderInterval(state, r, baseHours) {
  const repBoost = 1 + state.reputation * 0.01;
  const printerBoost = 1 + (state.printers.length - 1) * 0.10;
  return baseHours / (repBoost * printerBoost) * (0.7 + r * 0.8);
}
function anyCapable(cat, state, order) {
  return state.printers.some((slot) => {
    const printer = cat.printer(slot.printerId);
    const opts = order.materialOptions && order.materialOptions.length ? order.materialOptions : [order.materialId];
    return opts.some((m) => fitsMaterial(cat, printer, slot, order, m));
  });
}

// ---------------------------------------------------------------------
// Starting a job
// ---------------------------------------------------------------------
function buildJob(cat, state, slot, order, est, risk) {
  const printer = cat.printer(slot.printerId);
  const rolled = rollJob(state, printer, slot, est, risk);
  return {
    orderId: order.id, productId: order.productId, productName: order.productName, materialId: est.materialId,
    grams: order.grams, hoursTotal: est.machineHours, hoursElapsed: 0, payout: order.basePrice,
    qualityValue: order.qualityValue, precision: effectivePrecision(printer, slot),
    color: order.color || FIXED_COLORS[order.productId] || MODEL_PALETTE[order.id % MODEL_PALETTE.length],
    v: SIM_VERSION, phases: est.phases, finish: est.finish, printHours: est.printHours,
    quality: est.quality, chance: risk.chance, fail: rolled.fail, clogT: rolled.clogT,
    watts: est.watts, kwh: 0, usedGrams: est.usedGrams, matCost: est.matCost,
    dueAt: order.dueAt ?? null, customer: order.customer || null, grace: risk.grace,
    order: { ...order }, startedAt: now(state),
  };
}
export function assign(cat, state, orderId, slotIdx) {
  const order = state.orders.find((o) => o.id === orderId);
  const slot = state.printers[slotIdx];
  if (!order || !slot) return { ok: false, reason: 'That order is gone', events: [] };
  const check = canAssign(cat, state, order, slot);
  if (!check.ok) return { ok: false, reason: check.reason, events: [] };
  const est = estimateJob(cat, state, slot, order, check.materialId);
  const risk = jobRisk(cat, state, slot, order, est);
  state.inventory[check.materialId] = (state.inventory[check.materialId] || 0) - est.usedGrams;
  if (state.inventory[check.materialId] < 1e-6) state.inventory[check.materialId] = 0;
  if (risk.grace) state.graceJobs = Math.max(0, (state.graceJobs || 0) - 1);
  slot.job = buildJob(cat, state, slot, order, est, risk);
  setPhase(slot, est.phases[0].id === 'prep' ? 'prep' : 'heating');
  state.orders = state.orders.filter((o) => o.id !== orderId);
  return { ok: true, events: [{ type: 'started', at: now(state), slotId: slot.slotId, orderId, kind: 'good',
    text: `Started ${possessive(order.customer)} ${order.productName} on the ${printerName(cat, slot.printerId)} (${risk.text.split(' · ')[0]} chance)` }] };
}

// ---------------------------------------------------------------------
// The clock. Advances to each next moment something happens, handles it, and goes on.
// ---------------------------------------------------------------------
const ACTIVE = new Set(['heating', 'prep', 'printing']);
const TIMED = new Set(['cleaning', 'coldpull']);
function jobBoundaries(job) {
  const list = [];
  let acc = 0;
  for (const p of job.phases || [{ id: 'print', h: job.hoursTotal }]) { acc += p.h; list.push(acc); }
  if (job.fail) list.push(job.fail.stopT);
  if (job.clogT != null) list.push(job.clogT);
  list.push(job.hoursTotal);
  return list;
}
function phaseAt(job, t) {
  let acc = 0;
  const phases = job.phases || [{ id: 'print', h: job.hoursTotal }];
  for (const p of phases) { acc += p.h; if (t < acc - EPS) return p.id; }
  return phases[phases.length - 1].id;
}
const machinePhaseName = (id) => (id === 'heat' ? 'heating' : id === 'prep' ? 'prep' : 'printing');

function timeToNext(cat, state) {
  const t = now(state);
  let m = (Math.floor(t / 24 + 1e-12) + 1) * 24 - t;
  m = Math.min(m, Math.max(0, state.nextOrderInHours));
  for (const slot of state.printers) {
    if (ACTIVE.has(slot.phase) && slot.job) {
      for (const b of jobBoundaries(slot.job)) if (b > slot.job.hoursElapsed + EPS) m = Math.min(m, b - slot.job.hoursElapsed);
    } else if (TIMED.has(slot.phase)) m = Math.min(m, Math.max(0, slot.timer || 0));
  }
  for (const s of state.stations) { const ph = s.phases[s.idx]; m = Math.min(m, ph ? Math.max(0, ph.h - s.t) : 0); }
  for (const o of state.orders) if (o.dueAt != null) m = Math.min(m, Math.max(0, o.dueAt - t));
  if (state.dryer) m = Math.min(m, Math.max(0, state.dryer.hoursLeft));
  return m;
}

function advance(cat, state, dt, out) {
  if (dt <= 0) return;
  setNow(state, now(state) + dt);
  state.nextOrderInHours -= dt;
  const L = state.ledger;
  for (const slot of state.printers) {
    if (ACTIVE.has(slot.phase) && slot.job) {
      const job = slot.job;
      job.hoursElapsed += dt;
      const watts = job.watts ?? (cat.printer(slot.printerId).powerW || 0);
      job.kwh = (job.kwh || 0) + watts * dt / 1000;
      L.kwh += watts * dt / 1000;
      slot.totalHours = (slot.totalHours || 0) + dt;
      slot.wearHours = (slot.wearHours || 0) + dt;
      out.dirty.printers = true;
    } else if (TIMED.has(slot.phase)) {
      slot.timer = (slot.timer || 0) - dt;
      out.dirty.printers = true;
    }
  }
  for (const s of state.stations) {
    const ph = s.phases[s.idx];
    s.t += dt;
    L.kwh += ((ph && ph.w) || 0) * dt / 1000;
    out.dirty.stations = true;
  }
  const t = now(state);
  for (const o of state.orders) if (o.dueAt != null) o.deadlineHours = Math.max(0, o.dueAt - t);   // v4 meaning: hours left
  const dryingId = state.dryer ? state.dryer.materialId : null;
  if (state.dryer) {
    const d = state.dryer;
    d.hoursLeft -= dt;
    L.kwh += DRYER_W * dt / 1000;
    const before = Math.round(wetOf(state, dryingId) * 100);
    state.wet[dryingId] = Math.max(0, wetOf(state, dryingId) - dt / d.specHours);
    if (Math.round(state.wet[dryingId] * 100) !== before) out.dirty.inventory = true;
  }
  // Spools on the shelf soak up water: faster when it's humid, 6x slower in a dry box.
  const rh = (state.humidity && state.humidity.rh) || 45;
  const box = hasShopUpgrade(state, 'drybox') ? 6 : 1;
  for (const id of Object.keys(state.inventory)) {
    if (id === dryingId || !(state.inventory[id] > 0)) continue;
    const mat = cat.material(id);
    if (!mat || !mat.dampHours55) continue;
    const tau = (mat.dampHours55 / Math.LN2) * (55 / rh) * box;
    const w0 = wetOf(state, id);
    const w1 = 1 - (1 - w0) * Math.exp(-dt / tau);
    state.wet[id] = w1;
    if (Math.round(w1 * 100) !== Math.round(w0 * 100)) out.dirty.inventory = true;
  }
}

function emit(out, ev) { out.events.push(ev); if (ev.text && ev.log !== false) out.dirty.log = true; }

function processDue(cat, state, opts, out) {
  const t = now(state);
  // Printers, in shop order.
  for (const slot of state.printers) {
    if (ACTIVE.has(slot.phase) && slot.job) {
      const job = slot.job;
      const e = job.hoursElapsed;
      if (job.fail && e >= job.fail.stopT - EPS) { failJob(cat, state, slot, out); continue; }
      if (job.clogT != null && e >= job.clogT - EPS) { clogJob(cat, state, slot, out); continue; }
      if (e >= job.hoursTotal - EPS) { printDone(cat, state, slot, out); continue; }
      const ph = machinePhaseName(phaseAt(job, e));
      if (ph !== slot.phase) { setPhase(slot, ph); out.dirty.printers = true; }
    } else if (TIMED.has(slot.phase) && (slot.timer || 0) <= EPS) {
      slot.timer = 0;
      if (slot.phase === 'cleaning') {
        slot.bed = 1;
        setPhase(slot, 'idle');
        emit(out, { type: 'bedCleaned', at: t, slotId: slot.slotId, kind: 'info', text: `${printerName(cat, slot.printerId)}: bed cleaned and leveled` });
      } else {
        setPhase(slot, machinePhaseName(phaseAt(slot.job, slot.job.hoursElapsed)));
        emit(out, { type: 'coldPullDone', at: t, slotId: slot.slotId, kind: 'info', text: `Cold pull done: the ${printerName(cat, slot.printerId)} is printing again` });
      }
      out.dirty.printers = true; out.dirty.orders = true;
    }
  }
  // Finishing stations.
  for (const s of state.stations.slice()) {
    while (s.idx < s.phases.length && s.t >= s.phases[s.idx].h - EPS) { s.t = 0; s.idx++; }
    if (s.idx >= s.phases.length) {
      state.stations = state.stations.filter((x) => x !== s);
      shipPart(cat, state, s, t, out);
    }
  }
  if (state.dryer && state.dryer.hoursLeft <= EPS) {
    const d = state.dryer;
    state.dryer = null;
    state.wet[d.materialId] = 0;
    emit(out, { type: 'dried', at: t, kind: 'good', toast: true, text: `${cap(materialLabel(cat, d.materialId))} is dry (${fmtDuration(d.specHours)} at ${d.specC} °C)` });
    out.dirty.inventory = true;
  }
  // Orders that waited too long on the board.
  for (const o of state.orders.slice()) {
    if (o.dueAt == null || o.dueAt > t + EPS) continue;
    state.orders = state.orders.filter((x) => x !== o);
    const penalty = !o.released && state.reputation > 0 && anyCapable(cat, state, o) ? 1 : 0;
    state.reputation -= penalty;
    emit(out, { type: 'expired', at: t, orderId: o.id, kind: 'warn', repLost: penalty,
      text: `${o.customer || 'A customer'} found another shop${penalty ? ' (-1 rep)' : ''}` });
    out.dirty.orders = true;
  }
  // New customers.
  let guard = 0;
  while (state.nextOrderInHours <= EPS && guard++ < 50) {
    const ev = spawnOrder(cat, state);
    if (ev) emit(out, ev);
    state.nextOrderInHours += nextOrderInterval(state, rngNext(state), opts.orderBaseHours || ORDER_SPAWN_BASE_HOURS);
    out.dirty.orders = true;
  }
  // Midnight: close the day's books and set tomorrow's weather.
  while (state.ledger && state.day > state.ledger.day) closeDay(cat, state, out);
}

function printedFraction(job, t) {
  const heatH = job.phases && job.phases.length > 1 ? job.phases[0].h : 0;
  const printH = job.printHours ?? (job.hoursTotal - heatH);
  return printH > 0 ? clamp01((t - heatH) / printH) : 1;
}
function wearAfterPrint(cat, slot, job, gramsPrinted) {
  const printer = cat.printer(slot.printerId);
  const tc = techClass(printer);
  if (tc === 'fdm' || tc === 'resin') slot.bed = clamp01((slot.bed ?? 1) - (printer.autoLevel ? 0.08 : 0.12));
  if (usesNozzle(printer)) slot.nozzleHealth = clamp01((slot.nozzleHealth ?? 1) - nozzleWearPerGram(slot, cat.material(job.materialId)) * gramsPrinted);
}
const FAIL_TEXT = {
  spaghetti: 'Spaghetti! The part came loose and the printer made noodles',
  detach: 'The part came loose from the bed',
  warp: 'The corners curled up and the part popped off',
  resin: 'The print stuck to the vat film instead of the plate',
  powder: 'A layer didn\'t spread right, so the build stopped',
  metal: 'The recoater bumped the part, so the build stopped',
};
function failJob(cat, state, slot, out) {
  const job = slot.job;
  const printer = cat.printer(slot.printerId);
  const tc = techClass(printer);
  const f = job.fail;
  const printedAtStop = printedFraction(job, f.stopT);
  // Undetected FDM keeps extruding to the planned end: every gram is gone. A resin vat keeps the
  // uncured resin. A camera or industrial monitor stops within 10 minutes.
  const wasteFrac = tc === 'fdm' && !f.detected ? 1 : tc === 'resin' ? clamp01(f.u) : printedAtStop;
  const used = job.usedGrams ?? job.grams;
  const refund = used * (1 - wasteFrac);
  if (refund > 0) state.inventory[job.materialId] = (state.inventory[job.materialId] || 0) + refund;
  const lostG = used * wasteFrac;
  state.ledger.scrap += lostG / 1000 * costPerKg(cat.material(job.materialId));
  wearAfterPrint(cat, slot, job, job.grams * (tc === 'fdm' && !f.detected ? 1 : printedAtStop));
  job.failedAt = now(state);
  job.lostGrams = lostG;
  setPhase(slot, 'failed');
  out.dirty.printers = true; out.dirty.inventory = true; out.dirty.orders = true;
  emit(out, { type: 'failed', at: now(state), slotId: slot.slotId, orderId: job.orderId, kind: 'bad', toast: true, failKind: f.kind, lostGrams: lostG, detected: f.detected,
    text: `${FAIL_TEXT[f.kind] || FAIL_TEXT.detach} on the ${printerName(cat, slot.printerId)}: ${fmtGrams(lostG)} of ${materialLabel(cat, job.materialId)} lost. Reprint or release the order.` });
}
function clogJob(cat, state, slot, out) {
  const job = slot.job;
  job.clogT = null;
  job.clogged = (job.clogged || 0) + 1;
  setPhase(slot, 'clogged');
  out.dirty.printers = true; out.dirty.orders = true;
  emit(out, { type: 'clogged', at: now(state), slotId: slot.slotId, orderId: job.orderId, kind: 'bad', toast: true,
    text: `The ${printerName(cat, slot.printerId)} clogged at ${Math.round(printedFraction(job, job.hoursElapsed) * 100)}%: do a cold pull. Nothing is lost.` });
}
function printDone(cat, state, slot, out) {
  const job = slot.job;
  job.hoursElapsed = job.hoursTotal;
  wearAfterPrint(cat, slot, job, job.grams);
  setPhase(slot, 'done');
  out.dirty.printers = true; out.dirty.orders = true;
  emit(out, { type: 'done', at: now(state), slotId: slot.slotId, orderId: job.orderId, kind: 'info', toast: true,
    text: `${possessive(job.customer)} ${job.productName} is done on the ${printerName(cat, slot.printerId)}: collect it` });
}

function bigContractBonus(price) { return price >= 500 ? Math.floor(Math.log2(price / 250)) : 0; }
function shipPart(cat, state, part, t, out) {
  const hoursLate = part.dueAt != null ? t - part.dueAt : -1;
  const late = lateFactor(hoursLate);
  const quality = part.quality ?? part.precision ?? 0.5;
  const payout = (part.payout || 0) * qualityMult(part.qualityValue, quality) * late;
  state.money += payout;
  const L = state.ledger;
  if (L.owed > 0) { const take = Math.min(L.owed, state.money); state.money -= take; L.owed -= take; }
  L.income += payout;
  L.materials += part.matCost || 0;
  const rep = late < 1 ? 0 : 2 + (quality >= 0.9 - EPS ? 1 : 0) + bigContractBonus(part.payout || 0);
  state.reputation += rep;
  state.shipped += 1;
  out.dirty.money = true; out.dirty.printers = true; out.dirty.orders = true;
  const who = `${possessive(part.customer)} ${part.productName}`;
  emit(out, { type: 'shipped', at: t, orderId: part.orderId, kind: late < 1 ? 'warn' : 'good', toast: true, payout, rep, late: hoursLate > EPS ? hoursLate : 0,
    text: late < 1 ? `Shipped ${who} ${fmtDuration(hoursLate)} late: paid ${Math.round(late * 100)}% (+${fmtMoney(payout)}), no rep`
                   : `Shipped ${who}: +${fmtMoney(payout)} · +${rep} rep` });
}

function closeDay(cat, state, out) {
  const L = state.ledger;
  const power = L.kwh * KWH_PRICE;
  const due = power + (L.owed || 0);
  const pay = Math.min(Math.max(0, state.money), due);
  state.money -= pay;
  const owed = due - pay;
  const net = L.income - L.materials - power - L.scrap;
  const closed = { day: L.day, income: L.income, materials: L.materials, kwh: L.kwh, power, scrap: L.scrap, net, owed };
  state.ledger = newLedger(L.day + 1, owed > 1e-9 ? owed : 0);
  // A quiet day still closes its books, but only a day with money moving gets a log line.
  const quiet = Math.max(closed.income, closed.materials, power, closed.scrap, owed) < 0.005;
  emit(out, { type: 'dayClosed', at: now(state), kind: 'info', ledger: closed, log: quiet ? false : undefined,
    text: `Day ${closed.day} closed: income ${fmtMoney(closed.income)} · materials ${fmtMoney(closed.materials)} · power ${fmtMoney(power)}${closed.scrap >= 0.005 ? ` · scrap ${fmtMoney(closed.scrap)}` : ''} · net ${fmtMoney(net)}` +
      (owed > 0.005 ? ` (${fmtMoney(owed)} of the power bill waits for the next sale)` : '') });
  out.dirty.money = true;
  newDayWeather(state, out);
}
// Shop humidity runs in multi-day spells, 30-75% RH. Three draws a day, always.
function newDayWeather(state, out) {
  const r1 = rngNext(state), r2 = rngNext(state), r3 = rngNext(state);
  const h = state.humidity || (state.humidity = { rh: 45, base: 45, daysLeft: 0 });
  const newSpell = h.daysLeft <= 0;
  if (newSpell) { h.base = 30 + r1 * 45; h.daysLeft = 2 + Math.floor(r2 * 4); }
  h.daysLeft -= 1;
  h.rh = Math.round(Math.min(75, Math.max(30, h.base + (r3 - 0.5) * 8)));
  out.dirty.header = true;
  if (newSpell && (h.rh >= 60 || h.rh <= 38)) {
    emit(out, { type: 'humidity', at: now(state), kind: 'info',
      text: h.rh >= 60 ? `Humid spell: ${h.rh}% RH. TPU and nylon soak up water fast` : `Dry spell: ${h.rh}% RH. Spools stay dry longer` });
  }
}

export function step(cat, state, hours, opts = {}) {
  const out = { events: [], dirty: { header: true, printers: false, orders: false, inventory: false, stations: false, log: false, money: false } };
  processDue(cat, state, opts, out);
  let left = Math.max(0, hours || 0);
  let guard = 0;
  while (left > EPS && guard++ < 200000) {
    const dt = Math.min(left, timeToNext(cat, state));
    advance(cat, state, dt, out);
    left -= dt;
    processDue(cat, state, opts, out);
  }
  return out;
}

// ---------------------------------------------------------------------
// Player actions on a printer
// ---------------------------------------------------------------------
const ok = (events = [], extra) => ({ ok: true, events, ...extra });
const fail = (reason) => ({ ok: false, reason, events: [] });

export function collect(cat, state, slotIdx) {
  const slot = state.printers[slotIdx];
  if (!slot || slot.phase !== 'done' || !slot.job) return fail('Nothing to collect');
  const job = slot.job;
  const printer = cat.printer(slot.printerId);
  const part = { id: state.nextStationId = (state.nextStationId || 1), orderId: job.orderId, productId: job.productId, productName: job.productName,
    customer: job.customer, payout: job.payout, qualityValue: job.qualityValue, quality: job.quality ?? job.precision, dueAt: job.dueAt ?? null,
    matCost: job.matCost || 0, materialId: job.materialId, tech: printer.tech, slotId: slot.slotId, color: job.color, phases: job.finish || [], idx: 0, t: 0 };
  state.nextStationId = (state.nextStationId || 1) + 1;
  slot.job = null;
  setPhase(slot, 'idle');
  const out = { events: [], dirty: {} };
  if (job.grandfathered || shipsOnCollect(printer) || !part.phases.length) {
    shipPart(cat, state, part, now(state), out);
  } else {
    state.stations.push(part);
    const names = part.phases.map((p) => FINISH_NAMES[p.id] || p.id).join(' and ');
    emit(out, { type: 'finishing', at: now(state), orderId: part.orderId, kind: 'info',
      text: `${possessive(part.customer)} ${part.productName} went to ${names} (${fmtDuration(sumH(part.phases))})` });
  }
  return ok(out.events);
}
export const FINISH_NAMES = { wash: 'washing', cure: 'curing', cool: 'cooling', depowder: 'depowdering', relief: 'stress relief', sinter: 'sintering' };
export function collectAll(cat, state) {
  const events = [];
  state.printers.forEach((slot, i) => { if (slot.phase === 'done') events.push(...collect(cat, state, i).events); });
  return ok(events);
}
export function cleanBed(cat, state, slotIdx) {
  const slot = state.printers[slotIdx];
  if (!slot) return fail('No printer');
  const tc = techClass(cat.printer(slot.printerId));
  if (tc !== 'fdm' && tc !== 'resin') return fail('This machine has no bed to clean');
  if (slot.phase !== 'idle') return fail(busyText(slot));
  setPhase(slot, 'cleaning');
  slot.timer = BED_CLEAN_HOURS;
  return ok();
}
export function coldPull(cat, state, slotIdx) {
  const slot = state.printers[slotIdx];
  if (!slot || slot.phase !== 'clogged') return fail('Nothing is clogged');
  setPhase(slot, 'coldpull');
  slot.timer = COLD_PULL_HOURS;
  return ok();
}
export function reprint(cat, state, slotIdx) {
  const slot = state.printers[slotIdx];
  if (!slot || slot.phase !== 'failed' || !slot.job) return fail('Nothing to reprint');
  const old = slot.job;
  const order = old.order || { id: old.orderId, productId: old.productId, productName: old.productName, materialOptions: [old.materialId], materialId: old.materialId,
    grams: old.grams, basePrice: old.payout, qualityValue: old.qualityValue, dueAt: old.dueAt, customer: old.customer, color: old.color };
  setPhase(slot, 'idle');
  const est = estimateJob(cat, state, slot, order, old.materialId);
  if ((state.inventory[old.materialId] || 0) + 1e-6 < est.usedGrams) {
    setPhase(slot, 'failed');
    return fail(`Needs ${fmtGrams(est.usedGrams - (state.inventory[old.materialId] || 0))} more ${materialLabel(cat, old.materialId)} to reprint`);
  }
  const risk = jobRisk(cat, state, slot, order, est, { grace: false });
  state.inventory[old.materialId] -= est.usedGrams;
  slot.job = buildJob(cat, state, slot, order, est, risk);
  slot.job.reprints = (old.reprints || 0) + 1;
  setPhase(slot, est.phases[0].id === 'prep' ? 'prep' : 'heating');
  return ok([{ type: 'reprint', at: now(state), slotId: slot.slotId, kind: 'info', text: `Reprinting ${possessive(order.customer)} ${order.productName} (${risk.text.split(' · ')[0]} chance)` }]);
}
export function release(cat, state, slotIdx) {
  const slot = state.printers[slotIdx];
  if (!slot || slot.phase !== 'failed' || !slot.job) return fail('Nothing to release');
  const job = slot.job;
  if (job.order) state.orders.push({ ...job.order, released: true });
  slot.job = null;
  setPhase(slot, 'idle');
  return ok([{ type: 'released', at: now(state), slotId: slot.slotId, kind: 'info',
    text: `${possessive(job.customer)} ${job.productName} is back on the order board` }]);
}

// ---------------------------------------------------------------------
// Shop actions
// ---------------------------------------------------------------------
export function buyMaterial(cat, state, matId, kg = 1) {
  const m = cat.material(matId);
  if (!m) return fail('Unknown material');
  const cost = costPerKg(m) * kg;
  if (state.money + 1e-9 < cost) return fail('Not enough cash');
  state.money -= cost;
  const have = state.inventory[matId] || 0, add = kg * 1000;
  state.wet = state.wet || {};
  state.wet[matId] = have + add > 0 ? wetOf(state, matId) * have / (have + add) : 0;   // new stock arrives dry, blends by weight
  state.inventory[matId] = have + add;
  return ok([], { cost });
}
export function startDrying(cat, state, matId) {
  if (!hasShopUpgrade(state, 'dryer')) return fail('Buy a filament dryer first');
  if (state.dryer) return fail(`The dryer is busy with ${materialLabel(cat, state.dryer.materialId)}`);
  const m = cat.material(matId);
  if (!m || !m.dryHours) return fail(`${cap(materialLabel(cat, matId))} doesn't need drying`);
  if (!(state.inventory[matId] > 0)) return fail(`No ${materialLabel(cat, matId)} in stock`);
  state.dryer = { materialId: matId, hoursLeft: m.dryHours, specHours: m.dryHours, specC: m.dryC };
  return ok([{ type: 'drying', at: now(state), kind: 'info', text: `Drying ${materialLabel(cat, matId)}: ${fmtDuration(m.dryHours)} at ${m.dryC} °C` }]);
}
export function buyUpgrade(cat, state, id, slotIdx) {
  const u = UPGRADES.find((x) => x.id === id);
  if (!u) return fail('Unknown upgrade');
  if (u.scope === 'shop') {
    if (hasShopUpgrade(state, id)) return fail('Already owned');
    if (state.money + 1e-9 < u.cost) return fail(`Need ${fmtMoney(u.cost)}`);
    state.money -= u.cost;
    state.shopUpgrades = [...(state.shopUpgrades || []), id];
    return ok([{ type: 'upgrade', at: now(state), kind: 'good', toast: true, text: `Bought ${aAn(u.name.toLowerCase())}` }]);
  }
  const slot = state.printers[slotIdx];
  if (!slot) return fail('No printer');
  if (!upgradeApplies(cat, slot, id)) return fail(`The ${printerName(cat, slot.printerId)} doesn't take ${aAn(u.name.toLowerCase())}`);
  if (hasUpgrade(slot, id)) return fail('Already fitted');
  if (state.money + 1e-9 < u.cost) return fail(`Need ${fmtMoney(u.cost)}`);
  state.money -= u.cost;
  slot.upgrades = [...(slot.upgrades || []), id];
  return ok([{ type: 'upgrade', at: now(state), slotId: slot.slotId, kind: 'good', toast: true, text: `Fitted ${aAn(u.name.toLowerCase())} to the ${printerName(cat, slot.printerId)}` }]);
}
export function changeNozzle(cat, state, slotIdx, nozzleId) {
  const slot = state.printers[slotIdx];
  if (!slot) return fail('No printer');
  if (!usesNozzle(cat.printer(slot.printerId))) return fail('This machine has no nozzle');
  if (slot.phase !== 'idle') return fail('Stop the print first');
  const noz = nozzleType(nozzleId);
  if (!noz) return fail('Unknown nozzle');
  const current = slotNozzle(slot);
  if (current.id === noz.id && (slot.nozzleHealth ?? 1) >= 0.999) return fail('Already installed');
  if (state.money + 1e-9 < noz.cost) return fail(`Need ${fmtMoney(noz.cost)}`);
  state.money -= noz.cost;
  slot.nozzleType = noz.id;
  slot.nozzleSize = noz.size;
  slot.nozzleHardened = hardenedMetal(noz);
  slot.nozzleHealth = 1;
  return ok([{ type: 'nozzle', at: now(state), slotId: slot.slotId, kind: 'good', text: `Installed a ${noz.label} nozzle on the ${printerName(cat, slot.printerId)}` }], { nozzle: noz });
}
export function service(cat, state, slotIdx, serviceId) {
  const slot = state.printers[slotIdx];
  if (!slot) return fail('No printer');
  if (slot.phase !== 'idle') return fail('Stop the print first');
  const svc = SERVICE_OPTIONS.find((s) => s.id === serviceId);
  if (!svc) return fail('Unknown service');
  if (state.money + 1e-9 < svc.cost) return fail(`Need ${fmtMoney(svc.cost)}`);
  state.money -= svc.cost;
  const cleared = Math.min(slot.wearHours || 0, svc.reduceWear);
  slot.wearHours = Math.max(0, (slot.wearHours || 0) - svc.reduceWear);
  return ok([], { cleared, svc });
}
export function buyPrinter(cat, state, printerId) {
  const p = cat.printer(printerId);
  if (p.unknown) return fail('Unknown printer');
  const need = TIER_UNLOCK_REP[p.tier] || 0;
  if (state.reputation < need) return fail(`Need ${need} reputation`);
  if (state.money + 1e-9 < p.price) return fail(`Need ${fmtMoney(p.price)}`);
  state.money -= p.price;
  state.printers.push(makeSlot(cat, printerId, state.nextSlotId++, p.price));
  return ok([{ type: 'bought', at: now(state), kind: 'good', text: `Welcome, ${p.model}!` }]);
}
export function sellPrinter(cat, state, slotIdx) {
  const slot = state.printers[slotIdx];
  if (!slot) return fail('No printer');
  if (state.printers.length <= 1) return fail('Need at least one printer');
  if (slot.phase !== 'idle') return fail('Stop the print first');
  const amount = calcSellPrice(cat, slot);
  state.money += amount;
  state.printers.splice(slotIdx, 1);
  return ok([{ type: 'sold', at: now(state), kind: 'good', text: `Sold the ${printerName(cat, slot.printerId)} for ${fmtMoney(amount)}` }], { amount });
}
export function rejectOrder(state, orderId) {
  const before = state.orders.length;
  state.orders = state.orders.filter((o) => o.id !== orderId);
  return before !== state.orders.length ? ok() : fail('That order is gone');
}

// ---------------------------------------------------------------------
// What a printer card says: one status line and at most one action.
// ---------------------------------------------------------------------
export function partProgress(slot) {
  const job = slot.job;
  if (!job) return 0;
  if (slot.phase === 'done') return 1;
  if (slot.phase === 'failed' && job.fail) return clamp01(job.fail.u);
  return printedFraction(job, job.hoursElapsed);
}
export function slotStatus(cat, state, slot) {
  const printer = cat.printer(slot.printerId);
  const job = slot.job;
  const tc = techClass(printer);
  const left = (t) => fmtDuration(Math.max(0, t));
  switch (slot.phase || 'idle') {
    case 'heating': return { line: `Heating up · ${left((job.phases[0] ? job.phases[0].h : 0) - job.hoursElapsed)}`, tone: 'busy' };
    case 'prep': return { line: `Getting ready · ${left((job.phases[0] ? job.phases[0].h : 0) - job.hoursElapsed)}`, tone: 'busy' };
    case 'printing': return { line: `Printing ${Math.floor(printedFraction(job, job.hoursElapsed) * 100)}% · ${left(job.hoursTotal - job.hoursElapsed)} left`, tone: 'busy' };
    case 'done': return { line: tc === 'fdm' && printer.tech !== 'ADAM' ? 'Done · the part is on the plate' : 'Done · collect it for finishing', tone: 'done', action: { id: 'collect', label: 'Collect' } };
    case 'clogged': return { line: `Clogged at ${Math.round(printedFraction(job, job.hoursElapsed) * 100)}% · nothing lost`, tone: 'fault', action: { id: 'coldpull', label: 'Cold pull' } };
    case 'coldpull': return { line: `Cold pull · ${left(slot.timer)}`, tone: 'busy' };
    case 'failed': return { line: `${{ spaghetti: 'Spaghetti', detach: 'Came loose', warp: 'Warped', resin: 'Stuck to the film', powder: 'Build stopped', metal: 'Build stopped' }[job.fail ? job.fail.kind : 'detach'] || 'Failed'} · ${fmtGrams(job.lostGrams || 0)} lost`,
      tone: 'fault', action: { id: 'reprint', label: 'Reprint' }, secondary: { id: 'release', label: 'Release' } };
    case 'cleaning': return { line: `Cleaning the bed · ${left(slot.timer)}`, tone: 'busy' };
    default:
      if (printer.unknown) return { line: "Retired · it can't take orders", tone: 'idle' };
      if ((tc === 'fdm' || tc === 'resin') && (slot.bed ?? 1) < 0.7) {
        return { line: `Idle · ${tc === 'resin' ? 'plate' : 'bed'} needs a clean`, tone: 'idle', action: { id: 'clean', label: 'Clean & level bed' } };
      }
      return { line: 'Idle · ready for an order', tone: 'idle' };
  }
}

// ---------------------------------------------------------------------
// Log
// ---------------------------------------------------------------------
export function appendLog(state, events) {
  state.log = state.log || [];
  for (const e of events) {
    if (!e.text || e.log === false) continue;
    const t = e.at ?? now(state);
    const d = Math.floor(t / 24 + 1e-12);
    state.log.unshift({ day: d + 1, hour: +(t - d * 24).toFixed(3), text: e.text, kind: e.kind || 'info' });
  }
  if (state.log.length > LOG_LIMIT) state.log.length = LOG_LIMIT;
}
