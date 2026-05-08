// =====================================================================
// Printer Tycoon — game logic + canvas-rendered printer visuals + shop.
// =====================================================================

const STATE_KEY = 'printer-tycoon-state-v2';
const TICK_MS = 250;
const REAL_SEC_PER_GAME_HOUR = 4;
const ORDER_SPAWN_BASE_HOURS = 14;

const STARTING_PRINTER = 'ender-3-v3-se';
const STARTING_MONEY = 500;
const STARTING_FILAMENT_GRAMS = 1000;
const STARTING_FILAMENT_ID = 'pla';

const TIER_UNLOCK_REP = {
  garage: 0,
  hobbyist: 5,
  studio: 25,
  pro: 75,
  industrial: 150,
  endgame: 300,
};

const SHAPE_FOR_PRODUCT = {
  'phone-case': 'flat',
  'cookie-cutter': 'flat',
  'plant-pot': 'tall',
  'wall-hook': 'small',
  'articulated-toy': 'humanoid',
  'rc-car-body': 'flat-wide',
  'drone-frame': 'cross',
  'decorative-vase': 'tall',
  'lithophane-lamp': 'dome',
  'cosplay-accessory': 'angular',
  'miniature-batch': 'humanoid',
  'custom-grip-batch': 'flat',
  'jewelry-casting': 'gem',
  'functional-gear': 'gear',
  'robot-enclosure': 'box',
  'cosplay-helmet': 'dome',
  'drone-propeller': 'cross',
  'engineering-fixture': 'bracket',
  'end-use-bracket': 'bracket',
  'surgical-guide': 'small',
  'dental-crown-wax': 'gem',
  'custom-orthotic': 'flat-wide',
  'sls-production-batch': 'batch',
  'mjf-connector-batch': 'batch',
  'biocompatible-device': 'box',
  'aerospace-bracket': 'bracket',
  'engine-cooling-channel': 'tall',
  'tooling-die': 'block',
  'heat-exchanger': 'angular',
  'surgical-implant': 'humanoid',
};

const MODEL_PALETTE = [
  '#ef4444', '#f97316', '#f59e0b', '#eab308',
  '#84cc16', '#22c55e', '#10b981', '#14b8a6',
  '#06b6d4', '#0ea5e9', '#3b82f6', '#6366f1',
  '#8b5cf6', '#a855f7', '#d946ef', '#ec4899',
  '#fafafa', '#525252',
];

const FIXED_COLORS = {
  'dental-crown-wax': '#fef3c7',
  'jewelry-casting': '#facc15',
  'surgical-guide': '#fafafa',
  'surgical-implant': '#cbd5e1',
  'aerospace-bracket': '#94a3b8',
  'engine-cooling-channel': '#fde68a',
  'tooling-die': '#475569',
  'heat-exchanger': '#cbd5e1',
  'biocompatible-device': '#fafafa',
};

let printersCat = [];
let materialsCat = [];
let productsCat = [];
let state = null;
let speed = 1;
let lastTickReal = Date.now();
let shopFilter = 'all';

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
    nextSlotId: 2,
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
  document.getElementById('printers').innerHTML = '';
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

function effectiveThroughput(p) {
  return p.throughputGPH || p.throughputCM3PH || 30;
}

function colorForJob(productId) {
  if (FIXED_COLORS[productId]) return FIXED_COLORS[productId];
  return MODEL_PALETTE[Math.floor(Math.random() * MODEL_PALETTE.length)];
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
  });
}

// ---------- compatibility ----------
function canAssign(order, slot) {
  const printer = printerById(slot.printerId);
  if (!printer) return { ok: false, reason: 'no printer' };
  if (slot.state !== 'idle') return { ok: false, reason: 'busy' };
  if (!order.materialOptions.some(m => printer.materials.includes(m))) {
    return { ok: false, reason: `Wrong material (needs ${order.materialOptions.join('/')})` };
  }
  if (order.techRequired && !order.techRequired.includes(printer.tech)) {
    return { ok: false, reason: `Wrong tech (needs ${order.techRequired.join('/')})` };
  }
  if (order.minPrecision && printer.precision < order.minPrecision) {
    return { ok: false, reason: `Precision too low (need ${order.minPrecision})` };
  }
  const bv = printer.buildVolumeMM, need = order.minBuildVolumeMM;
  if (bv && need && (bv[0] < need[0] || bv[1] < need[1] || bv[2] < need[2])) {
    return { ok: false, reason: `Build volume too small` };
  }
  const matId = order.materialOptions.find(m => printer.materials.includes(m));
  if (!matId) return { ok: false, reason: 'material mismatch' };
  const stock = state.inventory[matId] || 0;
  if (stock < order.grams) {
    const m = materialById(matId);
    return { ok: false, reason: `Need ${Math.ceil(order.grams)}g ${m ? m.name : matId}` };
  }
  return { ok: true, materialId: matId };
}

