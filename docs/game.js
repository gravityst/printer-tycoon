// =====================================================================
// Printer Tycoon — Three.js 3D printers + game logic + list-view shop.
// =====================================================================

const STATE_KEY = 'printer-tycoon-state-v3';
const TICK_MS = 250;
const REAL_SEC_PER_GAME_HOUR = 4;
const ORDER_SPAWN_BASE_HOURS = 5;

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
let state = null;
let speed = 1;
let lastTickReal = Date.now();
let shopFilter = 'all';

// =====================================================================
// catalog + state
// =====================================================================
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
    nextOrderInHours: 0.5,
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
  // Dispose all 3D scenes
  for (const info of printerScenes.values()) info.renderer.dispose();
  printerScenes.clear();
  state = defaultState();
  saveState();
  document.getElementById('printers').innerHTML = '';
  render();
  toast('Game reset.', 'success');
}

// =====================================================================
// helpers
// =====================================================================
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

function effectiveThroughput(p) { return p.throughputGPH || p.throughputCM3PH || 30; }

function colorForJob(productId) {
  if (FIXED_COLORS[productId]) return FIXED_COLORS[productId];
  return MODEL_PALETTE[Math.floor(Math.random() * MODEL_PALETTE.length)];
}

function hexToInt(hex) {
  return parseInt(hex.replace('#', ''), 16);
}

function printerCategory(printer) {
  const tech = printer.tech;
  if (tech === 'FDM' || tech === 'FFF' || tech === 'ADAM') return 'fdm';
  if (tech === 'MSLA' || tech === 'SLA') return 'resin';
  return 'industrial';
}

// =====================================================================
// game loop: spawn / assign / complete
// =====================================================================
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

const ICON_FOR_CAT = { fdm: '⚙', resin: '✦', industrial: '▣' };

function renderShop() {
  const root = document.getElementById('shopList');
  root.innerHTML = '';
  let list = printersCat.slice();
  if (shopFilter !== 'all') list = list.filter(p => p.tier === shopFilter);
  list.sort((a, b) => a.price - b.price);
  list.forEach(printer => {
    const repNeeded = TIER_UNLOCK_REP[printer.tier] || 0;
    const repOK = state.reputation >= repNeeded;
    const moneyOK = state.money >= printer.price;
    const cat = printerCategory(printer);
    const row = document.createElement('div');
    row.className = 'shop-row' + (repOK && moneyOK ? '' : ' locked');
    const matsBrief = (printer.materials || []).slice(0, 5).map(m => {
      const mat = materialById(m);
      return `<span class="mat-pill">${mat ? mat.name : m}</span>`;
    }).join('');
    const moreCount = printer.materials.length > 5 ? `<span class="mat-pill">+${printer.materials.length-5}</span>` : '';
    const specs = `${printer.tech} <span class="sep">·</span> ${printer.buildVolumeMM.join('×')}mm <span class="sep">·</span> ${effectiveThroughput(printer)} g/hr <span class="sep">·</span> ${(printer.baseReliability*100).toFixed(0)}% reliable`;
    const buttonContent =
      !repOK ? `<button class="shop-buy" disabled>Need ${repNeeded} rep</button>` :
      !moneyOK ? `<button class="shop-buy" disabled>${fmtPrice(printer.price - state.money)} short</button>` :
      `<button class="shop-buy affordable" onclick="window.buyPrinter('${printer.id}')">Buy</button>`;
    row.innerHTML = `
      <div class="shop-icon ${cat}">${ICON_FOR_CAT[cat]}</div>
      <div class="shop-row-info">
        <div class="shop-row-line1">
          <span class="brand">${printer.brand}</span>
          <span class="model">${printer.model}</span>
          <span class="printer-tier ${printer.tier}">${printer.tier}</span>
        </div>
        <div class="shop-row-line2">${specs}</div>
        <div class="shop-row-line3">${matsBrief}${moreCount}</div>
      </div>
      <div class="shop-row-action">
        <div class="shop-price">${fmtPrice(printer.price)}</div>
        ${buttonContent}
      </div>
    `;
    root.appendChild(row);
  });
}

// =====================================================================
// main tick
// =====================================================================
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
// 3D rendering with Three.js
// =====================================================================

const printerScenes = new Map(); // canvas → scene info

