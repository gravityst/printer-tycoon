// Saves survive anything: every v4 field kept, migrations idempotent, resin converted once,
// unknown machines kept, unreadable saves kept, old keys rescued, a throwing storage tolerated.
import test from 'node:test';
import assert from 'node:assert/strict';
import { cat, Sim, FIXTURES, fixture, fixtureText } from './helpers/catalog.mjs';
import * as Save from '../docs/save.js';

const ctx = { cat, Sim, newGame: () => Sim.newGame(cat, 99) };

class MemoryStorage {
  constructor(init = {}) { this.map = new Map(Object.entries(init)); this.writes = []; }
  getItem(k) { return this.map.has(k) ? this.map.get(k) : null; }
  setItem(k, v) { this.writes.push(k); this.map.set(k, String(v)); }
  removeItem(k) { this.map.delete(k); }
}
class ThrowingStorage {
  getItem() { throw new Error('SecurityError'); }
  setItem() { throw new Error('QuotaExceededError'); }
}

const TOP = ['money', 'day', 'hour', 'reputation', 'shipped', 'nextOrderInHours', 'nextOrderId', 'nextSlotId'];
const SLOT = ['printerId', 'slotId', 'state', 'nozzleSize', 'nozzleHardened', 'totalHours', 'wearHours', 'purchasePrice'];

for (const name of FIXTURES) {
  test(`${name}: every v4 field survives the migration`, () => {
    const v4 = fixture(name);
    const v5 = Save.migrate(v4, ctx);
    for (const k of TOP) assert.deepEqual(v5[k], v4[k], k);
    assert.equal(v5.printers.length, v4.printers.length);
    v4.printers.forEach((old, i) => {
      const sl = v5.printers[i];
      for (const k of SLOT) assert.deepEqual(sl[k], old[k], `printers[${i}].${k}`);
      if (old.job) for (const [k, v] of Object.entries(old.job)) assert.deepEqual(sl.job[k], v, `printers[${i}].job.${k}`);
      else assert.equal(sl.job, null);
    });
    assert.deepEqual(Object.keys(v5.inventory).sort(), Object.keys(v4.inventory).sort());
    for (const [id, g] of Object.entries(v4.inventory)) {
      const resin = cat.material(id).category === 'resin';
      assert.equal(v5.inventory[id], resin ? g * 1.1 : g, id);
    }
    assert.equal(v5.orders.length, v4.orders.length);
    v4.orders.forEach((o, i) => {
      for (const [k, v] of Object.entries(o)) assert.deepEqual(v5.orders[i][k], v, `orders[${i}].${k}`);
      const t = (v4.day - 1) * 24 + v4.hour;
      assert.ok(Math.abs(v5.orders[i].dueAt - (t + o.deadlineHours)) < 1e-9, 'dueAt = now + deadlineHours');
    });
    assert.deepEqual(Save.validate(v5), []);
  });

  test(`${name}: migrate(migrate(x)) deep-equals migrate(x), and the input is untouched`, () => {
    const v4 = fixture(name);
    const before = JSON.stringify(v4);
    const once = Save.migrate(v4, ctx);
    assert.equal(JSON.stringify(v4), before);
    assert.deepEqual(Save.migrate(once, ctx), once);
    assert.deepEqual(Save.migrate(JSON.parse(JSON.stringify(once)), ctx), once);
  });
}

test('save-before keeps its $34,010 and 721 rep (no clawback), resin x1.1 exactly once', () => {
  const v5 = Save.migrate(fixture('save-before'), ctx);
  assert.equal(v5.money, 34010.436924824564);
  assert.equal(v5.reputation, 721);
  assert.equal(v5.inventory['resin-standard'], 838.4838549140841 * 1.1);
  assert.equal(Save.migrate(v5, ctx).inventory['resin-standard'], 838.4838549140841 * 1.1);
});

test('slots gain nozzle types from size + hardened; non-nozzle machines get none', () => {
  const v5 = Save.migrate(fixture('save-before'), ctx);
  const by = Object.fromEntries(v5.printers.map((s) => [s.printerId, s]));
  assert.equal(by['ender-3-v3-se'].nozzleType, 'b04');
  assert.equal(by['bambu-a1-mini'].nozzleType, 'b06');
  assert.equal(by['bambu-p1s-ams'].nozzleType, 'h04');       // factory-hardened in v4, kept (corrected stock nozzles are for new purchases)
  assert.equal(by['anycubic-photon-mono-m5s'].nozzleType, null);
  for (const s of v5.printers) {
    assert.equal(s.nozzleHealth, 1);
    assert.equal(s.bed, 1);
    assert.deepEqual(s.upgrades, []);
  }
  assert.equal(Sim.v4NozzleId(0.4, true), 'h04');               // a v4 ruby (0.4 hardened) becomes h04
  assert.equal(Sim.makeSlot(cat, 'bambu-p1s-ams', 9).nozzleType, 's04');
});

