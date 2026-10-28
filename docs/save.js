// =====================================================================
// Print3D saves: one key forever, versioned contents, migrations that never lose anything.
//
// Pure ES module with no imports: the rules (sim.js) and the catalog come in through `ctx`,
// so this file never loads a second copy of sim.js. Every function here is safe to call with a
// storage object that throws (private windows, blocked site data): reads come back empty and
// writes report failure instead of throwing.
//
// Load order (load()):
//   1. No save under STATE_KEY: adopt the newest of the v3/v2/v1 keys, leaving that key alone.
//   2. Unreadable save: copy it to STATE_KEY.unreadable (then -2…-9, never overwriting one),
//      start a new game and say so.
//   3. A v4 save: write the untouched string once to STATE_KEY.backup-v4.
//   4. Migrate, validate, hand back. game.js saves straight away. If validation fails the raw
//      string is kept (backup or .unreadable copy) and a new game starts with a message.
// =====================================================================

export const STATE_KEY = 'printer-tycoon-state-v4';
export const BACKUP_KEY = STATE_KEY + '.backup-v4';
export const UNREADABLE_KEY = STATE_KEY + '.unreadable';
export const OLD_KEYS = ['printer-tycoon-state-v3', 'printer-tycoon-state-v2', 'printer-tycoon-state-v1'];
export const SAVE_VERSION = 5;

// Old printer id -> current id, for when a catalog id is renamed. Empty today; a slot whose id
// is in neither the catalog nor this table becomes an "Unknown machine" card that can be sold.
export const PRINTER_ALIASES = {};

// Printers whose v4 slots defaulted to a hardened nozzle when the save had no nozzle fields.
const V4_SHIPPED_HARDENED = new Set(['prusa-mk4s', 'bambu-p1s-ams', 'bambu-x1c-ams', 'bambu-x1e', 'bambu-h2d',
  'prusa-xl-5tool', 'voron-2-4', 'qidi-x-max-3', 'bcn3d-sigma-d25']);

const PHASES = new Set(['idle', 'heating', 'prep', 'printing', 'done', 'clogged', 'coldpull', 'failed', 'cleaning']);
const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
const clone = (x) => JSON.parse(JSON.stringify(x));

export function safeGet(storage, key) {
  try { return storage ? storage.getItem(key) : null; } catch (e) { return null; }
}
export function safeSet(storage, key, value) {
  try { storage.setItem(key, value); return true; } catch (e) { return false; }
}

function looksLikeSave(obj) {
  return !!obj && typeof obj === 'object' && !Array.isArray(obj) && isNum(obj.money);
}
function parse(raw) {
  try { const obj = JSON.parse(raw); return looksLikeSave(obj) ? obj : null; } catch (e) { return null; }
}

// ---------------------------------------------------------------------
// Migrations. Pure (the input is never touched) and idempotent: migrate(migrate(x)) deep-equals
// migrate(x), because each step only runs for saves older than its version.
// ---------------------------------------------------------------------
export function migrate(input, ctx) {
  let s = clone(input);
  if (!(s.saveVersion >= 5)) s = v4to5(s, ctx);
  return s;
}

function v4to5(old, ctx) {
  const { cat, Sim } = ctx;
  const day = isNum(old.day) && old.day >= 1 ? Math.floor(old.day) : 1;
  const hour = isNum(old.hour) ? Math.min(Math.max(old.hour, 0), 24 - 1e-6) : 8;
  const t = (day - 1) * 24 + hour;
  const printersIn = Array.isArray(old.printers) ? old.printers : [];
  const maxSlotId = printersIn.reduce((m, sl) => Math.max(m, isNum(sl && sl.slotId) ? sl.slotId : 0), 0);
  const s = {
    // Everything a v4 save had, untouched (no clawback of money or reputation).
    ...old,
    saveVersion: SAVE_VERSION,
    day, hour,
    reputation: isNum(old.reputation) ? old.reputation : 0,
    shipped: isNum(old.shipped) ? old.shipped : 0,
    nextOrderInHours: isNum(old.nextOrderInHours) ? old.nextOrderInHours : 5,
    nextOrderId: isNum(old.nextOrderId) ? old.nextOrderId : 1,
    nextSlotId: isNum(old.nextSlotId) ? old.nextSlotId : maxSlotId + 1,   // v1 saves never had it
  };
  s.printers = printersIn.filter((sl) => sl && typeof sl === 'object' && typeof sl.printerId === 'string').map((sl) => slotV5(sl, ctx));
  // Inventory: kept as is, except resin. v4 sold resin by the liter and stored 1000 g per liter;
  // resin weighs about 1.1 g/mL, so a liter is really 1100 g. Applied once, here.
  const inv = {};
  for (const [id, g] of Object.entries(old.inventory && typeof old.inventory === 'object' ? old.inventory : {})) {
    if (!isNum(g)) continue;
    const m = cat.material(id);
    inv[id] = m && m.category === 'resin' ? g * 1.1 : g;
  }
  s.inventory = inv;
  s.orders = (Array.isArray(old.orders) ? old.orders : []).filter((o) => o && typeof o === 'object').map((o) => orderV5(o, t, ctx));
  const printing = s.printers.filter((sl) => sl.job).length;
  Object.assign(s, {
    rng: Sim.seedFrom(day, s.nextOrderId, Math.round(hour * 1000)),
    humidity: { rh: 45, base: 45, daysLeft: 2 },
    wet: {}, stations: [], nextStationId: 1, ledger: Sim.newLedger(day), log: [],
    shopUpgrades: [], dryer: null,
    graceJobs: Math.max(0, Sim.GRACE_JOBS - (s.shipped || 0) - printing),
  });
  return s;
}