function createScene(canvas, printer) {
  const THREE = window.THREE;
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(canvas.clientWidth, canvas.clientHeight, false);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.localClippingEnabled = true;

  const scene = new THREE.Scene();

  // Sky-ish gradient via fog + clear
  scene.background = null;

  // Lighting — warm fill + cool key
  scene.add(new THREE.HemisphereLight(0xffffff, 0xb0c4de, 0.55));
  const sun = new THREE.DirectionalLight(0xffffff, 1.2);
  sun.position.set(8, 14, 8);
  sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024);
  sun.shadow.camera.near = 0.5;
  sun.shadow.camera.far = 40;
  sun.shadow.camera.left = -10;
  sun.shadow.camera.right = 10;
  sun.shadow.camera.top = 10;
  sun.shadow.camera.bottom = -10;
  scene.add(sun);

  const fill = new THREE.DirectionalLight(0xa8d0ff, 0.4);
  fill.position.set(-6, 5, -8);
  scene.add(fill);

  // Camera at 3/4 view, slightly closer for clearer printer detail
  const aspect = canvas.clientWidth / canvas.clientHeight;
  const camera = new THREE.PerspectiveCamera(38, aspect, 0.1, 100);
  camera.position.set(7.5, 5.0, 8.5);
  camera.lookAt(0, 2.0, 0);

  // Floor / workshop ground
  const floorGeo = new THREE.PlaneGeometry(40, 40);
  const floorMat = new THREE.MeshStandardMaterial({
    color: 0xe8eaef, roughness: 0.9, metalness: 0.0,
  });
  const floor = new THREE.Mesh(floorGeo, floorMat);
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  scene.add(floor);

  // Build the printer
  const cat = printerCategory(printer);
  let group;
  if (cat === 'fdm') group = buildFDM3D(printer);
  else if (cat === 'resin') group = buildResin3D(printer);
  else group = buildIndustrial3D(printer);
  scene.add(group);

  return {
    renderer, scene, camera, group,
    printerId: printer.id,
    modelMesh: null,
    modelJobId: null,
    modelClipPlane: null,
  };
}

function ensureScene(canvas, slot) {
  if (!window.THREE) return null;
  const printer = printerById(slot.printerId);
  if (!printer) return null;
  let info = printerScenes.get(canvas);
  if (info && info.printerId !== printer.id) {
    info.renderer.dispose();
    info = null;
    printerScenes.delete(canvas);
  }
  if (!info) {
    info = createScene(canvas, printer);
    printerScenes.set(canvas, info);
  }
  // Resize if canvas dims changed
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (w > 0 && h > 0 && (info.renderer.domElement.width !== w * info.renderer.getPixelRatio() || info.renderer.domElement.height !== h * info.renderer.getPixelRatio())) {
    info.renderer.setSize(w, h, false);
    info.camera.aspect = w / h;
    info.camera.updateProjectionMatrix();
  }
  return info;
}