// ---------- jobs ----------
function assignOrder(orderId, slotIdx) {
  const order = state.orders.find(o => o.id === orderId);
  const slot = state.printers[slotIdx];
  if (!order || !slot) return;
  const check = canAssign(order, slot);
  if (!check.ok) { toast(check.reason, 'error'); return; }
  const printer = printerById(slot.printerId);
  state.inventory[check.materialId] -= order.grams;
  const speedFactor = effectiveThroughput(printer) / 30;
  const adjustedHours = order.baseHours / speedFactor;
  slot.state = 'printing';
  slot.job = {
    orderId: order.id,
    productId: order.productId,
    productName: order.productName,
    materialId: check.materialId,
    grams: order.grams,
    hoursTotal: adjustedHours,
    hoursElapsed: 0,
    payout: order.basePrice,
    qualityValue: order.qualityValue,
    precision: printer.precision,
    color: colorForJob(order.productId),
  };
  state.orders = state.orders.filter(o => o.id !== orderId);
  toast(`Started: ${order.productName}`, 'success');
  render();
}

function completeJob(slot) {
  const job = slot.job;
  const qualityMult = 1 - job.qualityValue + job.qualityValue * job.precision;
  const payout = job.payout * qualityMult;
  state.money += payout;
  state.shipped += 1;
  state.reputation += Math.max(1, Math.floor(payout / 50));
  slot.state = 'idle';
  slot.job = null;
  toast(`Shipped → +${fmtMoney(payout)}`, 'success');
}

function rejectOrder(orderId) {
  state.orders = state.orders.filter(o => o.id !== orderId);
  render();
}

// ---------- materials shop ----------
function buyMaterial(matId, qty) {
  const m = materialById(matId);
  if (!m) return;
  const unitCost = m.costPerKg ?? m.costPerLiter ?? 50;
  const cost = unitCost * qty;
  if (state.money < cost) { toast('Not enough cash', 'error'); return; }
  state.money -= cost;
  state.inventory[matId] = (state.inventory[matId] || 0) + qty * 1000;
  toast(`Bought ${qty}${m.category === 'resin' ? 'L' : 'kg'} ${m.name}`, 'success');
  render();
}

// ---------- printer shop ----------
function openShop() {
  document.getElementById('shopModal').classList.add('open');
  shopFilter = 'all';
  renderShop();
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
  if (!printer) return;
  if (state.reputation < (TIER_UNLOCK_REP[printer.tier] || 0)) {
    toast(`Need ${TIER_UNLOCK_REP[printer.tier]} reputation`, 'error');
    return;
  }
  if (state.money < printer.price) {
    toast(`Need ${fmtPrice(printer.price)}`, 'error');
    return;
  }
  if (!confirm(`Buy ${printer.brand} ${printer.model} for ${fmtPrice(printer.price)}?`)) return;
  state.money -= printer.price;
  state.printers.push({
    printerId: id,
    slotId: state.nextSlotId++,
    state: 'idle',
    job: null,
  });
  toast(`Welcome, ${printer.model}!`, 'success');
  render();
  closeShop();
}

function renderShop() {
  const grid = document.getElementById('shopGrid');
  grid.innerHTML = '';
  let list = printersCat.slice();
  if (shopFilter !== 'all') list = list.filter(p => p.tier === shopFilter);
  list.sort((a, b) => a.price - b.price);
  list.forEach(printer => {
    const repNeeded = TIER_UNLOCK_REP[printer.tier] || 0;
    const repOK = state.reputation >= repNeeded;
    const moneyOK = state.money >= printer.price;
    const card = document.createElement('div');
    card.className = 'shop-card' + (repOK && moneyOK ? '' : ' locked');
    card.innerHTML = `
      <canvas class="shop-canvas" data-printer-id="${printer.id}" width="320" height="180"></canvas>
      <div class="shop-card-body">
        <div class="shop-brand">${printer.brand}</div>
        <div class="shop-model">${printer.model}</div>
        <div class="shop-tier"><span class="printer-tier ${printer.tier}">${printer.tier}</span> · ${printer.tech}</div>
        <div class="shop-specs">
          ${printer.buildVolumeMM.join('×')}mm · ${effectiveThroughput(printer)} g/hr · ${(printer.baseReliability*100).toFixed(0)}% reliable
        </div>
        <div class="shop-mats">${(printer.materials || []).slice(0, 6).map(m => {
          const mat = materialById(m);
          return `<span class="mat-pill">${mat ? mat.name : m}</span>`;
        }).join('')}${printer.materials.length > 6 ? `<span class="mat-pill">+${printer.materials.length-6}</span>` : ''}</div>
        <div class="shop-card-foot">
          <div class="shop-price">${fmtPrice(printer.price)}</div>
          ${!repOK ? `<button class="shop-buy" disabled>Need ${repNeeded} rep</button>` :
             !moneyOK ? `<button class="shop-buy" disabled>${fmtPrice(printer.price - state.money)} short</button>` :
             `<button class="shop-buy" onclick="buyPrinter('${printer.id}')">Buy</button>`}
        </div>
      </div>
    `;
    grid.appendChild(card);
  });
}

