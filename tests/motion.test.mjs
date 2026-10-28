// Motion: every machine moves like its class, the start of a print plays heat -> probe -> purge,
// the machine's own screen says what is happening in words, the time-lapse only ever moves
// forward, and the goofy failures are the same every time for the same job.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as M from '../docs/motion.js';
import { cat, printersJson } from './helpers/catalog.mjs';

test('motion.js is pure: no imports, DOM, THREE, clock or randomness', () => {
  const code = readFileSync(new URL('../docs/motion.js', import.meta.url), 'utf8').replace(/\/\/[^\n]*/g, '');
  assert.ok(!/^\s*import\s/m.test(code));
  for (const banned of ['document.', 'window.', 'THREE', 'performance.', 'Date.now', 'Math.random', 'localStorage']) assert.ok(!code.includes(banned), banned);
});

test('every printer says how it moves, and the classes are the right machines', () => {
  assert.ok(printersJson.fields.kinematics, 'printers.json documents the kinematics field');
  for (const p of cat.printers) {
    assert.ok(M.KINEMATICS.includes(p.kinematics), `${p.id}: kinematics ${p.kinematics}`);
    assert.equal(M.kinematicsOf(p), p.kinematics);
  }
  const k = (id) => cat.printer(id).kinematics;
  assert.equal(k('ender-3-v3-se'), 'bedslinger');
  assert.equal(k('prusa-mk4s'), 'bedslinger');
  assert.equal(k('bambu-a1-mini'), 'cantilever');
  assert.equal(k('creality-k1'), 'corexy');
  assert.equal(k('bambu-x1c-ams'), 'corexy');
  assert.equal(k('bcn3d-sigma-d25'), 'idex');
  assert.equal(k('elegoo-mars-5'), 'vat');
  assert.equal(k('formlabs-form-4'), 'vat');
  assert.equal(k('hp-mjf-5200'), 'powder');
  assert.equal(k('eos-m290'), 'powder');
  assert.equal(k('markforged-metal-x'), 'metal');
  assert.equal(cat.printer('voron-2-4').zAxis, 'gantry', 'the Voron 2.4 is a flying gantry');
  // Vat machines are the resin ones, powder machines the powder ones.
  for (const p of cat.printers) {
    if (p.tech === 'MSLA' || p.tech === 'SLA') assert.equal(p.kinematics, 'vat');
    if (p.tech === 'SLS' || p.tech === 'MJF' || p.tech === 'DMLS') assert.equal(p.kinematics, 'powder');
  }
  // A machine missing from the catalog (an old save's) still gets a class.
  assert.equal(M.kinematicsOf({ tech: 'FDM' }), 'bedslinger');
  assert.equal(M.kinematicsOf({ tech: 'FDM', enclosed: true }), 'corexy');
  assert.equal(M.kinematicsOf({ tech: 'MSLA' }), 'vat');
  assert.equal(M.kinematicsOf(undefined), 'bedslinger');
});

test('each class moves only its own axes, and the pose puts the nozzle tip where the path says', () => {
  const moved = (pose) => Object.keys(pose).filter((k) => Math.abs(pose[k]) > 1e-9).sort();
  const tip = { x: 31, y: -47, z: 12.4 };
  assert.deepEqual(moved(M.poseFor('bedslinger', tip)), ['bedY', 'gantryZ', 'headX']);
  assert.deepEqual(moved(M.poseFor('cantilever', tip)), ['bedY', 'gantryZ', 'headX']);
  assert.deepEqual(moved(M.poseFor('corexy', tip)), ['bedZ', 'headX', 'headY']);
  assert.deepEqual(moved(M.poseFor('corexy', tip, { zAxis: 'gantry' })), ['gantryZ', 'headX', 'headY']);
  assert.deepEqual(moved(M.poseFor('idex', tip)), ['bedZ', 'headX', 'headY']);
  assert.deepEqual(moved(M.poseFor('metal', tip)), ['bedZ', 'headX', 'headY']);
  assert.deepEqual(moved(M.poseFor('vat', tip)), ['plateZ']);
  assert.deepEqual(moved(M.poseFor('powder', tip)), ['pistonZ']);
  // Bed-slingers slide the bed the opposite way; CoreXY beds drop as the print climbs.
  assert.equal(M.poseFor('bedslinger', tip).bedY, 47);
  assert.equal(M.poseFor('corexy', tip).bedZ, -12.4);
  for (const kin of ['bedslinger', 'cantilever', 'corexy', 'idex', 'metal']) {
    for (const zAxis of [undefined, 'gantry']) {
      for (let i = 0; i < 20; i++) {
        const t = { x: -100 + i * 9.7, y: 80 - i * 7.3, z: i * 1.9 };
        const back = M.tipInBed(kin, M.poseFor(kin, t, { zAxis }), { zAxis });
        assert.ok(Math.abs(back.x - t.x) < 1e-9 && Math.abs(back.y - t.y) < 1e-9 && Math.abs(back.z - t.z) < 1e-9, `${kin} ${zAxis}`);
      }
    }
  }
  // Parking keeps clear of the part and on the bed.
  const park = M.parkTip('bedslinger', [220, 220, 250], 40);
  assert.ok(park.z > 40 && Math.abs(park.x) <= 110 && Math.abs(park.y) <= 110);
});

