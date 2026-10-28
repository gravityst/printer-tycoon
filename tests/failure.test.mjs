// Failures you can see coming: named factors make one chance, each fix restores it, failures
// are sampled up front (front-loaded), the tick size never changes an outcome, and the kid
// rules hold (starter jobs can't fail, failures cost no cash or rep, nothing burns or breaks).
import test from 'node:test';
import assert from 'node:assert/strict';
import { cat, Sim } from './helpers/catalog.mjs';

const mid = (r) => (r[0] + r[1]) / 2;
function makeOrder(s, productId, materialId, over = {}) {
  const p = cat.product(productId);
  const t = Sim.now(s);
  return { id: s.nextOrderId++, productId, productName: p.name, category: p.category, materialId, materialOptions: [materialId],
    grams: mid(p.grams), basePrice: p.basePrice, qualityValue: p.qualityValue, minPrecision: p.minPrecision, minBuildVolumeMM: p.minBuildVolumeMM,
    techRequired: p.tech, heightMM: mid(p.heightMM), deadlineHours: 500, arrivedAt: t, dueAt: t + 500, customer: 'Ava', ...over };
}
function shop(printerId, seed = 11) {
  const s = Sim.newGame(cat, seed);
  s.printers = [Sim.makeSlot(cat, printerId, 1)];
  s.money = 5000;
  s.graceJobs = 0;
  s.nextOrderInHours = 1e9;
  s.inventory = { pla: 1e9, abs: 1e9, 'tpu-95a': 1e9, petg: 1e9, 'resin-standard': 1e9, 'pa-cf': 1e9 };
  s.wet = {};
  return s;
}
function riskOf(s, order, slot = s.printers[0]) {
  const est = Sim.estimateJob(cat, s, slot, order, order.materialId);
  return Sim.jobRisk(cat, s, slot, order, est);
}

test('calibration: a 4 h PLA job on a budget printer is about 88%', () => {
  const s = shop('ender-3-v3-se');
  const o = makeOrder(s, 'plant-pot', 'pla', { grams: 48 });   // 48 g at 12 g/h = 4 h of printing
  const est = Sim.estimateJob(cat, s, s.printers[0], o, 'pla');
  assert.ok(Math.abs(est.printHours - 4) < 1e-9);
  const r = riskOf(s, o);
  assert.ok(Math.abs(r.chance - 0.88) < 0.01, `${r.chance}`);
  assert.equal(r.text, '88%');
});

test('calibration: a long ABS job on an open frame is about 50%, over 75% with the enclosure kit', () => {
  const s = shop('prusa-mk4s');
  const o = makeOrder(s, 'rc-car-body', 'abs');
  const open = riskOf(s, o);
  assert.ok(open.chance > 0.45 && open.chance < 0.55, `${open.chance}`);
  assert.equal(open.top.id, 'warp');
  assert.match(open.text, /^\d+% · ABS may warp on an open frame \(add an enclosure\)$/);
  s.printers[0].upgrades = ['enclosure'];
  const kit = riskOf(s, o);
  assert.ok(kit.chance > 0.75, `${kit.chance}`);
  // A printer with a heated chamber barely notices.
  const q = shop('qidi-x-max-3');
  assert.ok(riskOf(q, makeOrder(q, 'rc-car-body', 'abs')).chance > 0.85);
});

