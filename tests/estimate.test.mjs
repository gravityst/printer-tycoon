// Real time, cost and power for each technology: extrusion is timed by grams, vats and powder
// beds by height; powder use includes the refresh, power is watts x hours x $0.17.
import test from 'node:test';
import assert from 'node:assert/strict';
import { cat, Sim } from './helpers/catalog.mjs';

const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b}`);
const mid = (r) => (r[0] + r[1]) / 2;

function orderFor(productId, materialId, over = {}) {
  const p = cat.product(productId);
  return { id: 1, productId, productName: p.name, materialId, materialOptions: [materialId], grams: mid(p.grams), basePrice: p.basePrice,
    qualityValue: p.qualityValue, minPrecision: p.minPrecision, minBuildVolumeMM: p.minBuildVolumeMM, techRequired: p.tech,
    heightMM: mid(p.heightMM), dueAt: null, ...over };
}
function shop() { const s = Sim.newGame(cat, 1); s.wet = {}; return s; }
const est = (s, printerId, order, slotOver = {}) => Sim.estimateJob(cat, s, { ...Sim.makeSlot(cat, printerId, 1), ...slotOver }, order, order.materialId);

test('estimateJob returns phase hours, grams, material cost, kWh, power cost and what you keep', () => {
  const e = est(shop(), 'bambu-a1-mini', orderFor('phone-case', 'pla'));
  for (const k of ['phases', 'finish', 'machineHours', 'finishHours', 'usedGrams', 'matCost', 'kwh', 'powerCost', 'keep']) assert.ok(k in e, k);
  assert.deepEqual(e.phases.map((p) => p.id), ['heat', 'print']);
  near(e.keep, e.payout - e.matCost - e.powerCost, 1e-9, 'keep');
  near(e.powerCost, e.kwh * 0.17, 1e-12, 'power at $0.17/kWh');
});

test('16 minis take as long as 1 mini at the same height (a vat prints every part at once)', () => {
  const s = shop();
  const one = est(s, 'anycubic-photon-mono-m5s', orderFor('miniature-batch', 'resin-standard', { grams: 5 }));
  const sixteen = est(s, 'anycubic-photon-mono-m5s', orderFor('miniature-batch', 'resin-standard', { grams: 80 }));
  near(sixteen.machineHours, one.machineHours, 1e-9, 'same hours');
  assert.ok(sixteen.matCost > one.matCost * 15, 'but 16x the resin');
});

test('twice the grams means twice the print hours on an extrusion printer (+-1%)', () => {
  const s = shop();
  const a = est(s, 'bambu-p1s-ams', orderFor('decorative-vase', 'pla', { grams: 150 }));
  const b = est(s, 'bambu-p1s-ams', orderFor('decorative-vase', 'pla', { grams: 300 }));
  near(b.printHours / a.printHours, 2, 0.02, 'print ratio');
  near(b.phases[0].h, a.phases[0].h, 1e-12, 'same heat-up');
});

test('nozzle size changes extrusion time only', () => {
  const s = shop();
  const o = orderFor('decorative-vase', 'pla');
  const n04 = est(s, 'bambu-a1-mini', o), n06 = est(s, 'bambu-a1-mini', o, { nozzleType: 'b06', nozzleSize: 0.6 });
  near(n04.printHours / n06.printHours, 1.55, 1e-9, '0.6 mm is 1.55x faster');
  const r = orderFor('miniature-batch', 'resin-standard');
  const resinA = est(s, 'anycubic-photon-mono-m5s', r), resinB = est(s, 'anycubic-photon-mono-m5s', r, { nozzleType: 'b02', nozzleSize: 0.2 });
  assert.equal(resinA.machineHours, resinB.machineHours);
  const sl = Sim.makeSlot(cat, 'anycubic-photon-mono-m5s', 1);
  assert.equal(Sim.effectivePrecision(cat.printer(sl.printerId), { ...sl, nozzleSize: 0.2 }), cat.printer(sl.printerId).precision);
  assert.equal(sl.nozzleType, null);
});

test('an MJF connector batch takes at least 8 h on the machine, then cools', () => {
  const e = est(shop(), 'hp-mjf-5200', orderFor('mjf-connector-batch', 'mjf-pa12'));
  assert.ok(e.machineHours >= 8, `machine ${e.machineHours}`);
  const cool = e.finish.find((f) => f.id === 'cool');
  assert.ok(cool && cool.h > 0, 'cools off the printer');
  assert.ok(e.finish.some((f) => f.id === 'depowder'));
});

test('a PLA phone case on the Ender 3 V3 SE takes 2-4 h', () => {
  const e = est(shop(), 'ender-3-v3-se', orderFor('phone-case', 'pla'));
  assert.ok(e.machineHours >= 2 && e.machineHours <= 4, `${e.machineHours}`);
});

test('a P1S printing PLA costs $0.0179 an hour in power', () => {
  const e = est(shop(), 'bambu-p1s-ams', orderFor('decorative-vase', 'pla'));
  near(e.powerCost / e.machineHours, 0.01785, 0.0001, 'per hour');
  assert.equal(e.watts, 105);
  const abs = est(shop(), 'bambu-p1s-ams', orderFor('rc-car-body', 'abs'));
  assert.equal(abs.watts, 140, 'hot materials use the hot draw');
});

test('a Fuse 1+ uses 2.0x the part weight in powder (30% refresh)', () => {
  const o = orderFor('sls-production-batch', 'sls-pa12');
  const e = est(shop(), 'formlabs-fuse-1-plus-30w', o);
  near(e.usedGrams / o.grams, 2.0, 1e-9, 'powder factor');
  near(e.matCost, o.grams * 2 / 1000 * 100, 1e-9, 'cost');
  assert.equal(Sim.powderFactor(cat.printer('hp-mjf-5200'), cat.material('mjf-pa12')), 0.2 / 0.15);
});

test('vat and powder printers are timed by height; a powder bed stands a long part up', () => {
  const s = shop();
  const e = est(s, 'formlabs-form-4', orderFor('surgical-guide', 'resin-surgical-guide', { heightMM: 40 }));
  const print = e.phases.find((p) => p.id === 'print').h;
  near(print, Math.max(40, cat.product('surgical-guide').minBuildVolumeMM[2]) / (40 * 0.8), 1e-9, 'height / (mm per h x resin speed)');
  // A 280 mm orthotic fits the Fuse 1+ standing up (165 x 165 bed, 300 mm tall).
  const fuse = cat.printer('formlabs-fuse-1-plus-30w');
  const box = Sim.partBox(cat, orderFor('custom-orthotic', 'sls-tpu'));
  assert.ok(Sim.buildHeight(fuse, box) !== null);
  assert.equal(Sim.buildHeight(cat.printer('bambu-a1-mini'), [200, 100, 20]), null, 'an extrusion bed only turns parts flat');
});

test('Metal X parts wash 12-72 h and sinter; DMLS parts get stress relief; resin washes and cures', () => {
  const s = shop();
  const mx = Sim.estimateJob(cat, s, Sim.makeSlot(cat, 'markforged-metal-x', 1), orderFor('end-use-bracket', 'onyx'), 'onyx');
  const wash = mx.finish.find((f) => f.id === 'wash');
  assert.ok(wash.h >= 12 && wash.h <= 72);
  assert.ok(mx.finish.some((f) => f.id === 'sinter'));
  const dmls = est(s, 'eos-m290', orderFor('aerospace-bracket', 'metal-ti6al4v'));
  assert.deepEqual(dmls.finish.map((f) => f.id), ['relief']);
  const resin = est(s, 'formlabs-form-4', orderFor('jewelry-casting', 'resin-castable'));
  assert.deepEqual(resin.finish.map((f) => f.id), ['wash', 'cure']);
  near(resin.finishHours, 1, 1e-9, 'an hour by hand');
  s.shopUpgrades = ['washcure'];
  const station = est(s, 'formlabs-form-4', orderFor('jewelry-casting', 'resin-castable'));
  near(station.finishHours, 25 / 60, 1e-9, '25 minutes with the station');
});

test('a ruby nozzle installs over hardened 0.4; abrasive filament refuses a 0.2 mm nozzle', () => {
  const s = shop();
  s.money = 1000;
  s.printers = [Sim.makeSlot(cat, 'bambu-x1c-ams', 1)];
  assert.equal(s.printers[0].nozzleType, 'h04');
  const r = Sim.changeNozzle(cat, s, 0, 'r04');
  assert.ok(r.ok, r.reason);
  assert.equal(s.printers[0].nozzleType, 'r04');
  assert.equal(s.printers[0].nozzleHardened, true);
  assert.equal(s.money, 1000 - 90);
  Sim.changeNozzle(cat, s, 0, 'b02');
  s.inventory['pa-cf'] = 1000;
  const c = Sim.canAssign(cat, s, orderFor('drone-propeller', 'pa-cf'), s.printers[0]);
  assert.equal(c.code, 'nozzle');
  assert.ok(!/pa-cf/.test(c.reason), c.reason);
  // A resin machine has no nozzle to change.
  s.printers.push(Sim.makeSlot(cat, 'formlabs-form-4', 2));
  assert.equal(Sim.changeNozzle(cat, s, 1, 'b04').ok, false);
});

test('brass wears out on carbon fiber in about a third of a kilo; hardened steel barely notices', () => {
  const brass = Sim.makeSlot(cat, 'bambu-a1-ams-lite', 1);
  const hard = { ...brass, nozzleType: 'h04', nozzleHardened: true };
  const cf = cat.material('pa-cf');
  near(1 / Sim.nozzleWearPerGram(brass, cf), 333, 1, 'brass grams to worn out');
  assert.ok(1 / Sim.nozzleWearPerGram(hard, cf) > 20000);
  assert.equal(Sim.nozzleWearPerGram(brass, cat.material('pla')), 0);
});