test('a print starts in real time: heat, probe (self-levelling machines), purge, then print', () => {
  const L = M.startLength(60);
  assert.ok(L > 0 && L <= M.START_MAX_S);
  assert.equal(M.startLength(5), 0, 'a five-second job skips the start');
  assert.ok(M.startLength(10) <= 1.2 + 1e-9);
  const order = [];
  for (let t = 0; t <= L + 0.05; t += 0.05) {
    const s = M.startStage(t, L, { autoLevel: true });
    if (order[order.length - 1] !== s.stage) order.push(s.stage);
    assert.ok(s.f >= 0 && s.f <= 1);
  }
  assert.deepEqual(order, ['heat', 'probe', 'purge', 'print']);
  const noProbe = new Set();
  for (let t = 0; t <= L + 0.05; t += 0.05) noProbe.add(M.startStage(t, L, { autoLevel: false }).stage);
  assert.deepEqual([...noProbe], ['heat', 'purge', 'print']);
  assert.equal(M.startStage(0.1, L, { nozzle: false }).stage, 'heat', 'vats and powder beds only heat');
  assert.equal(M.startStage(0, 0).stage, 'print');
});

test('temperatures climb to the material targets, and the screen says what is happening in words', () => {
  const pla = cat.material('pla'), abs = cat.material('abs');
  const t = M.targetsFor('bedslinger', pla);
  assert.equal(t.nozzle, 205);
  assert.equal(t.bed, 55);
  assert.ok(M.targetsFor('corexy', abs).bed > t.bed);
  let last = -1;
  for (let f = 0; f <= 1.0001; f += 0.1) { const c = M.tempsAt(t, f); assert.ok(c.nozzle >= last && c.nozzle <= t.nozzle && c.bed <= t.bed); last = c.nozzle; }
  assert.equal(M.tempsAt(t, 1).nozzle, 205);
  assert.equal(M.tempsAt(t, 0).nozzle, M.AMBIENT_C);

  const base = { kin: 'bedslinger', targets: t, model: 'Ender 3 V3 SE' };
  const heating = M.lcdText({ ...base, phase: 'printing', stage: 'heat', stageF: 0.3 });
  assert.match(heating.title, /^Heating \d+\/205 °C$/);
  assert.match(heating.line, /^Bed \d+\/55 °C$/);
  assert.equal(M.lcdText({ ...base, phase: 'printing', stage: 'probe', probeIndex: 6, probeCount: 16 }).title, 'Probing bed');
  assert.equal(M.lcdText({ ...base, phase: 'printing', stage: 'purge' }).title, 'Purging');
  const printing = M.lcdText({ ...base, phase: 'printing', stage: 'print', progress: 0.437, hoursLeft: 1.2, layer: 41, layers: 120 });
  assert.equal(printing.title, 'Printing 43% · 1:12 left');
  assert.equal(printing.line, 'Layer 42/120');
  assert.equal(M.lcdText({ ...base, phase: 'done' }).title, 'Done');
  const clog = M.lcdText({ ...base, phase: 'clogged', progress: 0.61 });
  assert.equal(clog.title, 'Clog: cold pull');
  assert.equal(clog.tone, 'warn');
  assert.equal(M.lcdText({ ...base, phase: 'coldpull' }).title, 'Cold pull');
  assert.equal(M.lcdText({ ...base, phase: 'failed', failKind: 'spaghetti' }).title, 'Spaghetti!');
  assert.equal(M.lcdText({ ...base, phase: 'failed', failKind: 'detach' }).title, 'Part came loose');
  assert.equal(M.lcdText({ ...base, phase: 'failed', failKind: 'warp' }).title, 'Corners lifted');
  assert.equal(M.lcdText({ ...base, phase: 'cleaning' }).title, 'Cleaning bed');
  assert.equal(M.lcdText({ ...base, phase: 'idle', bedDirty: true }).title, 'Bed needs a clean');
  assert.equal(M.lcdText({ ...base, phase: 'idle' }).title, 'Ready');
  assert.match(M.lcdText({ ...base, phase: 'printing', progress: 0.2, hoursLeft: 2, damp: true }).line, /Damp/);
  // A watching machine asks before it stops: amber, and the title alone says what it suspects.
  const sus = M.lcdText({ ...base, phase: 'printing', stage: 'print', progress: 0.4, hoursLeft: 2, suspect: 'spaghetti' });
  assert.equal(sus.title, 'Spaghetti?');
  assert.equal(sus.tone, 'warn');
  for (const k of ['spaghetti', 'detach', 'warp', 'resin', 'powder', 'metal']) {
    const a = M.lcdText({ ...base, phase: 'printing', progress: 0.4, suspect: k }).title, b = M.lcdText({ ...base, phase: 'failed', failKind: k }).title;
    assert.ok(a.endsWith('?') && a !== b, `${k}: ${a} / ${b}`);
  }
  // Metal X: the stations say what they do once the part has gone to finishing.
  assert.equal(M.lcdText({ kin: 'metal', phase: 'idle', finishing: { id: 'sinter', hoursLeft: 12.5 } }).title, 'Sintering');
  // Powder machines heat their chamber.
  const pw = M.lcdText({ kin: 'powder', phase: 'heating', heatF: 0.5, targets: M.targetsFor('powder', cat.material('sls-pa12')) });
  assert.match(pw.title, /^Heating \d+\/170 °C$/);
  // Every state reads differently without colour.
  const titles = ['heat', 'probe', 'purge'].map((s) => M.lcdText({ ...base, phase: 'printing', stage: s, stageF: 0.5 }).title.split(' ')[0])
    .concat(['done', 'clogged', 'coldpull', 'cleaning', 'idle'].map((ph) => M.lcdText({ ...base, phase: ph }).title))
    .concat(['spaghetti', 'detach', 'warp', 'resin', 'powder', 'metal'].map((k) => M.lcdText({ ...base, phase: 'failed', failKind: k }).title));
  assert.equal(new Set(titles).size, titles.length, titles.join(' | '));
  assert.equal(M.hm(1.2), '1:12');
  assert.equal(M.hm(0), '0:00');
});