// ---------------------------------------------------------------------
// FDM / FFF (Cartesian or CoreXY)
// ---------------------------------------------------------------------
function buildFDM3D(printer) {
  const THREE = window.THREE;
  const group = new THREE.Group();
  const colors = BRAND_COLORS[printer.brand] || { frame: 0x444444, accent: 0x222222, panel: 0x222222 };
  const frameColor = colors.frame;
  const accentColor = colors.accent;
  const panelColor = colors.panel;

  // Determine chassis style — cantilever (Ender, Sovol, A1) vs cube (CoreXY, enclosed)
  const cantileverIds = new Set([
    'ender-3-v3-se', 'anycubic-kobra-2-neo', 'elegoo-neptune-4', 'sovol-sv06-plus',
    'bambu-a1-mini', 'bambu-a1-ams-lite', 'prusa-mk4s',
  ]);
  const isCantilever = cantileverIds.has(printer.id);

  // Electronics base (the box that holds the mainboard, where the LCD lives)
  const baseMat = new THREE.MeshStandardMaterial({ color: 0x111827, roughness: 0.5, metalness: 0.4 });
  const base = new THREE.Mesh(new THREE.BoxGeometry(5.5, 0.6, 4.2), baseMat);
  base.position.set(0, 0.3, 0);
  base.castShadow = true;
  base.receiveShadow = true;
  group.add(base);

  // Y-axis bed carrier (bed slides forward/back on this platform)
  const carrierMat = new THREE.MeshStandardMaterial({ color: panelColor, roughness: 0.6, metalness: 0.3 });
  const carrier = new THREE.Mesh(new THREE.BoxGeometry(4.3, 0.12, 4.3), carrierMat);
  carrier.position.set(0, 0.66, 0);
  carrier.receiveShadow = true;
  group.add(carrier);

  // Heated bed
  const bedMat = new THREE.MeshStandardMaterial({ color: 0x0f172a, roughness: 0.55, metalness: 0.4 });
  const bed = new THREE.Mesh(new THREE.BoxGeometry(4.0, 0.10, 4.0), bedMat);
  bed.position.set(0, 0.77, 0);
  bed.castShadow = true;
  bed.receiveShadow = true;
  group.add(bed);
  // PEI textured surface
  const peiMat = new THREE.MeshStandardMaterial({ color: 0x334155, roughness: 0.85, metalness: 0.2 });
  const pei = new THREE.Mesh(new THREE.BoxGeometry(3.95, 0.04, 3.95), peiMat);
  pei.position.set(0, 0.84, 0);
  pei.receiveShadow = true;
  group.add(pei);
  // Bed handle clip on the front edge (recognizable Ender detail)
  const clipMat = new THREE.MeshStandardMaterial({ color: 0x000000, roughness: 0.5 });
  const clip = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.08, 0.15), clipMat);
  clip.position.set(0, 0.84, 1.95);
  group.add(clip);

  // Frame — posts and top crossbar
  const postMat = new THREE.MeshStandardMaterial({ color: frameColor, roughness: 0.45, metalness: 0.5 });
  const postH = 4.5;  // shorter than before, less empty space at top
  const postGeo = new THREE.BoxGeometry(0.28, postH, 0.28);

  let postPositions;
  if (isCantilever) {
    // 2 back posts only, more substantial (40×40 extrusion look)
    postPositions = [[-2.0, postH/2 + 0.6, -1.85], [2.0, postH/2 + 0.6, -1.85]];
    const backPostGeo = new THREE.BoxGeometry(0.4, postH, 0.4);
    postPositions.forEach(([x, y, z]) => {
      const post = new THREE.Mesh(backPostGeo, postMat);
      post.position.set(x, y, z);
      post.castShadow = true;
      group.add(post);
    });
    // Top crossbar between back posts
    const cross = new THREE.Mesh(new THREE.BoxGeometry(4.4, 0.28, 0.28), postMat);
    cross.position.set(0, postH + 0.6, -1.85);
    cross.castShadow = true;
    group.add(cross);
  } else {
    // 4 corner posts (cube / CoreXY)
    postPositions = [
      [-2.3, postH/2 + 0.6, -1.95], [2.3, postH/2 + 0.6, -1.95],
      [-2.3, postH/2 + 0.6, 1.95],  [2.3, postH/2 + 0.6, 1.95],
    ];
    postPositions.forEach(([x, y, z]) => {
      const post = new THREE.Mesh(postGeo, postMat);
      post.position.set(x, y, z);
      post.castShadow = true;
      group.add(post);
    });
    // Top frame
    const topY = postH + 0.6;
    const tx = new THREE.BoxGeometry(4.7, 0.28, 0.28);
    const tz = new THREE.BoxGeometry(0.28, 0.28, 4.18);
    [[0, topY, -1.95, 'x'], [0, topY, 1.95, 'x'], [-2.3, topY, 0, 'z'], [2.3, topY, 0, 'z']].forEach(([x, y, z, axis]) => {
      const m = new THREE.Mesh(axis === 'x' ? tx : tz, postMat);
      m.position.set(x, y, z);
      m.castShadow = true;
      group.add(m);
    });
  }

  // ---- Z-Carriage: gantry rail + print head (moves UP as model grows) ----
  const zCarriage = new THREE.Group();

  // Gantry rail (horizontal, X-axis)
  const railMat = new THREE.MeshStandardMaterial({ color: 0x9ca3af, roughness: 0.25, metalness: 0.85 });
  const rail = new THREE.Mesh(new THREE.BoxGeometry(4.6, 0.16, 0.35), railMat);
  rail.position.set(0, 0, isCantilever ? -1.55 : 0);
  rail.castShadow = true;
  zCarriage.add(rail);
  // Second guide rod (parallel, smaller)
  const rail2 = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 4.4, 12), railMat);
  rail2.rotation.z = Math.PI / 2;
  rail2.position.set(0, -0.3, isCantilever ? -1.55 : 0);
  rail2.castShadow = true;
  zCarriage.add(rail2);

  // Print head (rides the rail in X)
  const headGroup = new THREE.Group();
  const headMat = new THREE.MeshStandardMaterial({ color: accentColor, roughness: 0.45, metalness: 0.4 });
  const headBox = new THREE.Mesh(new THREE.BoxGeometry(0.75, 0.85, 0.85), headMat);
  headBox.position.set(0, -0.15, 0);
  headBox.castShadow = true;
  headGroup.add(headBox);
  // Hot end — silver block beneath the head
  const hotMat = new THREE.MeshStandardMaterial({ color: 0xb8b8b8, roughness: 0.3, metalness: 0.9 });
  const hot = new THREE.Mesh(new THREE.BoxGeometry(0.36, 0.32, 0.36), hotMat);
  hot.position.set(0, -0.7, 0);
  hot.castShadow = true;
  headGroup.add(hot);
  // Brass nozzle — pointing down
  const nozMat = new THREE.MeshStandardMaterial({ color: 0xd4a017, roughness: 0.3, metalness: 0.9 });
  const noz = new THREE.Mesh(new THREE.ConeGeometry(0.09, 0.18, 16), nozMat);
  noz.rotation.x = Math.PI;
  noz.position.set(0, -0.95, 0);
  headGroup.add(noz);
  // Cooling fan duct (in front)
  const fanMat = new THREE.MeshStandardMaterial({ color: 0x4b5563, roughness: 0.6 });
  const fan = new THREE.Mesh(new THREE.BoxGeometry(0.95, 0.25, 0.35), fanMat);
  fan.position.set(0, -0.4, 0.4);
  fan.castShadow = true;
  headGroup.add(fan);
  // For cantilever: head sits on the front of the rail
  if (isCantilever) headGroup.position.z = -1.0;
  zCarriage.add(headGroup);

  // Position the carriage in the printer's coordinate space
  const bedY = 0.86;  // top of PEI surface
  const carriageMinY = bedY + 0.95;  // resting position (just above the bed)
  const carriageMaxY = postH + 0.4;   // ceiling
  zCarriage.position.set(0, carriageMinY, 0);
  group.add(zCarriage);

  // ---- Filament spool — large and visible on top of frame ----
  const spoolMat = new THREE.MeshStandardMaterial({ color: 0xf97316, roughness: 0.7 });
  const spool = new THREE.Mesh(new THREE.TorusGeometry(0.6, 0.22, 12, 32), spoolMat);
  spool.rotation.y = Math.PI / 2;
  const spoolY = postH + 1.1;
  const spoolZ = isCantilever ? -1.85 : 0;
  spool.position.set(0, spoolY, spoolZ);
  spool.castShadow = true;
  group.add(spool);
  // Spool hub axis
  const axisMat = new THREE.MeshStandardMaterial({ color: 0x111827, roughness: 0.4, metalness: 0.7 });
  const axis = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, 0.7, 16), axisMat);
  axis.rotation.z = Math.PI / 2;
  axis.position.set(0, spoolY, spoolZ);
  group.add(axis);
  // Spool support arm
  const armMat = postMat;
  const arm = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.5, 0.12), armMat);
  arm.position.set(0, spoolY - 0.3, spoolZ);
  group.add(arm);

  // ---- LCD on the electronics base, front face ----
  const lcdMat = new THREE.MeshStandardMaterial({
    color: 0x064e3b, emissive: 0x22d3ee, emissiveIntensity: 0.55, roughness: 0.2
  });
  const lcd = new THREE.Mesh(new THREE.BoxGeometry(1.3, 0.5, 0.06), lcdMat);
  lcd.position.set(0.7, 0.45, 2.13);
  group.add(lcd);
  // Knob next to LCD
  const knobMat = new THREE.MeshStandardMaterial({ color: 0x9ca3af, roughness: 0.3, metalness: 0.7 });
  const knob = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 0.08, 24), knobMat);
  knob.rotation.x = Math.PI / 2;
  knob.position.set(1.7, 0.45, 2.13);
  group.add(knob);
  // Brand badge on the base
  const badgeMat = new THREE.MeshStandardMaterial({
    color: accentColor, emissive: accentColor, emissiveIntensity: 0.25, roughness: 0.3
  });
  const badge = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.16, 0.03), badgeMat);
  badge.position.set(-1.6, 0.45, 2.13);
  group.add(badge);

  // ---- Translucent enclosure walls (cube/CoreXY only) ----
  if (printer.enclosed && !isCantilever) {
    const wallMat = new THREE.MeshPhysicalMaterial({
      color: 0xc7e5ff, transparent: true, opacity: 0.16, roughness: 0.0, metalness: 0.0,
      transmission: 0.85, thickness: 0.02, side: THREE.DoubleSide,
    });
    const sideGeoX = new THREE.PlaneGeometry(4.6, postH);
    const sideGeoZ = new THREE.PlaneGeometry(3.9, postH);
    const front = new THREE.Mesh(sideGeoX, wallMat); front.position.set(0, postH/2 + 0.6, 1.95); group.add(front);
    const back = new THREE.Mesh(sideGeoX, wallMat); back.position.set(0, postH/2 + 0.6, -1.95); back.rotation.y = Math.PI; group.add(back);
    const left = new THREE.Mesh(sideGeoZ, wallMat); left.position.set(-2.3, postH/2 + 0.6, 0); left.rotation.y = Math.PI/2; group.add(left);
    const right = new THREE.Mesh(sideGeoZ, wallMat); right.position.set(2.3, postH/2 + 0.6, 0); right.rotation.y = -Math.PI/2; group.add(right);
    const roof = new THREE.Mesh(new THREE.PlaneGeometry(4.6, 3.9), wallMat);
    roof.position.set(0, postH + 0.6, 0);
    roof.rotation.x = Math.PI/2;
    group.add(roof);
  }

  group.userData.zCarriage = zCarriage;
  group.userData.headGroup = headGroup;
  group.userData.zCarriageMinY = carriageMinY;
  group.userData.zCarriageMaxY = carriageMaxY;
  group.userData.bedY = bedY;
  group.userData.bedHalfSize = 1.85;
  group.userData.isCantilever = isCantilever;
  return group;
}