test('printing jobs are grandfathered: same hours and pay, no failure, no due time, Done then Collect', () => {
  const s = Save.migrate(fixture('save-before'), ctx);
  const idx = s.printers.findIndex((x) => x.printerId === 'bambu-p1s-ams');
  const job = s.printers[idx].job;
  assert.equal(job.grandfathered, true);
  assert.equal(job.fail, null);
  assert.equal(job.dueAt, null);
  assert.equal(s.printers[idx].phase, 'printing');
  const moneyBefore = s.money;
  for (let i = 0; i < 20; i++) Sim.step(cat, s, 0.25);
  assert.equal(s.printers[idx].phase, 'done');
  assert.equal(s.money, moneyBefore - 0, 'nothing pays until collected');
  const r = Sim.collect(cat, s, idx);
  assert.ok(r.ok);
  const shipped = r.events.find((e) => e.type === 'shipped');
  assert.ok(shipped, 'FDM ships on collect');
  assert.ok(Math.abs(shipped.payout - 63.38988985633478 * (1 - 0.7 + 0.7 * 0.86)) < 1e-9);
  // The grandfathered resin job ships on collect too (no wash/cure for a job started before v5).
  const m5 = s.printers.findIndex((x) => x.printerId === 'anycubic-photon-mono-m5s');
  for (let i = 0; i < 40 && s.printers[m5].phase !== 'done'; i++) Sim.step(cat, s, 0.25);
  const r2 = Sim.collect(cat, s, m5);
  assert.ok(r2.events.some((e) => e.type === 'shipped'));
  assert.equal(s.stations.length, 0);
});

test('a v4 multi-material order uses the first option in stock', () => {
  const s = Save.migrate(fixture('save-early'), ctx);
  const order = s.orders[0];
  assert.deepEqual(order.materialOptions, ['tpu-95a', 'petg', 'pla']);
  const mini = s.printers.findIndex((x) => x.printerId === 'bambu-a1-mini');
  const c = Sim.canAssign(cat, s, order, s.printers[mini]);
  assert.ok(c.ok, c.reason);
  assert.equal(c.materialId, 'pla');
});

