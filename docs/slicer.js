// =====================================================================
// Print3D slicer client: asks the slicer worker for part meshes and toolpaths.
//
// Two module workers (one for meshes, one for toolpaths, so a slow mesh never stalls a print's
// next layer). If workers can't start (or fail to load), the same code runs on the main thread
// one request at a time, between frames.
// =====================================================================

export function createSlicer(build) {
  const v = encodeURIComponent(build || 'dev');
  const url = new URL('./slicer-worker.js?v=' + v, import.meta.url);
  const lanes = {};
  let seq = 1;
  let local = null;            // main-thread fallback: { handle, queue, busy }
  const stats = { sent: 0, done: 0, failed: 0, shared: 0, mainThread: false, ms: { loft: [], plan: [] } };

  const toLocal = (job) => {
    if (!local) {
      stats.mainThread = true;
      local = { handle: null, queue: [], busy: false };
      import('./slicer-worker.js?v=' + v).then((m) => { local.handle = m.handle; pump(); }, (e) => {
        for (const j of local.queue) j.reject(e);
        local.queue = [];
      });
    }
    local.queue.push(job);
    pump();
  };
  function pump() {
    if (!local || !local.handle || local.busy || !local.queue.length) return;
    local.busy = true;
    const job = local.queue.shift();
    setTimeout(async () => {
      try { job.resolve(await local.handle(job.msg)); } catch (e) { job.reject(e); }
      local.busy = false;
      pump();
    }, 8);
  }

  function lane(name) {
    if (lanes[name] !== undefined) return lanes[name];
    let w = null;
    try { w = new Worker(url, { type: 'module', name: 'print3d-' + name }); } catch (e) { w = null; }
    const L = lanes[name] = w ? { w, pending: new Map() } : null;
    if (!L) return null;
    w.onmessage = (ev) => {
      const d = ev.data;
      const job = L.pending.get(d.id);
      if (!job) return;
      L.pending.delete(d.id);
      if (d.error) { stats.failed++; job.reject(new Error(d.error)); } else { stats.done++; job.resolve(d); }
    };
    w.onerror = (ev) => {
      // A worker that can't load its modules: everything it held moves to the main thread.
      if (ev && ev.preventDefault) ev.preventDefault();
      console.warn('[Print3D] slicer worker unavailable; slicing on the main thread', ev && ev.message);
      lanes[name] = null;
      try { w.terminate(); } catch (e) {}
      for (const job of L.pending.values()) toLocal(job);
      L.pending.clear();
    };
    return L;
  }

  // Meshes and layouts are shared: every view printing the same part asks once (the last few are
  // kept). Callers only read what comes back.
  const shared = new Map();
  function request(msg) {
    if (msg.op !== 'loft' && msg.op !== 'spec') return send(msg);
    const k = msg.op + '|' + JSON.stringify(msg.args) + '|' + (msg.budget || 0) + '|' + (msg.hero ? 1 : 0) + '|' + (msg.limit || 0);
    let p = shared.get(k);
    if (p) { shared.delete(k); shared.set(k, p); stats.shared++; return p; }
    p = send(msg);
    shared.set(k, p);
    p.catch(() => shared.delete(k));
    while (shared.size > 12) shared.delete(shared.keys().next().value);
    return p;
  }
  function send(msg) {
    stats.sent++;
    const name = msg.op === 'loft' || msg.op === 'spec' ? 'mesh' : 'path';
    return new Promise((resolve, reject) => {
      const t0 = performance.now();
      const job = { msg: { ...msg, id: seq++ }, resolve: (d) => { const arr = stats.ms[msg.op]; if (arr) { arr.push(performance.now() - t0); if (arr.length > 50) arr.shift(); } resolve(d); }, reject };
      const L = lane(name);
      if (!L) { toLocal(job); return; }
      L.pending.set(job.msg.id, job);
      try { L.w.postMessage(job.msg); } catch (e) { L.pending.delete(job.msg.id); toLocal(job); }
    });
  }

  function pending() {
    let n = local ? local.queue.length + (local.busy ? 1 : 0) : 0;
    for (const L of Object.values(lanes)) if (L) n += L.pending.size;
    return n;
  }

  function dispose() {
    for (const L of Object.values(lanes)) if (L) { try { L.w.terminate(); } catch (e) {} }
    for (const k of Object.keys(lanes)) delete lanes[k];
  }

  return { request, pending, dispose, stats };
}
