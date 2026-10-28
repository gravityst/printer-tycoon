// =====================================================================
// Print3D stage: one WebGL renderer for every printer card, every shop thumbnail and every order's
// part picture.
//
// Each frame, the cards that need drawing (on screen and printing, or changed: idle cards redraw
// at most four times a second) are rendered side by side into one offscreen canvas (an atlas of
// scissored viewports), then each region is copied into its card's own 2D canvas. One context, one
// shadow map, one environment map and one shader cache serve them all, so card 2 is lit exactly
// like card 1, and a shop of 26 machines never runs out of contexts.
//
// Quality steps itself (docs/governor.js): High (pixel ratio up to 2, soft 1024 shadows, clearcoat,
// physical glass), Medium (1.5, 512 shadows, standard materials), Low (1, no shadow map: a baked
// soft shadow, the room as one backdrop). ?quality=high|medium|low pins a tier; ?fps=1 shows
// ms/frame (work plus the GPU's share), tier, draw calls and triangles.
//
// Glass is physical but not transmissive: three.js renders transmission from a copy of the whole
// drawing buffer sampled in canvas coordinates, which an atlas of viewports can't share.
// =====================================================================

export async function createStage(o) {
  const { THREE } = o;
  const q = new URLSearchParams(location.search);
  const pinned = ['low', 'medium', 'high'].includes(q.get('quality')) ? q.get('quality') : null;
  const showFps = q.get('fps') === '1';
  const v = '?v=' + encodeURIComponent(o.build);
  const [M, T, L, G, MachinesMod, RoomsMod, PartsMod, ViewsMod, SlicerMod] = await Promise.all([
    import('./motion.js' + v), import('./toolpath.js' + v), import('./look.js' + v), import('./governor.js' + v), import('./machines.js' + v),
    import('./rooms.js' + v), import('./parts.js' + v), import('./printview.js' + v), import('./slicer.js' + v),
  ]);

  // ---------------------------------------------------------------------
  // The renderer
  // ---------------------------------------------------------------------
  const glCanvas = document.createElement('canvas');
  glCanvas.width = 4; glCanvas.height = 4;
  const renderer = new THREE.WebGLRenderer({ canvas: glCanvas, antialias: true, alpha: false, powerPreference: 'high-performance', preserveDrawingBuffer: false });
  renderer.setPixelRatio(1);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.localClippingEnabled = true;
  renderer.info.autoReset = false;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  const gl = renderer.getContext();
  const maxDim = Math.min(4096, gl.getParameter(gl.MAX_RENDERBUFFER_SIZE) || 4096, (gl.getParameter(gl.MAX_VIEWPORT_DIMS) || [4096])[0]);

  // One environment map for every scene.
  let env = null;
  function makeEnv() {
    const pm = new THREE.PMREMGenerator(renderer);
    pm.compileEquirectangularShader();
    env = pm.fromScene(new o.RoomEnvironment(renderer), 0.04).texture;
    pm.dispose();
  }
  makeEnv();

  // One set of lights, moved into whichever scene is drawing: a warm key that casts the shadow, a
  // cool fill from the window side, and a sky/ground hemisphere.
  const key = new THREE.DirectionalLight(0xffffff, 2.6);
  key.castShadow = true;
  key.shadow.mapSize.set(1024, 1024);
  key.shadow.bias = -0.0004;
  const fill = new THREE.DirectionalLight(0xc8dcff, 0.8);
  const hemi = new THREE.HemisphereLight(0xe8eef6, 0x5a5048, 0.6);
  const lightDir = new THREE.Vector3(0.55, 1.0, 0.62).normalize();
  const fillDir = new THREE.Vector3(-1, 0.45, 0.25).normalize();

  // ---------------------------------------------------------------------
  // Modules that build the scenes
  // ---------------------------------------------------------------------
  const ctx = {
    THREE, M, T, L, mergeGeometries: o.mergeGeometries, RoundedBoxGeometry: o.RoundedBoxGeometry, brandColors: o.brandColors,
    lines: { LineSegments2: o.LineSegments2, LineSegmentsGeometry: o.LineSegmentsGeometry, LineMaterial: o.LineMaterial, Line2: o.Line2, LineGeometry: o.LineGeometry },
  };
  const machines = MachinesMod.createMachines(ctx);
  const rooms = RoomsMod.createRooms(ctx, machines);
  const parts = PartsMod.createParts(ctx);
  const slicer = SlicerMod.createSlicer(o.build);
  const views = ViewsMod.createPrintViews(ctx, { machines, rooms, parts, slicer, Sim: o.Sim, cat: o.cat, clock: o.clock });

  // ---------------------------------------------------------------------
  // Quality tiers
  // ---------------------------------------------------------------------
  const TIER = {
    high: { dpr: 2, shadow: THREE.PCFSoftShadowMap, map: 1024 },
    medium: { dpr: 1.5, shadow: THREE.PCFShadowMap, map: 512 },
    low: { dpr: 1, shadow: null, map: 0 },
  };
  const gov = G.createGovernor({ tier: G.TIERS.indexOf(pinned || 'high') });
  let tier = G.TIERS[gov.tier];
  let compiling = null;
  const tierLog = [];
  function applyTier(name, why) {
    tier = name;
    const t = TIER[name];
    renderer.shadowMap.enabled = !!t.shadow;
    if (t.shadow) renderer.shadowMap.type = t.shadow;
    if (key.shadow.map) { key.shadow.map.dispose(); key.shadow.map = null; }
    key.shadow.mapSize.set(t.map || 512, t.map || 512);
    for (const e of entries.values()) {
      e.view.setTier(name);
      e.view.scene.traverse((ob) => { if (ob.material) (Array.isArray(ob.material) ? ob.material : [ob.material]).forEach((m) => { m.needsUpdate = true; }); });
      sizeEntry(e);
    }
    tierLog.push({ at: +(performance.now() / 1000).toFixed(2), tier: name, why });
    // Compile the new programs off the critical path (the cards', and every class's once the first
    // warm-up is done); cards keep their last picture meanwhile.
    compiling = Promise.all([compileAll(), warm ? warmUp(name) : null]).finally(() => { compiling = null; for (const e of entries.values()) { e.view.dirty = true; e.view.setup = true; } });
  }
  async function compileAll() {
    if (!renderer.compileAsync) return;
    const jobs = [];
    for (const e of entries.values()) { withLights(e.view); jobs.push(compileScene(e.view.scene, e.view.camera)); }
    try { await Promise.all(jobs); } catch (err) { /* compiled synchronously instead */ }
  }
  // three.js (r160) keys a program compiled ahead of time with the clipping-plane count the last
  // draw left behind, not the material's own, so a warm-up after a tier change compiled the wrong
  // variants. Two passes fix it: everything after a draw with no planes, then the clipped part
  // materials (one plane) after a draw with one. Each "draw" is a 1-pixel scissored render.
  const clipProbe = (() => {
    const one = new THREE.Scene();
    const m = new THREE.MeshBasicMaterial({ color: 0x000000 });
    m.clippingPlanes = [new THREE.Plane(new THREE.Vector3(0, -1, 0), 1e6)];
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), m);
    mesh.position.z = -10; mesh.frustumCulled = false;
    one.add(mesh);
    return { none: new THREE.Scene(), one, cam: new THREE.PerspectiveCamera(30, 1, 1, 100) };
  })();
  function leaveClipState(planes) {
    renderer.setScissorTest(true);
    renderer.setScissor(0, 0, 1, 1); renderer.setViewport(0, 0, 1, 1);
    renderer.render(planes ? clipProbe.one : clipProbe.none, clipProbe.cam);
    renderer.setScissorTest(false);
  }
  // A shader the browser can't link (seen once in about 45 loads: WebKit's ANGLE-to-Metal
  // translation rejected a High-tier machine shader) would leave part of a card blank. Instead the
  // stage steps down a tier, after this frame, and never climbs back to the tier that failed.
  renderer.debug.onShaderError = (glc, program) => {
    stats.shaderErrors = (stats.shaderErrors || 0) + 1;
    let info = '';
    try { info = (glc.getProgramInfoLog(program) || '').slice(0, 200); } catch (e) { /* lost context */ }
    console.warn('[Print3D] a shader failed to link at ' + tier + ' quality; stepping down:', info);
    const failed = G.TIERS.indexOf(tier);
    if (failed > 0) setTimeout(() => { const ch = G.capTier(gov, failed - 1, performance.now() / 1000); if (ch) applyTier(G.TIERS[ch.to], 'shader'); }, 0);
  };
  function compileScene(scene, cam) {
    leaveClipState(0);
    const all = renderer.compileAsync(scene, cam);
    const clipped = [];
    scene.traverse((ob) => { const m = ob.material; if (m && !Array.isArray(m) && m.clippingPlanes && m.clippingPlanes.length === 1) clipped.push(ob); });
    if (!clipped.length) return all;
    leaveClipState(1);
    return Promise.all([all, ...clipped.map((ob) => renderer.compileAsync(ob, cam, scene))]);
  }

  // ---------------------------------------------------------------------
  // Cards
  // ---------------------------------------------------------------------
  const entries = new Map();   // canvas -> entry
  let seq = 0;
  let forceAll = false;
  const io = new IntersectionObserver((list) => {
    for (const it of list) { const e = entries.get(it.target); if (e) { e.visible = it.isIntersecting; if (e.visible) e.view.dirty = true; } }
  }, { rootMargin: '64px' });
  const ro = new ResizeObserver((list) => {
    for (const it of list) { const e = entries.get(it.target); if (e) { e.cssW = it.contentRect.width; e.cssH = it.contentRect.height; sizeEntry(e); } }
  });
  function renderDpr() { return Math.min(window.devicePixelRatio || 1, TIER[tier].dpr); }
  function sizeEntry(e) {
    const d = renderDpr();
    const w = Math.max(1, Math.round(e.cssW * d)), h = Math.max(1, Math.round(e.cssH * d));
    if (w !== e.pxW || h !== e.pxH) {
      e.pxW = w; e.pxH = h;
      if (e.canvas.width !== w) e.canvas.width = w;
      if (e.canvas.height !== h) e.canvas.height = h;
      e.view.resize(w, h);
      e.view.dirty = true;
      e.lastRender = -1e9;
    }
  }
  function attach(canvas, getSlot, extra = {}) {
    let e = entries.get(canvas);
    if (e) { e.getSlot = getSlot; return e; }
    const view = views.view({ id: ++seq, getSlot: () => e.getSlot(), getState: o.getState, tier, ...extra });
    view.setTier(tier);
    e = { canvas, ctx2d: canvas.getContext('2d', { alpha: false }), view, getSlot, visible: false, cssW: canvas.clientWidth || 320, cssH: canvas.clientHeight || 240,
      pxW: 0, pxH: 0, lastRender: -1e9, forced: false, rendered: 0 };
    entries.set(canvas, e);
    sizeEntry(e);
    io.observe(canvas);
    ro.observe(canvas);
    return e;
  }
  function detach(canvas) {
    const e = entries.get(canvas);
    if (!e) return;
    io.unobserve(canvas); ro.unobserve(canvas);
    e.view.dispose();
    entries.delete(canvas);
  }
  function clear() { for (const c of [...entries.keys()]) detach(c); }

  // ---------------------------------------------------------------------
  // The frame
  // ---------------------------------------------------------------------
  function withLights(view) {
    const s = view.scene, f = view.frame;
    const lt = view.roomLight || rooms.light('garage');
    if (key.parent !== s) s.add(key, key.target, fill, fill.target, hemi);
    s.environment = env;
    if (f) {
      const r = f.radius;
      key.position.copy(f.center).addScaledVector(lightDir, r * 3.2);
      key.target.position.copy(f.center);
      const cam = key.shadow.camera;
      cam.left = -r * 1.25; cam.right = r * 1.25; cam.top = r * 1.25; cam.bottom = -r * 1.25;
      cam.near = r * 0.6; cam.far = r * 6.5;
      cam.updateProjectionMatrix();
      key.shadow.normalBias = Math.max(0.6, r * 0.0025);
      fill.position.copy(f.center).addScaledVector(fillDir, r * 3);
      fill.target.position.copy(f.center);
    }
    key.color.setHex(lt.key[0]); key.intensity = lt.key[1];
    fill.color.setHex(lt.fill[0]); fill.intensity = lt.fill[1];
    hemi.color.setHex(lt.hemi[0]); hemi.groundColor.setHex(lt.hemi[1]); hemi.intensity = lt.hemi[2];
  }
  // The atlas canvas grows to fit what's due (in steps of 128 px) and shrinks after 5 s mostly unused.
  let atlasW = 0, atlasH = 0, shrinkSince = 0;
  function resizeAtlas(W, H) { atlasW = W; atlasH = H; renderer.setSize(W, H, false); stats.atlas = [W, H]; }
  function ensureAtlas(w, h, now) {
    const needW = Math.min(maxDim, Math.ceil(w / 128) * 128), needH = Math.min(maxDim, Math.ceil(h / 128) * 128);
    if (needW <= atlasW && needH <= atlasH) {
      if (needW * needH < atlasW * atlasH * 0.3) {
        if (!shrinkSince) shrinkSince = now;
        else if (now - shrinkSince > 5000) { shrinkSince = 0; resizeAtlas(needW, needH); }
      } else shrinkSince = 0;
      return;
    }
    shrinkSince = 0;
    resizeAtlas(Math.max(atlasW, needW), Math.max(atlasH, needH));
  }
  // Shelf-pack the due cards; anything that doesn't fit waits for the next frame.
  function pack(list) {
    const placed = [];
    let x = 0, y = 0, rowH = 0;
    const maxW = Math.min(maxDim, Math.max(2048, ...list.map((e) => e.pxW)));
    for (const e of list) {
      if (x + e.pxW > maxW) { x = 0; y += rowH; rowH = 0; }
      if (y + e.pxH > maxDim) break;
      placed.push({ e, x, y });
      x += e.pxW; rowH = Math.max(rowH, e.pxH);
    }
    let w = 0, h = 0;
    for (const p of placed) { w = Math.max(w, p.x + p.e.pxW); h = Math.max(h, p.y + p.e.pxH); }
    return { placed, w, h };
  }

  let lost = false, lastStart = 0, busyMs = 0;
  const intervals = [];
  const stats = { frames: 0, drawn: 0, workMs: 0, gpuMs: 0, costMs: 0, calls: 0, triangles: 0, thumbs: 0, lastDue: 0 };
  let rrCursor = 0;
  // GPU time, for the governor. The tiers mostly change GPU work (pixel ratio, shadow maps), which
  // the time spent issuing draw calls doesn't show, so every PROBE_EVERY drawing frames the stage
  // waits for the GPU once (a 1-pixel read) and keeps a running GPU cost per megapixel drawn.
  const PROBE_EVERY = 10;
  const probePx = new Uint8Array(4);
  let gpuPerMpx = 0, probeIn = 1;
  // Setup isn't frame cost: until the up-front compile is done (and 2 s after), and on a frame that
  // draws a card for the first time, at a new size or with a rebuilt scene (new buffers to upload),
  // the governor looks away, and the gap after such a frame isn't counted as a late frame either.
  let warm = false, settledAt = Infinity, prevSetup = true, prevDrawn = 0;
  function frame(now = performance.now()) {
    const t0 = performance.now();
    if (busyMs > 0) { const until = t0 + busyMs; while (performance.now() < until) { /* injected load (debug) */ } }
    const interval = lastStart ? now - lastStart : 0;
    lastStart = now;
    renderer.info.reset();
    let workMs = 0, drawn = 0, gpuMs = 0, setup = !warm || now < settledAt;
    if (!lost && !compiling) {
      // Which cards need drawing.
      const due = [];
      for (const e of entries.values()) {
        if (!(e.visible || forceAll || e.forced)) continue;
        if (e.pxW < 2 || e.pxH < 2) continue;
        const anim = e.view.update(now);
        const stale = now - e.lastRender;
        if (anim || e.forced || (e.view.dirty && (stale >= 250 || e.rendered === 0))) due.push(e);
      }
      if (due.length) {
        // Round-robin start so a long list shares the atlas fairly.
        const order = due.length > 1 ? due.slice(rrCursor % due.length).concat(due.slice(0, rrCursor % due.length)) : due;
        const { placed, w, h } = pack(order);
        rrCursor += placed.length;
        ensureAtlas(w, h, now);
        renderer.setScissorTest(true);
        for (const p of placed) {
          const e = p.e, vw = e.view;
          if (e.rendered === 0 || e.lastRender < 0 || vw.setup) setup = true;
          vw.setup = false;
          const y = atlasH - p.y - e.pxH;
          renderer.setViewport(p.x, y, e.pxW, e.pxH);
          renderer.setScissor(p.x, y, e.pxW, e.pxH);
          withLights(vw);
          const c0 = renderer.info.render.calls, t0r = renderer.info.render.triangles;
          renderer.render(vw.scene, vw.camera);
          vw.info = { calls: renderer.info.render.calls - c0, triangles: renderer.info.render.triangles - t0r };
        }
        renderer.setScissorTest(false);
        let mpx = 0;
        for (const p of placed) mpx += (p.e.pxW * p.e.pxH) / 1e6;
        if ((!pinned || fpsEl) && --probeIn <= 0) {
          // The wait lands inside this frame's work time; other frames add the running estimate.
          probeIn = PROBE_EVERY;
          const w0 = performance.now();
          gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, probePx);
          const rate = (performance.now() - w0) / Math.max(0.05, mpx);
          gpuPerMpx = gpuPerMpx ? gpuPerMpx * 0.6 + rate * 0.4 : rate;
        } else gpuMs = gpuPerMpx * mpx;
        for (const p of placed) {
          const e = p.e;
          e.ctx2d.drawImage(glCanvas, p.x, p.y, e.pxW, e.pxH, 0, 0, e.pxW, e.pxH);
          e.lastRender = now; e.rendered++; e.view.dirty = false; e.forced = false;
          drawn++;
        }
        stats.lastDue = due.length;
      }
      workMs = performance.now() - t0;
      // Thumbnails ride along when the frame has room (one-off work: setup, not frame cost).
      if (thumbQueue.length && workMs < 7 && runThumbs(t0, 9)) setup = true;
    }
    const cost = workMs + gpuMs;
    stats.frames++; stats.drawn = drawn; stats.workMs = workMs; stats.gpuMs = gpuMs; stats.costMs = cost;
    stats.calls = renderer.info.render.calls; stats.triangles = renderer.info.render.triangles;
    // The governor sees the frame's cost (its work plus the GPU's share), or the gap before it when
    // the frame came at least a refresh late (G.frameSample); a hidden page counts for nothing.
    if (interval > 0) { intervals.push(interval); if (intervals.length > 60) intervals.shift(); }
    if (!document.hidden && !pinned && !compiling && entries.size && !setup) {
      const ch = G.sample(gov, now / 1000, G.frameSample(intervals, prevSetup ? 0 : interval, cost, prevDrawn > 0));
      if (ch && ch.changed) applyTier(G.TIERS[ch.to], ch.why);
    }
    prevSetup = setup; prevDrawn = drawn;
    stats.setup = setup;
    if (fpsEl && now - fpsAt > 250) drawFps(now);
    return workMs;
  }

  // ---------------------------------------------------------------------
  // Thumbnails: shop machines and order parts, a few per frame within a time budget, cached as blob URLs
  // ---------------------------------------------------------------------
  const thumbCache = new Map();   // key -> Promise<url>
  const thumbQueue = [];
  const thumbScene = new THREE.Scene();
  thumbScene.background = new THREE.Color(0x24252b);
  const thumbCam = new THREE.PerspectiveCamera(30, 4 / 3, 10, 60000);
  const thumbView = { scene: thumbScene, camera: thumbCam, frame: null, roomLight: rooms.light('studio') };
  const floorMat = new THREE.MeshStandardMaterial({ color: 0x3a3b42, roughness: 0.8, metalness: 0 });
  const floor = new THREE.Mesh(new THREE.CircleGeometry(1, 48).rotateX(-Math.PI / 2), floorMat);
  floor.receiveShadow = true;
  thumbScene.add(floor);
  function frameThumb(box, w, h, dir = new THREE.Vector3(0.62, 0.48, 1)) {
    const c = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const d = dir.clone().normalize();
    thumbCam.aspect = w / h;
    const tv = Math.tan((thumbCam.fov * Math.PI / 180) / 2) * 0.9, th = tv * thumbCam.aspect;
    const up = new THREE.Vector3(0, 1, 0), right = new THREE.Vector3().crossVectors(up, d).normalize(), u2 = new THREE.Vector3().crossVectors(d, right).normalize();
    let D = 0;
    const p = new THREE.Vector3();
    for (const x of [box.min.x, box.max.x]) for (const y of [box.min.y, box.max.y]) for (const z of [box.min.z, box.max.z]) {
      p.set(x, y, z).sub(c);
      D = Math.max(D, p.dot(d) + Math.abs(p.dot(u2)) / tv, p.dot(d) + Math.abs(p.dot(right)) / th);
    }
    thumbCam.position.copy(c).addScaledVector(d, D);
    thumbCam.near = Math.max(1, D * 0.05); thumbCam.far = D * 10 + 1000;
    thumbCam.lookAt(c);
    thumbCam.updateProjectionMatrix();
    const r = Math.max(size.x, size.y, size.z) * 0.8;
    floor.scale.set(r * 2.2, 1, r * 2.2);
    floor.position.set(c.x, box.min.y - 0.5, c.z);
    thumbView.frame = { center: c, radius: r };
  }
  // One job at a time while the frame has time left (a machine never drawn before builds its model
  // first, about 10-15 ms). A job waits at least one frame after it was queued, so the frame that
  // lays out a list that has just opened (the shop, new orders) never also renders its pictures.
  function runThumbs(t0, budgetMs) {
    let n = 0;
    while (thumbQueue.length && thumbQueue[0].after < stats.frames && performance.now() - t0 < budgetMs) {
      const job = thumbQueue.shift();
      try { job.run(); } catch (err) { job.reject(err); }
      n++;
    }
    return n;
  }
  function renderThumb(subject, box, w, h) {
    thumbScene.add(subject);
    frameThumb(box, w, h);
    ensureAtlas(w, h, performance.now());
    renderer.setScissorTest(true);
    const y = atlasH - h;
    renderer.setViewport(0, y, w, h);
    renderer.setScissor(0, y, w, h);
    withLights(thumbView);
    renderer.render(thumbScene, thumbCam);
    renderer.setScissorTest(false);
    const cv = document.createElement('canvas');
    cv.width = w; cv.height = h;
    cv.getContext('2d', { alpha: false }).drawImage(glCanvas, 0, 0, w, h, 0, 0, w, h);
    thumbScene.remove(subject);
    stats.thumbs++;
    return new Promise((res) => cv.toBlob((b) => res(b ? URL.createObjectURL(b) : cv.toDataURL('image/jpeg', 0.85)), 'image/jpeg', 0.86));
  }
  function printerThumb(printer, cssW = 96, cssH = 72) {
    const d = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.round(cssW * d), h = Math.round(cssH * d);
    const k = `printer|${printer.id}|${w}x${h}`;
    if (thumbCache.has(k)) return thumbCache.get(k);
    const p = new Promise((resolve, reject) => {
      thumbQueue.push({
        reject, after: stats.frames,
        run() {
          const dp = printer.unknown ? { ...printer, tech: 'FDM', kinematics: 'bedslinger', buildVolumeMM: [220, 220, 250], footprintMM: [410, 366] } : printer;
          const rig = machines.rig(dp, tier === 'low' ? 'medium' : tier);
          rig.setStatus('idle');
          rig.lcd.draw({ title: 'Ready', line: printer.model || '', tone: 'idle', bar: null });
          const [x0, y0, z0, x1, y1, z1] = rig.bounds;
          const box = new THREE.Box3(new THREE.Vector3(x0, y0, z0), new THREE.Vector3(x1, y1, z1));
          renderThumb(rig.root, box, w, h).then((url) => { rig.dispose(); resolve(url); }, reject);
        },
      });
    });
    thumbCache.set(k, p);
    return p;
  }
  // A part as an order card shows it: the order's own size, in its material and colour, on a disc.
  // opts.hero: a gallery tile (each part gets its own full budget, 8k triangles).
  const thumbInfo = new Map();   // key -> { triangles, units, copies } (for the harness)
  function partThumb(order, cssW = 64, cssH = 48, opts = {}) {
    const d = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.round(cssW * d), h = Math.round(cssH * d);
    const look = L.lookFor(order.materialId, order.color);
    const k = `part|${order.productId}|${look.finishId}|${look.color}|${w}x${h}${opts.hero ? '|hero' : ''}`;
    if (thumbCache.has(k)) return thumbCache.get(k);
    const product = o.cat.product(order.productId);
    const pick = (o.cat.printers || []).filter((pr) => product && product.tech.includes(pr.tech) && pr.buildVolumeMM.every((x, i) => x >= ((product.minBuildVolumeMM || [])[i] || 0)))
      .sort((a, b) => a.buildVolumeMM[0] * a.buildVolumeMM[1] - b.buildVolumeMM[0] * b.buildVolumeMM[1])[0];
    const args = { productId: order.productId, heightMM: order.heightMM || 40, grams: order.grams || 50, density: L.densityOf(order.materialId),
      bedMM: pick ? pick.buildVolumeMM : [256, 256, 256], tech: pick ? pick.tech : 'FDM', nozzleMM: 0.4 };
    const p = slicer.request({ op: 'loft', args, budget: opts.hero ? 8000 : 3000, hero: !!opts.hero, limit: 9 }).then((r) => new Promise((resolve, reject) => {
      thumbQueue.push({
        reject, after: stats.frames,
        run() {
          const prig = parts.rig(tier === 'low' ? 'medium' : tier);
          prig.setPart(r, r.spec, look, { limit: 9 });
          prig.revealAll();
          prig.setResolution(w, h);
          const holder = new THREE.Group();
          holder.rotation.x = -Math.PI / 2;
          holder.add(prig.root);
          holder.updateMatrixWorld(true);
          const box = new THREE.Box3().setFromObject(prig.body);
          if (box.isEmpty()) box.set(new THREE.Vector3(-20, 0, -20), new THREE.Vector3(20, 20, 20));
          thumbInfo.set(k, { triangles: prig.triangles(), units: Object.fromEntries(Object.entries(r.units).map(([n, u]) => [n, u.triangles])), copies: r.spec.plates[0].length });
          renderThumb(holder, box, w, h).then((url) => { prig.dispose(); resolve(url); }, reject);
        },
      });
    }));
    thumbCache.set(k, p);
    p.catch(() => thumbCache.delete(k));
    return p;
  }

  // ---------------------------------------------------------------------
  // Compile every machine class up front (and again for each new tier), so buying a new kind of
  // printer never hitches. One of each is kept (off stage): three.js deletes a program when the
  // last material using it is disposed, so throwing the warm-up away would undo it.
  // ---------------------------------------------------------------------
  let warmKept = null;
  async function warmUp(forTier = tier) {
    const scene = new THREE.Scene();
    const reps = {};
    for (const p of o.cat.printers || []) { const k = M.kinematicsOf(p) + '|' + p.tech; if (!reps[k]) reps[k] = p; }
    const made = [];
    for (const p of Object.values(reps)) { const r = machines.rig(p, forTier); scene.add(r.root); made.push(r); }
    for (const kind of L.ROOMS) { const rm = rooms.room(kind, { w: 400, d: 400, h: 450, floor: false }, forTier); scene.add(rm.group); made.push(rm); }
    const pr = parts.rig(forTier);
    const box = new THREE.BoxGeometry(10, 10, 10);
    const fake = { units: { part: { positions: box.attributes.position.array, normals: box.attributes.normal.array, index: box.index.array, caps: [] } } };
    const fakeSpec = { layerH: 0.2, plates: [[{ unit: 'part', x: 0, y: 0, a: 0, mirror: false, z0: 0 }, { unit: 'part', x: 20, y: 0, a: 0, mirror: true, z0: 0 }]] };
    pr.setPart(fake, fakeSpec, L.lookFor('pla', '#c62d2d'), {});
    pr.setStatic('skirt', { pts: Float32Array.from([0, 0, 10, 0]), pen: Uint8Array.from([1]), type: Uint8Array.from([0]), z: 0.2, h: 0.2 }, '#c62d2d', 2);
    pr.setNest(Float32Array.from([0, 0, 0, 1, 1, 1, 2, 0, 2]), '#c62d2d', 2);
    pr.setSpecks(new Float32Array(24), { x: 0, y: 0, z: 0 }, 3);
    pr.setSection([Float32Array.from([0, 0, 10, 0, 10, 10, 0, 10])], 0, '#ffffff');
    pr.setGlow(true, [0, 0, 10, 10], 10);
    pr.setSmudge(0.5, [100, 100]);
    try {
      pr.setLaser(true, [0, 0, 1], 100, 0xff5a1f, 0xff8a2a);
      pr.setStreak(true, [200, 200, 200], 0.6);
    } catch (e) { /* drawn the first time instead */ }
    pr.root.add(pr.section);
    scene.add(pr.root);
    const cam = new THREE.PerspectiveCamera(30, 4 / 3, 10, 60000);
    cam.position.set(800, 800, 1600); cam.lookAt(0, 0, 0);
    const holder = { scene, camera: cam, frame: { center: new THREE.Vector3(), radius: 400 }, roomLight: rooms.light('garage') };
    withLights(holder);
    const t0 = performance.now();
    try { if (renderer.compileAsync) await compileScene(scene, cam); else renderer.compile(scene, cam); } catch (e) { /* first renders compile instead */ }
    stats.warmUpMs = +(performance.now() - t0).toFixed(1);
    stats.programs = renderer.info.programs ? renderer.info.programs.length : null;
    for (const r of made) scene.remove(r.root || r.group);
    scene.remove(pr.root);
    // Keep this tier's set; the previous tier's goes (its programs stay while cards still use them).
    const old = warmKept;
    warmKept = { made, pr, box };
    if (old) { for (const r of old.made) r.dispose(); old.pr.dispose(); old.box.dispose(); }
  }

  // ---------------------------------------------------------------------
  // Context loss: cards keep their last picture; everything is rebuilt when the context returns.
  // ---------------------------------------------------------------------
  glCanvas.addEventListener('webglcontextlost', (ev) => { ev.preventDefault(); lost = true; stats.lostCount = (stats.lostCount || 0) + 1; });
  glCanvas.addEventListener('webglcontextrestored', () => {
    lost = false;
    makeEnv();
    atlasW = atlasH = 0;
    if (key.shadow.map) { key.shadow.map.dispose(); key.shadow.map = null; }
    for (const e of entries.values()) e.view.dirty = true;
  });

  // ---------------------------------------------------------------------
  // ?fps=1
  // ---------------------------------------------------------------------
  let fpsEl = null, fpsAt = 0;
  if (showFps) {
    fpsEl = document.createElement('div');
    fpsEl.id = 'fpsReadout';
    fpsEl.setAttribute('aria-hidden', 'true');
    document.body.appendChild(fpsEl);
  }
  const fpsHist = [];
  function drawFps(now) {
    fpsAt = now;
    fpsHist.push(stats.costMs); if (fpsHist.length > 30) fpsHist.shift();
    const mean = fpsHist.reduce((a, b) => a + b, 0) / fpsHist.length;
    let calls = 0, tris = 0;
    for (const e of entries.values()) if (e.view.info && (e.visible || forceAll)) { calls += e.view.info.calls; tris += e.view.info.triangles; }
    const vis = [...entries.values()].filter((e) => e.visible || forceAll).length;
    fpsEl.textContent = `${mean.toFixed(1)} ms/frame · ${tier}${pinned ? ' (pinned)' : ''} · ${calls} calls · ${(tris / 1000).toFixed(1)}k tris · ${vis}/${entries.size} on screen`;
  }

  if (pinned) applyTier(pinned, 'pinned');
  const ready = warmUp();
  // The page's own start-up (catalogs, lists, workers) settles for 2 s before the governor watches.
  const settle = () => { warm = true; settledAt = performance.now() + 2000; };
  ready.then(settle, settle);

  // ---------------------------------------------------------------------
  // Debug hooks for the harness (read-only for the game)
  // ---------------------------------------------------------------------
  const px = new Uint8Array(4);
  const debug = {
    renderer, machines, rooms, parts, slicer, M, T, L, entries, gov, stats, tierLog,
    get tier() { return tier; },
    forceAllVisible(on) { forceAll = !!on; for (const e of entries.values()) e.view.dirty = true; },
    busy(ms) { busyMs = Math.max(0, +ms || 0); },
    sync() {
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
      let last = null;
      for (const e of entries.values()) if (e.rendered) last = e;
      if (last) last.ctx2d.getImageData(0, 0, 1, 1);
    },
    setTier(name) { if (TIER[name]) { G.setTier(gov, G.TIERS.indexOf(name), performance.now() / 1000); applyTier(name, 'debug'); } return compiling || Promise.resolve(); },
    compiling: () => !!compiling,
    list() {
      return [...entries.values()].map((e) => ({ id: e.view.id, printer: e.view.printerId, visible: e.visible, px: [e.pxW, e.pxH], rendered: e.rendered, phase: e.view.phase,
        info: e.view.info, lcd: e.view.lcd ? e.view.lcd.title : null, kit: e.view.rig ? e.view.rig.triangles : null, part: e.view.part ? e.view.part.triangles() : 0,
        room: e.view.room ? e.view.room.triangles : 0 }));
    },
    // Is every card lit by the shared environment map (uploaded in this one context)?
    envProbe() {
      const tex = env && renderer.properties.get(env);
      const uploaded = !!(tex && tex.__webglTexture);
      return [...entries.values()].map((e) => {
        let lum = null;
        try { const d = e.ctx2d.getImageData(Math.floor(e.pxW * 0.5), Math.floor(e.pxH * 0.45), 8, 8).data; let s = 0; for (let i = 0; i < d.length; i += 4) s += 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]; lum = +(s / (d.length / 4)).toFixed(1); } catch (err) { lum = null; }
        return { id: e.view.id, printer: e.view.printerId, env: e.view.scene.environment === env && uploaded, rendered: e.rendered, lum };
      });
    },
    probe(i) { const e = [...entries.values()][i]; return e ? e.view.probe() : null; },
    view(i) { const e = [...entries.values()][i]; return e ? e.view : null; },
    contexts: () => 1,
    lost: () => lost,
    loseContext() { const ext = gl.getExtension('WEBGL_lose_context'); if (ext) { ext.loseContext(); setTimeout(() => ext.restoreContext(), 300); } },
    thumbs: () => ({ cached: thumbCache.size, queued: thumbQueue.length, made: stats.thumbs }),
    thumbInfo: (k) => (k ? thumbInfo.get(k) : Object.fromEntries(thumbInfo)),
    governor: () => G.summary(gov),
  };
  window.__print3dStage = debug;

  return { attach, detach, clear, frame, printerThumb, partThumb, ready, debug, get tier() { return tier; }, entries };
}
