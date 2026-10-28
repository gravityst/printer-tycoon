// Sourced data corrections, every v4 id kept, and the catalog hangs together.
import test from 'node:test';
import assert from 'node:assert/strict';
import { cat, Sim, printersJson, materialsJson, productsJson } from './helpers/catalog.mjs';

const byId = (list) => Object.fromEntries(list.map((x) => [x.id, x]));
const P = byId(printersJson.printers), M = byId(materialsJson.materials), PD = byId(productsJson.products);

// v4's ids (repo HEAD ad80f2f). Nothing may disappear: saves refer to these.
const V4_PRINTERS = ['ender-3-v3-se', 'anycubic-kobra-2-neo', 'elegoo-neptune-4', 'sovol-sv06-plus', 'bambu-a1-mini', 'bambu-a1-ams-lite',
  'creality-k1', 'prusa-mk4s', 'bambu-p1s-ams', 'qidi-x-max-3', 'bambu-x1c-ams', 'bambu-x1e', 'bambu-h2d', 'prusa-xl-5tool', 'voron-2-4',
  'bcn3d-sigma-d25', 'elegoo-mars-5', 'anycubic-photon-mono-m5s', 'elegoo-saturn-4-ultra', 'phrozen-sonic-mighty-8k', 'formlabs-form-4',
  'markforged-mark-two', 'formlabs-fuse-1-plus-30w', 'markforged-metal-x', 'hp-mjf-5200', 'eos-m290'];
const V4_MATERIALS = ['pla', 'pla-plus', 'petg', 'tpu-95a', 'abs', 'asa', 'pc', 'nylon-pa12', 'pa-cf', 'peek', 'resin-standard', 'resin-tough',
  'resin-flexible', 'resin-castable', 'resin-engineering', 'onyx', 'nylon-white', 'fiber-carbon', 'fiber-kevlar', 'fiber-fiberglass', 'sls-pa12',
  'sls-pa11', 'sls-pa12-gf', 'sls-tpu', 'mjf-pa12', 'mjf-pa11', 'mjf-tpu', 'mjf-pa12-gb', 'metal-ss316l', 'metal-ss17-4ph', 'metal-h13',
  'metal-a2', 'metal-d2', 'metal-alsi10mg', 'metal-ti6al4v', 'metal-inconel-625', 'metal-inconel-718', 'metal-maraging', 'metal-copper'];
const V4_PRODUCTS = ['phone-case', 'cookie-cutter', 'plant-pot', 'wall-hook', 'articulated-toy', 'rc-car-body', 'drone-frame', 'decorative-vase',
  'lithophane-lamp', 'cosplay-accessory', 'miniature-batch', 'custom-grip-batch', 'jewelry-casting', 'functional-gear', 'robot-enclosure',
  'cosplay-helmet', 'drone-propeller', 'engineering-fixture', 'end-use-bracket', 'surgical-guide', 'dental-crown-wax', 'custom-orthotic',
  'sls-production-batch', 'mjf-connector-batch', 'biocompatible-device', 'aerospace-bracket', 'engine-cooling-channel', 'tooling-die',
  'heat-exchanger', 'surgical-implant'];