// ---------------------------------------------------------------------
// Resin (MSLA / SLA)
// ---------------------------------------------------------------------
function buildResin3D(printer) {
  const THREE = window.THREE;
  const group = new THREE.Group();
  const colors = BRAND_COLORS[printer.brand] || { frame: 0x222222, accent: 0xa855f7, panel: 0x111827 };

  // Cabinet body
  const cabMat = new THREE.MeshStandardMaterial({ color: colors.panel, roughness: 0.6, metalness: 0.3 });
  const cab = new THREE.Mesh(new THREE.BoxGeometry(3.5, 5.5, 3.5), cabMat);
  cab.position.y = 2.75;
  cab.castShadow = true;
  cab.receiveShadow = true;
  group.add(cab);
  // Frame trim
  const trimMat = new THREE.MeshStandardMaterial({ color: colors.frame, roughness: 0.5, metalness: 0.5 });
  const trimGeo = new THREE.BoxGeometry(3.7, 0.2, 3.7);
  const trimTop = new THREE.Mesh(trimGeo, trimMat); trimTop.position.y = 5.55; group.add(trimTop);
  const trimBot = new THREE.Mesh(trimGeo, trimMat); trimBot.position.y = 0.05; group.add(trimBot);

  // Vat (translucent purple) at the bottom inside
  const vatMat = new THREE.MeshPhysicalMaterial({
    color: 0xa855f7,
    transparent: true,
    opacity: 0.55,
    roughness: 0.05,
    metalness: 0.0,
    transmission: 0.6,
  });
  const vat = new THREE.Mesh(new THREE.BoxGeometry(2.4, 1.0, 2.4), vatMat);
  vat.position.set(0, 1.3, 0);
  group.add(vat);
  const vatRim = new THREE.Mesh(new THREE.BoxGeometry(2.6, 0.1, 2.6), trimMat);
  vatRim.position.y = 1.85;
  group.add(vatRim);

  // Z-screw on the back interior
  const zMat = new THREE.MeshStandardMaterial({ color: 0xfbbf24, roughness: 0.4, metalness: 0.7 });
  const zScrew = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, 3.5, 12), zMat);
  zScrew.position.set(0, 3.2, -1.4);
  group.add(zScrew);

  // Z-axis guide rails (chrome)
  const guideMat = new THREE.MeshStandardMaterial({ color: 0xc0c0c0, roughness: 0.2, metalness: 0.9 });
  const guideGeo = new THREE.CylinderGeometry(0.05, 0.05, 3.5, 12);
  [-0.4, 0.4].forEach(x => {
    const g = new THREE.Mesh(guideGeo, guideMat);
    g.position.set(x, 3.2, -1.4);
    group.add(g);
  });

  // Build plate (metal) — moves up as print progresses
  const plateMat = new THREE.MeshStandardMaterial({ color: 0xd1d5db, roughness: 0.3, metalness: 0.8 });
  const plate = new THREE.Mesh(new THREE.BoxGeometry(2.2, 0.12, 2.0), plateMat);
  plate.position.set(0, 1.85, 0); // resting position over vat
  plate.castShadow = true;
  group.add(plate);
  // Plate arm to z-screw
  const armMat = trimMat;
  const arm = new THREE.Mesh(new THREE.BoxGeometry(0.25, 0.2, 1.4), armMat);
  arm.position.set(0, 1.95, -0.7);
  group.add(arm);

  // LED display panel on front
  const lcdMat = new THREE.MeshStandardMaterial({ color: 0x0c4a6e, emissive: 0x22d3ee, emissiveIntensity: 0.6, roughness: 0.2 });
  const lcd = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.9, 0.08), lcdMat);
  lcd.position.set(0, 4.4, 1.79);
  group.add(lcd);
  // Brand badge
  const badgeMat = new THREE.MeshStandardMaterial({ color: colors.accent, emissive: colors.accent, emissiveIntensity: 0.3 });
  const badge = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.16, 0.04), badgeMat);
  badge.position.set(0, 5.2, 1.79);
  group.add(badge);

  group.userData.plate = plate;
  group.userData.plateRestY = 1.85;
  group.userData.plateMaxY = 4.5;
  group.userData.bedHalfSize = 1.0;
  return group;
}