test('each factor moves the chance, and its fix restores it', () => {
  const cases = [
    { name: 'bed', printer: 'bambu-a1-mini', product: 'phone-case', mat: 'pla', spoil: (s) => { s.printers[0].bed = 0.4; },
      fix: (s) => { Sim.cleanBed(cat, s, 0); Sim.step(cat, s, 0.2); }, text: /bed needs cleaning \(clean & level it\)/ },
    { name: 'nozzle', printer: 'bambu-a1-mini', product: 'phone-case', mat: 'pla', spoil: (s) => { s.printers[0].nozzleHealth = 0.2; },
      fix: (s) => { Sim.changeNozzle(cat, s, 0, 'b04'); }, text: /nozzle is worn \(fit a new one\)/ },
    { name: 'wear', printer: 'bambu-a1-mini', product: 'phone-case', mat: 'pla', spoil: (s) => { s.printers[0].wearHours = 400; },
      fix: (s) => { Sim.service(cat, s, 0, 'rebuild'); }, text: /printer is worn \(service it\)/ },
    { name: 'damp', printer: 'bambu-a1-mini', product: 'phone-case', mat: 'tpu-95a', spoil: (s) => { s.wet['tpu-95a'] = 1; },
      fix: (s) => { s.shopUpgrades = ['dryer']; Sim.startDrying(cat, s, 'tpu-95a'); Sim.step(cat, s, 8.01); }, text: /^\d+% · TPU is damp \(dry it\)$/ },
    { name: 'warp', printer: 'prusa-mk4s', product: 'rc-car-body', mat: 'abs', spoil: () => {},
      fix: (s) => { Sim.buyUpgrade(cat, s, 'enclosure', 0); }, text: /ABS may warp/, baseline: false },
  ];
  for (const c of cases) {
    const s = shop(c.printer);
    const o = makeOrder(s, c.product, c.mat);
    const clean = riskOf(s, o).chance;
    c.spoil(s);
    const spoiled = riskOf(s, o);
    if (c.baseline !== false) assert.ok(spoiled.chance < clean - 0.02, `${c.name}: ${spoiled.chance} vs ${clean}`);
    assert.match(spoiled.text, c.text, c.name);
    assert.ok(spoiled.factors.some((f) => f.id === (c.name === 'nozzle' ? 'nozzle' : c.name)), c.name);
    c.fix(s);
    const fixed = riskOf(s, o).chance;
    assert.ok(fixed > spoiled.chance + 0.02, `${c.name} fix: ${fixed} vs ${spoiled.chance}`);
    if (c.baseline !== false) assert.ok(Math.abs(fixed - clean) < 0.005, `${c.name} restores ${fixed} vs ${clean}`);
  }
});

// Start the same job over and over to check the sampled failures against the shown chance.
function sampleJobs(n, printerId, productId, mat, prep = () => {}) {
  const s = shop(printerId, 4242);
  prep(s);
  const o = makeOrder(s, productId, mat);
  const r = riskOf(s, o);
  const jobs = [];
  for (let i = 0; i < n; i++) {
    s.orders = [{ ...o, id: i + 1 }];
    s.printers[0].phase = 'idle'; s.printers[0].state = 'idle'; s.printers[0].job = null;
    Sim.assign(cat, s, i + 1, 0);
    jobs.push(s.printers[0].job);
  }
  return { r, jobs };
}

test('10,000 jobs fail at the shown rate (+-1 point), half of the failures in the first 10% of the print', () => {
  for (const [printerId, productId, mat, prep] of [
    ['ender-3-v3-se', 'plant-pot', 'pla', () => {}],
    ['prusa-mk4s', 'rc-car-body', 'abs', () => {}],
    ['elegoo-saturn-4-ultra', 'miniature-batch', 'resin-standard', (s) => { s.printers[0].wearHours = 150; }],
  ]) {
    const { r, jobs } = sampleJobs(10000, printerId, productId, mat, prep);
    const failed = jobs.filter((j) => j.fail);
    const rate = failed.length / jobs.length;
    assert.ok(Math.abs(rate - (1 - r.chance)) < 0.01, `${printerId}: ${rate} vs ${1 - r.chance}`);
    const early = failed.filter((j) => j.fail.u < 0.1).length / failed.length;
    assert.ok(Math.abs(early - 0.5) < 0.05, `${printerId}: ${early} of failures in the first 10%`);
  }
});

test('a camera stops a failed print within 10 minutes; without one every gram is lost', () => {
  // The vase is up to 240 mm tall, so the 256 mm A1 (not the 180 mm A1 mini) runs it.
  for (const [printerId, detected] of [['bambu-x1c-ams', true], ['bambu-a1-ams-lite', false], ['bambu-a1-ams-lite+camera', true]]) {
    const id = printerId.replace('+camera', '');
    const { jobs } = sampleJobs(3000, id, 'decorative-vase', 'pla', (s) => {
      s.printers[0].wearHours = 500;   // lots of failures to look at
      if (printerId.endsWith('+camera')) s.printers[0].upgrades = ['camera'];
    });
    const failed = jobs.filter((j) => j.fail);
    assert.ok(failed.length > 300);
    for (const j of failed) {
      assert.equal(j.fail.detected, detected, printerId);
      // Play the failure out and check what was lost.
      const s = shop(id);
      s.printers[0].upgrades = printerId.endsWith('+camera') ? ['camera'] : [];
      s.printers[0].job = JSON.parse(JSON.stringify(j));
      s.printers[0].phase = 'heating'; s.printers[0].state = 'printing';
      const before = s.inventory.pla;
      const money = s.money, rep = s.reputation;
      let ev = [];
      for (let k = 0; k < 400 && s.printers[0].phase !== 'failed'; k++) ev = ev.concat(Sim.step(cat, s, 0.1).events);
      const f = ev.find((e) => e.type === 'failed');
      assert.ok(f);
      const heat = j.phases[0].h;
      if (detected) {
        const printedAtStop = Math.min(1, (j.fail.atT + 10 / 60 - heat) / j.printHours);
        assert.ok(f.lostGrams <= j.grams * printedAtStop + 1e-6, `lost ${f.lostGrams} of ${j.grams}, printed ${printedAtStop}`);
        assert.ok(Math.abs(s.inventory.pla - before - (j.usedGrams - f.lostGrams)) < 1e-6, 'the rest goes back on the shelf');
      } else {
        assert.ok(Math.abs(f.lostGrams - j.usedGrams) < 1e-9, 'undetected: all grams');
      }
      assert.equal(s.money, money, 'a failure costs no cash');
      assert.equal(s.reputation, rep, 'a failure costs no rep');
      if (failed.indexOf(j) > 40) break;
    }
  }
});