// ---------- main tick ----------
function tick() {
  const now = Date.now();
  const realDelta = (now - lastTickReal) / 1000;
  lastTickReal = now;
  const gameHours = realDelta * speed / REAL_SEC_PER_GAME_HOUR;

  state.hour += gameHours;
  while (state.hour >= 24) { state.hour -= 24; state.day += 1; }

  for (const slot of state.printers) {
    if (slot.state === 'printing' && slot.job) {
      slot.job.hoursElapsed += gameHours;
      if (slot.job.hoursElapsed >= slot.job.hoursTotal) completeJob(slot);
    }
  }

  state.orders = state.orders.filter(o => {
    o.deadlineHours -= gameHours;
    return o.deadlineHours > 0;
  });

  state.nextOrderInHours -= gameHours;
  if (state.nextOrderInHours <= 0) {
    spawnOrder();
    const repBoost = 1 + state.reputation * 0.02;
    const printerBoost = 1 + (state.printers.length - 1) * 0.15;
    state.nextOrderInHours = ORDER_SPAWN_BASE_HOURS / (repBoost * printerBoost) * (0.6 + Math.random() * 0.8);
  }

  render();
  saveState();
}

// =====================================================================
// CANVAS RENDERING — printers + growing models
// =====================================================================

function setupCanvas(canvas, w, h) {
  const dpr = window.devicePixelRatio || 1;
  if (canvas.dataset.dpr === String(dpr) && canvas.width === w * dpr) {
    return canvas.getContext('2d');
  }
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  canvas.style.width = w + 'px';
  canvas.style.height = h + 'px';
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  canvas.dataset.dpr = String(dpr);
  return ctx;
}

function drawPrinter(canvas, slot) {
  const printer = printerById(slot.printerId);
  if (!printer) return;
  const w = parseInt(canvas.getAttribute('width'), 10);
  const h = parseInt(canvas.getAttribute('height'), 10);
  const ctx = setupCanvas(canvas, w, h);

  // Background workshop floor
  ctx.fillStyle = '#f3f4f6';
  ctx.fillRect(0, 0, w, h);
  // Floor shadow
  ctx.fillStyle = 'rgba(0,0,0,0.07)';
  ctx.fillRect(20, h - 14, w - 40, 10);

  const tech = printer.tech;
  if (tech === 'FDM' || tech === 'FFF' || tech === 'ADAM') {
    drawFDMPrinter(ctx, w, h, printer, slot);
  } else if (tech === 'MSLA' || tech === 'SLA') {
    drawResinPrinter(ctx, w, h, printer, slot);
  } else {
    drawIndustrialPrinter(ctx, w, h, printer, slot);
  }
}

