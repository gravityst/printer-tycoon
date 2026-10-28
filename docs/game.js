// =====================================================================
// Printer Tycoon — Three.js 3D printers + game logic + list-view shop.
// =====================================================================

// The save key never changes again (every earlier bump orphaned saves); save.js versions the
// contents instead. BUILD busts caches for the code and data and comes from index.html's
// game.js?v=… so there is one place to bump it.
const STATE_KEY = 'printer-tycoon-state-v4';
const BUILD = (() => {
  try { return new URL(document.currentScript.src).searchParams.get('v') || 'dev'; } catch (e) { return 'dev'; }
})();
let Sim = null;   // docs/sim.js, loaded once in boot()
let Save = null;  // docs/save.js, loaded with sim.js
const TICK_MS = 250;
const REAL_SEC_PER_GAME_HOUR = 4;
// The game rules (nozzles, prices, order rate, failures, finishing) live in sim.js now; this file
// draws them, plays them and saves them.


// Brand colors used in 3D printer geometry
const BRAND_COLORS = {
  'Bambu Lab':       { frame: 0x1a1a1a, accent: 0x4ade80, panel: 0xfafafa },
  'Prusa Research':  { frame: 0xff7a00, accent: 0x222222, panel: 0x222222 },
  'Voron Design':    { frame: 0x0066ff, accent: 0x111111, panel: 0x111111 },
  'Creality':        { frame: 0x1a1a1a, accent: 0xff0000, panel: 0x222222 },
  'BCN3D':           { frame: 0x14b8a6, accent: 0x1f2937, panel: 0x1f2937 },
  'Markforged':      { frame: 0x1a1a1a, accent: 0xfbbf24, panel: 0x1f2937 },
  'Anycubic':        { frame: 0x111827, accent: 0xfbbf24, panel: 0x1f2937 },
  'Elegoo':          { frame: 0x1f2937, accent: 0xa855f7, panel: 0x111827 },
  'Sovol':           { frame: 0x6d28d9, accent: 0xfafafa, panel: 0x111827 },
  'QIDI Tech':       { frame: 0x1e293b, accent: 0xfbbf24, panel: 0x111827 },
  'Phrozen':         { frame: 0x1f2937, accent: 0xec4899, panel: 0x111827 },
  'Formlabs':        { frame: 0xfafafa, accent: 0xff6f00, panel: 0x222222 },
  'HP':              { frame: 0x1a1a1a, accent: 0x0096d6, panel: 0x1f2937 },
  'EOS':             { frame: 0x222222, accent: 0xfbbf24, panel: 0x111827 },
};

let printersCat = [];
let materialsCat = [];
let productsCat = [];
let Cat = null;            // Sim.makeCatalog(): lookups that also know "Unknown machine"
let state = null;
let speed = 1;
let lastTickReal = Date.now();
let shopFilter = 'all';
let saveFailing = false;   // shows the "Not saving" note while storage refuses writes
let bootNotes = [];
// Which parts of the page need drawing again. tick() sets these from the rules' own dirty flags,
// so a quiet tick only touches the clock.
const dirty = { header: true, printers: true, orders: true, inventory: true, log: true, shop: true, manage: true };
const markAll = () => { for (const k of Object.keys(dirty)) dirty[k] = true; };

// =====================================================================
// catalog + state
// =====================================================================
async function loadCatalogs() {
  // Cache-bust so users always get the freshest catalog after a deploy
  const v = BUILD;
  const [pr, mt, pd] = await Promise.all([
    fetch(`data/printers.json?v=${v}`).then(r => r.json()),
    fetch(`data/materials.json?v=${v}`).then(r => r.json()),
    fetch(`data/products.json?v=${v}`).then(r => r.json()),
  ]);
  printersCat = pr.printers;
  materialsCat = mt.materials;
  productsCat = pd.products;
  Cat = Sim.makeCatalog(pr, mt, pd);
  console.log(`[Print3D] Loaded ${materialsCat.length} materials, ${printersCat.length} printers, ${productsCat.length} products`);
}

// An id that left the catalog comes back as the "Unknown machine" stub, so old saves still draw.
const printerById = id => Cat.printer(id);
const materialById = id => Cat.material(id);
const productById = id => Cat.product(id);

function makeSlot(printerId, slotId, purchasePrice = null) {
  return Sim.makeSlot(Cat, printerId, slotId, purchasePrice ?? undefined);
}

function wearStatus(slot) {
  const w = slot.wearHours || 0;
  if (w < 80)  return { label: 'Good',     pct: w/8,    color: '#22c55e' };
  if (w < 200) return { label: 'Worn',     pct: 10 + (w-80)*0.4, color: '#fbbf24' };
  if (w < 400) return { label: 'Servicing recommended', pct: 50 + (w-200)*0.2, color: '#f97316' };
  return { label: 'Service required', pct: Math.min(95, 90 + (w-400)*0.025), color: '#dc2626' };
}

function newSeed() {
  try { const a = new Uint32Array(1); crypto.getRandomValues(a); return a[0] || 1; } catch (e) { return (Date.now() >>> 0) || 1; }
}
// A new game opens with one line in the shop log, so the log never starts blank.
function defaultState() {
  const s = Sim.newGame(Cat, newSeed());
  const p = printerById(s.printers[0].printerId);
  Sim.appendLog(s, [{ at: Sim.now(s), kind: 'good',
    text: `Your garage shop is open: one ${p.model}, ${Sim.fmtMoney(s.money)} and a 1 kg spool of PLA. The first order should come in a few hours.` }]);
  return s;
}

// save.js reads the save (or rescues an older one), keeps a backup, migrates and validates it.
function loadState() {
  let storage = null;
  try { storage = window.localStorage; } catch (e) {}
  const r = Save.load(storage, { cat: Cat, Sim, newGame: defaultState });
  bootNotes = r.notes || [];
  if (r.notes && r.notes.some(n => n.problems)) console.warn('[Print3D] save problems:', r.notes.map(n => n.problems).filter(Boolean));
  return r.state;
}

function saveState() {
  let ok = false;
  try { localStorage.setItem(STATE_KEY, JSON.stringify(state)); ok = true; } catch (e) {}
  if (ok === saveFailing) {
    saveFailing = !ok;
    const note = document.getElementById('saveNote');
    if (note) note.hidden = !saveFailing;
  }
}

function resetState() {
  if (!confirm('Reset all progress?')) return;
  // Drop every card's 3D view (the stage and its one renderer stay)
  detachAllCards();
  state = defaultState();
  saveState();
  document.getElementById('printers').innerHTML = '';
  resetKeyedLists();
  markAll();
  render();
  toast('Game reset.', 'success');
}

// =====================================================================
// helpers
// =====================================================================
function fmtTime(h) {
  const hh = Math.floor(h);
  const mm = Math.floor((h - hh) * 60);
  return `${String(hh).padStart(2,'0')}:${String(mm).padStart(2,'0')}`;
}

function fmtMoney(n) {
  if (n >= 1_000_000) return `$${(n/1_000_000).toFixed(2)}M`;
  if (n >= 10_000) return `$${(n/1000).toFixed(1)}k`;
  return `$${n.toFixed(2)}`;
}

function fmtPrice(n) {
  if (n >= 100_000) return `$${(n/1000).toFixed(0)}k`;
  if (n >= 10_000) return `$${(n/1000).toFixed(1)}k`;
  return `$${n.toLocaleString('en-US')}`;
}

// How fast a machine builds: grams an hour for extrusion, millimeters of height for vats and beds.
function speedLabel(p) {
  if (Sim.techClass(p) === 'fdm') return `${p.throughputGPH || 30} g/hr`;
  return p.verticalMMPerHour ? `${p.verticalMMPerHour} mm/hr tall` : '';
}

function colorForJob(job) {
  return (job && job.color) || Sim.FIXED_COLORS[job && job.productId] || Sim.MODEL_PALETTE[Math.abs((job && job.orderId) | 0) % Sim.MODEL_PALETTE.length];
}