// ---------------------------------------------------------------------
// Industrial (SLS / MJF / DMLS / ADAM)
// ---------------------------------------------------------------------
function buildIndustrial3D(printer) {
  const THREE = window.THREE;
  const group = new THREE.Group();
  const colors = BRAND_COLORS[printer.brand] || { frame: 0x222222, accent: 0xfbbf24, panel: 0x1f2937 };

  // Big metal cabinet
  const cabMat = new THREE.MeshStandardMaterial({ color: colors.panel, roughness: 0.55, metalness: 0.5 });
  const cab = new THREE.Mesh(new THREE.BoxGeometry(5, 5.5, 4), cabMat);
  cab.position.y = 2.75;
  cab.castShadow = true;
  cab.receiveShadow = true;
  group.add(cab);

  // Door panel (lighter color, inset)
  const doorMat = new THREE.MeshStandardMaterial({ color: 0x64748b, roughness: 0.5, metalness: 0.5 });
  const door = new THREE.Mesh(new THREE.BoxGeometry(3.2, 4.2, 0.08), doorMat);
  door.position.set(-0.6, 2.75, 2.05);
  group.add(door);

  // Window in the door
  const winMat = new THREE.MeshPhysicalMaterial({
    color: 0x1e293b,
    transparent: true,
    opacity: 0.7,
    roughness: 0.05,
    metalness: 0.0,
    transmission: 0.3,
  });
  const win = new THREE.Mesh(new THREE.BoxGeometry(2.0, 1.6, 0.04), winMat);
  win.position.set(-0.6, 3.4, 2.10);
  group.add(win);

  // Door handle
  const handleMat = new THREE.MeshStandardMaterial({ color: 0xc0c0c0, roughness: 0.3, metalness: 0.9 });
  const handle = new THREE.Mesh(new THREE.BoxGeometry(0.15, 0.6, 0.08), handleMat);
  handle.position.set(0.85, 2.75, 2.10);
  group.add(handle);

  // Right-side control panel (dark with LEDs)
  const panelMat = new THREE.MeshStandardMaterial({ color: 0x0f172a, roughness: 0.5 });
  const panel = new THREE.Mesh(new THREE.BoxGeometry(1.4, 4.2, 0.08), panelMat);
  panel.position.set(1.85, 2.75, 2.05);
  group.add(panel);

  // LCD screen on panel
  const lcdMat = new THREE.MeshStandardMaterial({ color: 0x065f46, emissive: 0x22d3ee, emissiveIntensity: 0.7 });
  const lcd = new THREE.Mesh(new THREE.BoxGeometry(1.0, 0.7, 0.04), lcdMat);
  lcd.position.set(1.85, 3.6, 2.10);
  group.add(lcd);

  // Status LEDs
  const ledColors = [0x22c55e, 0xfbbf24, 0xef4444];
  ledColors.forEach((c, i) => {
    const ledMat = new THREE.MeshStandardMaterial({
      color: c, emissive: c, emissiveIntensity: 0.7,
    });
    const led = new THREE.Mesh(new THREE.SphereGeometry(0.10, 12, 8), ledMat);
    led.position.set(1.85, 2.7 - i * 0.3, 2.10);
    group.add(led);
  });

  // Brand badge near the top
  const badgeMat = new THREE.MeshStandardMaterial({ color: colors.accent, emissive: colors.accent, emissiveIntensity: 0.4 });
  const badge = new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.2, 0.04), badgeMat);
  badge.position.set(0, 4.7, 2.05);
  group.add(badge);

  // Caster wheels at corners of base
  const wheelMat = new THREE.MeshStandardMaterial({ color: 0x111827, roughness: 0.6 });
  const wheelGeo = new THREE.SphereGeometry(0.18, 12, 12);
  [[-2.3, -1.8], [2.3, -1.8], [-2.3, 1.8], [2.3, 1.8]].forEach(([x, z]) => {
    const w = new THREE.Mesh(wheelGeo, wheelMat);
    w.position.set(x, 0.18, z);
    w.castShadow = true;
    group.add(w);
  });

  // Save references for animation
  group.userData.lcd = lcd;
  group.userData.leds = group.children.filter(c => c.material && c.material.emissiveIntensity > 0.5).slice(-3);
  return group;
}