function drawFDMPrinter(ctx, w, h, printer, slot) {
  const margin = 28;
  const x = margin, y = 22, fw = w - margin*2, fh = h - margin - 18;
  const printing = slot.state === 'printing' && slot.job;

  // Frame uprights
  ctx.fillStyle = '#374151';
  ctx.fillRect(x - 3, y, 6, fh);
  ctx.fillRect(x + fw - 3, y, 6, fh);
  // Top crossbar
  ctx.fillRect(x - 3, y, fw + 6, 5);
  // Base
  ctx.fillStyle = '#1f2937';
  ctx.fillRect(x - 8, y + fh - 6, fw + 16, 10);

  // X-gantry (horizontal rail head rides on)
  const gantryY = y + 10;
  ctx.fillStyle = '#6b7280';
  ctx.fillRect(x + 4, gantryY, fw - 8, 5);
  // Gantry highlight
  ctx.fillStyle = '#9ca3af';
  ctx.fillRect(x + 4, gantryY, fw - 8, 1);

  // Build plate
  const bedY = y + fh - 16;
  ctx.fillStyle = '#9ca3af';
  ctx.fillRect(x + 12, bedY, fw - 24, 10);
  ctx.fillStyle = '#374151'; // PEI surface
  ctx.fillRect(x + 12, bedY, fw - 24, 3);

  // Model area bounds
  const modelX = x + 18;
  const modelY = y + 18;
  const modelW = fw - 36;
  const modelH = bedY - modelY;

  // Print head position
  let headX = x + fw / 2;
  let headBottomY = bedY - 4;

  if (printing) {
    const progress = Math.min(1, slot.job.hoursElapsed / slot.job.hoursTotal);
    const shape = SHAPE_FOR_PRODUCT[slot.job.productId] || 'box';

    // Head wobble — varies by tech (CoreXY moves in 2D, Cartesian 1D)
    const t = Date.now() / 350;
    const wobble = Math.sin(t) * (modelW * 0.32);
    headX = modelX + modelW / 2 + wobble;

    // Visible model height
    const visibleH = modelH * progress;
    headBottomY = modelY + (modelH - visibleH) - 2;

    drawPrintingModel(ctx, modelX, modelY, modelW, modelH, shape, slot.job.color, progress);
  } else {
    // Show a dimmed silhouette of nothing — just keep print bed
  }

  // Print head visualization
  const headColor = printing ? '#dc2626' : '#1f2937';
  // Carriage on gantry
  ctx.fillStyle = '#1f2937';
  ctx.fillRect(headX - 14, gantryY + 5, 28, 8);
  // Head body
  ctx.fillStyle = '#111827';
  ctx.fillRect(headX - 11, gantryY + 13, 22, headBottomY - gantryY - 13);
  // Hot end
  ctx.fillStyle = headColor;
  ctx.beginPath();
  ctx.moveTo(headX - 5, headBottomY);
  ctx.lineTo(headX + 5, headBottomY);
  ctx.lineTo(headX, headBottomY + 5);
  ctx.closePath();
  ctx.fill();

  // Tiny molten drop
  if (printing && Math.random() < 0.25) {
    ctx.fillStyle = slot.job.color;
    ctx.beginPath();
    ctx.arc(headX, headBottomY + 3, 1.5, 0, Math.PI * 2);
    ctx.fill();
  }

  // Enclosure overlay
  if (printer.enclosed) {
    const grad = ctx.createLinearGradient(x, y, x, y + fh);
    grad.addColorStop(0, 'rgba(135, 206, 250, 0.18)');
    grad.addColorStop(1, 'rgba(135, 206, 250, 0.10)');
    ctx.fillStyle = grad;
    ctx.fillRect(x, y, fw, fh);
    ctx.strokeStyle = 'rgba(50, 100, 130, 0.35)';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(x, y, fw, fh);
  }

  // Brand badge on the front
  ctx.fillStyle = printing ? '#22c55e' : '#94a3b8';
  ctx.beginPath();
  ctx.arc(x + 8, y + fh - 22, 3, 0, Math.PI * 2);
  ctx.fill();
}

function drawResinPrinter(ctx, w, h, printer, slot) {
  const margin = 32;
  const x = margin, y = 22, fw = w - margin*2, fh = h - margin - 18;
  const printing = slot.state === 'printing' && slot.job;
  const progress = printing ? Math.min(1, slot.job.hoursElapsed / slot.job.hoursTotal) : 0;

  // Outer cabinet
  ctx.fillStyle = '#1f2937';
  ctx.fillRect(x, y, fw, fh);
  ctx.fillStyle = '#374151';
  ctx.fillRect(x + 5, y + 5, fw - 10, fh - 10);

  // Top control panel
  ctx.fillStyle = '#111827';
  ctx.fillRect(x + 5, y + 5, fw - 10, 14);
  // Status LED
  ctx.fillStyle = printing ? '#22c55e' : '#6b7280';
  ctx.beginPath();
  ctx.arc(x + 14, y + 12, 3, 0, Math.PI * 2);
  ctx.fill();

  // Z-screw (lifts the build plate)
  ctx.fillStyle = '#fcd34d';
  ctx.fillRect(x + fw - 14, y + 22, 4, fh - 30);
  // Z-screw guide bar
  ctx.fillStyle = '#9ca3af';
  ctx.fillRect(x + 10, y + 22, 3, fh - 30);

  // Resin vat at the bottom
  const vatTopY = y + fh - 36;
  const vatBotY = y + fh - 8;
  ctx.fillStyle = 'rgba(168, 85, 247, 0.55)';
  ctx.fillRect(x + 18, vatTopY, fw - 36, vatBotY - vatTopY);
  // Vat lip
  ctx.fillStyle = '#9ca3af';
  ctx.fillRect(x + 16, vatTopY - 2, fw - 32, 3);

  // Build plate (starts touching vat bottom, lifts as print grows)
  const plateMaxLift = (vatTopY - 4) - (y + 24);
  const plateY = (vatBotY - 6) - plateMaxLift * progress;
  ctx.fillStyle = '#cbd5e1';
  ctx.fillRect(x + 22, plateY, fw - 44, 4);
  // Plate stem up to z-screw
  ctx.fillStyle = '#6b7280';
  ctx.fillRect(x + fw - 22, y + 22, 4, plateY - (y + 22));

  // Model hanging down from plate (resin prints upside down)
  if (printing) {
    const shape = SHAPE_FOR_PRODUCT[slot.job.productId] || 'box';
    const modelTop = plateY + 4;
    const modelBot = vatBotY - 4;
    const modelH = Math.max(0, modelBot - modelTop);
    const modelW = fw - 44;
    if (modelH > 2) {
      ctx.save();
      ctx.translate(x + 22, modelTop);
      ctx.scale(1, -1);
      ctx.translate(0, -modelH);
      drawPrintingModel(ctx, 0, 0, modelW, modelH, shape, slot.job.color, 1);
      ctx.restore();
    }
  }

  // UV light glow at vat bottom while printing
  if (printing) {
    const t = Date.now() / 200;
    const a = 0.25 + Math.sin(t) * 0.08;
    ctx.fillStyle = `rgba(99, 102, 241, ${a})`;
    ctx.fillRect(x + 18, vatBotY - 6, fw - 36, 4);
  }
}