function printerCategory(printer) {
  const tech = printer.tech;
  if (tech === 'FDM' || tech === 'FFF' || tech === 'ADAM') return 'fdm';
  if (tech === 'MSLA' || tech === 'SLA') return 'resin';
  return 'industrial';
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// =====================================================================
// game loop: the rules are in sim.js; these wrappers play them and show what happened
// =====================================================================
function canAssign(order, slot) { return Sim.canAssign(Cat, state, order, slot); }

function spawnOrder() {
  const ev = Sim.spawnOrder(Cat, state);
  if (ev) handleEvents([ev]);
  dirty.orders = true;
}

// Rules events become log lines, and the ones worth interrupting for become a toast.
function handleEvents(events) {
  if (!events || !events.length) return;
  Sim.appendLog(state, events);
  dirty.log = true;
  const t = events.filter(e => e.toast).pop();
  if (t) toast(t.text, t.kind === 'good' ? 'success' : t.kind === 'bad' ? 'warn' : 'info');
}

function afterAction(r, okToast) {
  if (!r.ok) { toast(r.reason, 'error'); return false; }
  handleEvents(r.events);
  if (okToast) toast(okToast, 'success');
  markAll();
  render();
  saveState();
  return true;
}

function assignOrder(orderId, slotIdx) {
  const order = state.orders.find(o => o.id === orderId);
  const r = Sim.assign(Cat, state, orderId, slotIdx);
  afterAction(r, r.ok && order ? `Started: ${order.productName}` : null);
}

// A finished part comes off the printer: FDM ships now, everything else goes to finishing first.
function completeJob(slot) {
  const i = state.printers.indexOf(slot);
  if (i >= 0) collectPart(i);
}
function collectPart(slotIdx) { afterAction(Sim.collect(Cat, state, slotIdx)); }
function collectAll() { afterAction(Sim.collectAll(Cat, state)); }
function coldPull(slotIdx) { afterAction(Sim.coldPull(Cat, state, slotIdx), 'Cold pull: warming up the nozzle'); }
function reprintJob(slotIdx) { afterAction(Sim.reprint(Cat, state, slotIdx)); }
function releaseJob(slotIdx) { afterAction(Sim.release(Cat, state, slotIdx)); }
function cleanBed(slotIdx) { afterAction(Sim.cleanBed(Cat, state, slotIdx), 'Cleaning and leveling the bed'); }
function dryMaterial(matId) { afterAction(Sim.startDrying(Cat, state, matId)); }
function buyUpgrade(id, slotIdx) {
  const u = Sim.UPGRADES.find(x => x.id === id);
  if (!u) return;
  if (!confirm(`Buy ${Sim.aAn(u.name.toLowerCase())} for ${fmtPrice(u.cost)}?`)) return;
  afterAction(Sim.buyUpgrade(Cat, state, id, slotIdx));
}

function rejectOrder(orderId) {
  Sim.rejectOrder(state, orderId);
  dirty.orders = true;
  render();
}

function rejectAllOrders() {
  if (state.orders.length === 0) return;
  if (!confirm(`Decline all ${state.orders.length} pending orders?`)) return;
  const n = state.orders.length;
  state.orders = [];
  toast(`Declined ${n} orders`, 'success');
  dirty.orders = true;
  render();
}

function buyMaterial(matId, qty) {
  const m = materialById(matId);
  if (!m) return;
  const r = Sim.buyMaterial(Cat, state, matId, qty);
  afterAction(r, r.ok ? `Bought ${qty} kg of ${Sim.materialLabel(Cat, matId)}` : null);
}

// =====================================================================
// printer shop — clean LIST view with brand, model, specs, buy
// =====================================================================
function openShop() {
  document.getElementById('shopModal').classList.add('open');
  shopFilter = 'all';
  document.querySelectorAll('#shopFilters button').forEach(b => {
    b.classList.toggle('active', b.dataset.filter === 'all');
  });
  renderShop();
  // Pictures arrive a few per frame from the stage; rows pick them up without being rebuilt.
  requestShopThumbnails();
}

function closeShop() {
  document.getElementById('shopModal').classList.remove('open');
}

function setShopFilter(f) {
  shopFilter = f;
  document.querySelectorAll('#shopFilters button').forEach(b => {
    b.classList.toggle('active', b.dataset.filter === f);
  });
  renderShop();
}

function buyPrinter(id) {
  const printer = printerById(id);
  if (!printer || printer.unknown) return;
  if (state.reputation < (Sim.TIER_UNLOCK_REP[printer.tier] || 0)) {
    toast(`Need ${Sim.TIER_UNLOCK_REP[printer.tier]} reputation`, 'error');
    return;
  }
  if (state.money < printer.price) {
    toast(`Need ${fmtPrice(printer.price)}`, 'error');
    return;
  }
  if (!confirm(`Buy ${printer.brand} ${printer.model} for ${fmtPrice(printer.price)}?`)) return;
  if (afterAction(Sim.buyPrinter(Cat, state, id), `Welcome, ${printer.model}!`)) closeShop();
}

// =====================================================================
// SUPPLIES SHOP — filament brands, resin brands, accessories
// =====================================================================
const SUPPLIES_CATALOG = [
  // ---- PLA & PLA+ ----
  { brand: 'Sunlu',      name: 'PLA',                material: 'pla',          color: 'White',           hex: '#fafafa', costPerKg: 18 },
  { brand: 'Sunlu',      name: 'PLA',                material: 'pla',          color: 'Yellow',          hex: '#fbbf24', costPerKg: 18 },
  { brand: 'Hatchbox',   name: 'PLA',                material: 'pla',          color: 'Tomato Red',      hex: '#dc2626', costPerKg: 22 },
  { brand: 'Hatchbox',   name: 'PLA',                material: 'pla',          color: 'Sky Blue',        hex: '#3b82f6', costPerKg: 22 },
  { brand: 'Hatchbox',   name: 'PLA',                material: 'pla',          color: 'Forest Green',    hex: '#16a34a', costPerKg: 22 },
  { brand: 'Bambu Lab',  name: 'PLA Basic',          material: 'pla',          color: 'Bambu Green',     hex: '#10b981', costPerKg: 25 },
  { brand: 'Bambu Lab',  name: 'PLA Basic',          material: 'pla',          color: 'Cyan',            hex: '#06b6d4', costPerKg: 25 },
  { brand: 'Bambu Lab',  name: 'PLA Silk',           material: 'pla',          color: 'Champagne Gold',  hex: '#fbbf24', costPerKg: 32 },
  { brand: 'Polymaker',  name: 'PolyTerra PLA',      material: 'pla',          color: 'Charcoal Black',  hex: '#1a1a1a', costPerKg: 26 },
  { brand: 'Polymaker',  name: 'PolyTerra PLA',      material: 'pla',          color: 'Cotton White',    hex: '#fafafa', costPerKg: 26 },
  { brand: 'Prusament',  name: 'PLA',                material: 'pla',          color: 'Galaxy Black',    hex: '#1a1a2e', costPerKg: 34 },
  { brand: 'Prusament',  name: 'PLA',                material: 'pla',          color: 'Lipstick Red',    hex: '#b91c1c', costPerKg: 34 },
  { brand: 'Eryone',     name: 'Silk PLA',           material: 'pla',          color: 'Rainbow',         hex: '#a855f7', costPerKg: 27 },
  { brand: 'Sunlu',      name: 'PLA+',               material: 'pla-plus',     color: 'Black',           hex: '#111111', costPerKg: 21 },
  { brand: 'eSun',       name: 'PLA+',               material: 'pla-plus',     color: 'Cool White',      hex: '#fafafa', costPerKg: 24 },
  // ---- PETG ----
  { brand: 'Hatchbox',   name: 'PETG',               material: 'petg',         color: 'Translucent',     hex: '#e5e7eb', costPerKg: 25 },
  { brand: 'Hatchbox',   name: 'PETG',               material: 'petg',         color: 'Blue',            hex: '#1d4ed8', costPerKg: 25 },
  { brand: 'Bambu Lab',  name: 'PETG Basic',         material: 'petg',         color: 'Light Gray',      hex: '#cbd5e1', costPerKg: 28 },
  { brand: 'Polymaker',  name: 'PolyLite PETG',      material: 'petg',         color: 'Black',           hex: '#000000', costPerKg: 30 },
  { brand: 'Prusament',  name: 'PETG',               material: 'petg',         color: 'Anthracite Gray', hex: '#374151', costPerKg: 36 },
  // ---- TPU ----
  { brand: 'Sunlu',      name: 'TPU 95A',            material: 'tpu-95a',      color: 'Black',           hex: '#222222', costPerKg: 32 },
  { brand: 'eSun',       name: 'eTPU 95A',           material: 'tpu-95a',      color: 'Red',             hex: '#ef4444', costPerKg: 38 },
  { brand: 'NinjaFlex',  name: 'TPU 85A',            material: 'tpu-95a',      color: 'Black',           hex: '#0a0a0a', costPerKg: 75 },
  // ---- ABS / ASA ----
  { brand: 'Polymaker',  name: 'PolyLite ABS',       material: 'abs',          color: 'Black',           hex: '#0a0a0a', costPerKg: 22 },
  { brand: 'eSun',       name: 'ABS+',               material: 'abs',          color: 'Sandstone',       hex: '#d4a017', costPerKg: 24 },
  { brand: 'Polymaker',  name: 'PolyLite ASA',       material: 'asa',          color: 'Black',           hex: '#000000', costPerKg: 32 },
  { brand: 'Prusament',  name: 'ASA',                material: 'asa',          color: 'Jet Black',       hex: '#000000', costPerKg: 38 },
  // ---- Engineering ----
  { brand: 'Polymaker',  name: 'PolyMax PC',         material: 'pc',           color: 'Black',           hex: '#000000', costPerKg: 50 },
  { brand: 'Polymaker',  name: 'CoPA Nylon',         material: 'nylon-pa12',   color: 'Natural',         hex: '#e5e0d3', costPerKg: 65 },
  { brand: 'eSun',       name: 'ePA-CF',             material: 'pa-cf',        color: 'Carbon Black',    hex: '#0a0a0a', costPerKg: 89 },
  { brand: 'Bambu Lab',  name: 'PA-CF',              material: 'pa-cf',        color: 'Black',           hex: '#000000', costPerKg: 95 },
  { brand: 'Polymaker',  name: 'PolyMide PA612-CF',  material: 'pa-cf',        color: 'Black',           hex: '#111111', costPerKg: 110 },
  { brand: 'Essentium',  name: 'PEEK',               material: 'peek',         color: 'Tan',             hex: '#bca987', costPerKg: 400 },
  // ---- Resins ----
  { brand: 'Anycubic',   name: 'Standard Resin',     material: 'resin-standard', color: 'Gray',          hex: '#6b7280', costPerLiter: 35 },
  { brand: 'Phrozen',    name: 'Aqua-Gray 8K',       material: 'resin-standard', color: 'Aqua-Gray',     hex: '#94a3b8', costPerLiter: 42 },
  { brand: 'Anycubic',   name: 'Tough Resin',        material: 'resin-tough',  color: 'Black',           hex: '#000000', costPerLiter: 80 },
  { brand: 'Elegoo',     name: 'ABS-Like Tough',     material: 'resin-tough',  color: 'White',           hex: '#fafafa', costPerLiter: 75 },
  { brand: 'Siraya Tech',name: 'Build',              material: 'resin-tough',  color: 'Black',           hex: '#000000', costPerLiter: 50 },
  { brand: 'Anycubic',   name: 'Flexible Resin',     material: 'resin-flexible', color: 'Translucent',   hex: '#f3f4f6', costPerLiter: 110 },
  { brand: 'Phrozen',    name: 'Castable Wax 40%',   material: 'resin-castable',color: 'Purple',         hex: '#a855f7', costPerLiter: 180 },
  { brand: 'Formlabs',   name: 'Castable Wax 40',    material: 'resin-castable',color: 'Purple',         hex: '#a855f7', costPerLiter: 220 },
  { brand: 'Formlabs',   name: 'Tough 2000',         material: 'resin-engineering', color: 'Amber',      hex: '#fde68a', costPerLiter: 200 },
  // ---- SLS Powders (Formlabs Fuse, BASF Ultrasint, Sinterit) ----
  { brand: 'Formlabs',   name: 'Fuse Nylon 12',       material: 'sls-pa12',     color: 'Gray',          hex: '#94a3b8', costPerKg: 110 },
  { brand: 'Formlabs',   name: 'Fuse Nylon 11',       material: 'sls-pa11',     color: 'Natural',       hex: '#e5e0d3', costPerKg: 200 },
  { brand: 'Formlabs',   name: 'Fuse PA12 GF',        material: 'sls-pa12-gf',  color: 'Light Gray',    hex: '#cbd5e1', costPerKg: 130 },
  { brand: 'Formlabs',   name: 'Fuse TPU 90A',        material: 'sls-tpu',      color: 'Off-White',     hex: '#e7e5e4', costPerKg: 200 },
  { brand: 'BASF',       name: 'Ultrasint PA12',      material: 'sls-pa12',     color: 'White',         hex: '#fafafa', costPerKg: 95 },
  { brand: 'BASF',       name: 'Ultrasint PA11 ESD',  material: 'sls-pa11',     color: 'Carbon Black',  hex: '#1a1a1a', costPerKg: 220 },
  // ---- MJF Powders (HP, Lubrizol, Evonik) ----
  { brand: 'HP',         name: '3D HR PA 12',         material: 'mjf-pa12',     color: 'Light Gray',    hex: '#cbd5e1', costPerKg: 90 },
  { brand: 'HP',         name: '3D HR PA 11',         material: 'mjf-pa11',     color: 'Natural',       hex: '#e5e0d3', costPerKg: 120 },
  { brand: 'HP',         name: '3D HR TPU',           material: 'mjf-tpu',      color: 'Black',         hex: '#0a0a0a', costPerKg: 150 },
  { brand: 'HP',         name: '3D HR PA 12 GB',      material: 'mjf-pa12-gb',  color: 'Light Gray',    hex: '#d1d5db', costPerKg: 110 },
  { brand: 'Evonik',     name: 'INFINAM TPC',         material: 'mjf-tpu',      color: 'Natural',       hex: '#e5e7eb', costPerKg: 165 },
  // ---- DMLS / SLM Metal Powders (EOS, GE Additive, Sandvik) ----
  { brand: 'EOS',        name: 'StainlessSteel 316L', material: 'metal-ss316l', color: 'Steel Gray',    hex: '#94a3b8', costPerKg: 150 },
  { brand: 'EOS',        name: 'StainlessSteel 17-4PH', material: 'metal-ss17-4ph', color: 'Steel Gray', hex: '#94a3b8', costPerKg: 180 },
  { brand: 'EOS',        name: 'ToolSteel H13',       material: 'metal-h13',    color: 'Dark Gray',     hex: '#475569', costPerKg: 250 },
  { brand: 'EOS',        name: 'ToolSteel A2',        material: 'metal-a2',     color: 'Dark Gray',     hex: '#475569', costPerKg: 240 },
  { brand: 'EOS',        name: 'ToolSteel D2',        material: 'metal-d2',     color: 'Dark Gray',     hex: '#475569', costPerKg: 250 },
  { brand: 'EOS',        name: 'Aluminium AlSi10Mg',  material: 'metal-alsi10mg', color: 'Aluminum',    hex: '#cbd5e1', costPerKg: 130 },
  { brand: 'EOS',        name: 'Titanium Ti-6Al-4V',  material: 'metal-ti6al4v',color: 'Titanium Gray', hex: '#9ca3af', costPerKg: 400 },
  { brand: 'EOS',        name: 'NickelAlloy IN625',   material: 'metal-inconel-625', color: 'Nickel',   hex: '#b8b8b8', costPerKg: 380 },
  { brand: 'EOS',        name: 'NickelAlloy IN718',   material: 'metal-inconel-718', color: 'Nickel',   hex: '#b8b8b8', costPerKg: 500 },
  { brand: 'EOS',        name: 'MaragingSteel MS1',   material: 'metal-maraging', color: 'Dark Steel',  hex: '#475569', costPerKg: 220 },
  { brand: 'EOS',        name: 'CopperAlloy CuCrZr',  material: 'metal-copper', color: 'Copper',        hex: '#b87333', costPerKg: 300 },
  { brand: 'GE Additive',name: 'AlSi10Mg',            material: 'metal-alsi10mg', color: 'Aluminum',    hex: '#cbd5e1', costPerKg: 110 },
  { brand: 'Sandvik',    name: 'Osprey Ti-6Al-4V',    material: 'metal-ti6al4v',color: 'Titanium Gray', hex: '#9ca3af', costPerKg: 350 },
  // ---- Markforged consumables (Onyx, Nylon White, continuous fibers) ----
  { brand: 'Markforged', name: 'Onyx',                material: 'onyx',         color: 'Matte Black',   hex: '#1a1a1a', costPerKg: 190 },
  { brand: 'Markforged', name: 'Nylon White',         material: 'nylon-white',  color: 'White',         hex: '#fafafa', costPerKg: 175 },
  { brand: 'Markforged', name: 'Continuous Carbon Fiber', material: 'fiber-carbon', color: 'Black',     hex: '#000000', costPerKg: 120 },
  { brand: 'Markforged', name: 'Continuous Kevlar',   material: 'fiber-kevlar', color: 'Yellow',        hex: '#fbbf24', costPerKg: 100 },
  { brand: 'Markforged', name: 'Continuous Fiberglass', material: 'fiber-fiberglass', color: 'White',   hex: '#fafafa', costPerKg: 50 },
];

let suppliesFilter = 'all';

function openSupplies() {
  document.getElementById('suppliesModal').classList.add('open');
  suppliesFilter = 'all';
  document.querySelectorAll('#suppliesFilters button').forEach(b => {
    b.classList.toggle('active', b.dataset.filter === 'all');
  });
  renderSupplies();
}
function closeSupplies() {
  document.getElementById('suppliesModal').classList.remove('open');
}
function setSuppliesFilter(f) {
  suppliesFilter = f;
  document.querySelectorAll('#suppliesFilters button').forEach(b => {
    b.classList.toggle('active', b.dataset.filter === f);
  });
  renderSupplies();
}

function buyFilament(idx) {
  const item = SUPPLIES_CATALOG[idx];
  if (!item) return;
  const cost = item.costPerKg ?? item.costPerLiter ?? 0;
  if (state.money < cost) { toast('Not enough cash', 'error'); return; }
  state.money -= cost;
  // Stock goes into the underlying material id (color is flavor)
  state.inventory[item.material] = (state.inventory[item.material] || 0) + 1000;
  const unit = item.costPerLiter ? 'L' : 'kg';
  toast(`Bought 1${unit} ${item.brand} ${item.name} (${item.color})`, 'success');
  render();
  renderSupplies();
}

// Simple shop: ONE row per material (no brand/color clutter).
// Each row shows category badge, name, price, and how many of YOUR
// printers can use it.
const CAT_COLORS = {
  filament: { bg: '#1e3a5f', fg: '#93c5fd', label: 'FILAMENT' },
  resin:    { bg: '#3b1e5e', fg: '#c4b5fd', label: 'RESIN' },
  powder:   { bg: '#3a3a40', fg: '#d1d5db', label: 'POWDER' },
  fiber:    { bg: '#1f2937', fg: '#fbbf24', label: 'FIBER' },
};

function renderSupplies() {
  const root = document.getElementById('suppliesList');
  if (!root) return;
  let list = materialsCat.slice();
  // Filter
  if (suppliesFilter !== 'all') {
    if (suppliesFilter === 'filament') list = list.filter(m => m.category === 'filament');
    else if (suppliesFilter === 'resin') list = list.filter(m => m.category === 'resin');
    else if (suppliesFilter === 'powder') list = list.filter(m => m.category === 'powder');
    else if (suppliesFilter === 'fiber') list = list.filter(m => m.category === 'fiber');
    else if (suppliesFilter === 'metal') list = list.filter(m => m.id.startsWith('metal-') || (m.category === 'powder' && m.tech === 'DMLS'));
  }
  // Sort by category then by cost
  const catOrder = { filament: 0, resin: 1, powder: 2, fiber: 3 };
  list.sort((a, b) => {
    const ca = catOrder[a.category] ?? 9;
    const cb = catOrder[b.category] ?? 9;
    if (ca !== cb) return ca - cb;
    return (a.costPerKg ?? a.costPerLiter ?? 0) - (b.costPerKg ?? b.costPerLiter ?? 0);
  });

  root.innerHTML = '';
  list.forEach(m => {
    const cost = m.costPerKg ?? m.costPerLiter ?? 0;
    const unit = m.costPerLiter ? 'L' : 'kg';
    const canAfford = state.money >= cost;
    const stock = state.inventory[m.id] || 0;
    const cat = CAT_COLORS[m.category] || CAT_COLORS.powder;
    // Compatibility with the player's owned printers
    const compatPrinters = state.printers.filter(slot => {
      const printer = printerById(slot.printerId);
      return printer && printer.materials.includes(m.id);
    });
    const compatTxt = compatPrinters.length > 0
      ? `<span class="compat-good">✓ ${compatPrinters.length} of your ${state.printers.length} printer${state.printers.length === 1 ? '' : 's'} support this</span>`
      : `<span class="compat-none">✗ none of your printers support this</span>`;
    const noteShort = m.notes ? m.notes.split('.')[0].slice(0, 90) : '';

    const row = document.createElement('div');
    row.className = 'supplies-row simple' + (canAfford ? '' : ' locked');
    row.innerHTML = `
      <div class="cat-badge" style="background:${cat.bg};color:${cat.fg}">${cat.label}</div>
      <div class="supplies-info">
        <div class="supplies-line1"><span class="model">${m.name}</span></div>
        <div class="supplies-line2 compat">${compatTxt}</div>
        ${noteShort ? `<div class="supplies-line3 note">${noteShort}</div>` : ''}
        <div class="supplies-stock">${stock.toFixed(0)}g in stock</div>
      </div>
      <div class="supplies-action">
        <div class="supplies-price">${fmtPrice(cost)}<span class="muted">/${unit}</span></div>
        <button class="supplies-buy ${canAfford ? 'affordable' : ''}" onclick="window.buyMaterialDirect('${m.id}')" ${canAfford ? '' : 'disabled'}>${canAfford ? 'Buy 1' + unit : 'Short'}</button>
      </div>
    `;
    root.appendChild(row);
  });
}

function buyMaterialDirect(matId) {
  const m = materialById(matId);
  if (!m) return;
  const cost = m.costPerKg ?? m.costPerLiter ?? 0;
  if (state.money < cost) { toast('Not enough cash', 'error'); return; }
  state.money -= cost;
  state.inventory[matId] = (state.inventory[matId] || 0) + 1000;
  const unit = m.costPerLiter ? 'L' : 'kg';
  toast(`Bought 1${unit} ${m.name}`, 'success');
  render();
  renderSupplies();
}

// =====================================================================
// printer management — condition, upgrades, maintenance, nozzle swap, sell
// =====================================================================
let manageSlotIdx = -1;
let manageSig = '';

function openManage(slotIdx) {
  manageSlotIdx = slotIdx;
  manageSig = '';
  document.getElementById('manageModal').classList.add('open');
  renderManage();
}

function closeManage() {
  manageSlotIdx = -1;
  document.getElementById('manageModal').classList.remove('open');
}

function changeNozzle(nozzleId) {
  if (manageSlotIdx < 0) return;
  const slot = state.printers[manageSlotIdx];
  if (!slot) return;
  const noz = Sim.nozzleType(nozzleId);
  if (!noz) return;
  if (slot.phase !== 'idle') { toast('Stop the print first', 'error'); return; }
  const fresh = Sim.slotNozzle(slot).id === noz.id;
  if (!confirm(`${fresh ? 'Fit a fresh' : 'Swap to a'} ${noz.label} nozzle for ${fmtPrice(noz.cost)}?`)) return;
  afterAction(Sim.changeNozzle(Cat, state, manageSlotIdx, nozzleId), `Installed a ${noz.label} nozzle`);
}

function performService(slotIdx, serviceId) {
  const svc = Sim.SERVICE_OPTIONS.find(s => s.id === serviceId);
  if (!svc) return;
  const slot = state.printers[slotIdx];
  if (!slot) return;
  if (slot.phase !== 'idle') { toast('Stop the print first', 'error'); return; }
  if (state.money < svc.cost) { toast(`Need ${fmtPrice(svc.cost)}`, 'error'); return; }
  if (!confirm(`${svc.label} for ${fmtPrice(svc.cost)}?`)) return;
  const r = Sim.service(Cat, state, slotIdx, serviceId);
  afterAction(r, r.ok ? `${svc.label} complete · cleared ${r.cleared.toFixed(0)} h of wear` : null);
}

function sellPrinter(slotIdxArg) {
  const slotIdx = slotIdxArg !== undefined ? slotIdxArg : manageSlotIdx;
  if (slotIdx < 0) return;
  if (state.printers.length <= 1) { toast('Need at least one printer', 'error'); return; }
  const slot = state.printers[slotIdx];
  if (!slot) return;
  if (slot.phase !== 'idle') { toast('Stop the print first', 'error'); return; }
  const printer = printerById(slot.printerId);
  const sellAmt = Sim.calcSellPrice(Cat, slot);
  if (!confirm(`Sell ${printer.brand} ${printer.model} for ${fmtPrice(sellAmt)}?\nUsed: ${(slot.totalHours || 0).toFixed(1)} hours\n(Original: ${fmtPrice(slot.purchasePrice)})`)) return;
  const r = Sim.sellPrinter(Cat, state, slotIdx);
  if (!r.ok) { toast(r.reason, 'error'); return; }
  closeManage();
  // Rebuild the workshop cards so canvases and their views get cleaned up
  detachAllCards();
  document.getElementById('printers').innerHTML = '';
  afterAction(r, `Sold for ${fmtPrice(sellAmt)}`);
}

// Only the values the modal shows; while they stay the same the modal is left alone.
function manageSignature(slot) {
  return [manageSlotIdx, slot.printerId, slot.phase, slot.nozzleType, Math.round((slot.nozzleHealth ?? 1) * 100), Math.round((slot.bed ?? 1) * 100),
    (slot.upgrades || []).join('+'), Math.floor((slot.wearHours || 0) / 5), Math.floor((slot.totalHours || 0) / 5), state.printers.length,
    Math.floor(state.money)].join('|');
}

function bar(pct, color) {
  return `<div class="wear-bar"><div class="wear-bar-fill" style="width: ${Math.max(0, Math.min(100, pct)).toFixed(0)}%; background: ${color}"></div></div>`;
}

function renderManage() {
  if (manageSlotIdx < 0) return;
  const slot = state.printers[manageSlotIdx];
  if (!slot) return closeManage();
  const printer = printerById(slot.printerId);
  const sig = manageSignature(slot);
  if (sig === manageSig) return;
  manageSig = sig;
  const tc = Sim.techClass(printer);
  const fdm = Sim.usesNozzle(printer);
  const noz = fdm ? Sim.slotNozzle(slot) : null;
  const nozEff = noz ? (Sim.NOZZLE_EFFECTS[noz.size] || Sim.NOZZLE_EFFECTS[0.4]) : null;

  document.getElementById('manageSubtitle').innerHTML = printer.unknown
    ? `<strong>Unknown machine</strong> · <span class="muted">no longer in the catalog</span>`
    : `<span class="brand">${esc(printer.brand)}</span> <strong>${esc(printer.model)}</strong> · <span class="printer-tier ${printer.tier}">${printer.tier}</span>`;

  const sellAmt = Sim.calcSellPrice(Cat, slot);
  const isIdle = slot.phase === 'idle';
  const isOnly = state.printers.length <= 1;
  const busyLabel = Sim.busyText(slot);

  const rows = [];
  const row = (label, value) => rows.push(`<div class="manage-stat-row"><span class="manage-stat-label">${label}</span><span class="manage-stat-value">${value}</span></div>`);
  if (!printer.unknown) {
    row('Tech', `${printer.tech}${Sim.hardwareLabel(printer) ? ` <span class="muted">${Sim.hardwareLabel(printer)}</span>` : ''}`);
    row('Build volume', `${printer.buildVolumeMM.join(' × ')} mm`);
    if (fdm) row('Speed (now)', `${Math.round((printer.throughputGPH || 30) * nozEff.speed)} g/hr <span class="muted">(${printer.throughputGPH || 30} with 0.4 mm)</span>`);
    else row('Speed', `${printer.verticalMMPerHour} mm of height per hour <span class="muted">(every part on the plate at once)</span>`);
    row('Precision (now)', `${Sim.effectivePrecision(printer, slot).toFixed(2)} <span class="muted">(${printer.precision.toFixed(2)} stock)</span>`);
    row('Reliability', `${Math.round(printer.baseReliability * 100)}% <span class="muted">for a 4 h print, before wear and setup</span>`);
    row('Multi-material', printer.multiMaterialColors > 0 ? `${printer.multiMaterialColors} colors` : 'single');
    row('Power', `${printer.powerW} W average${printer.powerHotW ? ` · ${printer.powerHotW} W on hot materials` : ''} <span class="muted">($${Sim.KWH_PRICE.toFixed(2)}/kWh)</span>`);
    row('Released', esc(printer.released));
  } else {
    row('Status', 'This machine is no longer in the catalog. It can still be sold.');
  }

  // Condition: nozzle health and the bed (or build plate) a print sticks to.
  let conditionHtml = '';
  if (fdm || tc === 'resin') {
    const bed = slot.bed ?? 1;
    const bedWord = tc === 'resin' ? 'Build plate' : 'Bed';
    const bedState = bed >= 0.95 ? 'clean and level' : bed >= 0.7 ? 'a little grubby' : 'greasy: prints may come loose';
    const cleanBtn = `<button class="service-buy" data-act="cleanBed" data-slot="${manageSlotIdx}" ${isIdle && bed < 0.999 ? '' : 'disabled'}>${isIdle ? (bed < 0.999 ? 'Clean & level · free' : 'Clean') : busyLabel}</button>`;
    conditionHtml += `
      <div class="wear-bar-wrap">
        <div class="wear-bar-label"><span>${bedWord}: <strong>${bedState}</strong></span><span class="muted">${Math.round(bed * 100)}%</span></div>
        ${bar(bed * 100, bed >= 0.95 ? '#22c55e' : bed >= 0.7 ? '#fbbf24' : '#f97316')}
        <div class="condition-action">${cleanBtn}</div>
      </div>`;
    if (fdm) {
      const h = slot.nozzleHealth ?? 1;
      const nozState = h >= 0.8 ? 'like new' : h >= 0.5 ? 'wearing' : 'worn: rough prints and clogs';
      conditionHtml += `
        <div class="wear-bar-wrap">
          <div class="wear-bar-label"><span>Nozzle (${noz.label}): <strong>${nozState}</strong></span><span class="muted">${Math.round(h * 100)}% healthy</span></div>
          ${bar(h * 100, h >= 0.8 ? '#22c55e' : h >= 0.5 ? '#fbbf24' : '#f97316')}
          <div class="muted condition-note">Carbon-fiber and glass-filled filaments wear brass in about a third of a kilo; hardened steel lasts for kilograms.</div>
        </div>`;
    }
  }

  // Upgrades for this printer (extrusion machines only).
  let upgradesHtml = '';
  if (fdm && !printer.unknown) {
    const cards = Sim.UPGRADES.filter(u => u.scope === 'printer').map(u => {
      const builtIn = u.id === 'enclosure' ? printer.enclosed : !!printer.failureDetection;
      const owned = Sim.hasUpgrade(slot, u.id);
      const action = builtIn ? `<div class="nozzle-current">Built in</div>`
        : owned ? `<div class="nozzle-current">Fitted</div>`
        : `<button class="service-buy" data-act="buyUpgrade" data-arg="${u.id}" data-slot="${manageSlotIdx}" ${state.money >= u.cost ? '' : 'disabled'}>Fit ${fmtPrice(u.cost)}</button>`;
      return `<div class="service-card upgrade-card${owned || builtIn ? ' owned' : ''}"><div class="service-name">${u.name}</div><div class="service-desc">${u.desc}</div>${action}</div>`;
    }).join('');
    upgradesHtml = `<div class="manage-section"><h3>Upgrades</h3><div class="service-grid">${cards}</div></div>`;
  }

  // Maintenance section
  const ws = wearStatus(slot);
  const serviceCardsHtml = Sim.SERVICE_OPTIONS.map(svc => {
    const canAfford = state.money >= svc.cost;
    return `
      <div class="service-card">
        <div class="service-name">${svc.label}</div>
        <div class="service-desc">${svc.desc}</div>
        <div class="service-effect">Clears ${svc.reduceWear === 9999 ? 'all' : `${svc.reduceWear} h`} of wear</div>
        <button class="service-buy" data-act="performService" data-slot="${manageSlotIdx}" data-arg="${svc.id}" ${canAfford && isIdle ? '' : 'disabled'}>${isIdle ? `${fmtPrice(svc.cost)}` : 'Busy'}</button>
      </div>
    `;
  }).join('');
  const maintenanceHtml = `
    <div class="wear-bar-wrap">
      <div class="wear-bar-label">
        <span>Wear: <strong style="color: ${ws.color}">${ws.label}</strong></span>
        <span class="muted">${(slot.wearHours||0).toFixed(1)} h since last service</span>
      </div>
      ${bar(ws.pct, ws.color)}
    </div>
    <div class="service-grid">${serviceCardsHtml}</div>
  `;

  // Nozzle picker: extrusion printers only. Resin and powder machines show their hardware instead.
  let nozzleSectionHtml = '';
  if (fdm) {
    const nozzleHtml = Sim.NOZZLE_TYPES.map(n => {
      const isCurrent = n.id === noz.id;
      const eff = Sim.NOZZLE_EFFECTS[n.size];
      const canAfford = state.money >= n.cost;
      const worn = isCurrent && (slot.nozzleHealth ?? 1) < 0.999;
      const action = isCurrent && !worn
        ? `<div class="nozzle-current">Currently installed</div>`
        : `<button class="nozzle-buy" data-act="changeNozzle" data-arg="${n.id}" ${canAfford && isIdle ? '' : 'disabled'}>${isIdle ? `${worn ? 'Fit a fresh one' : 'Install'} ${fmtPrice(n.cost)}` : 'Busy'}</button>`;
      return `
        <div class="nozzle-card${isCurrent ? ' current' : ''}" data-nozzle="${n.id}">
          <div class="nozzle-name">${n.label}</div>
          <div class="nozzle-desc">${n.desc}</div>
          <div class="nozzle-effects">${eff.speed.toFixed(2)}× speed · ${eff.precision.toFixed(2)}× precision</div>
          ${action}
        </div>
      `;
    }).join('');
    nozzleSectionHtml = `
      <div class="manage-section" id="manageNozzles">
        <h3>Nozzle <span class="muted">— current: ${noz.label}</span></h3>
        <div class="nozzle-grid">${nozzleHtml}</div>
      </div>`;
  } else if (!printer.unknown) {
    const how = { resin: 'Resin printers have no nozzle: a light cures each whole layer at once, so time depends on how tall the parts are, not how many.',
      powder: 'Powder-bed printers have no nozzle: they fuse each layer of powder, so a full bed takes as long as one part. Unused powder is mixed with fresh powder for the next build.',
      metal: 'Metal powder-bed printers have no nozzle: a laser melts each layer of metal powder. Parts get a stress-relief bake afterwards.' }[tc] || '';
    nozzleSectionHtml = `<div class="manage-section" id="manageHardware"><h3>Hardware <span class="muted">— ${Sim.hardwareLabel(printer)}</span></h3><div class="hardware-note">${how}</div></div>`;
  }

  // Compatible materials list — show all the materials this printer can run
  const matsHtml = printer.materials.map(matId => {
    const mat = materialById(matId);
    if (!mat) return '';
    const stock = state.inventory[matId] || 0;
    const needsHard = fdm && Sim.isAbrasive(mat) && !Sim.isFiber(mat);
    const blocked = needsHard && noz.size <= 0.2;
    const cls = blocked ? 'mat-chip warn' : 'mat-chip ok';
    const tip = needsHard ? `${mat.name}: abrasive, wears brass fast${blocked ? '; needs a 0.4 mm or bigger nozzle' : ''}` : mat.name;
    return `<span class="${cls}" title="${esc(tip)}">${esc(mat.name)}${stock > 0 ? ` <span class="stock-num">${stock.toFixed(0)} g</span>` : ''}${blocked ? ' ⚠' : ''}</span>`;
  }).join('');

  document.getElementById('manageBody').innerHTML = `
    <div class="manage-section">
      <h3>Stats</h3>
      ${rows.join('')}
    </div>
    ${conditionHtml ? `<div class="manage-section" id="manageCondition"><h3>Condition</h3>${conditionHtml}</div>` : ''}
    ${upgradesHtml}
    <div class="manage-section">
      <h3>Maintenance</h3>
      ${maintenanceHtml}
    </div>
    ${nozzleSectionHtml}
    ${printer.materials.length ? `<div class="manage-section">
      <h3>Materials supported <span class="muted">— ${printer.materials.length} total</span></h3>
      <div class="mat-chip-grid">${matsHtml}</div>
    </div>` : ''}
    <div class="manage-section sell-section-wrap">
      <h3>Sell this printer</h3>
      <div class="sell-row">
        <div class="sell-info">
          <div class="sell-price-display">${fmtPrice(sellAmt)}</div>
          <div class="sell-meta">
            Original: ${fmtPrice(slot.purchasePrice)} <span class="sep">·</span>
            ${(slot.totalHours || 0).toFixed(1)} hrs used <span class="sep">·</span>
            ${slot.purchasePrice ? ((sellAmt/slot.purchasePrice)*100).toFixed(0) : 0}% of new
          </div>
          <div class="sell-meta muted">Starts at 75% of new, drops with lifetime hours (floor 15%)</div>
        </div>
        <button class="sell-button" data-act="sellPrinter" ${(isIdle && !isOnly) ? '' : 'disabled'}>${
          isOnly ? "Can't sell only printer" :
          !isIdle ? busyLabel :
          'Sell'
        }</button>
      </div>
    </div>
  `;
}

// One listener for every button the Manage modal draws (they call through window, like the
// inline handlers elsewhere, so a wrapped window function still sees every press).
function onManageClick(e) {
  const b = e.target.closest('button[data-act]');
  if (!b || b.disabled) return;
  const slot = b.dataset.slot !== undefined ? Number(b.dataset.slot) : manageSlotIdx;
  switch (b.dataset.act) {
    case 'changeNozzle': window.changeNozzle(b.dataset.arg); break;
    case 'performService': window.performService(slot, b.dataset.arg); break;
    case 'buyUpgrade': window.buyUpgrade(b.dataset.arg, slot); break;
    case 'cleanBed': window.cleanBed(slot); break;
    case 'sellPrinter': window.sellPrinter(); break;
  }
}

const ICON_FOR_CAT = { fdm: '⚙', resin: '✦', industrial: '▣' };

// 3D pictures of each machine (blob URLs from the stage), filled in as they arrive.
const shopThumbs = new Map();
function requestShopThumbnails() {
  if (!stage) return;
  // Rows in view first: the current filter's order, then the rest.
  const list = printersCat.slice().sort((a, b) => a.price - b.price);
  const first = shopFilter === 'all' ? list : list.filter(p => p.tier === shopFilter).concat(list.filter(p => p.tier !== shopFilter));
  for (const printer of first) {
    if (shopThumbs.has(printer.id)) continue;
    shopThumbs.set(printer.id, null);
    stage.printerThumb(printer).then((url) => {
      shopThumbs.set(printer.id, url);
      if (document.getElementById('shopModal').classList.contains('open')) renderShop();
    }, () => shopThumbs.delete(printer.id));
  }
}

// Rows are built once per printer and kept; a render only patches the buy button, the lock
// state and the thumbnail when one of them actually changes.
const shopRows = new Map();
function shopRowFor(printer) {
  let r = shopRows.get(printer.id);
  if (r) return r;
  const cat = printerCategory(printer);
  const el = document.createElement('div');
  el.className = 'shop-row';
  el.dataset.printer = printer.id;
  const matsBrief = (printer.materials || []).slice(0, 5).map(m => {
    const mat = materialById(m);
    return `<span class="mat-pill">${esc(mat ? mat.name : m)}</span>`;
  }).join('');
  const moreCount = printer.materials.length > 5 ? `<span class="mat-pill">+${printer.materials.length-5}</span>` : '';
  const specs = `${printer.tech} <span class="sep">·</span> ${printer.buildVolumeMM.join('×')} mm <span class="sep">·</span> ${speedLabel(printer)} <span class="sep">·</span> ${(printer.baseReliability*100).toFixed(0)}% reliable`;
  el.innerHTML = `
    <div class="shop-icon ${cat}">${ICON_FOR_CAT[cat]}</div>
    <div class="shop-row-info">
      <div class="shop-row-line1">
        <span class="brand">${esc(printer.brand)}</span>
        <span class="model">${esc(printer.model)}</span>
        <span class="printer-tier ${printer.tier}">${printer.tier}</span>
      </div>
      <div class="shop-row-line2">${specs}</div>
      <div class="shop-row-line3">${matsBrief}${moreCount}</div>
    </div>
    <div class="shop-row-action">
      <div class="shop-price">${fmtPrice(printer.price)}</div>
      <button class="shop-buy" data-buy="${printer.id}"></button>
    </div>
  `;
  r = { el, btn: el.querySelector('.shop-buy'), thumb: false, sig: '' };
  shopRows.set(printer.id, r);
  return r;
}

function renderShop() {
  const root = document.getElementById('shopList');
  let list = printersCat.slice();
  if (shopFilter !== 'all') list = list.filter(p => p.tier === shopFilter);
  list.sort((a, b) => a.price - b.price);
  // Order and membership (only changes with the filter)
  const want = list.map(p => shopRowFor(p).el);
  if (root.children.length !== want.length || want.some((el, i) => root.children[i] !== el)) {
    root.replaceChildren(...want);
  }
  for (const printer of list) {
    const r = shopRowFor(printer);
    const thumb = shopThumbs.get(printer.id);
    if (thumb && !r.thumb) {
      const img = document.createElement('img');
      img.className = 'shop-thumb';
      img.alt = `${printer.brand} ${printer.model}`;
      img.src = thumb;
      r.el.querySelector('.shop-icon').replaceWith(img);
      r.thumb = true;
    }
    const repNeeded = Sim.TIER_UNLOCK_REP[printer.tier] || 0;
    const repOK = state.reputation >= repNeeded;
    const moneyOK = state.money >= printer.price;
    const label = !repOK ? `Need ${repNeeded} rep` : !moneyOK ? `${fmtPrice(Math.ceil(printer.price - state.money))} short` : 'Buy';
    const sig = `${repOK}|${moneyOK}|${label}`;
    if (sig === r.sig) continue;
    r.sig = sig;
    r.el.classList.toggle('locked', !(repOK && moneyOK));
    r.btn.textContent = label;
    r.btn.disabled = !(repOK && moneyOK);
    r.btn.classList.toggle('affordable', repOK && moneyOK);
  }
}

// =====================================================================
// main tick
// =====================================================================
function tick() {
  const now = Date.now();
  let realDelta = (now - lastTickReal) / 1000;
  lastTickReal = now;
  // A clock that jumped backwards does nothing, and a long gap (a sleeping laptop, a throttled
  // background tab) counts as one second: the shop never races ahead while nobody watches.
  if (!(realDelta > 0)) realDelta = 0;
  realDelta = Math.min(realDelta, 1);
  const gameHours = realDelta * speed / REAL_SEC_PER_GAME_HOUR;
  const out = Sim.step(Cat, state, gameHours);
  for (const k of Object.keys(out.dirty)) if (out.dirty[k]) dirty[k] = true;
  if (out.dirty.money || out.dirty.printers) dirty.shop = true;
  if (out.dirty.printers || out.dirty.money) dirty.manage = true;
  handleEvents(out.events);
  render();
  saveState();
}

// =====================================================================
// 3D: one shared renderer (docs/stage.js) draws every printer card, shop thumbnail and order part
// =====================================================================
const printerScenes = new Map();   // card canvas -> its view on the stage (one per printer card)
let stage = null;                   // the stage once docs/stage.js has loaded; null without WebGL

// Load the stage after the page has drawn; without it the cards keep their plain background.
async function startStage() {
  if (!window.THREE || !window.LineSegments2 || !window.mergeGeometries) return null;
  try {
    const mod = await import('./stage.js?v=' + encodeURIComponent(BUILD));
    stage = await mod.createStage({
      THREE: window.THREE, build: BUILD, Sim, cat: Cat, getState: () => state, brandColors: BRAND_COLORS,
      clock: {
        speed: () => speed,
        secondsPerGameHour: REAL_SEC_PER_GAME_HOUR,
        // Game hours since the last tick, so motion is smooth between quarter-second ticks.
        hoursSinceTick: () => Math.max(0, Math.min(TICK_MS * 2, Date.now() - lastTickReal)) / 1000 * speed / REAL_SEC_PER_GAME_HOUR,
      },
      RoomEnvironment: window.RoomEnvironment, RoundedBoxGeometry: window.RoundedBoxGeometry, mergeGeometries: window.mergeGeometries,
      Line2: window.Line2, LineMaterial: window.LineMaterial, LineGeometry: window.LineGeometry,
      LineSegments2: window.LineSegments2, LineSegmentsGeometry: window.LineSegmentsGeometry,
    });
  } catch (e) {
    console.warn('[Print3D] 3D view unavailable:', e && e.message ? e.message : e);
    stage = null;
  }
  return stage;
}

// Hand a card's canvas to the stage (once): it draws whatever printer sits in that slot.
function attachCard(card, i) {
  if (!stage || !card) return;
  const canvas = card.querySelector('.printer-canvas');
  if (!canvas || printerScenes.has(canvas)) return;
  printerScenes.set(canvas, stage.attach(canvas, () => state.printers[i]));
}
function attachAllCards() {
  const root = document.getElementById('printers');
  if (root) for (let i = 0; i < root.children.length; i++) attachCard(root.children[i], i);
}
function detachAllCards() {
  if (stage) stage.clear();
  printerScenes.clear();
}


// =====================================================================
// DOM rendering
// Every list is built once and patched in place: a node is only written when what it shows has
// changed, so a button under the pointer stays the same button between mousedown and mouseup.
// =====================================================================

// Write text (or HTML) into a node only when it differs from what was last written there.
function put(cache, key, el, value, html) {
  if (cache[key] === value) return;
  cache[key] = value;
  if (html) el.innerHTML = value; else el.textContent = value;
}
function showEl(cache, key, el, on, display = '') {
  if (cache[key] === on) return;
  cache[key] = on;
  el.style.display = on ? display : 'none';
}

function ensurePrinterCards() {
  const root = document.getElementById('printers');
  // Track current cards by slotId so reorders / removals are cheap
  while (root.children.length < state.printers.length) {
    const card = document.createElement('div');
    card.className = 'printer-card';
    card.innerHTML = `
      <canvas class="printer-canvas"></canvas>
      <div class="printer-info">
        <div class="printer-name"></div>
        <div class="printer-specs"></div>
        <div class="printer-meta"></div>
        <div class="printer-status"></div>
        <div class="progress" style="display:none"><div class="fill"></div></div>
        <div class="job-info" style="display:none"></div>
        <div class="printer-actions">
          <button class="card-action" style="display:none"></button>
          <button class="card-secondary" style="display:none"></button>
          <button class="printer-manage-btn">Manage / Sell</button>
        </div>
      </div>
    `;
    card._v = {};
    card._el = {
      name: card.querySelector('.printer-name'), specs: card.querySelector('.printer-specs'), meta: card.querySelector('.printer-meta'),
      status: card.querySelector('.printer-status'), progress: card.querySelector('.progress'), fill: card.querySelector('.progress .fill'),
      job: card.querySelector('.job-info'), action: card.querySelector('.card-action'), secondary: card.querySelector('.card-secondary'),
    };
    root.appendChild(card);
    attachCard(card, root.children.length - 1);
  }
  while (root.children.length > state.printers.length) {
    const removed = root.lastChild;
    const canvas = removed.querySelector('canvas');
    if (printerScenes.has(canvas)) { if (stage) stage.detach(canvas); printerScenes.delete(canvas); }
    root.removeChild(removed);
  }
}

function renderPrinters() {
  ensurePrinterCards();
  const root = document.getElementById('printers');
  state.printers.forEach((slot, i) => {
    const card = root.children[i];
    if (!card || !card._el) return;
    const slotKey = `${slot.slotId}|${slot.printerId}`;
    if (card._v.slotKey !== slotKey) card._v = { slotKey };     // a different printer now sits at this index
    const v = card._v, el = card._el;
    const printer = printerById(slot.printerId);
    const fdm = Sim.usesNozzle(printer);
    const phase = slot.phase || 'idle';
    const st = Sim.slotStatus(Cat, state, slot);
    const active = phase === 'heating' || phase === 'prep' || phase === 'printing' || phase === 'coldpull' || phase === 'cleaning';
    if (v.cls !== `${active}|${st.tone}`) {
      v.cls = `${active}|${st.tone}`;
      card.classList.toggle('printing', active);
      card.classList.toggle('attention', st.tone === 'done');
      card.classList.toggle('fault', st.tone === 'fault');
    }
    put(v, 'name', el.name, printer.unknown
      ? `<strong>Unknown machine</strong> <span class="printer-tier">retired</span>`
      : `<span class="brand">${esc(printer.brand)}</span> <strong>${esc(printer.model)}</strong> <span class="printer-tier ${printer.tier}">${printer.tier}</span>`, true);
    put(v, 'specs', el.specs, printer.unknown ? 'No longer in the catalog · sell it in Manage'
      : `${printer.tech} · ${printer.buildVolumeMM.join('×')} mm · ${speedLabel(printer)} · ${(printer.baseReliability*100).toFixed(0)}% reliable`);

    const pills = [];
    if (fdm) {
      const noz = Sim.slotNozzle(slot);
      const h = slot.nozzleHealth ?? 1;
      pills.push(`<span class="meta-pill">${noz.size} mm ${noz.metal === 'brass' ? 'brass' : `<span class="hardened">${noz.metal}</span>`}${h < 0.5 ? ' · worn' : ''}</span>`);
    }
    for (const u of slot.upgrades || []) pills.push(`<span class="meta-pill">${u === 'enclosure' ? 'Enclosure' : 'Camera'}</span>`);
    pills.push(`<span class="meta-pill">${Math.floor(slot.totalHours || 0)} h used</span>`);
    pills.push(`<span class="meta-pill resale">${fmtPrice(Sim.calcSellPrice(Cat, slot))} resale</span>`);
    put(v, 'meta', el.meta, pills.join(' '), true);

    put(v, 'status', el.status, st.line);
    if (v.tone !== st.tone) { v.tone = st.tone; el.status.className = 'printer-status ' + st.tone; }

    const job = slot.job;
    const showProgress = !!job && phase !== 'idle' && phase !== 'cleaning';
    showEl(v, 'progressOn', el.progress, showProgress, 'block');
    if (showProgress) {
      const pct = Math.round(Sim.partProgress(slot) * 100);
      if (v.pct !== pct) { v.pct = pct; el.fill.style.width = `${pct}%`; }
    }
    showEl(v, 'jobOn', el.job, !!job, 'flex');
    if (job) {
      const mat = Sim.cap(Sim.materialLabel(Cat, job.materialId));
      // A damp spool strings (the 3D view shows the wisps; this says it in words).
      const m = materialById(job.materialId);
      const damp = fdm && m && m.dampHours55 && phase === 'printing' && Sim.wetOf(state, job.materialId) >= 0.3 ? ' · damp spool, stringy' : '';
      put(v, 'job', el.job, `<span>${esc(job.productName)}${job.customer ? ` for ${esc(job.customer)}` : ''}</span><span>${esc(mat)} · ${Math.round(job.grams)} g${damp}</span>`, true);
    }

    const a = st.action;
    showEl(v, 'actOn', el.action, !!a, '');
    if (a) {
      put(v, 'actLabel', el.action, a.label);
      if (el.action.dataset.act !== a.id) { el.action.dataset.act = a.id; el.action.className = 'card-action ' + a.id; }
    }
    const s2 = st.secondary;
    showEl(v, 'secOn', el.secondary, !!s2, '');
    if (s2) {
      put(v, 'secLabel', el.secondary, s2.label);
      if (el.secondary.dataset.act !== s2.id) el.secondary.dataset.act = s2.id;
    }
  });
}

// What an order earns on the best printer for it: one that can take it now, else one that could
// once it's free or stocked.
function bestFor(order) {
  let best = null, fallback = null;
  state.printers.forEach((slot, i) => {
    const c = canAssign(order, slot);
    if (c.ok) {
      const est = Sim.estimateJob(Cat, state, slot, order, c.materialId);
      const risk = Sim.jobRisk(Cat, state, slot, order, est);
      const value = est.keep * risk.chance;
      if (!best || value > best.value) best = { i, slot, c, est, risk, value };
    } else if (!fallback && (c.code === 'busy' || c.code === 'stock')) {
      const probe = c.code === 'busy' ? canAssign(order, { ...slot, phase: 'idle', state: 'idle' }) : c;
      if (probe.ok || probe.code === 'stock') {
        const est = Sim.estimateJob(Cat, state, slot, order, probe.materialId || order.materialId);
        fallback = { i, slot, c, est };
      }
    }
  });
  return best || fallback;
}

// Why nothing can take an order right now. A busy printer that could make it once it's free comes
// first (with how long, or what to do to free it), so owning the right machine never reads as
// "needs a resin printer". Otherwise the easiest fix among the printers that never could.
function waitReason(order, checks, one) {
  if (!state.printers.length) return 'No printers yet · buy one in the shop';
  let soonest = null;
  const never = [];
  checks.forEach((c, i) => {
    if (c.code !== 'busy') { never.push(c); return; }
    const slot = state.printers[i];
    const probe = canAssign(order, { ...slot, phase: 'idle', state: 'idle' });
    if (!probe.ok && probe.code !== 'stock') { never.push(probe); return; }
    const j = slot.job;
    const wait = (slot.phase === 'heating' || slot.phase === 'prep' || slot.phase === 'printing') && j ? Math.max(0, j.hoursTotal - j.hoursElapsed)
      : (slot.phase === 'cleaning' || slot.phase === 'coldpull') ? Math.max(0, slot.timer || 0) : 0;
    if (!soonest || wait < soonest.wait) soonest = { slot, wait, probe };
  });
  const stockNow = never.find(c => c.code === 'stock');   // a free printer that only needs material: buying it is quickest
  if (stockNow) return stockNow.reason;
  if (soonest) {
    const who = one ? 'Your printer' : `The ${printerById(soonest.slot.printerId).model}`;
    const then = { done: 'collect its part first', clogged: 'do a cold pull first', failed: 'reprint or release its failed print first' }[soonest.slot.phase]
      || `when it's free · ${Sim.fmtDuration(Math.ceil(soonest.wait * 12) / 12)} left`;
    const stock = soonest.probe.code === 'stock' ? ` · ${soonest.probe.reason.replace(/^Needs /, 'needs ')}` : '';
    return `${who} can make it ${then}${stock}`;
  }
  let pick = null;
  for (const code of Sim.REASON_PRIORITY) { pick = never.find(c => c.code === code); if (pick) break; }
  return (pick || never[0]).reason;
}

function dueText(order) {
  const h = order.dueAt != null ? order.dueAt - Sim.now(state) : order.deadlineHours;
  if (h >= 24) return `Due in ${Sim.fmtDuration(h)}`;
  if (h >= 2) return `Due in ${Math.floor(h)} h`;
  return `Due in ${Math.max(5, Math.ceil(h * 60 / 5) * 5)} m`;
}

const orderEls = new Map();   // order id -> { el, v, parts }
let ordersShell = null;
let lastOrdersRender = 0;
function renderOrders() {
  const root = document.getElementById('orders');
  if (!ordersShell || ordersShell.root !== root || !root.contains(ordersShell.list)) {
    root.innerHTML = `<div class="orders-toolbar" style="display:none"><button class="reject-all-btn" data-act="rejectAll"></button></div>
      <div class="empty" style="display:none">No incoming orders. Hang tight…</div><div class="orders-list"></div>`;
    ordersShell = { root, toolbar: root.querySelector('.orders-toolbar'), rejectAll: root.querySelector('.reject-all-btn'),
      empty: root.querySelector('.empty'), list: root.querySelector('.orders-list'), v: {} };
    orderEls.clear();
  }
  const S = ordersShell;
  showEl(S.v, 'toolbar', S.toolbar, state.orders.length >= 3, 'flex');
  if (state.orders.length >= 3) put(S.v, 'rejectAll', S.rejectAll, `Decline all ${state.orders.length}`);
  showEl(S.v, 'empty', S.empty, state.orders.length === 0, 'block');

  const live = new Set();
  const wanted = [];
  for (const order of state.orders) {
    live.add(order.id);
    let o = orderEls.get(order.id);
    if (!o) {
      const el = document.createElement('div');
      el.className = 'order-card';
      el.dataset.order = order.id;
      el.innerHTML = `<img class="order-thumb" alt="" aria-hidden="true" hidden><div class="order-name"></div><div class="order-spec"></div><div class="order-cost"></div><div class="order-pay"></div>
        <div class="order-deadline"></div><div class="order-reason" style="display:none"></div><div class="order-actions"></div>`;
      o = { el, v: {}, parts: { name: el.querySelector('.order-name'), spec: el.querySelector('.order-spec'), cost: el.querySelector('.order-cost'),
        pay: el.querySelector('.order-pay'), due: el.querySelector('.order-deadline'), reason: el.querySelector('.order-reason'), actions: el.querySelector('.order-actions'),
        thumb: el.querySelector('.order-thumb') } };
      orderEls.set(order.id, o);
    }
    wanted.push(o.el);
    const { v, parts } = o;
    // The part itself, in its material and colour (drawn by the stage, a few per frame).
    if (stage && !o.thumbAsked) {
      o.thumbAsked = true;
      stage.partThumb(order).then((url) => {
        if (!url) return;
        parts.thumb.src = url;
        parts.thumb.hidden = false;
        o.el.classList.add('has-thumb');
      }, () => {});
    }
    const matLabel = Sim.cap(Sim.materialLabel(Cat, order.materialId));
    put(v, 'name', parts.name, `${esc(order.productName)}<span class="order-cat">${esc(order.category || '')}</span>${order.customer ? `<span class="order-for">for ${esc(order.customer)}</span>` : ''}`, true);
    const best = bestFor(order);
    if (best) {
      put(v, 'spec', parts.spec, `${matLabel} · ${Sim.fmtDuration(best.est.totalHours)} · you keep ${fmtMoney(best.est.keep)}`);
      put(v, 'cost', parts.cost, `${Sim.fmtGrams(best.est.usedGrams)} material ${fmtMoney(best.est.matCost)} · power ${fmtMoney(best.est.powerCost)}${best.est.finishHours > 0 ? ` · includes ${Sim.fmtDuration(best.est.finishHours)} finishing` : ''}`);
    } else {
      put(v, 'spec', parts.spec, `${matLabel} · ${Sim.fmtGrams(order.grams)}${order.batchSize > 1 ? ` · batch of ${order.batchSize}` : ''}`);
      put(v, 'cost', parts.cost, '');
    }
    put(v, 'pay', parts.pay, `Pays up to ${fmtMoney(order.basePrice)}`);
    const due = dueText(order);
    put(v, 'due', parts.due, due);
    const urgent = (order.dueAt != null ? order.dueAt - Sim.now(state) : order.deadlineHours) < 12;
    if (v.urgent !== urgent) { v.urgent = urgent; parts.due.classList.toggle('urgent', urgent); }

    // One button for each printer that can take it now (best first), with its chance and the risk
    // to fix; otherwise the easiest reason to fix.
    const checks = state.printers.map((slot) => canAssign(order, slot));
    const ready = [];
    checks.forEach((c, i) => {
      if (!c.ok) return;
      const slot = state.printers[i];
      const est = Sim.estimateJob(Cat, state, slot, order, c.materialId);
      const risk = Sim.jobRisk(Cat, state, slot, order, est);
      ready.push({ i, est, risk, value: est.keep * risk.chance });
    });
    ready.sort((a, b) => b.value - a.value);
    const one = state.printers.length === 1;
    const buttons = ready.slice(0, 4).map((r) => {
      const model = printerById(state.printers[r.i].printerId).model;
      const late = r.est.lateFactor < 1 ? ` · late: pays ${Math.round(r.est.lateFactor * 100)}%` : '';
      return `<button data-act="assign" data-order="${order.id}" data-slot="${r.i}" title="${esc(r.risk.text)}"><span class="assign-main">${one ? 'Print it' : `Print on ${esc(model)}`}</span><span class="assign-risk${r.risk.chance < 0.7 ? ' risky' : ''}">${esc(r.risk.text)}${late}</span></button>`;
    });
    buttons.push(`<button class="reject" data-act="reject" data-order="${order.id}" title="Decline">Decline</button>`);
    put(v, 'actions', parts.actions, buttons.join(''), true);

    let reason = '';
    if (!ready.length) reason = waitReason(order, checks, one);
    showEl(v, 'reasonOn', parts.reason, !!reason, 'block');
    if (reason) put(v, 'reason', parts.reason, reason);
  }
  for (const [id, o] of orderEls) if (!live.has(id)) { o.el.remove(); orderEls.delete(id); }
  const list = S.list;
  if (list.children.length !== wanted.length || wanted.some((el, i) => list.children[i] !== el)) {
    wanted.forEach((el, i) => { if (list.children[i] !== el) list.insertBefore(el, list.children[i] || null); });
  }
  lastOrdersRender = Date.now();
}

// Materials: shop upgrades for storage on top, then every material, grouped, stock first.
const matEls = new Map();
let invShell = null;
function renderInventory() {
  const root = document.getElementById('inventory');
  if (!invShell || !root.contains(invShell.upgrades)) {
    root.innerHTML = '';
    matEls.clear();
    const upgrades = document.createElement('div');
    upgrades.className = 'shop-upgrades';
    upgrades.innerHTML = `<div class="inv-cat-header"><span>SHOP UPGRADES</span></div>` + Sim.UPGRADES.filter(u => u.scope === 'shop').map(u => `
      <div class="mat-card upgrade-row" data-upgrade="${u.id}" title="${esc(u.desc)}">
        <div class="mat-info"><div class="mat-name">${u.name}</div><div class="mat-stock">${u.short}</div></div>
        <button class="mat-buy" data-act="buyShopUpgrade" data-arg="${u.id}"></button>
      </div>`).join('');
    root.appendChild(upgrades);
    const groups = {};
    for (const cat of ['filament', 'resin', 'powder', 'fiber']) {
      const box = document.createElement('div');
      box.className = 'inv-group';
      box.innerHTML = `<div class="inv-cat-header"><span>${{ filament: 'FILAMENT', resin: 'RESIN', powder: 'POWDER', fiber: 'FIBER / METAL' }[cat]}</span> <span class="inv-cat-count"></span></div><div class="inv-items"></div>`;
      root.appendChild(box);
      groups[cat] = { box, items: box.querySelector('.inv-items'), count: box.querySelector('.inv-cat-count') };
    }
    invShell = { upgrades, groups, v: {} };
    const totalEl = document.getElementById('inventoryTotal');
    if (totalEl) totalEl.textContent = `${materialsCat.length} materials`;
  }
  // Shop upgrade rows
  for (const row of invShell.upgrades.querySelectorAll('[data-upgrade]')) {
    const u = Sim.UPGRADES.find(x => x.id === row.dataset.upgrade);
    const owned = Sim.hasShopUpgrade(state, u.id);
    const btn = row.querySelector('button');
    const label = owned ? 'Owned' : `Buy ${fmtPrice(u.cost)}`;
    const dis = owned || state.money < u.cost;
    if (btn.textContent !== label) btn.textContent = label;
    if (btn.disabled !== dis) btn.disabled = dis;
    if (row.classList.contains('has-stock') !== owned) row.classList.toggle('has-stock', owned);
  }

  const groups = { filament: [], resin: [], powder: [], fiber: [] };
  materialsCat.forEach(m => { (groups[m.category] || groups.powder).push(m); });
  const hasDryer = Sim.hasShopUpgrade(state, 'dryer');
  for (const [cat, items] of Object.entries(groups)) {
    const g = invShell.groups[cat];
    put(invShell.v, 'count-' + cat, g.count, String(items.length));
    items.sort((a, b) => {
      const sa = state.inventory[a.id] || 0, sb = state.inventory[b.id] || 0;
      if ((sa > 0) !== (sb > 0)) return sa > 0 ? -1 : 1;
      return (a.costPerKg ?? 0) - (b.costPerKg ?? 0);
    });
    const wanted = [];
    for (const m of items) {
      let o = matEls.get(m.id);
      if (!o) {
        const el = document.createElement('div');
        el.className = 'mat-card';
        el.dataset.mat = m.id;
        el.innerHTML = `<div class="mat-info"><div class="mat-name"></div><div class="mat-stock"></div></div>
          <button class="mat-dry" data-act="dry" data-arg="${m.id}" style="display:none">Dry</button>
          <button class="mat-buy" data-act="buy" data-arg="${m.id}">Buy 1 kg</button>`;
        o = { el, v: {}, name: el.querySelector('.mat-name'), stock: el.querySelector('.mat-stock'), dry: el.querySelector('.mat-dry'), buy: el.querySelector('.mat-buy') };
        matEls.set(m.id, o);
      }
      wanted.push(o.el);
      const stock = state.inventory[m.id] || 0;
      const unitCost = m.costPerKg ?? 0;
      const compatCount = state.printers.filter(slot => printerById(slot.printerId).materials.includes(m.id)).length;
      const cls = 'mat-card' + (stock > 0 ? ' has-stock' : '') + (compatCount === 0 ? ' incompat' : '');
      if (o.v.cls !== cls) { o.v.cls = cls; o.el.className = cls; }
      put(o.v, 'name', o.name, `${esc(m.name)}${compatCount === 0 ? ' <span class="incompat-tag" title="No owned printer supports this material">N/A</span>' : ''}`, true);
      const wet = Sim.wetOf(state, m.id);
      const drying = state.dryer && state.dryer.materialId === m.id;
      let damp = '';
      if (drying) damp = ` · <span class="damp-tag drying">drying · ${Sim.fmtDuration(Math.ceil(state.dryer.hoursLeft * 4) / 4)} left</span>`;
      else if (m.dampHours55 && stock > 0 && wet >= 0.3) damp = ` · <span class="damp-tag${wet >= Sim.DAMP_AT ? ' wet' : ''}">damp ${Math.round(wet * 20) * 5}%</span>`;
      put(o.v, 'stock', o.stock, `${stock > 0 ? `<strong class="stock-yes">${stock.toFixed(0)} g</strong> · ` : ''}<span class="mat-price">$${unitCost}/kg</span>${damp}`, true);
      const canAfford = state.money >= unitCost;
      if (o.buy.disabled === canAfford) o.buy.disabled = !canAfford;
      const dryable = !!m.dryHours && stock > 0 && (wet >= 0.2 || drying);
      showEl(o.v, 'dryOn', o.dry, dryable, '');
      if (dryable) {
        const label = drying ? 'Drying' : !hasDryer ? 'Dry' : state.dryer ? 'Dryer busy' : 'Dry';
        put(o.v, 'dryLabel', o.dry, label);
        const dis = drying || !hasDryer || !!state.dryer;
        if (o.dry.disabled !== dis) o.dry.disabled = dis;
        const title = !hasDryer ? 'Buy a filament dryer (shop upgrades, above)' : `${m.dryHours} h at ${m.dryC} °C`;
        if (o.dry.title !== title) o.dry.title = title;
      }
    }
    if (g.items.children.length !== wanted.length || wanted.some((el, i) => g.items.children[i] !== el)) {
      wanted.forEach((el, i) => { if (g.items.children[i] !== el) g.items.insertBefore(el, g.items.children[i] || null); });
    }
  }
}

// The shop log: newest first, the last 50 things that happened.
const logSeen = new WeakSet();
function renderLog() {
  const root = document.getElementById('log');
  if (!root) return;
  const fresh = [];
  for (const entry of state.log) { if (logSeen.has(entry)) break; fresh.push(entry); }
  if (!fresh.length && root.children.length === state.log.length) return;
  if (fresh.length === state.log.length) root.innerHTML = '';
  for (let k = fresh.length - 1; k >= 0; k--) {
    const e = fresh[k];
    logSeen.add(e);
    const line = document.createElement('div');
    line.className = 'log-line ' + (e.kind || 'info');
    line.innerHTML = `<span class="log-time">Day ${e.day} ${fmtTime(e.hour)}</span> ${esc(e.text)}`;
    root.insertBefore(line, root.firstChild);
  }
  while (root.children.length > state.log.length) root.removeChild(root.lastChild);
  const count = document.getElementById('logCount');
  if (count) put(headerV, 'logCount', count, state.log.length ? `last ${state.log.length}` : '');
}

// Parts off the printer, still washing, curing, cooling or in the furnace.
const stationV = {};
function renderStations() {
  const root = document.getElementById('stations');
  if (!root) return;
  const html = state.stations.map((s) => {
    const ph = s.phases[s.idx];
    const left = s.phases.slice(s.idx).reduce((a, p) => a + p.h, 0) - s.t;
    const word = ph ? (Sim.FINISH_NAMES[ph.id] || ph.id) : 'finishing';
    return `<div class="station-line"><span class="station-what">${esc(s.customer ? `${s.customer}'s ` : '')}${esc(s.productName)}</span>` +
      `<span class="station-phase">${word} · ${Sim.fmtDuration(Math.max(0, left))} left</span></div>`;
  }).join('');
  put(stationV, 'html', root, html ? `<div class="stations-title">Finishing</div>${html}` : '', true);
  if (stationV.on !== !!html) { stationV.on = !!html; root.hidden = !html; }
}

const headerV = {};
function renderHeader() {
  const set = (id, value) => { const el = document.getElementById(id); if (el) put(headerV, id, el, value); };
  set('money', state.money.toFixed(2));
  set('day', String(state.day));
  set('hour', fmtTime(state.hour));
  set('rep', String(state.reputation));
  set('shipped', String(state.shipped));
  set('humidity', `${Math.round(state.humidity ? state.humidity.rh : 45)}%`);
  set('printerCount', `${state.printers.length} printer${state.printers.length === 1 ? '' : 's'}`);
  set('orderCount', `${state.orders.length} pending`);
  set('btnSpeed', `${speed}x`);
  const done = state.printers.filter(s => s.phase === 'done').length;
  const btn = document.getElementById('btnCollectAll');
  if (btn) {
    put(headerV, 'collectAll', btn, done ? `Collect all (${done})` : 'Collect all');
    if (headerV.collectOn !== done > 0) { headerV.collectOn = done > 0; btn.hidden = !done; }
  }
  const finishing = state.stations.length;
  const fin = document.getElementById('finishing');
  if (fin) {
    put(headerV, 'finishing', fin, finishing ? `${finishing} part${finishing === 1 ? '' : 's'} finishing` : '');
    if (headerV.finOn !== finishing > 0) { headerV.finOn = finishing > 0; fin.hidden = !finishing; }
  }
}

// Draw what changed. The orders board also refreshes once a second for its countdowns.
function render() {
  renderHeader();
  if (dirty.stations || dirty.printers) { dirty.stations = false; renderStations(); }
  if (dirty.printers) { dirty.printers = false; renderPrinters(); }
  if (dirty.orders || Date.now() - lastOrdersRender > 1000) { dirty.orders = false; renderOrders(); }
  if (dirty.inventory) { dirty.inventory = false; renderInventory(); }
  if (dirty.log) { dirty.log = false; renderLog(); }
  if (document.getElementById('shopModal').classList.contains('open') && dirty.shop) { dirty.shop = false; renderShop(); }
  if (manageSlotIdx >= 0 && dirty.manage) { dirty.manage = false; renderManage(); }
}

function resetKeyedLists() {
  orderEls.clear(); ordersShell = null;
  matEls.clear(); invShell = null;
  const log = document.getElementById('log');
  if (log) log.innerHTML = '';
  for (const k of Object.keys(headerV)) delete headerV[k];
  for (const k of Object.keys(stationV)) delete stationV[k];
}

// =====================================================================
// Animation loop: the stage draws the cards that need it each frame
// =====================================================================
function animate() {
  if (stage && state) stage.frame(performance.now());
  requestAnimationFrame(animate);
}

// =====================================================================
// Toast / speed control / boot
// =====================================================================
let toastTimer = null;
function toast(msg, kind) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = 'toast show' + (kind ? ' ' + kind : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.className = 'toast'; }, 2600);
}

