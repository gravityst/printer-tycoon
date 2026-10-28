// Damp filament, humidity spells, the dryer, the dry box and the other upgrades.
import test from 'node:test';
import assert from 'node:assert/strict';
import { cat, Sim } from './helpers/catalog.mjs';

function shopAt(rh, extra = {}) {
  const s = Sim.newGame(cat, 3);
  s.humidity = { rh, base: rh, daysLeft: 1e9 };   // hold the weather still
  s.nextOrderInHours = 1e9;
  s.money = 5000;
  s.inventory = { pla: 1000, petg: 1000, 'tpu-95a': 1000, 'nylon-pa12': 1000, abs: 1000, ...extra };
  return s;
}
// Hours on the shelf until a spool counts as damp (wetness 0.5).
function hoursToDamp(s, id, dt = 0.5) {
  for (let h = 0; h < 24 * 60; h += dt) {
    Sim.step(cat, s, dt);
    s.humidity.rh = s.humidity.base;   // midnight re-rolls the weather; keep it fixed for the measurement
    s.humidity.daysLeft = 1e9;
    if (Sim.wetOf(s, id) >= Sim.DAMP_AT) return h + dt;
  }
  return Infinity;
}

test('at 55% RH: TPU and nylon are damp in 8-12 h, PETG in about 2 days, PLA in about a week', () => {
  const at55 = (id) => hoursToDamp(shopAt(55), id);
  for (const id of ['tpu-95a', 'nylon-pa12']) { const h = at55(id); assert.ok(h >= 8 && h <= 12, `${id} ${h}`); }
  const petg = at55('petg');
  assert.ok(petg >= 40 && petg <= 56, `petg ${petg}`);
  const pla = at55('pla');
  assert.ok(pla >= 6 * 24 && pla <= 8 * 24, `pla ${pla}`);
  // Drier air is slower, wetter air is faster.
  assert.ok(hoursToDamp(shopAt(35), 'tpu-95a') > hoursToDamp(shopAt(75), 'tpu-95a'));
});

test('a dry box slows water uptake at least 5x', () => {
  const open = hoursToDamp(shopAt(55), 'tpu-95a', 0.25);
  const boxed = shopAt(55);
  boxed.shopUpgrades = ['drybox'];
  const inBox = hoursToDamp(boxed, 'tpu-95a', 0.25);
  assert.ok(inBox >= 5 * open, `${inBox} vs ${open}`);
});

test('new stock arrives dry and blends with what is on the shelf by weight', () => {
  const s = shopAt(55);
  s.wet['tpu-95a'] = 0.8;
  Sim.buyMaterial(cat, s, 'tpu-95a', 1);   // 1000 g damp + 1000 g dry
  assert.ok(Math.abs(Sim.wetOf(s, 'tpu-95a') - 0.4) < 1e-12);
  const fresh = shopAt(55, { petg: 0 });
  fresh.wet.petg = 0.9;
  Sim.buyMaterial(cat, fresh, 'petg', 1);
  assert.equal(Sim.wetOf(fresh, 'petg'), 0);
});

test('the dryer dries one spool to its spec time and temperature, billed as power', () => {
  const s = shopAt(55);
  s.wet['nylon-pa12'] = 1;
  assert.equal(Sim.startDrying(cat, s, 'nylon-pa12').ok, false, 'needs a dryer');
  assert.ok(Sim.buyUpgrade(cat, s, 'dryer').ok);
  const r = Sim.startDrying(cat, s, 'nylon-pa12');
  assert.ok(r.ok);
  assert.match(r.events[0].text, /Drying nylon \(PA12\): 12 h at 80 °C/);
  assert.equal(Sim.startDrying(cat, s, 'tpu-95a').ok, false, 'one spool at a time');
  Sim.step(cat, s, 6);
  assert.ok(Math.abs(Sim.wetOf(s, 'nylon-pa12') - 0.5) < 1e-9, 'half dry halfway');
  const kwhBefore = s.ledger.kwh;
  const ev = Sim.step(cat, s, 6).events;
  assert.equal(Sim.wetOf(s, 'nylon-pa12'), 0, 'bone dry when the dryer finishes');
  assert.ok(ev.some((e) => e.type === 'dried'));
  assert.equal(s.dryer, null);
  assert.ok(Math.abs(s.ledger.kwh - kwhBefore - 0.06 * 6) < 1e-9, 'the dryer drew 60 W');
  Sim.step(cat, s, 2);
  assert.ok(Sim.wetOf(s, 'nylon-pa12') > 0, 'and starts soaking up water again on the shelf');
});