function drawIndustrialPrinter(ctx, w, h, printer, slot) {
  const margin = 24;
  const x = margin, y = 22, fw = w - margin*2, fh = h - margin - 18;
  const printing = slot.state === 'printing' && slot.job;

  // Steel cabinet
  const grad = ctx.createLinearGradient(x, y, x + fw, y + fh);
  grad.addColorStop(0, '#475569');
  grad.addColorStop(1, '#334155');
  ctx.fillStyle = grad;
  ctx.fillRect(x, y, fw, fh);
  ctx.strokeStyle = '#1e293b';
  ctx.lineWidth = 2;
  ctx.strokeRect(x, y, fw, fh);

  // Door panel + handle
  const doorX = x + 10, doorY = y + 14, doorW = fw - 80, doorH = fh - 28;
  ctx.fillStyle = '#64748b';
  ctx.fillRect(doorX, doorY, doorW, doorH);
  // Viewing window
  const winX = doorX + 10, winY = doorY + 10, winW = doorW - 20, winH = doorH - 30;
  ctx.fillStyle = printing ? 'rgba(34, 197, 94, 0.18)' : 'rgba(0,0,0,0.4)';
  ctx.fillRect(winX, winY, winW, winH);
  ctx.strokeStyle = '#0f172a';
  ctx.lineWidth = 1;
  ctx.strokeRect(winX, winY, winW, winH);
  // Door handle
  ctx.fillStyle = '#cbd5e1';
  ctx.fillRect(doorX + doorW - 8, doorY + doorH/2 - 8, 4, 16);

  // Status panel on the right
  const panelX = x + fw - 60, panelY = y + 14;
  ctx.fillStyle = '#1e293b';
  ctx.fillRect(panelX, panelY, 50, fh - 28);
  // LED bank
  const t = Date.now() / 400;
  const led1 = printing ? (Math.sin(t) > 0 ? '#22c55e' : '#15803d') : '#374151';
  const led2 = printing ? '#fbbf24' : '#374151';
  const led3 = '#374151';
  ctx.fillStyle = led1;
  ctx.beginPath(); ctx.arc(panelX + 12, panelY + 12, 4, 0, Math.PI*2); ctx.fill();
  ctx.fillStyle = led2;
  ctx.beginPath(); ctx.arc(panelX + 26, panelY + 12, 4, 0, Math.PI*2); ctx.fill();
  ctx.fillStyle = led3;
  ctx.beginPath(); ctx.arc(panelX + 40, panelY + 12, 4, 0, Math.PI*2); ctx.fill();

  // Mini display
  ctx.fillStyle = '#0c4a6e';
  ctx.fillRect(panelX + 6, panelY + 24, 38, 18);
  if (printing) {
    const progress = Math.min(1, slot.job.hoursElapsed / slot.job.hoursTotal);
    ctx.fillStyle = '#22d3ee';
    ctx.font = '700 9px ui-monospace, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(`${(progress*100).toFixed(0)}%`, panelX + 25, panelY + 33);
  } else {
    ctx.fillStyle = '#0e7490';
    ctx.font = '700 9px ui-monospace, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('READY', panelX + 25, panelY + 33);
  }

  // Bottom progress bar
  if (printing) {
    const progress = Math.min(1, slot.job.hoursElapsed / slot.job.hoursTotal);
    const pbY = y + fh - 10;
    ctx.fillStyle = '#1e293b';
    ctx.fillRect(panelX + 6, pbY, 38, 3);
    ctx.fillStyle = '#22c55e';
    ctx.fillRect(panelX + 6, pbY, 38 * progress, 3);
  }

  // Industrial caster wheels
  ctx.fillStyle = '#1e293b';
  ctx.beginPath(); ctx.arc(x + 10, y + fh + 1, 3, 0, Math.PI*2); ctx.fill();
  ctx.beginPath(); ctx.arc(x + fw - 10, y + fh + 1, 3, 0, Math.PI*2); ctx.fill();
}