function cycleSpeed() {
  const cycle = [1, 2, 4, 8];
  const i = cycle.indexOf(speed);
  speed = cycle[(i + 1) % cycle.length];
  render();
}

function buyShopUpgrade(id) { buyUpgrade(id); }

window.assignOrder = assignOrder;
window.rejectOrder = rejectOrder;
window.rejectAllOrders = rejectAllOrders;
window.buyMaterial = buyMaterial;
window.buyPrinter = buyPrinter;
window.openShop = openShop;
window.closeShop = closeShop;
window.setShopFilter = setShopFilter;
window.openManage = openManage;
window.closeManage = closeManage;
window.changeNozzle = changeNozzle;
window.sellPrinter = sellPrinter;
window.performService = performService;
window.openSupplies = openSupplies;
window.closeSupplies = closeSupplies;
window.setSuppliesFilter = setSuppliesFilter;
window.buyFilament = buyFilament;
window.buyMaterialDirect = buyMaterialDirect;
window.collectPart = collectPart;
window.collectAll = collectAll;
window.coldPull = coldPull;
window.reprintJob = reprintJob;
window.releaseJob = releaseJob;
window.cleanBed = cleanBed;
window.dryMaterial = dryMaterial;
window.buyUpgrade = buyUpgrade;
window.buyShopUpgrade = buyShopUpgrade;

