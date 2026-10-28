// Look data: the named filament palette matches the colours orders draw, every material has a
// finish and a density, old saves' colours map to names, and the room follows reputation.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as L from '../docs/look.js';
import { cat, Sim } from './helpers/catalog.mjs';

test('look.js is pure: no imports, DOM, THREE, clock or randomness', () => {
  const code = readFileSync(new URL('../docs/look.js', import.meta.url), 'utf8').replace(/\/\/[^\n]*/g, '');
  assert.ok(!/^\s*import\s/m.test(code));
  for (const banned of ['document.', 'window.', 'THREE', 'performance.', 'Date.now', 'Math.random', 'localStorage']) assert.ok(!code.includes(banned));
});

test('orders draw their colours from the named palette, in the same order', () => {
  assert.deepEqual(Sim.MODEL_PALETTE, L.FILAMENT_PALETTE.map((c) => c.hex));
  const names = new Set(L.FILAMENT_PALETTE.map((c) => c.name));
  assert.equal(names.size, L.FILAMENT_PALETTE.length, 'names are unique');
  for (const c of L.FILAMENT_PALETTE) assert.match(c.hex, /^#[0-9a-f]{6}$/);
});

test('colours from older saves map to a named filament: by their old place, else the nearest', () => {
  L.LEGACY_PALETTE.forEach((hex, i) => assert.equal(L.colorOf(hex).name, L.FILAMENT_PALETTE[i].name));
  assert.equal(L.colorOf('#3b82f6').name, 'Cobalt Blue');      // the lifecycle tests' colour
  assert.equal(L.colorOf('#C62D2D').name, 'Signal Red');       // case does not matter
  assert.equal(L.colorOf('#ff0000').name, 'Signal Red');       // nearest
  assert.equal(L.colorOf('#000000').name, 'Jet Black');
  assert.equal(L.colorOf(undefined).name.length > 0, true);
});

test("every material has a look: a known finish, a density, its own colour or the customer's", () => {
  for (const m of cat.materials) {
    const look = L.MATERIAL_LOOK[m.id];
    assert.ok(look, `${m.id} has no look`);
    assert.ok(L.FINISHES[look.finish], `${m.id}: unknown finish ${look.finish}`);
    assert.ok(look.density > 0.5 && look.density < 10, `${m.id}: density ${look.density}`);
    if (look.color !== null) assert.match(look.color, /^#[0-9a-f]{6}$/);
  }
  for (const id of Object.keys(L.MATERIAL_LOOK)) assert.ok(cat.materials.some((m) => m.id === id), `${id} is not a material`);
  // Filaments take the customer's colour; resins, powders and metals come in their own.
  assert.equal(L.lookFor('pla', '#2a52be').color, '#2a52be');
  assert.equal(L.lookFor('pla', '#2a52be').colorName, 'Cobalt Blue');
  assert.equal(L.lookFor('sls-pa12', '#2a52be').color, '#ece9e2');
  assert.equal(L.lookFor('metal-ti6al4v', '#2a52be').colorName, null);
  // Clear polycarbonate only carries a hint of the colour.
  const pc = L.lookFor('pc', '#c62d2d');
  assert.ok(pc.opacity < 1 && pc.color !== '#c62d2d');
  // Metal X parts are dull grey bound metal until they are sintered.
  assert.equal(L.lookFor('metal-ss17-4ph', null, { boundMetal: true }).finishId, 'bound');
});

test('the room follows the reputation tiers: garage, studio, workshop, factory', () => {
  assert.equal(L.roomFor(0), 'garage');
  assert.equal(L.roomFor(24), 'garage');
  assert.equal(L.roomFor(25), 'studio');
  assert.equal(L.roomFor(75), 'workshop');
  assert.equal(L.roomFor(150), 'factory');
  assert.equal(L.roomFor(undefined), 'garage');
  // The thresholds are the reputation tier unlocks the sim uses.
  const t = Sim.TIER_UNLOCK_REP;
  if (t) for (const [tier, room] of [['hobbyist', 'garage'], ['studio', 'studio']]) if (t[tier] != null) assert.equal(L.roomFor(t[tier]), room);
});
