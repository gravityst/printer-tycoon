// Printer Tycoon — MVP game loop.
// One Ender 3 V3 SE, 1 kg of PLA, $500. Orders spawn over time; player
// assigns them to the printer; jobs progress in real-time; money flows.

const STATE_KEY = 'printer-tycoon-state-v1';
const TICK_MS = 250;            // 4 ticks per real second
const REAL_SEC_PER_GAME_HOUR = 4; // 1 game hour = 4 real seconds → 1 day = 96s
const ORDER_SPAWN_BASE_HOURS = 2; // average ~1 order per 2 game hours at rep 0

const STARTING_PRINTER = 'ender-3-v3-se';
const STARTING_MONEY = 500;
const STARTING_FILAMENT_GRAMS = 1000;
const STARTING_FILAMENT_ID = 'pla';

let printersCat = [];
let materialsCat = [];
let productsCat = [];
let state = null;
let speed = 1;
let lastTickReal = Date.now();

// ---------- catalog loaders ----------
async function loadCatalogs() {
  const [pr, mt, pd] = await Promise.all([
    fetch('data/printers.json').then(r => r.json()),
    fetch('data/materials.json').then(r => r.json()),
    fetch('data/products.json').then(r => r.json()),
  ]);
  printersCat = pr.printers;
  materialsCat = mt.materials;
  productsCat = pd.products;
}

const printerById = id => printersCat.find(p => p.id === id);
const materialById = id => materialsCat.find(m => m.id === id);
const productById = id => productsCat.find(p => p.id === id);

// ---------- state ----------
function defaultState() {
  return {
    money: STARTING_MONEY,
    day: 1,
    hour: 8,
    reputation: 0,
    shipped: 0,
    printers: [{ printerId: STARTING_PRINTER, slotId: 1, state: 'idle', job: null }],
    inventory: { [STARTING_FILAMENT_ID]: STARTING_FILAMENT_GRAMS },
    orders: [],
    nextOrderInHours: 1,
    nextOrderId: 1,
  };
}

function loadState() {
  try {
    const raw = localStorage.getItem(STATE_KEY);
    if (raw) {
      const s = JSON.parse(raw);
      if (s && typeof s.money === 'number') return s;
    }
  } catch (e) {}
  return defaultState();
}

function saveState() { localStorage.setItem(STATE_KEY, JSON.stringify(state)); }

function resetState() {
  if (!confirm('Reset all progress?')) return;
  state = defaultState();
  saveState();
  render();
  toast('Game reset.', 'success');
}

// ---------- helpers ----------
function rand(lo, hi) { return lo + Math.random() * (hi - lo); }
function pickWeighted(items) {
  const total = items.reduce((s, x) => s + (x.demandWeight || 1), 0);
  let r = Math.random() * total;
  for (const x of items) { r -= (x.demandWeight || 1); if (r <= 0) return x; }
  return items[items.length - 1];
}
function fmtTime(h) {
  const hh = Math.floor(h);
  const mm = Math.floor((h - hh) * 60);
  return `${String(hh).padStart(2,'0')}:${String(mm).padStart(2,'0')}`;
}
function effectiveThroughput(printer) {
  return printer.throughputGPH || printer.throughputCM3PH || 30;
}

// ---------- order spawning ----------
function spawnOrder() {
  const eligible = productsCat.filter(p => p.unlockReputation <= state.reputation);
  if (eligible.length === 0) return;
  const product = pickWeighted(eligible);
  const grams = rand(product.grams[0], product.grams[1]);
  const baseHours = rand(product.printHours[0], product.printHours[1]);
  const priceMult = 0.85 + Math.random() * 0.45;
  state.orders.push({
    id: state.nextOrderId++,
    productId: product.id,
    productName: product.name,
    category: product.category,
    materialId: product.materials[0],
    materialOptions: product.materials,
    grams,
    baseHours,
    basePrice: product.basePrice * priceMult * (product.batchSize || 1),
    minPrecision: product.minPrecision,
    minBuildVolumeMM: product.minBuildVolumeMM,
    techRequired: product.tech,
    deadlineHours: rand(product.deadlineHours[0], product.deadlineHours[1]),
    qualityValue: product.qualityValue,
    batchSize: product.batchSize || 1,
    notes: product.notes,
  });
}

// ---------- compatibility check ----------
function canAssign(order, slot) {
  const printer = printerById(slot.printerId);
  if (!printer) return { ok: false, reason: 'no printer' };
  if (slot.state !== 'idle') return { ok: false, reason: 'busy' };
  if (!order.materialOptions.some(m => printer.materials.includes(m))) {
    return { ok: false, reason: `${printer.model} can't print ${order.materialOptions.join('/')}` };
  }
  if (order.techRequired && !order.techRequired.includes(printer.tech)) {
    return { ok: false, reason: `${printer.tech} not compatible (needs ${order.techRequired.join('/')})` };
  }
  if (order.minPrecision && printer.precision < order.minPrecision) {
    return { ok: false, reason: `Precision too low (need ${order.minPrecision}, have ${printer.precision})` };
  }
  const bv = printer.buildVolumeMM;
  const need = order.minBuildVolumeMM;
  if (bv && need && (bv[0] < need[0] || bv[1] < need[1] || bv[2] < need[2])) {
    return { ok: false, reason: `Build volume too small (need ${need.join('×')}mm)` };
  }
  // pick best material the printer supports
  const matId = order.materialOptions.find(m => printer.materials.includes(m));
  if (!matId) return { ok: false, reason: 'material mismatch' };
  const stock = state.inventory[matId] || 0;
  if (stock < order.grams) {
    const m = materialById(matId);
    return { ok: false, reason: `Not enough ${m ? m.name : matId} (need ${Math.ceil(order.grams)}g, have ${Math.floor(stock)}g)` };
  }
  return { ok: true, materialId: matId };
}