// Card, order and material buttons are drawn once and found by their data-act, so one listener per
// list serves them all. Each calls through window[...] like the inline onclick handlers do.
const CARD_ACTIONS = { collect: 'collectPart', coldpull: 'coldPull', reprint: 'reprintJob', release: 'releaseJob', clean: 'cleanBed' };
function wireLists() {
  document.getElementById('printers').addEventListener('click', (e) => {
    const card = e.target.closest('.printer-card');
    if (!card) return;
    const i = Array.prototype.indexOf.call(card.parentNode.children, card);
    if (e.target.closest('.printer-manage-btn')) { window.openManage(i); return; }
    const b = e.target.closest('button[data-act]');
    if (b && CARD_ACTIONS[b.dataset.act]) window[CARD_ACTIONS[b.dataset.act]](i);
  });
  document.getElementById('orders').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-act]');
    if (!b || b.disabled) return;
    const id = Number(b.dataset.order);
    if (b.dataset.act === 'assign') window.assignOrder(id, Number(b.dataset.slot));
    else if (b.dataset.act === 'reject') window.rejectOrder(id);
    else if (b.dataset.act === 'rejectAll') window.rejectAllOrders();
  });
  document.getElementById('inventory').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-act]');
    if (!b || b.disabled) return;
    if (b.dataset.act === 'buy') window.buyMaterial(b.dataset.arg, 1);
    else if (b.dataset.act === 'dry') window.dryMaterial(b.dataset.arg);
    else if (b.dataset.act === 'buyShopUpgrade') window.buyShopUpgrade(b.dataset.arg);
  });
  document.getElementById('shopList').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-buy]');
    if (b && !b.disabled) window.buyPrinter(b.dataset.buy);
  });
  document.getElementById('manageBody').addEventListener('click', onManageClick);
  document.getElementById('btnCollectAll').addEventListener('click', () => window.collectAll());
}