function slotV5(old, ctx) {
  const { cat, Sim } = ctx;
  const sl = { ...old };
  if (!cat.printerKnown(sl.printerId) && PRINTER_ALIASES[sl.printerId] && cat.printerKnown(PRINTER_ALIASES[sl.printerId])) {
    sl.printerId = PRINTER_ALIASES[sl.printerId];
  }
  const printer = cat.printer(sl.printerId);   // an unknown id comes back as the "Unknown machine" stub
  // Fields a v1-v3 save may lack, filled the way v4's own migrateSlot did.
  if (!isNum(sl.nozzleSize)) sl.nozzleSize = 0.4;
  if (typeof sl.nozzleHardened !== 'boolean') sl.nozzleHardened = V4_SHIPPED_HARDENED.has(sl.printerId);
  if (!isNum(sl.totalHours)) sl.totalHours = 0;
  if (!isNum(sl.wearHours)) sl.wearHours = sl.totalHours || 0;
  if (!isNum(sl.purchasePrice)) sl.purchasePrice = printer.price || 200;
  // New in v5. A v4 ruby (0.4 mm, hardened) becomes 0.4 mm hardened steel.
  sl.nozzleType = Sim.usesNozzle(printer) ? Sim.v4NozzleId(sl.nozzleSize, sl.nozzleHardened) : null;
  sl.nozzleHealth = 1;
  sl.bed = 1;
  sl.upgrades = [];
  const job = sl.job && typeof sl.job === 'object' ? sl.job : null;
  if (sl.state === 'printing' && job) {
    sl.job = jobV5(job, sl, ctx);
    sl.phase = sl.job.hoursElapsed >= sl.job.hoursTotal - 1e-9 ? 'done' : 'printing';
  } else {
    sl.state = 'idle';
    sl.job = null;
    sl.phase = 'idle';
  }
  return sl;
}

// A job already on the plate keeps its time and pay, can't fail, has no due time and ends in
// Done -> Collect (it ships on collect, whatever the machine).
function jobV5(old, slot, ctx) {
  const { cat, Sim } = ctx;
  const printer = cat.printer(slot.printerId);
  const mat = cat.material(old.materialId);
  const hoursTotal = isNum(old.hoursTotal) && old.hoursTotal > 0 ? old.hoursTotal : 1;
  const grams = isNum(old.grams) ? old.grams : 0;
  const costPerKg = mat ? (mat.costPerKg ?? 0) : 0;
  return {
    ...old,
    hoursTotal,
    hoursElapsed: isNum(old.hoursElapsed) ? Math.max(0, old.hoursElapsed) : 0,
    color: old.color || Sim.MODEL_PALETTE[Math.abs(old.orderId | 0) % Sim.MODEL_PALETTE.length],
    v: 4, grandfathered: true,
    phases: [{ id: 'print', h: hoursTotal }], finish: [], printHours: hoursTotal,
    quality: isNum(old.precision) ? old.precision : 0.5,
    chance: 1, fail: null, clogT: null, grace: true,
    watts: printer.powerW || 0, kwh: 0, usedGrams: grams, matCost: grams / 1000 * costPerKg,
    dueAt: null, customer: Sim.customerForId(old.orderId),
  };
}

function orderV5(old, t, ctx) {
  const { cat, Sim } = ctx;
  const o = { ...old };
  const deadline = isNum(o.deadlineHours) ? o.deadlineHours : 24;
  const product = cat.product(o.productId);
  if (!Array.isArray(o.materialOptions) || !o.materialOptions.length) o.materialOptions = o.materialId ? [o.materialId] : [];
  if (!o.materialId) o.materialId = o.materialOptions[0];
  o.dueAt = t + deadline;
  o.arrivedAt = t;
  o.heightMM = product && product.heightMM ? (product.heightMM[0] + product.heightMM[1]) / 2
    : (o.minBuildVolumeMM && isNum(o.minBuildVolumeMM[2]) ? o.minBuildVolumeMM[2] : 50);
  o.customer = Sim.customerForId(o.id);
  o.color = Sim.FIXED_COLORS[o.productId] || Sim.MODEL_PALETTE[Math.abs(o.id | 0) % Sim.MODEL_PALETTE.length];
  o.v = 4;
  return o;
}