// Every value this round corrected (sources are in each record's notes / powerNote).
const CORRECTED = {
  printers: {
    'ender-3-v3-se': { baseReliability: 0.88, powerW: 100, stockNozzle: 'b04', powerMaxW: 350 },
    'anycubic-kobra-2-neo': { baseReliability: 0.86, powerW: 100 },
    'elegoo-neptune-4': { baseReliability: 0.87, powerW: 110, powerHotW: 180 },
    'sovol-sv06-plus': { maxSpeedMMs: 150, baseReliability: 0.88, powerW: 110 },
    'bambu-a1-mini': { multiMaterialColors: 0, baseReliability: 0.95, powerW: 80, powerMaxW: 150 },
    'bambu-a1-ams-lite': { baseReliability: 0.95, powerW: 95 },
    'creality-k1': { baseReliability: 0.9, powerW: 120 },
    'prusa-mk4s': { price: 999, baseReliability: 0.96, powerW: 80 },
    'bambu-p1s-ams': { baseReliability: 0.95, powerW: 105, powerHotW: 140, stockNozzle: 's04' },
    'qidi-x-max-3': { baseReliability: 0.92, powerW: 150, chamberC: 65, stockNozzle: 'h04' },
    'bambu-x1c-ams': { baseReliability: 0.96, powerW: 105, failureDetection: true, stockNozzle: 'h04' },
    'bambu-x1e': { baseReliability: 0.97, powerW: 185, chamberC: 60, failureDetection: true },
    'bambu-h2d': { buildVolumeMM: [325, 320, 325], maxSpeedMMs: 1000, multiMaterialColors: 2, baseReliability: 0.96, powerW: 197, chamberC: 65, failureDetection: true },
    'prusa-xl-5tool': { baseReliability: 0.95, powerW: 150 },
    'voron-2-4': { baseReliability: 0.95, powerW: 180 },
    'bcn3d-sigma-d25': { price: 3995, baseReliability: 0.93, powerW: 150 },
    'elegoo-mars-5': { price: 179, buildVolumeMM: [143.4, 89.6, 150], autoLevel: true, baseReliability: 0.8, powerW: 40, verticalMMPerHour: 20 },
    'anycubic-photon-mono-m5s': { price: 479, baseReliability: 0.84, powerW: 50, verticalMMPerHour: 35 },
    'elegoo-saturn-4-ultra': { autoLevel: true, powerW: 60, verticalMMPerHour: 30 },
    'phrozen-sonic-mighty-8k': { powerW: 60, verticalMMPerHour: 25 },
    'formlabs-form-4': { throughputCM3PH: null, baseReliability: 0.96, powerW: 100, verticalMMPerHour: 40 },
    'markforged-mark-two': { baseReliability: 0.94, powerW: 100, stockNozzle: 'h04' },
    'formlabs-fuse-1-plus-30w': { price: 24649, baseReliability: 0.95, powerW: 900, verticalMMPerHour: 13, failureDetection: true },
    'markforged-metal-x': { price: 124990, throughputCM3PH: null, throughputGPH: 35, baseReliability: 0.9, powerW: 300 },
    'hp-mjf-5200': { throughputCM3PH: 4010, baseReliability: 0.97, powerW: 12000, verticalMMPerHour: 37, failureDetection: true },
    'eos-m290': { baseReliability: 0.95, powerW: 2400, powerHotW: 3200, powerMaxW: 8500, verticalMMPerHour: 4, failureDetection: true },
  },
  materials: {
    pla: { dampHours55: 168, dryC: 55, dryHours: 8, speedFactor: 1 },
    petg: { printTempC: [240, 270], bedTempC: [60, 80], dampHours55: 48, dryC: 65, speedFactor: 0.85 },
    'tpu-95a': { printTempC: [200, 250], bedTempC: [30, 45], dampHours55: 10, dryC: 70, dryHours: 8, speedFactor: 0.45 },
    abs: { printTempC: [240, 280], bedTempC: [90, 100], dampHours55: 96 },
    asa: { printTempC: [240, 280], bedTempC: [90, 100] },
    pc: { printTempC: [260, 290], dampHours55: 24 },
    'nylon-pa12': { bedTempC: [100, 120], dampHours55: 10, dryHours: 12 },
    'pa-cf': { bedTempC: [100, 120], dampHours55: 10 },
    'resin-standard': { costPerKg: 20, costPerLiter: null },
    'resin-tough': { costPerKg: 82, costPerLiter: null },
    'resin-flexible': { costPerKg: 109, costPerLiter: null },
    'resin-castable': { costPerKg: 70, costPerLiter: null },
    'resin-engineering': { costPerKg: 180, costPerLiter: null },
    'fiber-carbon': { costPerKg: 2800 },
    'sls-pa12': { costPerKg: 100, refreshRate: 0.3 },
    'sls-tpu': { refreshRate: 0.2 },
    'mjf-pa12': { refreshRate: 0.2 },
    'metal-ss17-4ph': { costPerKg: 80 },
    'metal-alsi10mg': { costPerKg: 70 },
    'metal-ti6al4v': { costPerKg: 355 },
  },
  products: {
    'surgical-guide': { materials: ['resin-surgical-guide'] },
    'sls-production-batch': { grams: [800, 1800] },
    'surgical-implant': { minPrecision: 0.96 },
    'phone-case': { heightMM: [10, 14] },
    'mjf-connector-batch': { heightMM: [300, 380] },
  },
};