// Build a path for a product shape into ctx (caller fills/clips).
function buildShape(ctx, x, y, w, h, shape) {
  ctx.beginPath();
  switch (shape) {
    case 'flat':
      ctx.roundRect(x + w*0.18, y + h*0.55, w*0.64, h*0.40, 5);
      break;
    case 'flat-wide':
      ctx.roundRect(x + w*0.08, y + h*0.62, w*0.84, h*0.32, 4);
      break;
    case 'tall': {
      const lx = x + w*0.32, rx = x + w*0.68;
      ctx.moveTo(lx, y + h*0.95);
      ctx.lineTo(lx, y + h*0.45);
      ctx.bezierCurveTo(x + w*0.22, y + h*0.30, x + w*0.36, y + h*0.10, x + w*0.40, y + h*0.05);
      ctx.lineTo(x + w*0.60, y + h*0.05);
      ctx.bezierCurveTo(x + w*0.64, y + h*0.10, x + w*0.78, y + h*0.30, rx, y + h*0.45);
      ctx.lineTo(rx, y + h*0.95);
      ctx.closePath();
      break;
    }
    case 'humanoid': {
      const cx = x + w*0.5;
      ctx.arc(cx, y + h*0.20, h*0.13, 0, Math.PI*2);
      ctx.moveTo(cx - w*0.15, y + h*0.32);
      ctx.lineTo(cx + w*0.15, y + h*0.32);
      ctx.lineTo(cx + w*0.15, y + h*0.65);
      ctx.lineTo(cx - w*0.15, y + h*0.65);
      ctx.closePath();
      ctx.moveTo(cx - w*0.13, y + h*0.65); ctx.lineTo(cx - w*0.04, y + h*0.65);
      ctx.lineTo(cx - w*0.04, y + h*0.95); ctx.lineTo(cx - w*0.13, y + h*0.95); ctx.closePath();
      ctx.moveTo(cx + w*0.04, y + h*0.65); ctx.lineTo(cx + w*0.13, y + h*0.65);
      ctx.lineTo(cx + w*0.13, y + h*0.95); ctx.lineTo(cx + w*0.04, y + h*0.95); ctx.closePath();
      break;
    }
    case 'dome': {
      const cx = x + w*0.5;
      ctx.arc(cx, y + h*0.85, w*0.42, Math.PI, 0);
      ctx.lineTo(x + w*0.92, y + h*0.95);
      ctx.lineTo(x + w*0.08, y + h*0.95);
      ctx.closePath();
      break;
    }
    case 'cross': {
      const cx = x + w*0.5, cy = y + h*0.55, sz = w*0.36, t = h*0.10;
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(Math.PI/4);
      ctx.rect(-sz, -t/2, sz*2, t);
      ctx.rect(-t/2, -sz, t, sz*2);
      ctx.restore();
      break;
    }
    case 'gear': {
      const gcx = x + w*0.5, gcy = y + h*0.55, gr = h*0.32;
      const teeth = 10;
      for (let i = 0; i < teeth; i++) {
        const a = (i / teeth) * Math.PI * 2;
        const a2 = ((i + 0.5) / teeth) * Math.PI * 2;
        const r1 = gr, r2 = gr * 1.25;
        const x1 = gcx + Math.cos(a) * r1, y1 = gcy + Math.sin(a) * r1;
        const x2 = gcx + Math.cos(a2) * r2, y2 = gcy + Math.sin(a2) * r2;
        if (i === 0) ctx.moveTo(x1, y1); else ctx.lineTo(x1, y1);
        ctx.lineTo(x2, y2);
      }
      ctx.closePath();
      break;
    }
    case 'bracket':
      ctx.moveTo(x + w*0.20, y + h*0.20);
      ctx.lineTo(x + w*0.45, y + h*0.20);
      ctx.lineTo(x + w*0.45, y + h*0.65);
      ctx.lineTo(x + w*0.80, y + h*0.65);
      ctx.lineTo(x + w*0.80, y + h*0.90);
      ctx.lineTo(x + w*0.20, y + h*0.90);
      ctx.closePath();
      break;
    case 'block':
      ctx.rect(x + w*0.22, y + h*0.32, w*0.56, h*0.58);
      break;
    case 'gem':
      ctx.moveTo(x + w*0.5, y + h*0.30);
      ctx.lineTo(x + w*0.70, y + h*0.55);
      ctx.lineTo(x + w*0.5, y + h*0.78);
      ctx.lineTo(x + w*0.30, y + h*0.55);
      ctx.closePath();
      break;
    case 'small':
      ctx.arc(x + w*0.5, y + h*0.65, h*0.22, 0, Math.PI*2);
      break;
    case 'box':
      ctx.rect(x + w*0.27, y + h*0.40, w*0.46, h*0.50);
      break;
    case 'angular':
      ctx.moveTo(x + w*0.18, y + h*0.92);
      ctx.lineTo(x + w*0.36, y + h*0.32);
      ctx.lineTo(x + w*0.55, y + h*0.55);
      ctx.lineTo(x + w*0.74, y + h*0.22);
      ctx.lineTo(x + w*0.86, y + h*0.92);
      ctx.closePath();
      break;
    case 'batch': {
      const cols = 4, rows = 3;
      const px = w / (cols + 1), py = h / (rows + 2);
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const bx = x + (c + 0.7) * px;
          const by = y + (r + 1.4) * py;
          ctx.rect(bx, by, px * 0.6, py * 0.55);
        }
      }
      break;
    }
    default:
      ctx.rect(x + w*0.30, y + h*0.45, w*0.40, h*0.50);
  }
}

