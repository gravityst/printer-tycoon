// Job lifecycle: idle -> heating -> printing -> done -> Collect; finishing off the printer;
// late pay; orders that wait too long; the midnight ledger.
import test from 'node:test';
import assert from 'node:assert/strict';
import { cat, Sim } from './helpers/catalog.mjs';

const mid = (r) => (r[0] + r[1]) / 2;
function orderFor(s, productId, materialId, over = {}) {
  const p = cat.product(productId);
  const t = Sim.now(s);
  const o = { id: s.nextOrderId++, productId, productName: p.name, category: p.category, materialId, materialOptions: [materialId],
    grams: mid(p.grams), basePrice: p.basePrice, qualityValue: p.qualityValue, minPrecision: p.minPrecision,
    minBuildVolumeMM: p.minBuildVolumeMM, techRequired: p.tech, heightMM: mid(p.heightMM), deadlineHours: 200, arrivedAt: t, dueAt: t + 200,
    customer: 'Mia', color: '#3b82f6', ...over };
  s.orders.push(o);
  return o;
}
function shopWith(printerId, extra = {}) {
  const s = Sim.newGame(cat, 5);
  s.printers = [Sim.makeSlot(cat, printerId, 1)];
  s.money = 10000;
  s.nextOrderInHours = 1e9;   // no surprise customers
  s.graceJobs = 3;            // nothing fails
  s.inventory = { pla: 5000, 'resin-standard': 5000, 'sls-pa12': 50000, 'metal-ti6al4v': 5000, onyx: 5000, ...extra };
  return s;
}
function runUntil(s, pred, maxH = 500, dt = 0.25) {
  const events = [];
  for (let h = 0; h < maxH && !pred(); h += dt) events.push(...Sim.step(cat, s, dt).events);
  return events;
}