test('the time-lapse traces a layer, then jumps forward; it never goes back', () => {
  const lapse = M.createLapse();
  assert.ok(M.lapseDone(lapse, 0));
  assert.equal(M.lapseWant(lapse, 0, 0.1, 100, 0.01), 10);
  assert.ok(M.lapseJump(lapse, 0, 10, 2));
  assert.equal(M.lapseF(lapse, 1), 0.5);
  assert.ok(!M.lapseJump(lapse, 1, 30, 2), 'no jump mid-trace');
  // What to slice next: where the print will be when this trace ends (and at least one layer on).
  assert.equal(M.lapseWant(lapse, 1, 0.2, 100, 0.05), 25);
  assert.equal(M.lapseWant(lapse, 1, 0.05, 100, 0), 11);
  assert.ok(!M.lapseJump(lapse, 2.5, 9, 2), 'never back down');
  assert.ok(M.lapseJump(lapse, 2.5, 25, 1.5));
  assert.equal(lapse.layer, 25);
  assert.equal(M.lapseF(lapse, 99), 1);
  // Layer of a print, and readable trace times.
  assert.equal(M.layerOf(0, 120), 0);
  assert.equal(M.layerOf(1, 120), 119);
  assert.equal(M.layerOf(0.5, 120), 60);
  assert.ok(M.traceSeconds('bedslinger', 10) >= 1.1 && M.traceSeconds('bedslinger', 1e6) <= 2.6);
  assert.equal(M.traceSeconds('vat', 0), 1.8);
});