function drawPrintingModel(ctx, x, y, w, h, shape, color, progress) {
  if (progress <= 0) return;
  ctx.save();
  // Reveal mask: bottom progress fraction
  const visibleH = h * progress;
  const visibleY = y + h - visibleH;
  ctx.beginPath();
  ctx.rect(x, visibleY, w, visibleH);
  ctx.clip();

  // Fill silhouette
  buildShape(ctx, x, y, w, h, shape);
  ctx.fillStyle = color;
  ctx.fill();

  // Subtle gradient highlight on top edge of revealed area
  const grad = ctx.createLinearGradient(x, visibleY, x, visibleY + Math.min(8, visibleH));
  grad.addColorStop(0, 'rgba(255,255,255,0.35)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = grad;
  ctx.fillRect(x, visibleY, w, Math.min(8, visibleH));

  // Layer lines
  ctx.strokeStyle = 'rgba(0,0,0,0.10)';
  ctx.lineWidth = 0.5;
  for (let yy = y + h; yy > visibleY; yy -= 3) {
    ctx.beginPath();
    ctx.moveTo(x, yy);
    ctx.lineTo(x + w, yy);
    ctx.stroke();
  }

  ctx.restore();
}

// =====================================================================
// DOM rendering
// =====================================================================

function ensurePrinterCards() {
  const root = document.getElementById('printers');
  while (root.children.length < state.printers.length) {
    const card = document.createElement('div');
    card.className = 'printer-card';
    card.innerHTML = `
      <canvas class="printer-canvas" width="400" height="220"></canvas>
      <div class="printer-info">
        <div class="printer-name"></div>
        <div class="printer-specs"></div>
        <div class="printer-status"></div>
        <div class="progress" style="display:none"><div class="fill"></div></div>
        <div class="job-info" style="display:none"></div>
      </div>
    `;
    root.appendChild(card);
  }
  while (root.children.length > state.printers.length) {
    root.removeChild(root.lastChild);
  }
}

function renderPrinters() {
  ensurePrinterCards();
  const root = document.getElementById('printers');
  state.printers.forEach((slot, i) => {
    const card = root.children[i];
    if (!card) return;
    const printer = printerById(slot.printerId);
    if (!printer) return;

    card.classList.toggle('printing', slot.state === 'printing');

    card.querySelector('.printer-name').innerHTML =
      `<span class="brand">${printer.brand}</span> <strong>${printer.model}</strong>` +
      ` <span class="printer-tier ${printer.tier}">${printer.tier}</span>`;
    card.querySelector('.printer-specs').textContent =
      `${printer.tech} · ${printer.buildVolumeMM.join('×')}mm · ${effectiveThroughput(printer)} g/hr · ${(printer.baseReliability*100).toFixed(0)}% reliable`;

    const status = card.querySelector('.printer-status');
    const progress = card.querySelector('.progress');
    const jobInfo = card.querySelector('.job-info');

    if (slot.state === 'printing' && slot.job) {
      const j = slot.job;
      const pct = Math.min(100, j.hoursElapsed / j.hoursTotal * 100);
      const remaining = j.hoursTotal - j.hoursElapsed;
      const mat = materialById(j.materialId);
      status.innerHTML = `Printing <strong>${j.productName}</strong>`;
      status.className = 'printer-status';
      progress.style.display = 'block';
      progress.querySelector('.fill').style.width = `${pct}%`;
      jobInfo.style.display = 'flex';
      jobInfo.innerHTML = `<span>${mat ? mat.name : j.materialId} · ${j.grams.toFixed(0)}g</span><span>${remaining.toFixed(1)}h left → ${fmtMoney(j.payout)}</span>`;
    } else {
      status.textContent = 'Idle — assign an order';
      status.className = 'printer-status idle';
      progress.style.display = 'none';
      jobInfo.style.display = 'none';
    }
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
        : (c.ok ? `→ ${printer.brand} ${printer.model}` : `${printer.model} ✗`);
      actions += `<button onclick="window.assignOrder(${order.id}, ${i})" ${c.ok ? '' : 'disabled'} title="${c.reason || ''}">${label}</button>`;
    });
    actions += `<button class="reject" onclick="window.rejectOrder(${order.id})" title="Decline">Decline</button>`;

    el.innerHTML = `
      <div class="order-name">${order.productName}<span class="order-cat">${order.category}</span></div>
      <div class="order-spec">${matLabel} · ${order.grams.toFixed(0)}g · ~${order.baseHours.toFixed(1)}h${order.batchSize > 1 ? ` · batch of ${order.batchSize}` : ''}</div>
      <div class="order-pay">${fmtMoney(order.basePrice)}</div>
      <div class="order-deadline ${urgent ? 'urgent' : ''}">⏱ ${order.deadlineHours.toFixed(1)}h to deadline</div>
      <div class="order-actions">${actions}</div>
    `;
    root.appendChild(el);
  });
}

