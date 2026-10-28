// =====================================================================
// Print3D parts: the part on the plate, in its material, revealed layer by layer.
//
// Meshes come from the slicer worker (lofted from the same cross-sections the toolpath prints);
// caps are triangulated here. A batch is instanced. A clipping plane hides everything above the
// layer being printed, so the open top shows the walls (dark inside faces) and, on FDM, the last
// layer's infill drawn as lines under the layer being laid (a fat line in the filament's colour).
// Layer lines are in the shader: each wall gets a bead per layer that tilts the normal and darkens
// the seams, fading out when a layer is thinner than a couple of pixels.
//
// createParts(ctx) -> { geometry(loftUnit), material(look, tier), rig(), dispose }
//   ctx: { THREE, lines: { LineSegments2, LineSegmentsGeometry, LineMaterial, Line2, LineGeometry }, M }
// =====================================================================

export function createParts(ctx) {
  const { THREE, M } = ctx;
  const { LineSegments2, LineSegmentsGeometry, LineMaterial, Line2, LineGeometry } = ctx.lines;
  const PI = Math.PI;
  const tmpC = new THREE.Color();

  // ---------------------------------------------------------------------
  // Geometry from a lofted unit: walls as given, caps triangulated (earcut, via ShapeUtils).
  // ---------------------------------------------------------------------
  function geometry(u, mirror = false) {
    const pos = Array.from(u.positions), nor = Array.from(u.normals), idx = Array.from(u.index);
    for (const c of u.caps) {
      const toV = (a) => { const out = []; for (let i = 0; i < a.length; i += 2) out.push(new THREE.Vector2(a[i], a[i + 1])); return out; };
      const contour = toV(c.outer), holes = c.holes.map(toV);
      let faces;
      try { faces = THREE.ShapeUtils.triangulateShape(contour, holes); } catch (e) { continue; }
      const pts = contour.concat(...holes);
      const base = pos.length / 3;
      for (const p of pts) { pos.push(p.x, p.y, c.z); nor.push(0, 0, c.dir); }
      for (const [a, b, cc] of faces) {
        const pa = pts[a], pb = pts[b], pc = pts[cc];
        const s = (pb.x - pa.x) * (pc.y - pa.y) - (pb.y - pa.y) * (pc.x - pa.x);
        if ((s > 0) === (c.dir > 0)) idx.push(base + a, base + b, base + cc); else idx.push(base + a, base + cc, base + b);
      }
    }
    if (mirror) {
      for (let i = 0; i < pos.length; i += 3) { pos[i] = -pos[i]; nor[i] = -nor[i]; }
      for (let i = 0; i < idx.length; i += 3) { const t = idx[i + 1]; idx[i + 1] = idx[i + 2]; idx[i + 2] = t; }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
    g.setIndex(pos.length / 3 > 65535 ? new THREE.Uint32BufferAttribute(idx, 1) : new THREE.Uint16BufferAttribute(idx, 1));
    g.computeBoundingBox();
    g.computeBoundingSphere();
    return g;
  }

  // ---------------------------------------------------------------------
  // Materials: one program per tier (physical on High, standard below); finish and colour are
  // uniforms, so every part shares it.
  // ---------------------------------------------------------------------
  function material(look, tier = 'high', opts = {}) {
    const high = tier === 'high';
    const params = {
      color: new THREE.Color(look.color), roughness: look.roughness ?? 0.5, metalness: look.metalness ?? 0,
      side: THREE.DoubleSide, transparent: (look.opacity ?? 1) < 1, opacity: look.opacity ?? 1, envMapIntensity: 1,
    };
    const m = high ? new THREE.MeshPhysicalMaterial({ ...params, clearcoat: Math.max(0.001, look.clearcoat || 0), clearcoatRoughness: look.clearcoatRoughness ?? 0.3 })
      : new THREE.MeshStandardMaterial(params);
    const u = {
      uLayerH: { value: opts.layerH || 0.2 }, uLines: { value: opts.lines === false ? 0 : 1 }, uGrain: { value: look.grain || look.speckle || 0 },
      uWarp: { value: 0 }, uWarpBox: { value: new THREE.Vector4(0, 0, 50, 6) }, uInside: { value: 0.3 },
    };
    m.userData.u = u;
    m.clippingPlanes = [opts.plane || new THREE.Plane(new THREE.Vector3(0, -1, 0), 1e6)];
    m.clipShadows = true;
    m.onBeforeCompile = (sh) => {
      Object.assign(sh.uniforms, u);
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', `#include <common>
          varying vec3 vPartP;
          varying vec3 vUpView;
          uniform float uWarp;
          uniform vec4 uWarpBox;`)
        .replace('#include <begin_vertex>', `#include <begin_vertex>
          vec4 pp = vec4(transformed, 1.0);
          #ifdef USE_INSTANCING
            pp = instanceMatrix * pp;
          #endif
          if (uWarp > 0.0) {
            float rr = length(pp.xy - uWarpBox.xy) / max(1.0, uWarpBox.z);
            float lift = uWarp * uWarpBox.w * smoothstep(0.55, 1.0, rr) * (1.0 - smoothstep(0.0, 8.0, pp.z));
            transformed.z += lift;
            pp.z += lift;
          }
          vPartP = pp.xyz;
          vUpView = normalize(normalMatrix * vec3(0.0, 0.0, 1.0));`);
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', `#include <common>
          varying vec3 vPartP;
          varying vec3 vUpView;
          uniform float uLayerH;
          uniform float uLines;
          uniform float uGrain;
          uniform float uInside;
          float p3dHash(vec3 p) { return fract(sin(dot(p, vec3(12.9898, 78.233, 37.719))) * 43758.5453); }`)
        .replace('#include <color_fragment>', `#include <color_fragment>
          if (uGrain > 0.0) diffuseColor.rgb *= 1.0 - uGrain * 0.22 * p3dHash(floor(vPartP * 3.0));
          if (!gl_FrontFacing) diffuseColor.rgb *= uInside;`)
        .replace('#include <normal_fragment_begin>', `#include <normal_fragment_begin>
          if (uLines > 0.0) {
            float zl = vPartP.z / uLayerH;
            float lw = fwidth(zl);
            float fade = 1.0 - smoothstep(0.22, 0.65, lw);
            float side = 1.0 - abs(dot(normal, vUpView));
            float tt = fract(zl) * 2.0 - 1.0;
            float bead = sqrt(max(0.0, 1.0 - tt * tt));
            float k = fade * side * uLines;
            normal = normalize(normal + vUpView * clamp(tt / max(0.25, bead), -2.0, 2.0) * 0.32 * k);
            diffuseColor.rgb *= mix(1.0, 0.7 + 0.3 * bead, k);
          }`);
    };
    m.customProgramCacheKey = () => 'p3d-part-' + (high ? 'h' : 's');
    return m;
  }
  function setLook(m, look) {
    m.color.set(look.color);
    m.roughness = look.roughness ?? 0.5;
    m.metalness = look.metalness ?? 0;
    m.opacity = look.opacity ?? 1;
    m.transparent = m.opacity < 1;
    if (m.isMeshPhysicalMaterial) { m.clearcoat = Math.max(0.001, look.clearcoat || 0); m.clearcoatRoughness = look.clearcoatRoughness ?? 0.3; }
    m.userData.u.uGrain.value = look.grain || look.speckle || 0;
  }

  // ---------------------------------------------------------------------
  // Fat lines
  // ---------------------------------------------------------------------
  function lineMaterial(width = 2, opts = {}) {
    const m = new LineMaterial({ linewidth: width, vertexColors: true, worldUnits: false, dashed: false, transparent: !!opts.transparent, opacity: opts.opacity ?? 1 });
    m.clippingPlanes = opts.plane ? [opts.plane] : null;
    return m;
  }
  function segs() {
    const g = new LineSegmentsGeometry();
    const l = new LineSegments2(g, lineMaterial());
    l.frustumCulled = false;
    l.visible = false;
    return l;
  }
  // Colours per toolpath type, as multipliers of the filament colour: outer walls brightest.
  const TYPE_SHADE = [1.0, 0.86, 0.72, 0.9, 0.95, 1.0];

  // A layer plan's extrusion segments as [x1,y1,z1,x2,y2,z2,...] at height z, with colours.
  function planSegments(plan, z, hex, shade = 1, typesShade = TYPE_SHADE) {
    const n = plan.pen.length;
    let k = 0;
    for (let i = 0; i < n; i++) if (plan.pen[i]) k++;
    const pos = new Float32Array(k * 6), col = new Float32Array(k * 6);
    tmpC.set(hex);
    const r = tmpC.r, g = tmpC.g, b = tmpC.b;
    let j = 0;
    for (let i = 0; i < n; i++) {
      if (!plan.pen[i]) continue;
      pos[j] = plan.pts[i * 2]; pos[j + 1] = plan.pts[i * 2 + 1]; pos[j + 2] = z;
      pos[j + 3] = plan.pts[i * 2 + 2]; pos[j + 4] = plan.pts[i * 2 + 3]; pos[j + 5] = z;
      const s = shade * (typesShade[plan.type[i]] ?? 1);
      col[j] = col[j + 3] = r * s; col[j + 1] = col[j + 4] = g * s; col[j + 2] = col[j + 5] = b * s;
      j += 6;
    }
    return { pos, col, count: k };
  }
  function fill(line, pos, col) {
    const g = new LineSegmentsGeometry();
    if (pos.length) { g.setPositions(pos); g.setColors(col); }
    line.geometry.dispose();
    line.geometry = g;
    line.visible = pos.length > 0;
    return g;
  }

  // Islands of an outline (outer loops CCW, holes CW) triangulated into one flat mesh at z.
  function sectionGeometry(loops, z = 0) {
    const area = (l) => { let a = 0; for (let i = 0, n = l.length / 2, j = n - 1; i < n; j = i++) a += l[j * 2] * l[i * 2 + 1] - l[i * 2] * l[j * 2 + 1]; return a / 2; };
    const inside = (l, x, y) => { let c = false; for (let i = 0, n = l.length / 2, j = n - 1; i < n; j = i++) { const xi = l[i * 2], yi = l[i * 2 + 1], xj = l[j * 2], yj = l[j * 2 + 1]; if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) c = !c; } return c; };
    const outers = [], holes = [];
    for (const l of loops) (area(l) >= 0 ? outers : holes).push(l);
    const isl = outers.map((o) => ({ o, h: [] }));
    for (const h of holes) { const I = isl.find((x) => inside(x.o, h[0], h[1])); if (I) I.h.push(h); }
    const pos = [], idx = [];
    const toV = (a) => { const out = []; for (let i = 0; i < a.length; i += 2) out.push(new THREE.Vector2(a[i], a[i + 1])); return out; };
    for (const I of isl) {
      const c = toV(I.o), hs = I.h.map(toV);
      let faces;
      try { faces = THREE.ShapeUtils.triangulateShape(c, hs); } catch (e) { continue; }
      const pts = c.concat(...hs), base = pos.length / 3;
      for (const p of pts) pos.push(p.x, p.y, z);
      for (const f of faces) idx.push(base + f[0], base + f[1], base + f[2]);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    return g;
  }

  // A smudged-bed decal (fingerprints and glue), drawn once.
  const smudgeTex = (() => {
    const cv = document.createElement('canvas');
    cv.width = cv.height = 256;
    const g = cv.getContext('2d');
    const r = M.rng(2024);
    for (let i = 0; i < 26; i++) {
      const x = 30 + r() * 196, y = 30 + r() * 196, s = 10 + r() * 34;
      const grd = g.createRadialGradient(x, y, 1, x, y, s);
      grd.addColorStop(0, 'rgba(255,255,255,0.55)');
      grd.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = grd;
      g.beginPath(); g.ellipse(x, y, s, s * (0.5 + r() * 0.5), r() * PI, 0, 2 * PI); g.fill();
    }
    g.strokeStyle = 'rgba(255,255,255,0.35)';
    g.lineWidth = 1.5;
    for (let i = 0; i < 6; i++) {
      const x = 60 + r() * 136, y = 60 + r() * 136;
      for (let k = 0; k < 7; k++) { g.beginPath(); g.ellipse(x, y, 4 + k * 2.2, 3 + k * 1.7, 0.4, 0, 2 * PI); g.stroke(); }
    }
    const t = new THREE.CanvasTexture(cv);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  })();

  // A soft round dot (the laser's spot, sparks).
  const dotTex = (() => {
    const cv = document.createElement('canvas');
    cv.width = cv.height = 32;
    const g = cv.getContext('2d');
    const grd = g.createRadialGradient(16, 16, 0, 16, 16, 16);
    grd.addColorStop(0, 'rgba(255,255,255,1)');
    grd.addColorStop(0.35, 'rgba(255,255,255,0.85)');
    grd.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grd; g.fillRect(0, 0, 32, 32);
    const t = new THREE.CanvasTexture(cv);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  })();

  // ---------------------------------------------------------------------
  // One card's part: meshes, lines, failure props.
  // ---------------------------------------------------------------------
  function rig(tier = 'high') {
    const root = new THREE.Group();          // in plate coordinates (mm, z up): parent it to the anchor
    root.name = 'part';
    const body = new THREE.Group();          // the part itself (tilts when it comes loose)
    root.add(body);
    const plane = new THREE.Plane(new THREE.Vector3(0, -1, 0), 1e6);
    let mat = null, look = null, layerH = 0.2;
    let meshes = [];
    // current: the layer being laid (the segment under the nozzle is drawn up to the nozzle, in the
    // same buffer); prev: the layer below; base: the purge line and the skirt, one line between them.
    const lines = { current: segs(), prev: segs(), base: segs(), hatch: segs(), strings: segs(), streak: segs() };
    for (const l of Object.values(lines)) root.add(l);
    const base = { purge: null, skirt: null, purgeShown: Infinity, width: 2 };
    // Reveals a line's first `count` segments; with a tip ({ x, y }) the next one is drawn from its
    // start to the nozzle (its end is borrowed in place and put back on the next call).
    function revealer(line) {
      const r = { count: 0, buf: null, slot: -1, saved: [0, 0] };
      r.reset = (g, count) => { r.count = count; r.buf = count && g.attributes.instanceStart ? g.attributes.instanceStart.data : null; r.slot = -1; };
      r.show = (count, tip, after = 0) => {
        const c = Math.max(0, Math.min(count, r.count));
        const a = r.buf ? r.buf.array : null;
        const touch = (o) => { if (r.buf.addUpdateRange) r.buf.addUpdateRange(o, 2); r.buf.needsUpdate = true; };
        if (r.slot >= 0 && a) { const o = r.slot * 6 + 3; a[o] = r.saved[0]; a[o + 1] = r.saved[1]; touch(o); r.slot = -1; }
        let n = c;
        if (tip && a && c < r.count) {
          const o = c * 6 + 3;
          r.saved[0] = a[o]; r.saved[1] = a[o + 1];
          a[o] = tip.x; a[o + 1] = tip.y;
          touch(o);
          r.slot = c;
          n = c + 1;
        }
        if (c >= r.count) n = r.count + after;
        line.geometry.instanceCount = n;
        line.visible = n > 0;
      };
      return r;
    }
    const cur = revealer(lines.current), baseR = revealer(lines.base);
    lines.prev.material.dispose(); lines.prev.material = lineMaterial(1.5, { plane: null });
    // The nest is one long line revealed point by point.
    const nest = new Line2(new LineGeometry(), lineMaterial(2.4));
    nest.frustumCulled = false; nest.visible = false;
    root.add(nest);
    let nestPts = 0;
    // Specks from damp filament.
    const speckGeo = new THREE.BufferGeometry();
    speckGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6 * 3), 3));
    const speckMat = new THREE.PointsMaterial({ color: 0xffffff, size: 3, sizeAttenuation: false, transparent: true, opacity: 0.9, depthWrite: false });
    const specks = new THREE.Points(speckGeo, speckMat);
    specks.frustumCulled = false; specks.visible = false;
    root.add(specks);
    // Cross-section patch (resin UV flash, sintered powder, MJF agent) and a smudge decal.
    const sectionMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9, side: THREE.DoubleSide, depthWrite: false, toneMapped: false });
    const section = new THREE.Mesh(new THREE.BufferGeometry(), sectionMat);
    section.visible = false; section.renderOrder = 3;
    const smudgeMat = new THREE.MeshBasicMaterial({ map: smudgeTex, transparent: true, opacity: 0, depthWrite: false, color: 0xd9d2c4 });
    const smudge = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), smudgeMat);
    smudge.visible = false; smudge.position.z = 0.15; smudge.renderOrder = 2;
    root.add(smudge);
    const glowMat = new THREE.MeshBasicMaterial({ color: 0x5cff8a, transparent: true, opacity: 0.16, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false });
    const glow = new THREE.Mesh(new THREE.CylinderGeometry(1, 1.3, 1, 24, 1, true).rotateX(PI / 2).translate(0, 0, 0.5), glowMat);
    glow.visible = false;
    root.add(glow);
    // The laser (SLS, DMLS): a glowing beam from the scanner to a bright spot where the hatch ends.
    const laser = lines.laser = segs();
    laser.material.dispose();
    laser.material = new LineMaterial({ linewidth: 2.2, vertexColors: true, worldUnits: false, dashed: false, transparent: true, opacity: 0.85,
      depthWrite: false, toneMapped: false });
    fill(laser, new Float32Array(6), new Float32Array(6).fill(1));
    laser.visible = false; laser.renderOrder = 4;
    const spotGeo = new THREE.BufferGeometry();
    spotGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(3), 3));
    const spotMat = new THREE.PointsMaterial({ color: 0xffe2b0, map: dotTex, size: 14, sizeAttenuation: false, transparent: true, depthWrite: false, toneMapped: false });
    const spot = new THREE.Points(spotGeo, spotMat);
    spot.frustumCulled = false; spot.visible = false; spot.renderOrder = 4;
    root.add(laser, spot);
    let hatchPos = null, hatchTip = null, laserHex = -1;
    const blobMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.5 });
    const blob = new THREE.Mesh(new THREE.SphereGeometry(3.2, 10, 8), blobMat);
    blob.visible = false;

    let unitsKey = '', plateItems = null, unitGeo = null, plateIdx = -1;

    const api = {
      root, body, plane, section, blob, lines, nest,
      get material() { return mat; },
      // New part: lofted units + the spec's plates, in a look.
      setPart(loft, spec, look0, opts = {}) {
        api.clearPart();
        look = look0;
        layerH = spec.layerH || 0.2;
        mat = material(look, tier, { layerH, plane, lines: opts.lines !== false });
        unitGeo = {};
        for (const [name, u] of Object.entries(loft.units)) unitGeo[name] = { plain: geometry(u, false), mirror: null, src: u };
        unitsKey = Object.keys(unitGeo).join(',');
        plateItems = spec.plates;
        plateIdx = -1;
        api.showPlate(0, opts.limit);
      },
      // Show one plate's items (batches print a plate at a time).
      showPlate(i, limit) {
        if (!plateItems || i === plateIdx) return;
        plateIdx = i;
        for (const m of meshes) { body.remove(m); m.dispose && m.dispose(); }
        meshes = [];
        let items = plateItems[Math.min(i, plateItems.length - 1)] || [];
        // Too many copies to draw: the bottom tier first (a powder cake stacks them), nearest the middle.
        if (limit && items.length > limit) items = items.slice().sort((a, b) => ((a.z0 || 0) - (b.z0 || 0)) || (Math.hypot(a.x, a.y) - Math.hypot(b.x, b.y))).slice(0, limit);
        const buckets = new Map();
        for (const it of items) {
          const k = it.unit + (it.mirror ? '|m' : '');
          if (!buckets.has(k)) buckets.set(k, []);
          buckets.get(k).push(it);
        }
        const mtx = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), s = new THREE.Vector3(1, 1, 1), zAxis = new THREE.Vector3(0, 0, 1);
        for (const [k, list] of buckets) {
          const [name, mir] = k.split('|');
          const ug = unitGeo[name];
          if (!ug) continue;
          let g = ug.plain;
          if (mir) { if (!ug.mirror) ug.mirror = geometry(ug.src, true); g = ug.mirror; }
          const im = new THREE.InstancedMesh(g, mat, list.length);
          list.forEach((it, j) => { q.setFromAxisAngle(zAxis, it.a || 0); p.set(it.x, it.y, it.z0 || 0); mtx.compose(p, q, s); im.setMatrixAt(j, mtx); });
          im.instanceMatrix.needsUpdate = true;
          im.computeBoundingSphere();
          im.castShadow = !!api.castShadow;
          im.receiveShadow = true;
          body.add(im);
          meshes.push(im);
        }
      },
      hasPart() { return meshes.length > 0; },
      triangles() {
        let t = 0;
        for (const m of meshes) t += (m.geometry.index ? m.geometry.index.count / 3 : m.geometry.attributes.position.count / 3) * m.count;
        return t;
      },
      setCastShadow(on) { api.castShadow = on; for (const m of meshes) m.castShadow = on; },
      // Hide everything above z (the part's own coordinates), worked out in world space from the
      // part's current transform, so a part that tips over stays cut at its own layer.
      setReveal(z) {
        body.updateMatrixWorld(true);
        const n = new THREE.Vector3(0, 0, 1).transformDirection(body.matrixWorld).negate();
        const pt = body.localToWorld(new THREE.Vector3(0, 0, z));
        plane.setFromNormalAndCoplanarPoint(n, pt);
        body.visible = z > 0.01;
      },
      revealAll() { plane.set(new THREE.Vector3(0, -1, 0), 1e6); body.visible = true; },
      setVisible(on) { body.visible = on; },
      // The layer being laid (FDM): its extrusion segments, revealed as the nozzle lays them.
      setCurrent(plan, hex, width) {
        const s = planSegments(plan, plan.z - plan.h / 2, hex, 1);
        const g = fill(lines.current, s.pos, s.col);
        lines.current.material.linewidth = width;
        g.instanceCount = 0;
        lines.current.visible = false;
        cur.reset(g, s.count);
        return s.count;
      },
      // `count` whole segments laid; with `tip` ({ x, y }) the one under the nozzle is drawn up to it.
      revealCurrent(count, tip) { cur.show(count, tip); },
      clearCurrent() { lines.current.visible = false; },
      // The layer underneath, darker (the crosshatch you see through the open top).
      setPrev(plan, hex, width) {
        if (!plan) { lines.prev.visible = false; return; }
        const s = planSegments(plan, plan.z - plan.h * 0.55, hex, 0.62);
        fill(lines.prev, s.pos, s.col);
        lines.prev.material.linewidth = width;
      },
      // The purge line and the skirt stay on the bed under the print: one line for both (purge
      // first, so the purge can be revealed as it's drawn and the skirt shows once it's done).
      setStatic(which, plan, hex, width, z) {
        base[which] = plan ? planSegments(plan, z ?? plan.z - plan.h / 2, hex, 1) : null;
        if (which === 'purge') base.purgeShown = Infinity;
        if (width) base.width = width;
        const parts2 = [base.purge, base.skirt].filter(Boolean);
        const n = parts2.reduce((a, q) => a + q.pos.length, 0);
        const pos = new Float32Array(n), col = new Float32Array(n);
        let o = 0;
        for (const q of parts2) { pos.set(q.pos, o); col.set(q.col, o); o += q.pos.length; }
        const g = fill(lines.base, pos, col);
        lines.base.material.linewidth = base.width;
        baseR.reset(g, base.purge ? base.purge.count : 0);
        api.revealStatic('purge', base.purgeShown);
      },
      hasStatic(which) { return !!base[which]; },
      // The purge line drawn as the nozzle lays it (`count` segments, the next one up to `tip`);
      // the skirt shows once the purge is whole.
      revealStatic(which, count, tip) {
        if (which !== 'purge') return;
        base.purgeShown = count;
        baseR.show(count, tip || null, base.skirt ? base.skirt.count : 0);
      },
      // Laser hatching (SLS/DMLS), revealed like a layer being laid.
      setHatch(plan, hex, width, z) {
        const s = planSegments(plan, z, hex, 1, [1, 1, 1, 0.9, 1, 1]);
        hatchPos = s.pos; hatchTip = null;
        fill(lines.hatch, s.pos, s.col);
        lines.hatch.material.linewidth = width;
        lines.hatch.userData.count = s.count;
        lines.hatch.geometry.instanceCount = 0;
        lines.hatch.visible = false;
        return s.count;
      },
      revealHatch(count) {
        const c = Math.max(0, Math.min(count, lines.hatch.userData.count || 0));
        lines.hatch.geometry.instanceCount = c;
        lines.hatch.visible = c > 0;
        hatchTip = c > 0 && hatchPos ? [hatchPos[(c - 1) * 6 + 3], hatchPos[(c - 1) * 6 + 4], hatchPos[(c - 1) * 6 + 5]] : null;
      },
      // Where the laser is (plate coordinates), after revealHatch.
      hatchTip() { return hatchTip; },
      // The beam from the scanner (straight above the bed's centre, `height` mm up) to `at`.
      setLaser(on, at, height, hex, spotHex) {
        laser.visible = spot.visible = !!(on && at);
        if (!laser.visible) return;
        const buf = laser.geometry.attributes.instanceStart.data;
        buf.array[0] = 0; buf.array[1] = 0; buf.array[2] = height;
        buf.array[3] = at[0]; buf.array[4] = at[1]; buf.array[5] = at[2] + 0.3;
        buf.needsUpdate = true;
        if (hex !== laserHex) {
          laserHex = hex;
          tmpC.setHex(hex);
          const cb = laser.geometry.attributes.instanceColorStart.data;
          for (let i = 0; i < 6; i += 3) { cb.array[i] = tmpC.r; cb.array[i + 1] = tmpC.g; cb.array[i + 2] = tmpC.b; }
          cb.needsUpdate = true;
        }
        const b = spotGeo.attributes.position;
        b.setXYZ(0, at[0], at[1], at[2] + 0.5);
        b.needsUpdate = true;
        spotMat.color.setHex(spotHex ?? 0xffe2b0);
      },
      // A cross-section patch at z (plate coordinates), or none.
      setSection(loops, z, hex, opacity = 0.9) {
        section.geometry.dispose();
        section.geometry = loops && loops.length ? sectionGeometry(loops, z) : new THREE.BufferGeometry();
        sectionMat.color.set(hex);
        sectionMat.opacity = opacity;
        section.visible = !!(loops && loops.length);
      },
      // Spaghetti: the nest's points (plate coordinates), revealed as it grows.
      setNest(pts, hex, width) {
        if (!pts) { nest.visible = false; nestPts = 0; return; }
        // A shade lighter than the part, rippling, so the tangle reads on top of it.
        const col = new Float32Array(pts.length);
        tmpC.set(hex).lerp(new THREE.Color(0xffffff), 0.22);
        for (let i = 0; i < pts.length; i += 3) { const s = 0.78 + 0.22 * Math.sin(i * 0.37); col[i] = tmpC.r * s; col[i + 1] = tmpC.g * s; col[i + 2] = tmpC.b * s; }
        nest.geometry.dispose();
        nest.geometry = new LineGeometry();
        nest.geometry.setPositions(pts);
        nest.geometry.setColors(col);
        nest.material.linewidth = width;
        nestPts = pts.length / 3;
        nest.geometry.instanceCount = 0;
      },
      revealNest(f) {
        const c = Math.floor(Math.max(0, Math.min(1, f)) * Math.max(0, nestPts - 1));
        nest.geometry.instanceCount = c;
        nest.visible = c > 0;
      },
      setStrings(seg, hex, width) {
        if (!seg) { lines.strings.visible = false; return; }
        const col = new Float32Array(seg.length);
        tmpC.set(hex).lerp(new THREE.Color(0xffffff), 0.35);
        for (let i = 0; i < seg.length; i += 3) { col[i] = tmpC.r; col[i + 1] = tmpC.g; col[i + 2] = tmpC.b; }
        fill(lines.strings, seg, col);
        lines.strings.material.linewidth = width;
      },
      setSpecks(arr, at, sizePx) {
        if (!arr) { specks.visible = false; return; }
        const a = speckGeo.attributes.position;
        for (let i = 0; i < 6; i++) a.setXYZ(i, at.x + arr[i * 4], at.y + arr[i * 4 + 1], at.z + arr[i * 4 + 2]);
        a.needsUpdate = true;
        speckMat.size = sizePx;
        specks.visible = true;
      },
      setStreak(on, bed, z) {
        if (!on) { lines.streak.visible = false; return; }
        const [bx, by] = bed;
        const pos = new Float32Array([-bx * 0.45, by * 0.1, z, bx * 0.45, by * 0.16, z, -bx * 0.45, by * 0.13, z, bx * 0.45, by * 0.19, z]);
        const col = new Float32Array(12).fill(0.18);
        fill(lines.streak, pos, col);
        lines.streak.material.linewidth = 2;
      },
      setSmudge(amount, bed) {
        smudge.visible = amount > 0.02;
        smudgeMat.opacity = Math.min(0.75, amount);
        smudge.scale.set(bed[0] * 0.9, bed[1] * 0.9, 1);
      },
      setGlow(on, box, height) {
        glow.visible = on;
        if (on) {
          const r = Math.max(10, Math.hypot(box[2] - box[0], box[3] - box[1]) / 2 + 6);
          glow.position.set((box[0] + box[2]) / 2, (box[1] + box[3]) / 2, 0);
          glow.scale.set(r, r, Math.max(10, height + 10));
        }
      },
      setWarp(amount, box) {
        if (!mat) return;
        mat.userData.u.uWarp.value = amount;
        const r = Math.max(10, Math.hypot(box[2] - box[0], box[3] - box[1]) / 2);
        mat.userData.u.uWarpBox.value.set((box[0] + box[2]) / 2, (box[1] + box[3]) / 2, r, Math.min(9, 2 + r * 0.08));
      },
      setLook(l) { if (mat) setLook(mat, l); look = l; },
      setTier(t) {
        tier = t;
        if (!mat) return;
        const old = mat;
        mat = material(look, t, { layerH, plane, lines: old.userData.u.uLines.value > 0 });
        mat.userData.u.uWarp.value = old.userData.u.uWarp.value;
        mat.userData.u.uWarpBox.value.copy(old.userData.u.uWarpBox.value);
        for (const m of meshes) m.material = mat;
        old.dispose();
      },
      setResolution(w, h) {
        for (const l of Object.values(lines)) l.material.resolution.set(w, h);
        nest.material.resolution.set(w, h);
      },
      clearFaults() {
        nest.visible = false; lines.strings.visible = false; specks.visible = false; lines.streak.visible = false;
        body.rotation.set(0, 0, 0); body.position.set(0, 0, 0);
        if (mat) mat.userData.u.uWarp.value = 0;
      },
      clearPart() {
        for (const m of meshes) body.remove(m);
        meshes = [];
        if (unitGeo) for (const ug of Object.values(unitGeo)) { ug.plain.dispose(); if (ug.mirror) ug.mirror.dispose(); }
        unitGeo = null; plateItems = null; plateIdx = -1; unitsKey = '';
        if (mat) { mat.dispose(); mat = null; }
        for (const k of ['current', 'prev', 'base', 'hatch']) lines[k].visible = false;
        laser.visible = spot.visible = false; hatchPos = null; hatchTip = null;
        cur.reset({ attributes: {} }, 0); baseR.reset({ attributes: {} }, 0);
        base.purge = null; base.skirt = null; base.purgeShown = Infinity;
        section.visible = false; glow.visible = false;
        api.clearFaults();
      },
      dispose() {
        api.clearPart();
        for (const l of Object.values(lines)) { l.geometry.dispose(); l.material.dispose(); }
        nest.geometry.dispose(); nest.material.dispose();
        speckGeo.dispose(); speckMat.dispose();
        section.geometry.dispose(); sectionMat.dispose();
        smudge.geometry.dispose(); smudgeMat.dispose();
        glow.geometry.dispose(); glowMat.dispose();
        blob.geometry.dispose(); blobMat.dispose();
        spotGeo.dispose(); spotMat.dispose();
      },
      get unitsKey() { return unitsKey; },
    };
    return api;
  }

  return {
    geometry, material, setLook, rig, planSegments, sectionGeometry, lineMaterial,
    dispose() { smudgeTex.dispose(); dotTex.dispose(); },
  };
}