// ---------------------------------------------------------------------
// Validation: the shapes the game relies on. Returns a list of problems (empty = fine).
// ---------------------------------------------------------------------
export function validate(s) {
  const p = [];
  if (!s || typeof s !== 'object') return ['not an object'];
  if (s.saveVersion !== SAVE_VERSION) p.push('saveVersion');
  for (const k of ['money', 'reputation', 'shipped', 'nextOrderInHours', 'nextOrderId', 'nextSlotId', 'rng', 'graceJobs']) {
    if (!isNum(s[k])) p.push(k);
  }
  if (!(Number.isInteger(s.day) && s.day >= 1)) p.push('day');
  if (!(isNum(s.hour) && s.hour >= 0 && s.hour < 24)) p.push('hour');
  if (!Array.isArray(s.printers)) p.push('printers');
  else s.printers.forEach((sl, i) => {
    if (!sl || typeof sl.printerId !== 'string' || !isNum(sl.slotId)) { p.push(`printers[${i}]`); return; }
    if (!PHASES.has(sl.phase)) p.push(`printers[${i}].phase`);
    if ((sl.phase === 'idle') !== (sl.state === 'idle')) p.push(`printers[${i}].state`);
    if (['heating', 'prep', 'printing', 'done', 'clogged', 'coldpull', 'failed'].includes(sl.phase) && !(sl.job && isNum(sl.job.hoursTotal) && isNum(sl.job.hoursElapsed))) {
      p.push(`printers[${i}].job`);
    }
  });
  if (!s.inventory || typeof s.inventory !== 'object' || Array.isArray(s.inventory) || Object.values(s.inventory).some((g) => !isNum(g))) p.push('inventory');
  if (!Array.isArray(s.orders) || s.orders.some((o) => !o || !isNum(o.id))) p.push('orders');
  if (!Array.isArray(s.stations)) p.push('stations');
  if (!Array.isArray(s.log)) p.push('log');
  if (!s.wet || typeof s.wet !== 'object') p.push('wet');
  if (!s.ledger || !isNum(s.ledger.day)) p.push('ledger');
  if (!s.humidity || !isNum(s.humidity.rh)) p.push('humidity');
  if (!Array.isArray(s.shopUpgrades)) p.push('shopUpgrades');
  return p;
}

function keepUnreadable(storage, raw) {
  for (let i = 1; i <= 9; i++) {
    const key = i === 1 ? UNREADABLE_KEY : `${UNREADABLE_KEY}-${i}`;
    if (safeGet(storage, key) === raw) return key;           // already kept
    if (safeGet(storage, key) == null) return safeSet(storage, key, raw) ? key : null;
  }
  return null;
}

// ---------------------------------------------------------------------
// load(storage, ctx): { state, notes[], source, fromVersion, fresh }
// ctx = { cat, Sim, newGame: () => state }
// ---------------------------------------------------------------------
export function load(storage, ctx) {
  const notes = [];
  let source = STATE_KEY;
  let raw = safeGet(storage, STATE_KEY);
  if (raw == null) {
    for (const key of OLD_KEYS) {
      const r = safeGet(storage, key);
      if (r != null && parse(r)) { raw = r; source = key; break; }
    }
  }
  if (raw == null) return { state: ctx.newGame(), notes, source: null, fromVersion: null, fresh: true };

  const obj = parse(raw);
  if (!obj) {
    const kept = source === STATE_KEY ? keepUnreadable(storage, raw) : source;
    notes.push({ kind: 'warn', text: `Your saved game could not be read, so a new game started.${kept ? ' The old save is kept in this browser.' : ''}` });
    return { state: ctx.newGame(), notes, source, fromVersion: null, fresh: true };
  }
  const fromVersion = obj.saveVersion >= 5 ? obj.saveVersion : 4;
  if (fromVersion < SAVE_VERSION && source === STATE_KEY && safeGet(storage, BACKUP_KEY) == null) safeSet(storage, BACKUP_KEY, raw);

  let state = null, problems;
  try {
    state = migrate(obj, ctx);
    problems = validate(state);
  } catch (e) {
    problems = ['migration threw: ' + (e && e.message)];
  }
  if (problems.length) {
    if (source === STATE_KEY && fromVersion >= SAVE_VERSION) keepUnreadable(storage, raw);
    notes.push({ kind: 'warn', problems, text: 'Your saved game could not be upgraded safely, so a new game started. The old save is kept in this browser.' });
    return { state: ctx.newGame(), notes, source, fromVersion, fresh: true };
  }
  if (source !== STATE_KEY) notes.push({ kind: 'info', text: 'Found your game from an older version of Print3D and brought it back.' });
  if (fromVersion < SAVE_VERSION) {
    notes.push({ kind: 'info', text: 'Your shop got a realism upgrade: printers heat up, parts get collected, and filament can get damp.' });
  }
  return { state, notes, source, fromVersion, fresh: false };
}