// ---------- job execution ----------
function assignOrder(orderId, slotIdx) {
  const order = state.orders.find(o => o.id === orderId);
  const slot = state.printers[slotIdx];
  if (!order || !slot) return;
  const check = canAssign(order, slot);
  if (!check.ok) { toast(check.reason, 'error'); return; }

  const printer = printerById(slot.printerId);
  state.inventory[check.materialId] -= order.grams;
  const speedFactor = effectiveThroughput(printer) / 30; // 30 g/hr is the catalog baseline
  const adjustedHours = order.baseHours / speedFactor;

  slot.state = 'printing';
  slot.job = {
    orderId: order.id,
    productName: order.productName,
    materialId: check.materialId,
    grams: order.grams,
    hoursTotal: adjustedHours,
    hoursElapsed: 0,
    payout: order.basePrice,
    qualityValue: order.qualityValue,
    precision: printer.precision,
  };
  // remove from queue
  state.orders = state.orders.filter(o => o.id !== orderId);
  toast(`Started: ${order.productName}`, 'success');
  render();
}

function completeJob(slot) {
  const job = slot.job;
  // payout adjusted by quality (precision) where order cares
  const qualityMult = 1 - job.qualityValue + job.qualityValue * job.precision;
  const payout = job.payout * qualityMult;
  state.money += payout;
  state.shipped += 1;
  state.reputation += 1;
  slot.state = 'idle';
  slot.job = null;
  toast(`Shipped → +$${payout.toFixed(2)}`, 'success');
}

function rejectOrder(orderId) {
  state.orders = state.orders.filter(o => o.id !== orderId);
  render();
}

// ---------- shopping ----------
function buyMaterial(matId, kg) {
  const m = materialById(matId);
  if (!m) return;
  const unitCost = m.costPerKg ?? m.costPerLiter ?? 50;
  const cost = unitCost * kg;
  if (state.money < cost) { toast('Not enough cash', 'error'); return; }
  state.money -= cost;
  state.inventory[matId] = (state.inventory[matId] || 0) + kg * 1000;
  toast(`Bought ${kg}kg ${m.name}`, 'success');
  render();
}

// ---------- main tick ----------
function tick() {
  const now = Date.now();
  const realDelta = (now - lastTickReal) / 1000;
  lastTickReal = now;
  const gameHours = realDelta * speed / REAL_SEC_PER_GAME_HOUR;

  // advance clock
  state.hour += gameHours;
  while (state.hour >= 24) { state.hour -= 24; state.day += 1; }

  // advance jobs
  for (const slot of state.printers) {
    if (slot.state === 'printing' && slot.job) {
      slot.job.hoursElapsed += gameHours;
      if (slot.job.hoursElapsed >= slot.job.hoursTotal) completeJob(slot);
    }
  }

  // age order deadlines
  state.orders = state.orders.filter(o => {
    o.deadlineHours -= gameHours;
    return o.deadlineHours > 0;
  });

  // spawn orders on a Poisson-ish schedule
  state.nextOrderInHours -= gameHours;
  if (state.nextOrderInHours <= 0) {
    spawnOrder();
    const repBoost = 1 + state.reputation * 0.05;
    state.nextOrderInHours = ORDER_SPAWN_BASE_HOURS / repBoost * (0.5 + Math.random());
  }

  render();
  saveState();
}

// ---------- render ----------
function render() {
  document.getElementById('money').textContent = state.money.toFixed(2);
  document.getElementById('day').textContent = state.day;
  document.getElementById('hour').textContent = fmtTime(state.hour);
  document.getElementById('rep').textContent = state.reputation;
  document.getElementById('shipped').textContent = state.shipped;
  document.getElementById('printerCount').textContent = `${state.printers.length} printer${state.printers.length === 1 ? '' : 's'}`;
  document.getElementById('orderCount').textContent = `${state.orders.length} pending`;
  document.getElementById('btnSpeed').textContent = `${speed}x`;
  renderPrinters();
  renderOrders();
  renderInventory();
}