test("'gone-printer' keeps its slot as an Unknown machine that can still be sold", () => {
  const v4 = fixture('save-before');
  v4.printers[0].printerId = 'gone-printer';
  const s = Save.migrate(v4, ctx);
  assert.equal(s.printers.length, 4);
  assert.equal(s.printers[0].printerId, 'gone-printer');
  assert.equal(s.printers[0].purchasePrice, 199);
  assert.deepEqual(Save.validate(s), []);
  const p = cat.printer('gone-printer');
  assert.equal(p.unknown, true);
  assert.equal(p.model, 'Unknown machine');
  const status = Sim.slotStatus(cat, s, s.printers[0]);
  assert.match(status.line, /^Retired · it can't take orders$/);
  assert.equal(Sim.canAssign(cat, s, s.orders[1], s.printers[0]).code, 'unknown');
  const before = s.money;
  const sold = Sim.sellPrinter(cat, s, 0);
  assert.ok(sold.ok);
  assert.equal(s.money, before + Sim.calcSellPrice(cat, { ...v4.printers[0] }));
  assert.ok(!sold.events[0].text.includes('gone-printer'));
});

test('the alias table renames an old printer id', () => {
  const v4 = fixture('save-fresh');
  v4.printers[0].printerId = 'ender-3-v3-se-old';
  Save.PRINTER_ALIASES['ender-3-v3-se-old'] = 'ender-3-v3-se';
  try {
    const s = Save.migrate(v4, ctx);
    assert.equal(s.printers[0].printerId, 'ender-3-v3-se');
  } finally {
    delete Save.PRINTER_ALIASES['ender-3-v3-se-old'];
  }
});

test('unknown material and product ids are kept', () => {
  const v4 = fixture('save-early');
  v4.inventory['mystery-filament'] = 250;
  v4.orders[0].productId = 'retired-product';
  const s = Save.migrate(v4, ctx);
  assert.equal(s.inventory['mystery-filament'], 250);
  assert.equal(s.orders[0].productId, 'retired-product');
  assert.deepEqual(Save.validate(s), []);
});

test('load: a v4 save is backed up once, migrated and validated', () => {
  const raw = fixtureText('save-before');
  const st = new MemoryStorage({ [Save.STATE_KEY]: raw });
  const r = Save.load(st, ctx);
  assert.equal(r.fresh, false);
  assert.equal(r.fromVersion, 4);
  assert.equal(st.getItem(Save.BACKUP_KEY), raw);
  assert.equal(r.state.money, 34010.436924824564);
  // The game saves v5 under the same key; the next load leaves the backup alone.
  st.setItem(Save.STATE_KEY, JSON.stringify(r.state));
  const r2 = Save.load(st, ctx);
  assert.equal(r2.fromVersion, 5);
  assert.equal(st.getItem(Save.BACKUP_KEY), raw);
  assert.deepEqual(r2.state, r.state);
});

test('load: an unreadable save is kept (never overwritten) and a new game starts with a note', () => {
  const st = new MemoryStorage({ [Save.STATE_KEY]: '{"money": 12, "day": 3, ' });
  const r = Save.load(st, ctx);
  assert.equal(r.fresh, true);
  assert.equal(st.getItem(Save.UNREADABLE_KEY), '{"money": 12, "day": 3, ');
  assert.match(r.notes[0].text, /could not be read/);
  st.setItem(Save.STATE_KEY, 'not json at all');
  Save.load(st, ctx);
  assert.equal(st.getItem(Save.UNREADABLE_KEY), '{"money": 12, "day": 3, ', 'first copy untouched');
  assert.equal(st.getItem(Save.UNREADABLE_KEY + '-2'), 'not json at all');
});

test('load: with no v4 save, the newest of v3/v2/v1 is adopted and its key left alone', () => {
  const v1 = { money: 77, day: 4, hour: 9, reputation: 3, shipped: 2, printers: [{ printerId: 'ender-3-v3-se', slotId: 1, state: 'idle', job: null }],
    inventory: { pla: 500 }, orders: [], nextOrderInHours: 1, nextOrderId: 5 };
  const v3 = { ...v1, money: 88, nextSlotId: 2 };
  const st = new MemoryStorage({ 'printer-tycoon-state-v1': JSON.stringify(v1), 'printer-tycoon-state-v3': JSON.stringify(v3) });
  const r = Save.load(st, ctx);
  assert.equal(r.source, 'printer-tycoon-state-v3');
  assert.equal(r.state.money, 88);
  assert.equal(st.getItem('printer-tycoon-state-v3'), JSON.stringify(v3));
  assert.equal(st.getItem(Save.BACKUP_KEY), null);
  // A v1 save (no nextSlotId, no nozzle fields, job without productId) still migrates cleanly.
  const v1job = { ...v1, printers: [{ printerId: 'bambu-p1s-ams', slotId: 3, state: 'printing', job: { orderId: 4, productName: 'Old thing', materialId: 'pla', grams: 20, hoursTotal: 2, hoursElapsed: 1, payout: 10, qualityValue: 0.5, precision: 0.8 } }] };
  const s = Save.migrate(v1job, ctx);
  assert.deepEqual(Save.validate(s), []);
  assert.equal(s.nextSlotId, 4);
  assert.equal(s.printers[0].nozzleHardened, true);
  assert.equal(s.printers[0].nozzleType, 'h04');
  assert.ok(s.printers[0].job.color);
});

test('load: a storage that throws gives a new game instead of an exception', () => {
  const r = Save.load(new ThrowingStorage(), ctx);
  assert.equal(r.fresh, true);
  assert.equal(r.state.money, 500);
  assert.equal(Save.safeSet(new ThrowingStorage(), 'k', 'v'), false);
});

test('load: a save that fails validation keeps the raw text and starts fresh with a message', () => {
  const bad = JSON.stringify({ ...Save.migrate(fixture('save-fresh'), ctx), day: -3 });
  const st = new MemoryStorage({ [Save.STATE_KEY]: bad });
  const r = Save.load(st, ctx);
  assert.equal(r.fresh, true);
  assert.match(r.notes[0].text, /could not be upgraded safely/);
  assert.equal(st.getItem(Save.UNREADABLE_KEY), bad);
});

test('graceJobs: a new game gets 3, a shop that already shipped gets none', () => {
  assert.equal(Save.migrate(fixture('save-fresh'), ctx).graceJobs, 3);
  assert.equal(Save.migrate(fixture('save-early'), ctx).graceJobs, 0);
});