function renderInventory() {
  const root = document.getElementById('inventory');
  root.innerHTML = '';
  const buyable = ['pla', 'pla-plus', 'petg', 'tpu-95a', 'abs', 'asa', 'pc', 'nylon-pa12', 'pa-cf', 'resin-standard', 'resin-tough', 'resin-castable'];
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

function renderHeader() {
  document.getElementById('money').textContent = state.money.toFixed(2);
  document.getElementById('day').textContent = state.day;
  document.getElementById('hour').textContent = fmtTime(state.hour);
  document.getElementById('rep').textContent = state.reputation;
  document.getElementById('shipped').textContent = state.shipped;
  document.getElementById('printerCount').textContent = `${state.printers.length} printer${state.printers.length === 1 ? '' : 's'}`;
  document.getElementById('orderCount').textContent = `${state.orders.length} pending`;
  document.getElementById('btnSpeed').textContent = `${speed}x`;
}

function render() {
  renderHeader();
  renderPrinters();
  renderOrders();
  renderInventory();
  if (document.getElementById('shopModal').classList.contains('open')) renderShop();
}

// =====================================================================
// Animation loop — drives canvases at ~60fps
// =====================================================================

function animate() {
  // Workshop printer canvases
  const root = document.getElementById('printers');
  if (root) {
    state.printers.forEach((slot, i) => {
      const card = root.children[i];
      if (!card) return;
      const canvas = card.querySelector('.printer-canvas');
      if (canvas) drawPrinter(canvas, slot);
    });
  }
  // Shop modal canvases (idle preview of each catalog printer)
  if (document.getElementById('shopModal').classList.contains('open')) {
    document.querySelectorAll('#shopGrid canvas').forEach(canvas => {
      const printerId = canvas.dataset.printerId;
      const printer = printerById(printerId);
      if (printer) drawPrinter(canvas, { state: 'idle', job: null, printerId });
    });
  }
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
  toastTimer = setTimeout(() => { t.className = 'toast'; }, 2200);
}

function cycleSpeed() {
  const cycle = [1, 2, 4, 8];
  const i = cycle.indexOf(speed);
  speed = cycle[(i + 1) % cycle.length];
  render();
}

window.assignOrder = assignOrder;
window.rejectOrder = rejectOrder;
window.buyMaterial = buyMaterial;
window.buyPrinter = buyPrinter;
window.openShop = openShop;
window.closeShop = closeShop;
window.setShopFilter = setShopFilter;

async function boot() {
  await loadCatalogs();
  state = loadState();
  document.getElementById('btnSpeed').addEventListener('click', cycleSpeed);
  document.getElementById('btnReset').addEventListener('click', resetState);
  render();
  lastTickReal = Date.now();
  setInterval(tick, TICK_MS);
  requestAnimationFrame(animate);
}
boot();