// ---------------------------------------------------------------------
// Model creation — 3D shape per product
// ---------------------------------------------------------------------
function createGearGeo() {
  const THREE = window.THREE;
  const teeth = 10, outer = 0.72, inner = 0.55, h = 0.4;
  const shape = new THREE.Shape();
  for (let i = 0; i <= teeth * 2; i++) {
    const r = i % 2 === 0 ? outer : inner;
    const a = (i / (teeth * 2)) * Math.PI * 2;
    const x = Math.cos(a) * r, y = Math.sin(a) * r;
    if (i === 0) shape.moveTo(x, y); else shape.lineTo(x, y);
  }
  const hole = new THREE.Path();
  hole.absarc(0, 0, 0.18, 0, Math.PI * 2, true);
  shape.holes.push(hole);
  return new THREE.ExtrudeGeometry(shape, { depth: h, bevelEnabled: false });
}

function createBracketGeo() {
  const THREE = window.THREE;
  const shape = new THREE.Shape();
  shape.moveTo(-0.6, -0.6);
  shape.lineTo(0.6, -0.6);
  shape.lineTo(0.6, -0.2);
  shape.lineTo(-0.2, -0.2);
  shape.lineTo(-0.2, 0.6);
  shape.lineTo(-0.6, 0.6);
  shape.closePath();
  return new THREE.ExtrudeGeometry(shape, { depth: 0.5, bevelEnabled: false });
}