test('an FDM job goes idle -> heating -> printing -> done, and ships on Collect', () => {
  const s = shopWith('ender-3-v3-se');
  const o = orderFor(s, 'phone-case', 'pla');
  const seen = new Set([s.printers[0].phase]);
  assert.ok(Sim.assign(cat, s, o.id, 0).ok);
  for (let i = 0; i < 400 && s.printers[0].phase !== 'done'; i++) { Sim.step(cat, s, 0.02); seen.add(s.printers[0].phase); }
  assert.deepEqual([...seen], ['idle', 'heating', 'printing', 'done']);
  assert.equal(Sim.slotStatus(cat, s, s.printers[0]).action.id, 'collect');
  const money = s.money, rep = s.reputation;
  const r = Sim.collect(cat, s, 0);
  const shipped = r.events.find((e) => e.type === 'shipped');
  assert.ok(shipped);
  assert.ok(s.money > money);
  assert.ok(s.reputation > rep);
  assert.equal(s.printers[0].phase, 'idle');
  assert.equal(s.stations.length, 0);
  assert.match(shipped.text, /^Shipped Mia's Custom Phone Case: \+\$/);
});

test('resin parts wash and cure off the printer (1 h by hand, 25 min with the station)', () => {
  for (const [station, hours] of [[false, 1], [true, 25 / 60]]) {
    const s = shopWith('elegoo-saturn-4-ultra');
    if (station) s.shopUpgrades = ['washcure'];
    const o = orderFor(s, 'miniature-batch', 'resin-standard');
    Sim.assign(cat, s, o.id, 0);
    assert.equal(s.printers[0].phase, 'prep');
    runUntil(s, () => s.printers[0].phase === 'done');
    const r = Sim.collect(cat, s, 0);
    assert.equal(r.events[0].type, 'finishing');
    assert.match(r.events[0].text, /washing and curing/);
    assert.equal(s.printers[0].phase, 'idle', 'the printer is free while the part finishes');
    assert.equal(s.stations.length, 1);
    const t0 = Sim.now(s);
    const ev = runUntil(s, () => s.stations.length === 0, 5, 1 / 120);
    const shipped = ev.find((e) => e.type === 'shipped');
    assert.ok(shipped, 'ships when finishing is done');
    assert.ok(Math.abs(shipped.at - t0 - hours) < 1e-6, `${shipped.at - t0} h`);
  }
});

test('powder cools and depowders; Metal X washes and sinters; DMLS gets stress relief', () => {
  const cases = [
    ['formlabs-fuse-1-plus-30w', 'sls-production-batch', 'sls-pa12', ['cool', 'depowder']],
    ['markforged-metal-x', 'end-use-bracket', 'metal-ss17-4ph', ['wash', 'sinter']],   // no product names ADAM yet, so the order is made by hand
    ['eos-m290', 'aerospace-bracket', 'metal-ti6al4v', ['relief']],
  ];
  for (const [printerId, productId, mat, finish] of cases) {
    const s = shopWith(printerId, { [mat]: 50000 });
    orderFor(s, productId, mat, { techRequired: [cat.printer(printerId).tech], minPrecision: 0 });
    const id = s.orders[0].id;
    const a = Sim.assign(cat, s, id, 0);
    assert.ok(a.ok, `${printerId}: ${a.reason}`);
    runUntil(s, () => s.printers[0].phase === 'done', 400, 0.5);
    const job = s.printers[0].job;
    assert.deepEqual(job.finish.map((f) => f.id), finish, printerId);
    Sim.collect(cat, s, 0);
    assert.equal(s.stations.length, 1, `${printerId} part goes to finishing`);
    const ev = runUntil(s, () => s.stations.length === 0, 200, 0.5);
    assert.ok(ev.some((e) => e.type === 'shipped'), `${printerId} ships after finishing`);
  }
});

test('late delivery pays 75%, more than a day late pays 50%, and gives no rep', () => {
  for (const [lateBy, factor] of [[0, 1], [5, 0.75], [30, 0.5]]) {
    const s = shopWith('bambu-a1-mini');
    const o = orderFor(s, 'cookie-cutter', 'pla');
    Sim.assign(cat, s, o.id, 0);
    runUntil(s, () => s.printers[0].phase === 'done', 50, 0.05);
    const job = s.printers[0].job;
    job.dueAt = Sim.now(s) - lateBy;
    const rep = s.reputation;
    const r = Sim.collect(cat, s, 0);
    const shipped = r.events.find((e) => e.type === 'shipped');
    const full = o.basePrice * Sim.qualityMult(o.qualityValue, job.quality);
    assert.ok(Math.abs(shipped.payout - full * factor) < 1e-9, `late ${lateBy}: ${shipped.payout} vs ${full * factor}`);
    if (factor < 1) {
      assert.equal(s.reputation, rep, 'no rep when late');
      assert.match(shipped.text, /late: paid \d+%/);
    } else assert.ok(s.reputation > rep);
  }
});

test('rep: +1 delivered, +1 on time, +1 for 90% quality, plus a small bonus for big jobs', () => {
  const s = shopWith('formlabs-form-4');
  s.inventory['resin-castable'] = 1000;
  const o = orderFor(s, 'jewelry-casting', 'resin-castable', { basePrice: 2000 });
  Sim.assign(cat, s, o.id, 0);
  runUntil(s, () => s.printers[0].phase === 'done');
  Sim.collect(cat, s, 0);
  const ev = runUntil(s, () => s.stations.length === 0, 5, 0.05);
  const shipped = ev.find((e) => e.type === 'shipped');
  assert.equal(shipped.rep, 1 + 1 + 1 + Math.floor(Math.log2(2000 / 250)));
});

test("an order nobody takes leaves with '<name> found another shop', costing at most 1 rep, never below 0", () => {
  const s = shopWith('ender-3-v3-se');
  s.reputation = 1;
  orderFor(s, 'phone-case', 'pla', { dueAt: Sim.now(s) + 2, customer: 'Mia' });
  orderFor(s, 'cookie-cutter', 'pla', { dueAt: Sim.now(s) + 3, customer: 'Leo' });
  const ev = Sim.step(cat, s, 4).events.filter((e) => e.type === 'expired');
  assert.deepEqual(ev.map((e) => e.text), ['Mia found another shop (-1 rep)', 'Leo found another shop']);
  assert.equal(s.reputation, 0);
  assert.equal(s.orders.length, 0);
  // An order the shop could never make costs nothing.
  s.reputation = 10;
  orderFor(s, 'aerospace-bracket', 'metal-ti6al4v', { dueAt: Sim.now(s) + 1 });
  Sim.step(cat, s, 2);
  assert.equal(s.reputation, 10);
});

test('the midnight ledger books income, materials, power and scrap; a bill never takes cash below $0', () => {
  const s = shopWith('bambu-a1-ams-lite');
  s.hour = 1;
  const o = orderFor(s, 'decorative-vase', 'pla');
  Sim.assign(cat, s, o.id, 0);
  runUntil(s, () => s.printers[0].phase === 'done', 30, 0.25);
  Sim.collect(cat, s, 0);
  const ev = Sim.step(cat, s, 24 - s.hour + 0.01).events;
  const closed = ev.find((e) => e.type === 'dayClosed');
  assert.ok(closed);
  const L = closed.ledger;
  assert.ok(L.income > 0 && L.materials > 0 && L.kwh > 0 && L.power > 0);
  assert.ok(Math.abs(L.power - L.kwh * 0.17) < 1e-12);
  assert.ok(Math.abs(L.net - (L.income - L.materials - L.power - L.scrap)) < 1e-9);
  assert.match(closed.text, /^Day 1 closed: income \$[\d.]+ · materials \$[\d.]+ · power \$[\d.]+( · scrap \$[\d.]+)? · net \$[\d.]+/);
  assert.equal(/scrap/.test(closed.text), L.scrap >= 0.005, 'scrap is listed only on a day something was scrapped');
  // A big power bill with no cash: money stops at $0 and the rest waits for the next sale.
  const poor = shopWith('hp-mjf-5200', { 'mjf-pa12': 20000 });
  poor.money = 3;
  const job = orderFor(poor, 'mjf-connector-batch', 'mjf-pa12');
  Sim.assign(cat, poor, job.id, 0);
  const days = Sim.step(cat, poor, 30).events.filter((e) => e.type === 'dayClosed');
  assert.ok(days.length >= 1);
  assert.equal(poor.money, 0);
  assert.ok(poor.ledger.owed > 0);
  assert.match(days[0].text, /waits for the next sale/);
  const owed = poor.ledger.owed;
  runUntil(poor, () => poor.printers[0].phase === 'done', 50, 0.5);
  Sim.collect(cat, poor, 0);
  const shipped = runUntil(poor, () => poor.stations.length === 0, 50, 0.5).find((e) => e.type === 'shipped');
  assert.ok(shipped);
  assert.ok(poor.ledger.owed < owed, 'the next sale pays the bill');
});

test('quiet days close their books without a log line', () => {
  const s = shopWith('ender-3-v3-se');
  const ev = Sim.step(cat, s, 48).events.filter((e) => e.type === 'dayClosed');
  assert.equal(ev.length, 2);
  assert.ok(ev.every((e) => e.log === false));
  Sim.appendLog(s, ev);
  assert.equal(s.log.length, 0);
});

test('Collect all collects every finished printer', () => {
  const s = shopWith('bambu-a1-mini');
  s.printers.push(Sim.makeSlot(cat, 'bambu-a1-mini', 2));
  for (let i = 0; i < 2; i++) Sim.assign(cat, s, orderFor(s, 'cookie-cutter', 'pla').id, i);
  runUntil(s, () => s.printers.every((p) => p.phase === 'done'), 20, 0.1);
  const r = Sim.collectAll(cat, s);
  assert.equal(r.events.filter((e) => e.type === 'shipped').length, 2);
  assert.ok(s.printers.every((p) => p.phase === 'idle'));
});