test('0.05 h steps and 2 h steps give identical outcomes', () => {
  const play = (dt) => {
    const s = shop('bambu-a1-mini', 77);
    s.printers.push(Sim.makeSlot(cat, 'elegoo-saturn-4-ultra', 2), Sim.makeSlot(cat, 'ender-3-v3-se', 3));
    s.printers[2].wearHours = 300;
    s.nextOrderInHours = 3;
    const out = [];
    const end = Sim.now(s) + 24 * 6;
    while (Sim.now(s) < end - 1e-9) {
      const r = Sim.step(cat, s, Math.min(dt, end - Sim.now(s)));
      for (const e of r.events) out.push(`${e.type}@${e.at.toFixed(6)}:${e.text || ''}`);
      // Act only at whole hours, so both runs make the same moves at the same moments.
      if (Math.abs(Sim.now(s) - Math.round(Sim.now(s))) < 1e-6 && Math.round(Sim.now(s)) % 2 === 0) {
        s.printers.forEach((slot, i) => {
          if (slot.phase === 'done') Sim.collect(cat, s, i).events.forEach((e) => out.push(`${e.type}@${e.at.toFixed(6)}`));
          if (slot.phase === 'clogged') Sim.coldPull(cat, s, i);
          if (slot.phase === 'failed') Sim.reprint(cat, s, i);
        });
        for (const o of s.orders.slice()) {
          const i = s.printers.findIndex((slot) => Sim.canAssign(cat, s, o, slot).ok);
          if (i >= 0) Sim.assign(cat, s, o.id, i);
        }
      }
    }
    return { out, money: s.money.toFixed(6), rep: s.reputation, shipped: s.shipped, rng: s.rng, inv: JSON.stringify(s.inventory, (k, v) => typeof v === 'number' ? +v.toFixed(6) : v) };
  };
  const fine = play(0.05), coarse = play(2);
  assert.ok(fine.out.length > 10);
  assert.deepEqual(coarse, fine);
});

test('starter jobs (the first 3 of a new game) never fail', () => {
  const s = shop('ender-3-v3-se');
  s.graceJobs = 3;
  s.wet['tpu-95a'] = 1;
  s.printers[0].bed = 0.3;
  for (let i = 0; i < 3; i++) {
    const o = makeOrder(s, 'phone-case', 'tpu-95a');
    s.orders.push(o);
    const r = riskOf(s, o);
    assert.equal(r.chance, 1);
    assert.match(r.text, /starter job/);
    Sim.assign(cat, s, o.id, 0);
    const job = s.printers[0].job;
    assert.equal(job.fail, null);
    assert.equal(job.clogT, null);
    for (let k = 0; k < 400 && s.printers[0].phase !== 'done'; k++) Sim.step(cat, s, 0.1);
    assert.equal(s.printers[0].phase, 'done');
    Sim.collect(cat, s, 0);
  }
  assert.equal(s.graceJobs, 0);
  assert.ok(riskOf(s, makeOrder(s, 'phone-case', 'tpu-95a')).chance < 1);
});