async function waitForThree() {
  if (window.THREE) return;
  return new Promise(r => {
    window.addEventListener('threeReady', r, { once: true });
    // Safety timeout — proceed without 3D after 6s
    setTimeout(r, 6000);
  });
}

// A plain, readable message instead of a blank page when the code or data can't load.
function showBootError(err) {
  console.error('[Print3D] boot failed:', err);
  const box = document.createElement('div');
  box.id = 'bootError';
  box.setAttribute('role', 'alert');
  box.style.cssText = 'position:fixed;inset:0;z-index:200;display:flex;align-items:center;justify-content:center;padding:16px;background:#111;color:#e5e7eb;font:16px/1.5 -apple-system,BlinkMacSystemFont,sans-serif;text-align:center';
  box.innerHTML = '<div><p style="margin-bottom:12px">Print3D could not load. Check your connection, then reload the page.</p>' +
    '<button type="button" style="font:inherit;padding:10px 18px;border-radius:6px;border:1px solid #555;background:#222;color:inherit;cursor:pointer" onclick="location.reload()">Reload</button></div>';
  document.body.appendChild(box);
}

async function boot() {
  try {
    const v = encodeURIComponent(BUILD);
    [Sim, Save] = await Promise.all([import('./sim.js?v=' + v), import('./save.js?v=' + v)]);
    await loadCatalogs();
  } catch (e) {
    showBootError(e);
    return;
  }
  await waitForThree();
  state = loadState();
  saveState();   // the migrated save is written straight away (the v4 original stays in its backup)
  if (bootNotes.length) {
    Sim.appendLog(state, bootNotes.map(n => ({ text: n.text, kind: n.kind === 'warn' ? 'warn' : 'info', at: Sim.now(state) })));
    const last = bootNotes[bootNotes.length - 1];
    setTimeout(() => toast(last.text, last.kind === 'warn' ? 'warn' : 'info'), 400);
  }
  document.getElementById('btnSpeed').addEventListener('click', cycleSpeed);
  document.getElementById('btnReset').addEventListener('click', resetState);
  wireLists();
  markAll();
  render();
  lastTickReal = Date.now();
  setInterval(tick, TICK_MS);
  requestAnimationFrame(animate);
  startStage().then((s) => {
    if (!s) return;
    attachAllCards();
    dirty.orders = true;
    if (document.getElementById('shopModal').classList.contains('open')) requestShopThumbnails();
  });
}
boot();