test('humidity runs in spells between 30% and 75% and shows up in the risk', () => {
  const s = Sim.newGame(cat, 9);
  s.nextOrderInHours = 1e9;
  const seen = [];
  for (let d = 0; d < 120; d++) { Sim.step(cat, s, 24); seen.push(s.humidity.rh); }
  assert.ok(seen.every((x) => x >= 30 && x <= 75));
  assert.ok(Math.max(...seen) - Math.min(...seen) > 20, 'it changes');
  let runs = 0;
  for (let i = 1; i < seen.length; i++) if (Math.abs(seen[i] - seen[i - 1]) <= 8) runs++;
  assert.ok(runs / (seen.length - 1) > 0.6, 'mostly day-to-day drift within a spell');
  // A damp spool shows as the risk to fix.
  const t = shopAt(55);
  t.graceJobs = 0;
  t.printers = [Sim.makeSlot(cat, 'bambu-a1-mini', 1)];
  t.wet['tpu-95a'] = 1;
  const p = cat.product('phone-case');
  const o = { id: 1, productId: 'phone-case', productName: p.name, materialId: 'tpu-95a', materialOptions: ['tpu-95a'], grams: 35, basePrice: 18,
    qualityValue: p.qualityValue, minPrecision: p.minPrecision, minBuildVolumeMM: p.minBuildVolumeMM, techRequired: p.tech, heightMM: 12 };
  const est = Sim.estimateJob(cat, t, t.printers[0], o, 'tpu-95a');
  const risk = Sim.jobRisk(cat, t, t.printers[0], o, est);
  assert.match(risk.text, /^8\d% · TPU is damp \(dry it\)$/);
  assert.ok(est.quality < Sim.estimateJob(cat, { ...t, wet: {} }, t.printers[0], o, 'tpu-95a').quality, 'damp filament strings');
});

test('the five upgrades: prices, where they fit, and that they are saved', () => {
  const ids = Sim.UPGRADES.map((u) => u.id);
  assert.deepEqual(ids, ['enclosure', 'camera', 'dryer', 'drybox', 'washcure']);
  const s = shopAt(50);
  s.printers = [Sim.makeSlot(cat, 'bambu-a1-mini', 1), Sim.makeSlot(cat, 'bambu-x1c-ams', 2), Sim.makeSlot(cat, 'formlabs-form-4', 3)];
  assert.ok(Sim.buyUpgrade(cat, s, 'enclosure', 0).ok);
  assert.ok(Sim.buyUpgrade(cat, s, 'camera', 0).ok);
  assert.equal(Sim.buyUpgrade(cat, s, 'enclosure', 1).ok, false, 'the X1C is already enclosed');
  assert.equal(Sim.buyUpgrade(cat, s, 'camera', 1).ok, false, 'the X1C already watches its prints');
  assert.equal(Sim.buyUpgrade(cat, s, 'camera', 2).ok, false, 'a resin printer takes no camera');
  assert.ok(Sim.buyUpgrade(cat, s, 'washcure').ok);
  assert.equal(Sim.buyUpgrade(cat, s, 'washcure').ok, false, 'only one');
  assert.equal(s.money, 5000 - 80 - 45 - 160);
  const saved = JSON.parse(JSON.stringify(s));
  assert.deepEqual(saved.printers[0].upgrades, ['enclosure', 'camera']);
  assert.deepEqual(saved.shopUpgrades, ['washcure']);
  assert.ok(Sim.detects(cat.printer('bambu-a1-mini'), saved.printers[0]));
  assert.equal(Sim.warmthOf(cat.printer('bambu-a1-mini'), saved.printers[0]), 0.55);
});
