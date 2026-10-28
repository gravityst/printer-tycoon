// A playtest bot that plays Print3D through the rules module the way a careful kid would:
// take the order that keeps the most money, buy the material it needs, collect parts, fix
// clogs, clean the bed, service worn printers, dry damp spools, and grow to a small shop.
// The clock is stepped by hand, so every rule is the game's own.
import { cat, Sim } from './catalog.mjs';

const PLAN = [
  { id: 'bambu-a1-mini', reserve: 120 },              // hobbyist (rep 5): fast, precise, cheap
  { id: 'anycubic-photon-mono-m5s', reserve: 150 },   // first resin machine (rep 5)
  { id: 'bambu-p1s-ams', reserve: 250 },              // enclosed studio machine (rep 25)
];
const TIER_OF = Object.fromEntries(cat.products.map((p) => [p.id, p.customerTier]));
export const INDUSTRIAL_TIERS = new Set(['smb', 'enterprise']);

export function playGame({ seed = 1, days = 60, orderBaseHours = 45, stepHours = 0.5, maxPrinters = 4, upgrades = true } = {}) {
  const s = Sim.newGame(cat, seed);
  const opts = { orderBaseHours };
  const shipped = [];        // { day, productId, tier, payout, matCost, powerCost, scrap }
  const repByDay = [];       // reputation at each midnight
  const moneyByDay = [];
  const events = [];
  const scrapByOrder = new Map();
  const pending = new Map(); // orderId -> { matCost, kwh, finishKwh, productId }
  let firstRep5 = null, firstRep25 = null;

  const note = (out) => {
    for (const e of out.events) {
      events.push(e);
      if (e.type === 'failed') {
        const slot = s.printers.find((x) => x.slotId === e.slotId);
        const mat = slot && slot.job ? cat.material(slot.job.materialId) : null;
        const cost = mat ? e.lostGrams / 1000 * (mat.costPerKg || 0) : 0;
        scrapByOrder.set(e.orderId, (scrapByOrder.get(e.orderId) || 0) + cost);
      }
      if (e.type === 'shipped') {
        const info = pending.get(e.orderId) || { matCost: 0, kwh: 0, finishKwh: 0 };
        pending.delete(e.orderId);
        const productId = info.productId;
        shipped.push({ day: Math.floor(e.at / 24) + 1, at: e.at, orderId: e.orderId, productId, tier: TIER_OF[productId],
          payout: e.payout, rep: e.rep, late: e.late, matCost: info.matCost, powerCost: (info.kwh + info.finishKwh) * Sim.KWH_PRICE,
          scrap: scrapByOrder.get(e.orderId) || 0 });
      }
      if (e.type === 'dayClosed') {
        repByDay.push(s.reputation);
        moneyByDay.push(s.money);
      }
    }
    if (firstRep5 === null && s.reputation >= 5) firstRep5 = s.day;
    if (firstRep25 === null && s.reputation >= 25) firstRep25 = s.day;
  };
  const bookJob = (slot) => {
    const j = slot.job;
    if (!j) return;
    pending.set(j.orderId, { productId: j.productId, matCost: j.matCost || 0, kwh: j.kwh || 0,
      finishKwh: (j.finish || []).reduce((a, f) => a + (f.w || 0) * f.h, 0) / 1000 });
  };

  const endT = days * 24;
  while (Sim.now(s) < endT - 1e-9) {
    note(Sim.step(cat, s, Math.min(stepHours, endT - Sim.now(s)), opts));

    s.printers.forEach((slot, i) => {
      if (slot.phase === 'done') { bookJob(slot); note(Sim.collect(cat, s, i)); }
      else if (slot.phase === 'clogged') note(Sim.coldPull(cat, s, i));
      else if (slot.phase === 'failed') {
        const r = Sim.reprint(cat, s, i);
        if (!r.ok) {
          const m = slot.job && slot.job.materialId;
          const mat = m && cat.material(m);
          if (mat && s.money > (mat.costPerKg || 0) + 60) Sim.buyMaterial(cat, s, m, 1);
          const r2 = Sim.reprint(cat, s, i);
          if (!r2.ok) note(Sim.release(cat, s, i));
          else note(r2);
        } else note(r);
      }
    });
    // Upkeep while idle: clean the bed, service a worn machine, fit a fresh nozzle.
    s.printers.forEach((slot, i) => {
      if (slot.phase !== 'idle') return;
      if ((slot.bed ?? 1) < 0.75) { Sim.cleanBed(cat, s, i); return; }
      if ((slot.wearHours || 0) > 200 && s.money > 400) Sim.service(cat, s, i, 'service');
      if (Sim.usesNozzle(cat.printer(slot.printerId)) && (slot.nozzleHealth ?? 1) < 0.5 && s.money > 100) {
        Sim.changeNozzle(cat, s, i, slot.nozzleType || 'b04');
      }
    });
    if (upgrades) {
      if (!Sim.hasShopUpgrade(s, 'drybox') && s.money > 400) Sim.buyUpgrade(cat, s, 'drybox');
      if (!Sim.hasShopUpgrade(s, 'dryer') && s.money > 600) Sim.buyUpgrade(cat, s, 'dryer');
      if (!s.dryer && Sim.hasShopUpgrade(s, 'dryer')) {
        const damp = Object.keys(s.inventory).filter((m) => s.inventory[m] > 50 && Sim.wetOf(s, m) >= 0.3).sort((a, b) => Sim.wetOf(s, b) - Sim.wetOf(s, a))[0];
        if (damp) Sim.startDrying(cat, s, damp);
      }
    }
    // Buy material for orders that only lack stock, when the order pays for it.
    for (const order of s.orders) {
      for (const slot of s.printers) {
        const c = Sim.canAssign(cat, s, order, slot);
        if (c.code !== 'stock') continue;
        const mat = cat.material(c.materialId);
        const kg = Math.max(1, Math.ceil((c.needGrams - (s.inventory[c.materialId] || 0)) / 1000));
        const cost = (mat.costPerKg || 0) * kg;
        // A spool lasts for many orders: buy it when the order pays for it, or when it's pocket money.
        if ((order.basePrice > cost * 1.5 || cost <= s.money * 0.1) && s.money > cost + 60) Sim.buyMaterial(cat, s, c.materialId, kg);
        break;
      }
    }
    if ((s.inventory.pla || 0) < 300 && s.money > 80) Sim.buyMaterial(cat, s, 'pla', 1);
    // Each free printer takes the order that keeps the most money, counting the risk.
    s.printers.forEach((slot, i) => {
      if (slot.phase !== 'idle') return;
      let best = null;
      for (const order of s.orders) {
        const c = Sim.canAssign(cat, s, order, slot);
        if (!c.ok) continue;
        const est = Sim.estimateJob(cat, s, slot, order, c.materialId);
        const risk = Sim.jobRisk(cat, s, slot, order, est);
        const value = est.keep * risk.chance;
        if (value > 0 && (!best || value > best.value)) best = { order, value };
      }
      if (best) note(Sim.assign(cat, s, best.order.id, i));
    });
    // Grow the shop the way the plan says.
    if (s.printers.length < maxPrinters) {
      const owned = new Set(s.printers.map((x) => x.printerId));
      const next = PLAN.find((p) => !owned.has(p.id));
      if (next) {
        const p = cat.printer(next.id);
        if (s.reputation >= (Sim.TIER_UNLOCK_REP[p.tier] || 0) && s.money >= p.price + next.reserve) note(Sim.buyPrinter(cat, s, next.id));
      }
    }
    // An enclosure kit for an open printer once ABS-class orders show up.
    if (upgrades) {
      s.printers.forEach((slot, i) => {
        if (Sim.upgradeApplies(cat, slot, 'enclosure') && !Sim.hasUpgrade(slot, 'enclosure') && s.money > 500 &&
            s.orders.some((o) => ['abs', 'asa', 'pc', 'nylon-pa12', 'pa-cf'].includes(o.materialId))) {
          Sim.buyUpgrade(cat, s, 'enclosure', i);
        }
      });
    }
  }
  return { state: s, shipped, repByDay, moneyByDay, events, firstRep5, firstRep25 };
}

export function median(xs) {
  const v = xs.filter((x) => x != null).sort((a, b) => a - b);
  if (!v.length) return null;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}