function createCrossGeo() {
  const THREE = window.THREE;
  const a = new THREE.BoxGeometry(2.0, 0.18, 0.35);
  const b = new THREE.BoxGeometry(0.35, 0.18, 2.0);
  // Merge using BufferGeometryUtils-like manual approach: just return primary;
  // Two-mesh solution will be done in createModelMesh.
  return a;
}

function createTallGeo() {
  const THREE = window.THREE;
  const points = [];
  for (let i = 0; i <= 12; i++) {
    const t = i / 12;
    const r = 0.35 + Math.sin(t * Math.PI) * 0.30;
    points.push(new THREE.Vector2(r, t * 1.6));
  }
  return new THREE.LatheGeometry(points, 28);
}

function createAngularGeo() {
  const THREE = window.THREE;
  const shape = new THREE.Shape();
  shape.moveTo(-0.6, -0.6);
  shape.lineTo(-0.3, 0.5);
  shape.lineTo(0.0, 0.0);
  shape.lineTo(0.4, 0.7);
  shape.lineTo(0.6, -0.6);
  shape.closePath();
  return new THREE.ExtrudeGeometry(shape, { depth: 0.5, bevelEnabled: false });
}

function createBatchGeo() {
  const THREE = window.THREE;
  // Single representative box — visual fidelity sacrifice for simplicity
  return new THREE.BoxGeometry(1.6, 0.4, 1.2);
}

function createShapeGeometry(shape) {
  const THREE = window.THREE;
  switch (shape) {
    case 'flat': return new THREE.BoxGeometry(2.0, 0.30, 1.2);
    case 'flat-wide': return new THREE.BoxGeometry(2.4, 0.22, 1.0);
    case 'tall': return createTallGeo();
    case 'humanoid': return new THREE.CapsuleGeometry(0.35, 0.9, 6, 12);
    case 'dome': return new THREE.SphereGeometry(0.85, 24, 12, 0, Math.PI * 2, 0, Math.PI / 2);
    case 'cross': return createCrossGeo();
    case 'gear': return createGearGeo();
    case 'bracket': return createBracketGeo();
    case 'block': return new THREE.BoxGeometry(1.0, 1.2, 1.0);
    case 'gem': return new THREE.OctahedronGeometry(0.6, 0);
    case 'small': return new THREE.SphereGeometry(0.4, 16, 12);
    case 'box': return new THREE.BoxGeometry(1.2, 1.0, 1.2);
    case 'angular': return createAngularGeo();
    case 'batch': return createBatchGeo();
    default: return new THREE.BoxGeometry(1.0, 1.0, 1.0);
  }
}

