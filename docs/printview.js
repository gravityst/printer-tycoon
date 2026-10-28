// =====================================================================
// Print3D print views: one printer's scene, and how it follows its slot.
//
// A view owns a scene (room, machine, part), a camera framed on the machine, and the state of
// what it shows: the start of a print (heat, probe, purge), the time-lapse (one layer traced at a
// readable speed, then a jump to where the print really is), the class's own motion (peel cycles,
// recoater sweeps, laser scans, lamp passes), the machine's screen, and the goofy failures. It
// never changes the rules or the save: it only reads the slot.
//
// createPrintViews(ctx, deps) -> { view(opts) }
//   opts: { getSlot(), getState(), live (follow the sim clock), pin ({ f, hours } to freeze a moment) }
// =====================================================================

export function createPrintViews(ctx, deps) {
  const { THREE, M, T, L } = ctx;
  const { machines, rooms, parts, slicer, Sim, cat, clock } = deps;
  const PI = Math.PI;
  const mid = (r, d) => (Array.isArray(r) && r.length ? (r[0] + r[1]) / 2 : d);
  const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
  const ACTIVE = new Set(['heating', 'prep', 'printing']);
  const WARM = new Set(['heating', 'prep', 'printing', 'clogged', 'coldpull']);

  // Printers missing from the catalog still draw (as a plain grey bed-slinger).
  function drawable(printer) {
    if (!printer.unknown && printer.buildVolumeMM && printer.buildVolumeMM[0] > 0) return printer;
    return { ...printer, brand: '', tech: 'FDM', kinematics: 'bedslinger', buildVolumeMM: [220, 220, 250], footprintMM: [410, 366], multiMaterialColors: 0, enclosed: false };
  }
  // What the slicer needs to know about a job's part.
  function specArgs(slot, job, printer) {
    const product = cat.product(job.productId) || null;
    const kin = M.kinematicsOf(printer);
    let nozzle = 0.4;
    if (M.NOZZLE_KINDS.has(kin)) { try { nozzle = (Sim.slotNozzle(slot) || {}).size || 0.4; } catch (e) { nozzle = 0.4; } }
    const order = job.order || {};
    return {
      productId: job.productId,
      heightMM: +(order.heightMM || mid(product && product.heightMM, 40)).toFixed(3),
      grams: +(order.grams || job.grams || mid(product && product.grams, 50)).toFixed(3),
      density: L.densityOf(job.materialId),
      bedMM: printer.buildVolumeMM.slice(),
      tech: printer.tech === 'UNKNOWN' ? 'FDM' : printer.tech,
      nozzleMM: nozzle,
    };
  }

  function view(opts) {
    const getSlot = opts.getSlot, getState = opts.getState;
    const scene = new THREE.Scene();
    scene.name = 'print-view';
    const camera = new THREE.PerspectiveCamera(30, 4 / 3, 20, 60000);
    let tier = opts.tier || 'high';
    let printer = null, rig = null, room = null, roomKind = '', part = parts.rig(tier);
    const stations = { wash: null, sinter: null };
    let frameInfo = null;           // camera framing: { center, radius, aspect }
    let pxPerMM = 1.5, vw = 1, vh = 1;
    // Job state
    let jobKey = '', spec = null, specKey = '', look = null, plans = new Map(), want = new Set(), pre = null, preReq = false;
    let lapse = M.createLapse(), shown = null, shownTl = null, prevPlan = null, skirtDone = false;
    let seq = null;                  // { t0, len } of a playing start sequence
    let nestSeed = 0, nestPts = null, faultKind = null, stringsSet = false;
    let lastNow = 0, lastTone = '', animating = false;
    let lastTip = { x: 0, y: 0, z: 30 };
    let revealZ = null;               // applied after the pose, so the cut follows the bed this frame
    const tmpV = new THREE.Vector3(), tmpW = new THREE.Vector3();
    const v = {
      scene, camera, opts, dirty: true, setup: true, visible: false, lastRender: -1e9, info: null, id: opts.id,
      get printerId() { return printer && printer.id; },
      get rig() { return rig; }, get part() { return part; }, get room() { return room; }, get spec() { return spec; },
      get frame() { return frameInfo; },
    };

    function build(p) {
      if (rig) { scene.remove(rig.root); rig.dispose(); }
      printer = p;
      const dp = drawable(p);
      rig = machines.rig(dp, tier);
      scene.add(rig.root);
      rig.partAnchor.add(part.root);
      // The cross-section patch: on the exposure screen under a vat, on the powder for a bed.
      if (rig.kin === 'vat') { rig.root.add(part.section); part.section.position.set(0, rig.t.vat.screenY + 0.4, rig.t.vat.z); part.section.rotation.set(PI / 2, 0, 0); }
      else part.root.add(part.section);
      if (rig.t.stations) {
        const mk = (w, h, hex) => new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ color: hex, transparent: true, opacity: 0, toneMapped: false, depthWrite: false }));
        const ws = rig.t.stations.wash, ss = rig.t.stations.sinter;
        stations.wash = mk(ws.w, ws.h, 0x5ab8ff); stations.wash.position.set(ws.x, ws.y, ws.z + 1);
        stations.sinter = new THREE.Mesh(new THREE.CircleGeometry(ss.r, 28), new THREE.MeshBasicMaterial({ color: 0xff8a2a, transparent: true, opacity: 0, toneMapped: false, depthWrite: false }));
        stations.sinter.position.set(ss.x, ss.y, ss.z + 1);
        rig.root.add(stations.wash, stations.sinter);
      }
      frameCamera();
      setRoom(roomKind || 'garage', true);
      v.dirty = true;
      v.setup = true;     // new buffers to upload: the stage keeps this frame out of the governor
    }
    function setRoom(kind, force) {
      if (!rig || (!force && kind === roomKind && room)) return;
      if (room) { scene.remove(room.group); room.dispose(); }
      roomKind = kind;
      const [x0, y0, z0, x1, y1, z1] = rig.bounds;
      room = rooms.room(kind, { w: x1 - x0, d: z1 - z0, h: y1 - y0, floor: !!rig.floor }, tier);
      room.group.position.set((x0 + x1) / 2, 0, (z0 + z1) / 2);
      scene.add(room.group);
      const lt = rooms.light(kind);
      scene.background = new THREE.Color(lt.bg);
      v.roomLight = lt;
      v.dirty = true;
      v.setup = true;
    }
    // Frame the machine: a three-quarter view from the front right, a little above.
    function frameCamera() {
      const [x0, y0, z0, x1, y1, z1] = rig.bounds;
      const c = new THREE.Vector3((x0 + x1) / 2, y0 + (y1 - y0) * 0.44, (z0 + z1) / 2);
      // Resin printers are seen a little more from above (into the vat); floor machines more face-on.
      const dir = (rig.kin === 'vat' ? new THREE.Vector3(0.56, 0.62, 1) : rig.kin === 'powder' ? new THREE.Vector3(0.5, 0.3, 1)
        : new THREE.Vector3(0.62, rig.floor ? 0.34 : 0.42, 1)).normalize();
      const aspect = vw / vh || 4 / 3;
      camera.aspect = aspect;
      const tv = Math.tan((camera.fov * PI / 180) / 2) * 0.94, th = tv * aspect;
      const up = new THREE.Vector3(0, 1, 0);
      const right = new THREE.Vector3().crossVectors(up, dir).normalize();
      const u2 = new THREE.Vector3().crossVectors(dir, right).normalize();
      let D = 0;
      for (const x of [x0, x1]) for (const y of [y0, y1]) for (const z of [z0, z1]) {
        const q = tmpV.set(x, y, z).sub(c);
        const qx = q.dot(right), qy = q.dot(u2), qz = q.dot(dir);
        D = Math.max(D, qz + Math.abs(qy) / tv, qz + Math.abs(qx) / th);
      }
      camera.position.copy(c).addScaledVector(dir, D);
      camera.near = Math.max(10, D * 0.05);
      camera.far = D * 8 + 20000;
      camera.lookAt(c);
      camera.updateProjectionMatrix();
      const radius = Math.max(x1 - x0, y1 - y0, z1 - z0) * 0.75;
      frameInfo = { center: c.clone(), radius, distance: D };
      pxPerMM = vh / (2 * D * Math.tan((camera.fov * PI / 180) / 2));
    }
    v.resize = (w, h) => {
      if (w === vw && h === vh) return;
      vw = Math.max(1, w); vh = Math.max(1, h);
      if (rig) frameCamera();
      part.setResolution(vw, vh);
      v.dirty = true;
    };
    v.setTier = (t) => {
      tier = t;
      if (rig) rig.setTier(t);
      if (room) room.setTier(t);
      part.setTier(t);
      part.setCastShadow(t === 'high');
      v.dirty = true;
    };

    // ---------------------------------------------------------------
    // Part data from the slicer
    // ---------------------------------------------------------------
    function resetJob() {
      jobKey = ''; spec = null; specKey = ''; plans = new Map(); want = new Set(); pre = null; preReq = false;
      lapse = M.createLapse(); shown = null; shownTl = null; prevPlan = null; skirtDone = false;
      seq = null; nestPts = null; faultKind = null; stringsSet = false;
      v.purgeSet = false; v.uvShown = null;
      part.clearPart();
    }
    function loadJob(slot, job) {
      const args = specArgs(slot, job, drawable(printer));
      const key = JSON.stringify(args);
      specKey = key;
      const kin = rig.kin;
      const boundMetal = kin === 'metal';
      look = L.lookFor(job.materialId, job.color, { boundMetal });
      const limit = kin === 'powder' ? 36 : 0;
      slicer.request({ op: 'loft', args, budget: 6000, limit }).then((r) => {
        if (specKey !== key || !r.units) return;
        spec = r.spec;
        part.setPart(r, spec, look, { limit, lines: true });
        part.setCastShadow(tier === 'high');
        part.setResolution(vw, vh);
        v.dirty = true;
        v.setup = true;
      }).catch((e) => { if (specKey === key) console.warn('[Print3D] part mesh failed:', e.message); });
      if (M.NOZZLE_KINDS.has(kin)) {
        preReq = true;
        slicer.request({ op: 'pre', args, autoLevel: printer.autoLevel !== false }).then((r) => { if (specKey === key) pre = r; }).catch(() => {});
      }
      v.args = args;
    }
    function plan(plate, layer) {
      const k = plate * 100000 + layer;
      const p = plans.get(k);
      if (p) return p;
      if (!want.has(k) && spec && v.args) {
        want.add(k);
        const key = specKey;
        slicer.request({ op: 'plan', args: v.args, plate, layer, mjf: rig && rig.t.process === 'mjf', thin: 0.12 }).then((r) => {
          if (specKey !== key) return;
          const pl = r.plan;
          pl.tl = T.timeline(pl);
          plans.set(k, pl);
          // Keep a few: the shown one, the one below it, the next.
          if (plans.size > 8) { const first = plans.keys().next().value; plans.delete(first); want.delete(first); }
        }).catch(() => { want.delete(k); });
      }
      return null;
    }

    // ---------------------------------------------------------------
    // The frame's update
    // ---------------------------------------------------------------
    v.update = (now) => {
      const slot = getSlot();
      if (!slot) return false;
      const state = getState();
      const pr = cat.printer(slot.printerId);
      if (!printer || pr.id !== printer.id) { resetJob(); build(pr); }
      const kind = L.roomFor(state && state.reputation);
      if (kind !== roomKind) setRoom(kind);
      const dt = lastNow ? Math.min(0.1, Math.max(0, (now - lastNow) / 1000)) : 0;
      lastNow = now;
      const t = now / 1000;
      const phase = slot.phase || 'idle';
      const job = slot.job;
      const key = job ? `${job.orderId}|${job.startedAt ?? ''}|${slot.slotId}` : '';
      if (key !== jobKey) {
        resetJob();
        jobKey = key;
        if (job) {
          loadJob(slot, job);
          // A print that has only just started plays its start in real time.
          const sp = clock.speed();
          const realLen = (job.hoursTotal || 0) * clock.secondsPerGameHour / Math.max(1, sp);
          const fresh = ACTIVE.has(phase) && M.printedAt(job, job.hoursElapsed || 0) < 0.03 && !opts.pin;
          const len = fresh ? M.startLength(realLen) : 0;
          if (len > 0) seq = { t0: t, len };
        }
      }
      const kin = rig.kin;
      const nozzleKind = M.NOZZLE_KINDS.has(kin);
      const bed = drawable(printer).buildVolumeMM;
      const resinHex = parseInt(String(look ? look.color : '#8d929a').replace('#', ''), 16);
      // Game hours into the job, smoothed between sim ticks.
      let hours = 0;
      if (job) {
        hours = job.hoursElapsed || 0;
        if (opts.pin && opts.pin.hours != null) hours = opts.pin.hours;
        else if (ACTIVE.has(phase)) hours = Math.min(job.hoursTotal || hours, hours + clock.hoursSinceTick());
      }
      const progress = job ? (phase === 'done' ? 1 : M.printedAt(job, hours)) : 0;
      const fail = job ? M.failureAt(job, phase === 'failed' ? Math.max(hours, (job.fail && job.fail.stopT) || hours) : hours) : { grows: 0, fault: null };
      const faulting = job && job.fail && fail.fault != null && (phase === 'printing' || phase === 'failed');
      const grows = faulting ? fail.grows : progress;
      const stage = seq ? M.startStage(t - seq.t0, seq.len, { nozzle: nozzleKind, autoLevel: printer.autoLevel !== false }) : { stage: 'print', f: 1 };
      if (seq && stage.stage === 'print') seq = null;
      const material = job ? cat.material(job.materialId) : null;
      const targets = M.targetsFor(kin, material);
      animating = false;
      let tip = null, lcdExtra = {};
      const hot = WARM.has(phase);
      const layers = spec ? spec.layers : 0;
      const plates = spec ? spec.plates.length : 1;
      const totalLayers = layers * plates;
      const hpL = spec ? spec.layerH : 0.2;
      const park = M.parkTip(kin, bed, spec ? spec.H : 0);

      // Damp spools string; a dirty bed shows; a worn nozzle dulls.
      const damp = !!(job && nozzleKind && material && material.dampHours55 && Sim.wetOf(state, job.materialId) >= 0.3);
      const dirt = (kin === 'vat' || nozzleKind) && kin !== 'metal' ? clamp01((0.7 - (slot.bed ?? 1)) / 0.4) : 0;
      part.setSmudge(phase === 'cleaning' ? Math.max(dirt, 0.6) * clamp01((slot.timer || 0) / (Sim.BED_CLEAN_HOURS || 0.1)) : dirt, bed);
      rig.setNozzleWear(slot.nozzleHealth ?? 1);
      if (job) rig.setFilament(parseInt(String(look ? look.color : job.color || '#cccccc').replace('#', ''), 16));

      const showLayer = (g) => {
        // Global layer g across plates -> the plate it's on and its layer there.
        const plate = Math.min(plates - 1, Math.floor(g / Math.max(1, layers)));
        part.showPlate(plate);
        return { plate, layer: g - plate * layers };
      };

      if (job && spec && part.hasPart()) {
        if (phase === 'done') {
          part.showPlate(plates - 1);
          part.revealAll();
          part.clearCurrent();
          part.lines.prev.visible = false;
          part.setGlow(true, spec.bounds, spec.H);
          if (kin === 'vat') rig.setPose(M.poseFor('vat', { z: Math.min(bed[2] + 10, spec.H + 60) }));
          else if (nozzleKind) { tip = park; }
          part.setVisible(true);
          if (kin === 'powder') part.setSection(null);
        } else if (phase === 'printing' && stage.stage === 'print' || phase === 'failed' || phase === 'clogged' || phase === 'coldpull') {
          part.setGlow(false);
          const gTrue = M.layerOf(grows, totalLayers);
          const frozen = phase !== 'printing';
          // A pinned view (boards, filmstrips) shows exactly the pinned moment: no running ahead.
          const rate = opts.pin ? 0 : clock.speed() / clock.secondsPerGameHour / Math.max(0.05, job.printHours || job.hoursTotal || 1);
          if (M.lapseDone(lapse, t) || lapse.layer < 0) {
            let g = frozen ? Math.max(gTrue, 0) : M.lapseWant(lapse, t, grows, totalLayers, faulting ? 0 : rate);
            g = Math.min(g, gTrue + (frozen || opts.pin ? 0 : 2), totalLayers - 1);
            if (faulting) g = Math.min(g, M.layerOf(fail.grows, totalLayers));
            const at = showLayer(Math.max(0, g));
            const p = plan(at.plate, at.layer);
            if (at.layer > 0) plan(at.plate, at.layer - 1);
            if (p && (g > lapse.layer || lapse.layer < 0)) {
              const dur = frozen ? 1e9 : M.traceSeconds(kin, p.tl.total);
              M.lapseJump(lapse, t, g, dur);
              lapse.layer = g; lapse.t0 = t; lapse.dur = dur;
              shown = p; shownTl = p.tl;
              shown.plate = at.plate;
              if (nozzleKind) {
                const width = Math.max(1.5, Math.min(5, spec.lineW * pxPerMM * 1.5));
                part.setCurrent(p, look.color, width);
                prevPlan = at.layer > 0 ? plans.get(at.plate * 100000 + at.layer - 1) || null : null;
                part.setPrev(prevPlan, look.color, Math.max(1.2, width * 0.75));
                if (at.layer === 0 && !skirtDone) {
                  // Keep the first layer's skirt on the bed.
                  const sk = { ...p, pen: p.pen.map((x, i) => (x && p.type[i] === T.TYPE.skirt ? 1 : 0)) };
                  part.setStatic('skirt', sk, look.color, width);
                  skirtDone = true;
                }
                if (pre && pre.purge) {
                  if (!part.hasStatic('purge')) part.setStatic('purge', { ...pre.purge, z: hpL, h: hpL }, look.color, width);
                  else part.revealStatic('purge', Infinity);
                }
              }
              if (kin === 'powder') {
                const proc = rig.t.process;
                if (proc !== 'mjf') part.setHatch(p, proc === 'dmls' ? '#fff3c4' : '#fff1d6', Math.max(1.2, 1.8), 0.4);
                part.setSection(p.outline, 0.3, proc === 'mjf' ? '#2b2c30' : proc === 'dmls' ? '#b9b2a6' : '#d9cdb6', 0.85);
                part.lines.hatch.visible = false;
              }
              if (kin === 'vat') part.setSection(null);
            }
          }
          // Where the trace is.
          const f = shown ? (opts.pin && opts.pin.f != null ? opts.pin.f : M.lapseF(lapse, t)) : 0;
          const z0 = shown ? (shown.layer) * hpL : 0;           // bottom of the shown layer
          const zTop = z0 + hpL;
          if (shown && (nozzleKind)) {
            revealZ = z0;
            const h = T.headAt(shown, shownTl, frozen ? (phase === 'printing' ? f : 1) : f);
            const done = h.extruded;
            if (phase === 'printing' && !(faulting && faultKind !== 'warp')) {
              // The segment under the nozzle is drawn up to the nozzle.
              part.revealCurrent(done, h.pen ? { x: h.x, y: h.y } : null);
            } else if (faulting && faultKind === 'warp') part.revealCurrent(done, null);
            else part.revealCurrent(phase === 'failed' ? 0 : done, null);
            tip = { x: h.x, y: h.y, z: zTop };
            if (phase === 'clogged' || phase === 'coldpull' || phase === 'failed') tip = { ...park, z: zTop + 14 };
            v.trace = { layer: shown.layer, plate: shown.plate, f, z0, zTop, h: hpL, head: { x: h.x, y: h.y }, pen: h.pen, step: h.step };
            animating = phase === 'printing';
          } else if (shown && kin === 'vat') {
            const pk = M.peelAt(f, z0 + hpL, 6);
            rig.setPose(M.poseFor('vat', { z: pk.plateZ }));
            rig.setResin(resinHex, !!(pk.uv && phase === 'printing'));
            revealZ = z0 + hpL;
            // The UV flash: the layer's shape glowing on the screen under the vat.
            if (pk.uv && phase === 'printing' && shown.outline.length) {
              if (!v.uvShown || v.uvShown !== shown) {
                part.setSection(shown.outline, 0, '#b48cff', 0.85);
                v.uvShown = shown;
              }
              part.section.visible = true;
            } else part.section.visible = false;
            v.trace = { layer: shown.layer, f, z0, zTop, h: hpL, uv: pk.uv };
            animating = phase === 'printing';
          } else if (shown && kin === 'powder') {
            const proc = rig.t.process;
            const pa = M.powderAt(f, proc);
            const sw = rig.t.powderBed.sweep;
            rig.setRecoater(pa.recoater != null ? sw[0] + (sw[1] - sw[0]) * pa.recoater - rig.t.powderBed.x : (sw[0] - 60 - rig.t.powderBed.x));
            part.setVisible(false);
            const live = phase === 'printing';
            if (proc === 'mjf') {
              part.section.visible = pa.agent > 0.05;
              // The fusing lamp rides the carriage back across: the agent-printed areas glow behind it.
              const lampOn = live && pa.lamp != null && pa.lamp > 0 && pa.lamp < 1;
              if (lampOn) rig.setRecoater(sw[0] + (sw[1] - sw[0]) * (1 - pa.lamp) - rig.t.powderBed.x);
              rig.setFuser(lampOn);
              const heat = pa.lamp != null ? Math.max(0, 1 - Math.abs(pa.lamp - 0.5) * 2.2) : 0;
              part.section.material.color.set(heat > 0 ? new THREE.Color('#2b2c30').lerp(new THREE.Color('#ff9a3c'), heat) : new THREE.Color('#2b2c30'));
            } else {
              const n = part.lines.hatch.userData.count || 0;
              part.revealHatch(Math.floor(n * pa.scan));
              part.section.visible = pa.scan > 0.02;
              part.section.material.opacity = 0.35 + 0.5 * pa.scan;
              // The laser: a beam from the scanner to the spot where the hatch ends (sparks on metal).
              const at = part.hatchTip();
              const scanning = live && !faulting && at && pa.scan > 0.002 && pa.scan < 0.998;
              part.setLaser(scanning, at, rig.t.powderBed.ceiling, proc === 'dmls' ? 0xa8dcff : 0xff5a1f, proc === 'dmls' ? 0xfff6dc : 0xff8a2a);
              if (proc === 'dmls' && scanning) part.setSpecks(M.specks(M.seedOf(jobKey), t), { x: at[0], y: at[1], z: at[2] + 1 }, 3);
              else part.setSpecks(null);
            }
            v.trace = { layer: shown.layer, f, process: proc, recoater: pa.recoater, scan: pa.scan, lamp: pa.lamp };
            animating = phase === 'printing';
          }
          // Failures playing out. A machine that watches its prints spots it before it stops.
          if (faulting && phase === 'printing' && job.fail.detected && fail.fault > 0.15) lcdExtra.suspect = job.fail.kind;
          if (faulting) {
            faultKind = job.fail.kind;
            const ff = phase === 'failed' ? 1 : fail.fault;
            if (faultKind === 'spaghetti') {
              // (Made once the failed layer is known, so it lands on top of the part.)
              if (!nestPts && shown) {
                // The nest piles up on the failed part's top, around where the nozzle was.
                nestSeed = M.seedOf(job.orderId, job.startedAt);
                const b = spec.bounds;
                const hx = v.trace && v.trace.head ? v.trace.head.x : (b[0] + b[2]) / 2, hy = v.trace && v.trace.head ? v.trace.head.y : (b[1] + b[3]) / 2;
                const R = Math.max(16, Math.min(42, Math.hypot(b[2] - b[0], b[3] - b[1]) * 0.3));
                const mx = (b[0] + b[2]) / 2, my = (b[1] + b[3]) / 2;
                const pts = M.spaghetti(nestSeed, M.NEST_POINTS, { radius: R, height: Math.min(16, R * 0.5), cx: mx + (hx - mx) * 0.3, cy: my + (hy - my) * 0.3,
                  base: Math.max(0, zTop - 1), from: [hx, hy, zTop + 6], step: 2.2 });
                nestPts = pts;
                part.setNest(pts, look.color, Math.max(2.2, Math.min(4.5, 1.3 * pxPerMM)));
              }
              if (nestPts) part.revealNest(0.15 + 0.85 * ff);
              const d = M.detachAt(ff * 0.6);
              part.body.rotation.y = d.tilt * 0.5; part.body.position.x = d.slide * 0.5;
            } else if (faultKind === 'detach') {
              const d = M.detachAt(ff);
              part.body.rotation.y = d.tilt; part.body.position.x = d.slide;
            } else if (faultKind === 'warp') {
              part.setWarp(M.warpAt(ff), spec.bounds);
              if (phase === 'failed') { part.body.rotation.y = 0.12; part.body.position.x = 4; }
            } else if (faultKind === 'resin' && kin === 'vat') {
              // Stuck to the film: the cured slab sits in the vat, the plate climbs empty.
              part.body.position.z = Math.max(0, (rig.nodes.plate ? rig.nodes.plate.position.y : 0) + 2 - zTop);
            } else if (faultKind === 'powder' || faultKind === 'metal') {
              part.setStreak(true, bed, 0.6);
            }
          } else if (faultKind) { part.clearFaults(); faultKind = null; nestPts = null; }
        } else if (ACTIVE.has(phase)) {
          // Heating, getting ready, or the start sequence: nothing printed yet.
          revealZ = 0;
          part.setGlow(false);
          part.clearCurrent();
          if (kin === 'vat') rig.setPose(M.poseFor('vat', { z: 40 * (1 - clamp01(stage.f)) + 6 }));
        }
      } else if (job && ACTIVE.has(phase)) {
        part.setGlow(false);
      }

      // Nozzle classes: the start sequence moves the head; otherwise it follows the trace or parks.
      if (nozzleKind) {
        if (seq && ACTIVE.has(phase)) {
          animating = true;
          if (stage.stage === 'heat') tip = { ...park, z: park.z };
          else if (stage.stage === 'probe') {
            const grid = (pre && pre.probe && pre.probe.length) ? pre.probe : T.probeGrid(bed[0], bed[1], spec ? spec.bounds : null, 4);
            const n = grid.length / 2;
            const fi = stage.f * n, i = Math.min(n - 1, Math.floor(fi)), u = fi - i;
            const px = grid[i * 2], py = grid[i * 2 + 1];
            const prevX = i > 0 ? grid[i * 2 - 2] : park.x, prevY = i > 0 ? grid[i * 2 - 1] : park.y;
            const mv = Math.min(1, u / 0.45);
            const x = prevX + (px - prevX) * mv, y = prevY + (py - prevY) * mv;
            const dip = u < 0.45 ? 6 : 6 * Math.abs(Math.cos((u - 0.45) / 0.55 * PI));
            tip = { x, y, z: Math.max(0.4, dip) };
            lcdExtra = { probeIndex: i, probeCount: n };
          } else if (stage.stage === 'purge') {
            const pg = pre && pre.purge;
            if (pg) {
              const ptl = pg.tl || (pg.tl = T.timeline(pg));
              const h = T.headAt(pg, ptl, stage.f);
              tip = { x: h.x, y: h.y, z: hpL };
              if (look) {
                const width = Math.max(1.5, Math.min(5, (spec ? spec.lineW : 0.45) * pxPerMM * 1.5));
                if (!v.purgeSet) { part.setStatic('purge', { ...pg, z: hpL, h: hpL }, look.color, width); v.purgeSet = true; }
                part.revealStatic('purge', h.extruded, h.pen ? { x: h.x, y: h.y } : null);
              }
            } else tip = { x: -bed[0] / 2 + 10, y: -bed[1] / 2 + 6, z: hpL };
          }
        } else if (!tip) {
          tip = phase === 'idle' || phase === 'cleaning' ? { x: 0, y: 0, z: Math.max(20, (spec ? spec.H : 0) + 20) } : { ...park };
          if (phase === 'heating' || phase === 'prep') tip = { ...park };
        }
        if (v.purgeSet && (!job || phase === 'idle')) { part.setStatic('purge', null); v.purgeSet = false; }
        if (tip) {
          lastTip = tip;
          rig.setPose(M.poseFor(kin, tip, { zAxis: rig.zAxis }));
        }
        // Damp filament strings over the part, specks popping at the nozzle.
        if (damp && phase === 'printing' && spec && v.trace) {
          if (!stringsSet || v.stringsLayer !== v.trace.layer) {
            part.setStrings(M.strings(M.seedOf(jobKey, v.trace.layer), spec.bounds, v.trace.z0, 9), look.color, Math.max(1.4, Math.min(2.4, 0.7 * pxPerMM)));
            stringsSet = true; v.stringsLayer = v.trace.layer;
          }
          part.setSpecks(M.specks(M.seedOf(jobKey), t), { x: lastTip.x, y: lastTip.y, z: lastTip.z }, 4);
        } else if (stringsSet) { part.setStrings(null); part.setSpecks(null); stringsSet = false; }
        // A clog leaves a blob on the nozzle.
        if (phase === 'clogged' || phase === 'coldpull') {
          if (!part.blob.parent && rig.nodes.head) { rig.nodes.head.add(part.blob); part.blob.position.set(rig.tipHome[0], rig.tipHome[1] - 2, rig.tipHome[2]); }
          part.blob.visible = true;
          part.blob.material.color.set(look ? look.color : '#cccccc');
          part.blob.scale.setScalar(phase === 'coldpull' ? 0.6 : 1);
        } else part.blob.visible = false;
        rig.spin(dt, phase === 'printing' && stage.stage === 'print' ? 0.9 : phase === 'coldpull' ? -0.5 : 0, hot);
        rig.updateFilament();
      } else if (kin === 'vat' && (!job || phase === 'idle' || phase === 'cleaning')) {
        rig.setPose(M.poseFor('vat', { z: 90 }));
      } else if (kin === 'powder' && phase !== 'printing') {
        rig.setRecoater(rig.t.powderBed.sweep[0] - 60 - rig.t.powderBed.x);
        rig.setFuser(false);
        part.setLaser(false);
        if (phase === 'done' && part.hasPart()) part.setVisible(true);
      }
      if (kin === 'vat' && !(phase === 'printing' && shown)) rig.setResin(resinHex, false);

      // This machine's last part in finishing (washing, curing, cooling, sintering...): its screen
      // says so while it waits, and Metal X's wash station and furnace glow while the part is in them.
      if (state) {
        const mine = (state.stations || []).filter((s) => s.slotId === slot.slotId);
        if (rig.t.stations) {
          const ph = mine.map((s) => s.phases[s.idx] && s.phases[s.idx].id);
          const pulse = 0.55 + 0.25 * Math.sin(t * 2.4);
          stations.wash.material.opacity = ph.includes('wash') ? pulse * 0.8 : 0;
          stations.sinter.material.opacity = ph.includes('sinter') ? pulse : 0;
          if (ph.length && !opts.pin) animating = true;
        }
        if (phase === 'idle' && mine.length) {
          const s = mine[0], cur = s.phases[s.idx];
          lcdExtra.finishing = cur ? { id: cur.id, hoursLeft: s.phases.slice(s.idx).reduce((a, p) => a + p.h, 0) - s.t } : null;
        }
      }

      if (revealZ != null) { rig.root.updateMatrixWorld(true); part.setReveal(revealZ); revealZ = null; }

      // The machine's screen and status light.
      const lcd = M.lcdText({
        kin, phase, stage: seq ? stage.stage : null, stageF: stage.f, targets, progress: grows,
        hoursLeft: job ? Math.max(0, (job.hoursTotal || 0) - hours) : 0, layer: v.trace ? v.trace.layer : 0, layers: layers || 0,
        failKind: job && job.fail ? job.fail.kind : null, model: printer.unknown ? 'Retired machine' : printer.model, damp,
        heatF: job && job.phases && job.phases[0] ? clamp01(hours / Math.max(1e-6, job.phases[0].h)) : 0.5,
        material: material ? (material.label || material.name) : '', bedDirty: dirt > 0.05, nozzleWorn: (slot.nozzleHealth ?? 1) < 0.5,
        ...lcdExtra,
      });
      if (rig.lcd.draw(lcd)) v.dirty = true;
      if (lcd.tone !== lastTone) { rig.setStatus(lcd.tone); lastTone = lcd.tone; v.dirty = true; }
      v.lcd = lcd;
      v.phase = phase;
      v.progress = grows;
      if (seq || (rig.t.stations && animating)) animating = true;
      if (phase === 'clogged' || phase === 'coldpull') animating = animating || hot;
      return animating;
    };

    // Where the nozzle tip is against what it's printing (filmstrip probe).
    v.probe = () => {
      if (!rig || !M.NOZZLE_KINDS.has(rig.kin)) return null;
      scene.updateMatrixWorld(true);
      const tipW = rig.tipWorld(tmpV);
      const local = rig.partAnchor.worldToLocal(tmpW.copy(tipW));
      const tr = v.trace || null;
      return {
        tipWorld: [tipW.x, tipW.y, tipW.z], tipBed: [local.x, local.y, local.z],
        trace: tr, revealTop: tr ? tr.z0 : null, layerH: tr ? tr.h : null, phase: v.phase,
      };
    };
    v.dispose = () => {
      if (rig) rig.dispose();
      if (room) room.dispose();
      part.dispose();
      for (const s of Object.values(stations)) if (s) { s.geometry.dispose(); s.material.dispose(); }
    };
    return v;
  }

  return { view };
}