function renderPrinters() {
  const root = document.getElementById('printers');
  root.innerHTML = '';
  state.printers.forEach((slot) => {
    const printer = printerById(slot.printerId);
    if (!printer) return;
    const el = document.createElement('div');
    el.className = 'printer-card' + (slot.state === 'printing' ? ' printing' : '');
    let html = `<div class="printer-name">${printer.brand} ${printer.model}<span class="printer-tier ${printer.tier}">${printer.tier}</span></div>`;
    html += `<div class="printer-specs">${printer.tech} · ${printer.buildVolumeMM.join('×')}mm · ${effectiveThroughput(printer)} g/hr · ${(printer.baseReliability*100).toFixed(0)}% reliable</div>`;
    if (slot.state === 'printing') {
      const j = slot.job;
      const pct = Math.min(100, j.hoursElapsed / j.hoursTotal * 100);
      const remaining = j.hoursTotal - j.hoursElapsed;
      const mat = materialById(j.materialId);
      html += `<div class="printer-status">Printing <strong>${j.productName}</strong></div>`;
      html += `<div class="progress"><div class="fill" style="width:${pct}%"></div></div>`;
      html += `<div class="job-info"><span>${mat ? mat.name : j.materialId} · ${j.grams.toFixed(0)}g</span><span>${remaining.toFixed(1)}h left → $${j.payout.toFixed(0)}</span></div>`;
    } else {
      html += `<div class="printer-status idle">Idle — assign an order</div>`;
    }
    el.innerHTML = html;
    root.appendChild(el);
  });
}

function renderOrders() {
  const root = document.getElementById('orders');
  if (state.orders.length === 0) {
    root.innerHTML = '<div class="empty">No incoming orders. Hang tight…</div>';
    return;
  }
  root.innerHTML = '';
  state.orders.forEach(order => {
    const el = document.createElement('div');
    el.className = 'order-card';
    const mat = materialById(order.materialId);
    const matLabel = mat ? mat.name : order.materialId;
    const urgent = order.deadlineHours < 12;

    let actions = '';
    state.printers.forEach((slot, i) => {
      const c = canAssign(order, slot);
      const printer = printerById(slot.printerId);
      const label = state.printers.length === 1
        ? (c.ok ? 'Print it' : c.reason)
        : (c.ok ? `→ ${printer.model}` : printer.model + ' ✗');
      actions += `<button onclick="window.assignOrder(${order.id}, ${i})" ${c.ok ? '' : 'disabled'} title="${c.reason || ''}">${label}</button>`;
    });
    actions += `<button class="reject" onclick="window.rejectOrder(${order.id})" title="Decline order">Decline</button>`;

    el.innerHTML = `
      <div class="order-name">${order.productName}<span class="order-cat">${order.category}</span></div>
      <div class="order-spec">${matLabel} · ${order.grams.toFixed(0)}g · ~${order.baseHours.toFixed(1)}h${order.batchSize > 1 ? ` · batch of ${order.batchSize}` : ''}</div>
      <div class="order-pay">$${order.basePrice.toFixed(2)}</div>
      <div class="order-deadline ${urgent ? 'urgent' : ''}">⏱ ${order.deadlineHours.toFixed(1)}h to deadline</div>
      <div class="order-actions">${actions}</div>
    `;
    root.appendChild(el);
  });
}

function renderInventory() {
  const root = document.getElementById('inventory');
  root.innerHTML = '';
  // Show all consumer-tier materials available for purchase
  const buyable = ['pla', 'pla-plus', 'petg', 'tpu-95a', 'abs', 'asa', 'pc', 'nylon-pa12', 'pa-cf', 'resin-standard', 'resin-tough'];
  buyable.forEach(matId => {
    const m = materialById(matId);
    if (!m) return;
    const stock = state.inventory[matId] || 0;
    const unitCost = m.costPerKg ?? m.costPerLiter ?? 0;
    const unit = m.category === 'resin' ? 'L' : 'kg';
    const canAfford = state.money >= unitCost;
    const el = document.createElement('div');
    el.className = 'mat-card';
    el.innerHTML = `
      <div class="mat-info">
        <div class="mat-name">${m.name}</div>
        <div class="mat-stock">${stock.toFixed(0)}g · $${unitCost}/${unit}</div>
      </div>
      <button class="mat-buy" onclick="window.buyMaterial('${matId}', 1)" ${canAfford ? '' : 'disabled'}>Buy 1${unit}</button>
    `;
    root.appendChild(el);
  });
}

// ---------- toast ----------
let toastTimer = null;
function toast(msg, kind) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = 'toast show' + (kind ? ' ' + kind : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.className = 'toast'; }, 2200);
}

// ---------- speed control ----------
function cycleSpeed() {
  const cycle = [1, 2, 4, 8];
  const i = cycle.indexOf(speed);
  speed = cycle[(i + 1) % cycle.length];
  render();
}

// ---------- expose ----------
window.assignOrder = assignOrder;
window.rejectOrder = rejectOrder;
window.buyMaterial = buyMaterial;

// ---------- boot ----------
async function boot() {
  await loadCatalogs();
  state = loadState();
  document.getElementById('btnSpeed').addEventListener('click', cycleSpeed);
  document.getElementById('btnReset').addEventListener('click', resetState);
  render();
  lastTickReal = Date.now();
  setInterval(tick, TICK_MS);
}
boot();