test('each corrected value is in the data', () => {
  const tables = { printers: P, materials: M, products: PD };
  for (const [file, rows] of Object.entries(CORRECTED)) {
    for (const [id, fields] of Object.entries(rows)) {
      for (const [k, v] of Object.entries(fields)) assert.deepEqual(tables[file][id][k], v, `${file} ${id}.${k}`);
    }
  }
});

test('id sets equal v4 plus the surgical guide resin', () => {
  assert.deepEqual(Object.keys(P).sort(), [...V4_PRINTERS].sort());
  assert.deepEqual(Object.keys(M).sort(), [...V4_MATERIALS, 'resin-surgical-guide'].sort());
  assert.deepEqual(Object.keys(PD).sort(), [...V4_PRODUCTS].sort());
  assert.equal(M['resin-surgical-guide'].category, 'resin');
  assert.equal(M['resin-surgical-guide'].biocompatible, true);
});

test('every printer material exists, every material has a player-facing label', () => {
  for (const p of printersJson.printers) for (const m of p.materials) assert.ok(M[m], `${p.id} lists unknown material ${m}`);
  for (const m of materialsJson.materials) assert.ok(typeof m.label === 'string' && m.label.length > 1, `${m.id} label`);
  for (const p of productsJson.products) for (const m of p.materials) assert.ok(M[m], `${p.id} lists unknown material ${m}`);
});

test('every product runs on at least one printer', () => {
  for (const p of cat.products) {
    assert.ok(p.materials.some((m) => Sim.catalogRunnable(cat, p, m)), `${p.id} has no machine`);
  }
});

test('no printer lists PEEK (no capable machine is left)', () => {
  for (const p of printersJson.printers) assert.ok(!p.materials.includes('peek'), p.id);
});

test('every FDM printer has a stock nozzle that exists; resin and powder machines have none', () => {
  for (const p of printersJson.printers) {
    if (Sim.usesNozzle(p)) assert.ok(Sim.nozzleType(p.stockNozzle), `${p.id} stockNozzle ${p.stockNozzle}`);
    else assert.equal(p.stockNozzle ?? null, null, p.id);
  }
});

test('1,000 seeded spawns pay basePrice x 0.85-1.30 x the material value, with no batch multiplier', () => {
  const s = Sim.newGame(cat, 2024);
  s.reputation = 500;   // everything unlocked
  s.graceJobs = 0;      // past the starter orders
  for (const id of ['bambu-a1-mini', 'bambu-p1s-ams', 'formlabs-form-4', 'formlabs-fuse-1-plus-30w', 'hp-mjf-5200', 'eos-m290', 'markforged-mark-two']) {
    s.printers.push(Sim.makeSlot(cat, id, s.nextSlotId++));
  }
  let grips = 0;
  for (let i = 0; i < 1000; i++) {
    s.orders = [];
    Sim.spawnOrder(cat, s);
    const o = s.orders[0];
    const p = cat.product(o.productId);
    const ratio = Sim.valueRatio(cat, p, o.materialId);
    const lo = p.basePrice * 0.85 * ratio - 1e-9, hi = p.basePrice * 1.30 * ratio + 1e-9;
    assert.ok(o.basePrice >= lo && o.basePrice <= hi, `${o.productId} in ${o.materialId}: ${o.basePrice}`);
    assert.equal(o.materialOptions.length, 1, 'one named material');
    assert.ok(p.materials.includes(o.materialId));
    assert.ok(Sim.catalogRunnable(cat, p, o.materialId), `${o.productId} spawned in ${o.materialId}, which nothing can print`);
    if (o.productId === 'custom-grip-batch') {
      grips++;
      assert.ok(o.basePrice >= 297.5 - 1e-9 && o.basePrice <= 455 + 1e-9, `grip batch $${o.basePrice}`);
    }
  }
  assert.ok(grips > 0, 'saw some grip batches');
});

test('starter orders can be printed straight away from what is on the shelf', () => {
  for (let seed = 1; seed <= 200; seed++) {
    const s = Sim.newGame(cat, seed);
    Sim.spawnOrder(cat, s);
    const o = s.orders[0];
    assert.ok(Sim.canAssign(cat, s, o, s.printers[0]).ok, `seed ${seed}: ${o.productId} in ${o.materialId}`);
  }
});