test('a clog pauses the print until a cold pull; nothing is lost and the print finishes', () => {
  const s = shop('bambu-a1-ams-lite');
  const o = makeOrder(s, 'decorative-vase', 'pla');
  s.orders.push(o);
  Sim.assign(cat, s, o.id, 0);
  const job = s.printers[0].job;
  job.fail = null;
  job.clogT = job.phases[0].h + job.printHours * 0.4;
  const ev = [];
  for (let k = 0; k < 400 && s.printers[0].phase !== 'clogged'; k++) ev.push(...Sim.step(cat, s, 0.25).events);
  const clog = ev.find((e) => e.type === 'clogged');
  assert.match(clog.text, /clogged at 40%: do a cold pull\. Nothing is lost\./);
  const elapsed = job.hoursElapsed;
  Sim.step(cat, s, 5);
  assert.equal(job.hoursElapsed, elapsed, 'paused');
  assert.equal(Sim.slotStatus(cat, s, s.printers[0]).action.id, 'coldpull');
  assert.ok(Sim.coldPull(cat, s, 0).ok);
  assert.equal(s.printers[0].phase, 'coldpull');
  for (let k = 0; k < 400 && s.printers[0].phase !== 'done'; k++) Sim.step(cat, s, 0.25);
  assert.equal(s.printers[0].phase, 'done');
  const shipped = Sim.collect(cat, s, 0).events.find((e) => e.type === 'shipped');
  assert.ok(shipped);
});

test('a failed print offers Reprint or Release; Release puts the order back on the board', () => {
  const s = shop('bambu-a1-ams-lite');
  const o = makeOrder(s, 'decorative-vase', 'pla');
  s.orders.push(o);
  Sim.assign(cat, s, o.id, 0);
  const job = s.printers[0].job;
  job.fail = { u: 0.2, atT: job.phases[0].h + 0.2 * job.printHours, stopT: job.phases[0].h + 0.2 * job.printHours, detected: false, kind: 'spaghetti' };
  job.clogT = null;
  for (let k = 0; k < 400 && s.printers[0].phase !== 'failed'; k++) Sim.step(cat, s, 0.25);
  const st = Sim.slotStatus(cat, s, s.printers[0]);
  assert.equal(st.action.id, 'reprint');
  assert.equal(st.secondary.id, 'release');
  assert.match(st.line, /^Spaghetti · \d+ g lost$/);
  const r = Sim.reprint(cat, s, 0);
  assert.ok(r.ok);
  assert.equal(s.printers[0].phase, 'heating');
  assert.equal(s.printers[0].job.orderId, o.id);
  // Fail it again and release it this time.
  const j2 = s.printers[0].job;
  j2.fail = { u: 0.1, atT: j2.phases[0].h + 0.1 * j2.printHours, stopT: j2.phases[0].h + 0.1 * j2.printHours, detected: true, kind: 'detach' };
  j2.clogT = null;
  for (let k = 0; k < 400 && s.printers[0].phase !== 'failed'; k++) Sim.step(cat, s, 0.25);
  const rel = Sim.release(cat, s, 0);
  assert.ok(rel.ok);
  assert.equal(s.printers[0].phase, 'idle');
  assert.equal(s.orders.length, 1);
  assert.equal(s.orders[0].id, o.id);
  assert.equal(s.orders[0].released, true);
  // A released order that expires costs no rep.
  s.reputation = 5;
  s.orders[0].dueAt = Sim.now(s) + 0.5;
  Sim.step(cat, s, 1);
  assert.equal(s.reputation, 5);
});

test('kid-safe failure words: nothing burns, smokes, breaks or explodes', () => {
  const s = shop('bambu-a1-ams-lite');
  const texts = [];
  for (const kind of ['spaghetti', 'detach', 'warp', 'resin', 'powder', 'metal']) {
    const o = makeOrder(s, 'decorative-vase', 'pla');
    s.orders = [o];
    s.printers[0].phase = 'idle'; s.printers[0].state = 'idle'; s.printers[0].job = null;
    Sim.assign(cat, s, o.id, 0);
    const j = s.printers[0].job;
    j.fail = { u: 0.5, atT: 1, stopT: 1, detected: true, kind };
    j.clogT = null;
    for (let k = 0; k < 100 && s.printers[0].phase !== 'failed'; k++) texts.push(...Sim.step(cat, s, 0.25).events.map((e) => e.text));
    texts.push(Sim.slotStatus(cat, s, s.printers[0]).line);
  }
  const all = texts.filter(Boolean).join('\n');
  assert.ok(all.includes('Spaghetti'));
  assert.ok(!/fire|burn|smok|broke|break|explod|melt|danger|hurt/i.test(all), all);
});