test('resin peels and powder recoats in order', () => {
  // The plate sits on the film while the UV is on, and lifts before the next layer.
  for (let f = 0; f <= 1; f += 0.01) {
    const p = M.peelAt(f, 3.2, 6);
    if (p.uv) assert.ok(Math.abs(p.plateZ - 3.2) < 1e-9, 'UV only at the film');
    assert.ok(p.plateZ >= 3.2 - 1e-9 && p.plateZ <= 9.2 + 1e-9);
  }
  assert.ok([0.3, 0.4, 0.5].some((f) => M.peelAt(f, 1).uv === 1));
  // SLS: the recoater crosses before the laser scans; MJF: the carriage, then the lamp.
  let lastR = -1, scanned = false;
  for (let f = 0; f <= 1; f += 0.02) {
    const s = M.powderAt(f, 'sls');
    if (s.recoater != null) { assert.ok(!scanned && s.recoater >= lastR); lastR = s.recoater; }
    if (s.scan > 0) scanned = true;
  }
  assert.ok(scanned && lastR > 0.99);
  assert.equal(M.powderAt(0.9, 'sls').scan > 0.8, true);
  assert.equal(M.powderAt(0.2, 'mjf').lamp, null);
  assert.ok(M.powderAt(0.8, 'mjf').lamp > 0.5);
  assert.equal(M.powderProcess(cat.printer('hp-mjf-5200')), 'mjf');
  assert.equal(M.powderProcess(cat.printer('eos-m290')), 'dmls');
  assert.equal(M.powderProcess(cat.printer('formlabs-fuse-1-plus-30w')), 'sls');
});

test('spaghetti grows along one seeded curve, piles on the bed and stays nearby', () => {
  const a = M.spaghetti(1234, 300, { radius: 25, height: 16 });
  const b = M.spaghetti(1234, 600, { radius: 25, height: 16 });
  assert.deepEqual(Array.from(b.slice(0, a.length)), Array.from(a), 'the nest grows by revealing more of the same curve');
  assert.deepEqual(Array.from(M.spaghetti(1234, 300, { radius: 25, height: 16 })), Array.from(a), 'same job, same noodles');
  assert.notDeepEqual(Array.from(M.spaghetti(99, 300, { radius: 25, height: 16 })), Array.from(a));
  let far = 0;
  for (let i = 0; i < b.length; i += 3) {
    assert.ok(b[i + 2] >= 0.4 - 1e-6, 'never under the bed');
    assert.ok(b[i + 2] <= 16 * 1.6 + 2, 'never above the nozzle');
    far = Math.max(far, Math.hypot(b[i], b[i + 1]));
  }
  assert.ok(far < 25 * 2.2, `strays ${far.toFixed(1)} mm`);
  assert.equal(M.spaghetti(1, 1e6).length, M.NEST_POINTS * 3);
  // On top of a part: it piles on the part's top, not through it.
  const top = M.spaghetti(1234, 600, { radius: 30, height: 14, base: 50, from: [5, 5, 56], cx: 5, cy: 5, step: 2.2 });
  let spread = 0;
  for (let i = 0; i < top.length; i += 3) { assert.ok(top[i + 2] >= 50.4 - 1e-6, 'rests on the part'); spread = Math.max(spread, Math.hypot(top[i] - 5, top[i + 1] - 5)); }
  assert.ok(spread > 8 && spread < 30 * 2.2, `a nest you can see: ${spread.toFixed(1)} mm across`);
  // Strings sag between their ends; specks pop and fade.
  const s = M.strings(7, [-10, -10, 10, 10], 20, 5);
  assert.equal(s.length, 5 * 3 * 6);
  for (let i = 0; i < s.length; i += 3) assert.ok(s[i + 2] <= 20.4 + 1e-6 && s[i + 2] > 10);
  const sp = M.specks(3, 1.7);
  for (let i = 0; i < sp.length; i += 4) assert.ok(sp[i + 3] >= 0 && sp[i + 3] <= 1);
  assert.equal(M.seedOf(12, 'x'), M.seedOf(12, 'x'));
});

test('a failing print stops growing at the fault, and the fault plays out until it is caught', () => {
  const job = { phases: [{ id: 'heat', h: 0.1 }, { id: 'print', h: 4 }], printHours: 4, hoursTotal: 4.1,
    fail: { u: 0.4, atT: 1.7, stopT: 2.1, kind: 'spaghetti', detected: true } };
  assert.equal(M.printedAt(job, 0.05), 0);
  assert.ok(Math.abs(M.printedAt(job, 2.1) - 0.5) < 1e-9);
  assert.deepEqual(M.failureAt(job, 1.0), { grows: M.printedAt(job, 1.0), fault: null });
  const mid = M.failureAt(job, 1.9);
  assert.equal(mid.grows, 0.4);
  assert.ok(Math.abs(mid.fault - 0.5) < 1e-9);
  assert.equal(M.failureAt(job, 3).fault, 1);
  assert.ok(M.warpAt(1) === 1 && M.warpAt(0) === 0);
  assert.ok(M.detachAt(1).tilt > 0.3);
});