function createModelMesh(productId, color) {
  const THREE = window.THREE;
  const shape = SHAPE_FOR_PRODUCT[productId] || 'box';
  const geo = createShapeGeometry(shape);

  // For shape that's a 2D extrude (gear, bracket, angular), rotate so extrude axis is Y
  if (shape === 'gear' || shape === 'bracket' || shape === 'angular') {
    geo.rotateX(-Math.PI / 2);
  }
  // Lathe geometry already has Y as up.

  // Compute bbox and translate so bottom is at y=0
  geo.computeBoundingBox();
  const bb = geo.boundingBox;
  geo.translate(0, -bb.min.y, 0);

  const colorInt = hexToInt(color);
  const mat = new THREE.MeshStandardMaterial({
    color: colorInt,
    roughness: 0.65,
    metalness: 0.1,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.castShadow = true;
  mesh.receiveShadow = true;

  // For 'cross' (drone), add second perpendicular bar
  if (shape === 'cross') {
    const bar2Geo = new THREE.BoxGeometry(0.35, 0.18, 2.0);
    bar2Geo.translate(0, 0.09, 0);
    const bar2 = new THREE.Mesh(bar2Geo, mat);
    bar2.castShadow = true;
    bar2.receiveShadow = true;
    mesh.add(bar2);
  }

  return mesh;
}

function updateModel(info, slot) {
  const THREE = window.THREE;
  const printing = slot.state === 'printing' && slot.job;

  if (!printing) {
    if (info.modelMesh) {
      info.scene.remove(info.modelMesh);
      info.modelMesh.geometry.dispose();
      info.modelMesh.material.dispose();
      info.modelMesh = null;
      info.modelJobId = null;
    }
    return;
  }

  if (info.modelJobId !== slot.job.orderId) {
    if (info.modelMesh) {
      info.scene.remove(info.modelMesh);
      info.modelMesh.geometry.dispose();
      info.modelMesh.material.dispose();
    }
    const mesh = createModelMesh(slot.job.productId, slot.job.color);
    const printer = printerById(slot.printerId);
    const cat = printerCategory(printer);
    if (cat === 'fdm') {
      // Anchor at top of build plate; will scale upward as job runs
      mesh.position.y = info.group.userData.bedY;
    } else if (cat === 'resin') {
      // Model hangs below the build plate (resin prints upside-down)
      mesh.scale.y = -1;
      mesh.position.y = info.group.userData.plateRestY - 0.06;
    } else {
      // Industrial — model hidden inside cabinet
      mesh.position.y = 0.3;
      mesh.visible = false;
    }
    info.scene.add(mesh);

    info.modelMesh = mesh;
    info.modelJobId = slot.job.orderId;
    info.modelHeight = computeModelHeight(mesh);
    info.modelCategory = cat;
  }

  const progress = Math.min(1, slot.job.hoursElapsed / slot.job.hoursTotal);
  if (info.modelCategory === 'resin') {
    // Build plate rises; model attached underneath grows downward
    const plate = info.group.userData.plate;
    const lift = (info.group.userData.plateMaxY - info.group.userData.plateRestY) * progress;
    plate.position.y = info.group.userData.plateRestY + lift;
    info.modelMesh.position.y = info.group.userData.plateRestY - 0.06 + lift;
    info.modelMesh.scale.y = -Math.max(0.01, progress);
  } else if (info.modelCategory === 'fdm') {
    // Model grows from a thin disc up to full height as the print progresses
    info.modelMesh.scale.y = Math.max(0.02, progress);
    info.modelMesh.position.y = info.group.userData.bedY;
  }
}

function computeModelHeight(mesh) {
  const bb = mesh.geometry.boundingBox;
  return bb ? (bb.max.y - bb.min.y) : 1;
}

function animateScene(info, slot) {
  const printing = slot.state === 'printing' && slot.job;
  const t = Date.now() / 800;

  // FDM — animate Z-carriage rising with model + head wobbling on its rail
  if (info.group.userData.zCarriage) {
    const carriage = info.group.userData.zCarriage;
    const head = info.group.userData.headGroup;
    const isCanti = info.group.userData.isCantilever;
    const minY = info.group.userData.zCarriageMinY;
    const maxY = info.group.userData.zCarriageMaxY;
    const halfSize = info.group.userData.bedHalfSize || 1.7;

    if (printing) {
      const progress = Math.min(1, slot.job.hoursElapsed / slot.job.hoursTotal);
      const modelH = info.modelHeight || 0.5;
      // Carriage hovers just above the current top of the model
      const surfaceY = info.group.userData.bedY + modelH * progress * 0.85;
      // Carriage Y is the level of the print head's NOZZLE TIP
      // Nozzle tip is 0.95 below the carriage local origin (head down by 0.15 + 0.7 + 0.1)
      // We want nozzle tip ~= surfaceY + 0.05 (just touching)
      const carriageTargetY = surfaceY + 1.0;  // visual offset for the nozzle
      carriage.position.y = Math.min(Math.max(carriageTargetY, minY), maxY);

      // Head moves along the rail (X-axis)
      head.position.x = Math.sin(t * 1.3) * (halfSize * 0.9);
      // For cube printers, head also moves Y (CoreXY); for cantilever, the bed moves Y so head Z stays fixed
      if (isCanti) {
        head.position.z = -1.0;
      } else {
        head.position.z = Math.sin(t * 0.7) * (halfSize * 0.9);
      }
    } else {
      carriage.position.y = minY;
      head.position.x = 0;
      head.position.z = isCanti ? -1.0 : 0;
    }
  }

  info.renderer.render(info.scene, info.camera);
}

// =====================================================================
// DOM rendering
// =====================================================================

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
        <div class="printer-status"></div>
        <div class="progress" style="display:none"><div class="fill"></div></div>
        <div class="job-info" style="display:none"></div>
      </div>
    `;
    root.appendChild(card);
  }
  while (root.children.length > state.printers.length) {
    const removed = root.lastChild;
    const canvas = removed.querySelector('canvas');
    const info = printerScenes.get(canvas);
    if (info) { info.renderer.dispose(); printerScenes.delete(canvas); }
    root.removeChild(removed);
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
// Animation loop — drives 3D scenes at ~60fps
// =====================================================================
function animate() {
  if (window.THREE && state) {
    const root = document.getElementById('printers');
    if (root) {
      state.printers.forEach((slot, i) => {
        const card = root.children[i];
        if (!card) return;
        const canvas = card.querySelector('.printer-canvas');
        if (!canvas) return;
        const info = ensureScene(canvas, slot);
        if (info) {
          updateModel(info, slot);
          animateScene(info, slot);
        }
      });
    }
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

async function waitForThree() {
  if (window.THREE) return;
  return new Promise(r => {
    window.addEventListener('threeReady', r, { once: true });
    // Safety timeout — proceed without 3D after 6s
    setTimeout(r, 6000);
  });
}

async function boot() {
  await loadCatalogs();
  await waitForThree();
  state = loadState();
  document.getElementById('btnSpeed').addEventListener('click', cycleSpeed);
  document.getElementById('btnReset').addEventListener('click', resetState);
  render();
  lastTickReal = Date.now();
  setInterval(tick, TICK_MS);
  requestAnimationFrame(animate);
}
boot();
