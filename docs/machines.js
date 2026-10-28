// =====================================================================
// Print3D machines: one 3D model per printer, built from its real build volume, that moves like
// its class (see motion.js).
//
// World units are millimetres (x right, y up, z towards the camera). Every machine is built at its
// home pose, in world coordinates, out of a few merged meshes: everything that doesn't move is one
// mesh, and each moving group (bed, gantry, Y carriage, head, plate, recoater) is one more. The kit
// material reads colour, roughness, metalness, clearcoat and glow from vertex attributes, so a
// merged mesh keeps every part's own finish. Glass is one more merged mesh (RGBA vertex colours).
// A machine is about 10-20 draw calls (shadow pass included) and 2-6k triangles. Spare spools are
// painted into the static mesh; only the job's spool turns.
//
// createMachines(ctx) -> { rig(printer), template(printer), materials, dispose }
//   ctx: { THREE, mergeGeometries, RoundedBoxGeometry, M (motion.js), brandColors }
// =====================================================================

export function createMachines(ctx) {
  const { THREE, M } = ctx;
  const merge = ctx.mergeGeometries;
  const RBG = ctx.RoundedBoxGeometry || null;
  const PI = Math.PI;
  const tmpM = new THREE.Matrix4(), tmpE = new THREE.Euler(), tmpC = new THREE.Color();

  // ---------------------------------------------------------------------
  // Materials (shared by every machine; one set per quality tier)
  // ---------------------------------------------------------------------
  const materials = {};
  function kitMaterial(tier) {
    const high = tier === 'high';
    const m = high
      ? new THREE.MeshPhysicalMaterial({ vertexColors: true, roughness: 1, metalness: 1, clearcoat: 1, clearcoatRoughness: 0.14 })
      : new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, metalness: 1 });
    m.onBeforeCompile = (sh) => {
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nattribute vec4 pbr;\nvarying vec4 vPbr;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvPbr = pbr;');
      let f = sh.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying vec4 vPbr;')
        .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = vPbr.x;')
        .replace('#include <metalnessmap_fragment>', 'float metalnessFactor = vPbr.y;')
        .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += diffuseColor.rgb * vPbr.w;');
      if (high) f = f.replace('#include <lights_physical_fragment>', '#include <lights_physical_fragment>\n#ifdef USE_CLEARCOAT\nmaterial.clearcoat *= vPbr.z;\n#endif');
      sh.fragmentShader = f;
    };
    m.customProgramCacheKey = () => 'p3d-kit-' + (high ? 'h' : 's');
    return m;
  }
  function glassMaterial(tier) {
    const high = tier === 'high';
    const m = high
      ? new THREE.MeshPhysicalMaterial({ vertexColors: true, transparent: true, roughness: 0.04, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.03,
        envMapIntensity: 1.6, depthWrite: false, side: THREE.DoubleSide, specularIntensity: 1 })
      : new THREE.MeshStandardMaterial({ vertexColors: true, transparent: true, roughness: 0.08, metalness: 0.1, envMapIntensity: 1.3, depthWrite: false, side: THREE.DoubleSide });
    m.customProgramCacheKey = () => 'p3d-glass-' + (high ? 'h' : 's');
    return m;
  }
  for (const tier of ['high', 'medium', 'low']) materials[tier] = { kit: kitMaterial(tier), glass: glassMaterial(tier) };
  // Medium and low share the standard programs (no clearcoat); one instance each keeps swaps simple.

  // ---------------------------------------------------------------------
  // Building blocks
  // ---------------------------------------------------------------------
  // A look: [hex colour, roughness, metalness, clearcoat, glow]
  const LOOK = {
    alu: [0xc4c8cd, 0.32, 0.9, 0, 0], aluDark: [0x7d838a, 0.38, 0.85, 0, 0], steel: [0xb9bec4, 0.22, 1, 0, 0],
    black: [0x1c1d20, 0.55, 0.05, 0.3, 0], blackGloss: [0x141518, 0.25, 0.05, 0.8, 0], rubber: [0x101112, 0.9, 0, 0, 0],
    grey: [0x55595f, 0.5, 0.1, 0.3, 0], white: [0xe9e9e6, 0.42, 0.02, 0.5, 0], offWhite: [0xd6d6d1, 0.5, 0.02, 0.3, 0],
    brass: [0xc89b3c, 0.28, 1, 0, 0], copper: [0xb87333, 0.3, 1, 0, 0], gold: [0xd4a63a, 0.3, 1, 0, 0],
    pei: [0x8c6a3a, 0.78, 0.3, 0, 0], peiBlack: [0x26272b, 0.7, 0.2, 0, 0], glassDark: [0x0c0f14, 0.12, 0.2, 0.9, 0],
    screenOff: [0x0a0c10, 0.2, 0.1, 0.8, 0], knob: [0xf2b134, 0.5, 0.05, 0.4, 0], red: [0xc62d2d, 0.45, 0.05, 0.5, 0],
    ledWhite: [0xfff4e0, 0.5, 0, 0, 2.2], ledBlue: [0x7fb2ff, 0.5, 0, 0, 1.6], chamberWarm: [0x6e4a30, 0.85, 0, 0, 0.7],
    chamberCool: [0x3a4450, 0.85, 0, 0, 0.45], powderWhite: [0xeeebe4, 0.95, 0, 0, 0.05], powderGrey: [0x6f7277, 0.95, 0.1, 0, 0.02],
    powderMetal: [0x8f9398, 0.75, 0.6, 0, 0.03], amberDim: [0x5a3b09, 0.4, 0, 0.4, 0], greenDim: [0x0f3a1c, 0.4, 0, 0.4, 0], redDim: [0x3d0b0b, 0.4, 0, 0.4, 0],
  };
  const paint = (hex, base) => [hex, base[1], base[2], base[3], base[4]];

  function setAttrs(geo, look) {
    if (geo.attributes.uv) geo.deleteAttribute('uv');
    if (geo.attributes.uv1) geo.deleteAttribute('uv1');
    const n = geo.attributes.position.count;
    tmpC.setHex(look[0]);
    const col = new Float32Array(n * 3), pbr = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) {
      col[i * 3] = tmpC.r; col[i * 3 + 1] = tmpC.g; col[i * 3 + 2] = tmpC.b;
      pbr[i * 4] = look[1]; pbr[i * 4 + 1] = look[2]; pbr[i * 4 + 2] = look[3]; pbr[i * 4 + 3] = look[4];
    }
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geo.setAttribute('pbr', new THREE.BufferAttribute(pbr, 4));
    return geo;
  }
  function setGlassAttrs(geo, hex, alpha) {
    if (geo.attributes.uv) geo.deleteAttribute('uv');
    const n = geo.attributes.position.count;
    tmpC.setHex(hex);
    const col = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) { col[i * 4] = tmpC.r; col[i * 4 + 1] = tmpC.g; col[i * 4 + 2] = tmpC.b; col[i * 4 + 3] = alpha; }
    geo.setAttribute('color', new THREE.BufferAttribute(col, 4));
    return geo;
  }
  function place(geo, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0) {
    if (rx || ry || rz) { tmpE.set(rx, ry, rz); tmpM.makeRotationFromEuler(tmpE); geo.applyMatrix4(tmpM); }
    if (x || y || z) geo.translate(x, y, z);
    return geo;
  }
  const B = (w, h, d) => new THREE.BoxGeometry(w, h, d);
  const R = (w, h, d, r) => (RBG ? new RBG(w, h, d, 2, Math.min(r, w / 2 - 0.01, h / 2 - 0.01, d / 2 - 0.01)) : new THREE.BoxGeometry(w, h, d));
  const C = (r, h, seg = 16, rTop) => new THREE.CylinderGeometry(rTop ?? r, r, h, seg);

  class Kit {
    constructor() { this.g = {}; this.glass = []; }
    add(group, geo, look, x, y, z, rx, ry, rz) {
      setAttrs(geo, look);
      place(geo, x, y, z, rx, ry, rz);
      (this.g[group] || (this.g[group] = [])).push(geo);
      return this;
    }
    // A box from its min and max corners (most frame parts are easier to think of this way).
    box(group, look, x0, y0, z0, x1, y1, z1) {
      return this.add(group, B(Math.abs(x1 - x0), Math.abs(y1 - y0), Math.abs(z1 - z0)), look, (x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
    }
    rbox(group, look, x0, y0, z0, x1, y1, z1, r) {
      return this.add(group, R(Math.abs(x1 - x0), Math.abs(y1 - y0), Math.abs(z1 - z0), r), look, (x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
    }
    pane(hex, alpha, w, h, x, y, z, ry = 0, rx = 0) {
      const g = setGlassAttrs(new THREE.PlaneGeometry(w, h), hex, alpha);
      place(g, x, y, z, rx, ry, 0);
      this.glass.push(g);
      return this;
    }
    build() {
      const out = {};
      for (const [k, list] of Object.entries(this.g)) out[k] = mergeList(list);
      out.glass = this.glass.length ? mergeList(this.glass) : null;
      return out;
    }
  }
  function mergeList(list) {
    if (list.some((g) => !g.index)) list = list.map((g) => (g.index ? g.toNonIndexed() : g));
    const g = merge(list, false);
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g;
  }

  // Shared small parts
  function motor(kit, group, x, y, z, axis = 'y', s = 1) {
    const w = 42 * s;
    if (axis === 'y') { kit.box(group, LOOK.black, x - w / 2, y - 20 * s, z - w / 2, x + w / 2, y + 20 * s, z + w / 2); kit.box(group, LOOK.alu, x - w / 2 + 2, y + 20 * s, z - w / 2 + 2, x + w / 2 - 2, y + 26 * s, z + w / 2 - 2); }
    else if (axis === 'x') { kit.box(group, LOOK.black, x - 20 * s, y - w / 2, z - w / 2, x + 20 * s, y + w / 2, z + w / 2); kit.box(group, LOOK.alu, x + 20 * s, y - w / 2 + 2, z - w / 2 + 2, x + 26 * s, y + w / 2 - 2, z + w / 2 - 2); }
    else { kit.box(group, LOOK.black, x - w / 2, y - w / 2, z - 20 * s, x + w / 2, y + w / 2, z + 20 * s); kit.box(group, LOOK.alu, x - w / 2 + 2, y - w / 2 + 2, z - 26 * s, x + w / 2 - 2, y + w / 2 - 2, z - 20 * s); }
  }
  // Fan blades around their own origin, spinning about local z.
  function fanBlades(r) {
    const kit = new Kit();
    kit.add('b', C(r * 0.32, 3, 12), LOOK.black, 0, 0, 0, PI / 2);
    for (let i = 0; i < 7; i++) kit.add('b', B(r * 0.8, 1.2, r * 0.36), LOOK.black, Math.cos(i * 2 * PI / 7) * r * 0.5, Math.sin(i * 2 * PI / 7) * r * 0.5, 0, 0.4, 0, i * 2 * PI / 7);
    return kit.build().b;
  }
  // A spool around its own origin, axis along local x: two flanges, the hub and the wound filament.
  // The flanges are open rims with spokes (like a real spool's windows), so the filament's colour
  // shows through them face-on, and the spokes make the turning read. `merged` is frame + filament
  // in one geometry; the filament's vertices start at `filStart` (a job spool repaints just those).
  function spoolParts(r = 100, w = 64) {
    const seg = r > 60 ? 28 : 20;
    const kit = new Kit();
    for (const sx of [-1, 1]) {
      const x = sx * w / 2;
      kit.add('f', new THREE.CylinderGeometry(r, r, 3, seg, 1, true), LOOK.grey, x, 0, 0, 0, 0, PI / 2);
      kit.add('f', new THREE.RingGeometry(r * 0.84, r, seg, 1), LOOK.grey, x + 1.5, 0, 0, 0, PI / 2, 0);
      kit.add('f', new THREE.RingGeometry(r * 0.84, r, seg, 1), LOOK.grey, x - 1.5, 0, 0, 0, -PI / 2, 0);
      for (let i = 0; i < 3; i++) kit.add('f', B(3, r * 1.72, 7), LOOK.offWhite, x, 0, 0, i * PI / 3, 0, 0);
    }
    kit.add('f', C(26, w + 4, 14), LOOK.offWhite, 0, 0, 0, 0, 0, PI / 2);
    const frame = kit.build().f;
    const fil = setAttrs(C(r * 0.8, w - 4, seg), [0xcccccc, 0.45, 0, 0.2, 0]);
    fil.rotateZ(PI / 2);
    const merged = mergeList([frame, fil]);
    return { frame, fil, merged, filStart: frame.attributes.position.count };
  }

  const brandOf = (printer) => (ctx.brandColors && ctx.brandColors[printer.brand]) || { frame: 0x3a3d42, accent: 0x2b2d31, panel: 0x26282c };

  // ---------------------------------------------------------------------
  // Classes. Each returns a template: merged geometry per group, where each moving node sits, the
  // nozzle tip at home and the frame to point a camera at.
  // ---------------------------------------------------------------------
  function bedslinger(printer, cantilever) {
    const [bx, by, bz] = printer.buildVolumeMM;
    const col = brandOf(printer);
    const kit = new Kit();
    const NZ = 18;                        // the nozzle's line in z (the bed's centre slides under it)
    const BH = 52, BW = bx + 110, BD = by + 70;
    const BS = 85.5;                      // bed surface at home
    const UZ = -30;                       // uprights, behind the nozzle line
    const TOP = BH + bz + 135;
    const xU = bx / 2 + 44;
    const frame = paint(col.frame, LOOK.black);
    const accent = paint(col.accent, LOOK.blackGloss);
    // Base with its screen and feet.
    kit.rbox('static', paint(col.panel === 0xfafafa ? 0x2b2d31 : col.panel, LOOK.black), -BW / 2, 6, NZ - BD / 2, BW / 2, BH, NZ + BD / 2, 6);
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) kit.add('static', C(10, 6, 10), LOOK.rubber, sx * (BW / 2 - 18), 3, NZ + sz * (BD / 2 - 18));
    kit.box('static', LOOK.alu, -16, BH, NZ - by / 2 - 50, 16, BH + 16, NZ + by / 2 + 50);           // Y extrusion
    motor(kit, 'static', 0, BH - 18, NZ - by / 2 - 40, 'z', 0.85);
    for (let i = 0; i < 5; i++) kit.box('static', LOOK.rubber, -BW / 2 - 0.6, 14 + i * 7, NZ - 40, -BW / 2 + 0.6, 17 + i * 7, NZ + 40);  // vents
    // The bed: a heated plate on knobs, a PEI sheet on top, the cable at the back.
    kit.box('bed', LOOK.aluDark, -bx / 2 - 8, BS - 9, NZ - by / 2 - 8, bx / 2 + 8, BS - 2, NZ + by / 2 + 8);
    kit.box('bed', printer.brand === 'Prusa Research' || printer.brand === 'Bambu Lab' ? LOOK.pei : LOOK.peiBlack, -bx / 2, BS - 2, NZ - by / 2, bx / 2, BS, NZ + by / 2);
    kit.box('bed', LOOK.alu, -24, BH + 16, NZ - by / 2 + 10, 24, BS - 9, NZ + by / 2 - 10);      // carriage
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) kit.add('bed', C(10, 8, 12), LOOK.knob, sx * (bx / 2 - 6), BS - 14, NZ + sz * (by / 2 - 6));
    kit.box('bed', LOOK.black, -6, BS - 18, NZ - by / 2 - 26, 6, BS - 8, NZ - by / 2 - 8);
    // Frame: two uprights and a top bar (one column for a cantilever).
    if (cantilever) {
      kit.box('static', frame, -xU - 22, BH, UZ - 22, -xU + 22, TOP, UZ + 22);
      kit.box('static', LOOK.blackGloss, -xU - 24, TOP, UZ - 24, -xU + 24, TOP + 18, UZ + 24);
      kit.add('static', C(4, TOP - BH - 40, 10), LOOK.gold, -xU + 30, (TOP + BH) / 2, UZ);
      motor(kit, 'static', -xU + 30, BH + 22, UZ, 'y', 0.9);
    } else {
      for (const sx of [-1, 1]) {
        kit.box('static', frame, sx * xU - 10, BH, UZ - 20, sx * xU + 10, TOP, UZ + 20);
        kit.add('static', C(4, TOP - BH - 50, 10), LOOK.gold, sx * (xU - 4), (TOP + BH) / 2 + 10, UZ + 34);
        motor(kit, 'static', sx * (xU - 4), BH + 22, UZ + 34, 'y', 0.85);
      }
      kit.box('static', frame, -xU - 10, TOP, UZ - 20, xU + 10, TOP + 20, UZ + 20);
    }
    // Gantry: the X beam and its end blocks (moves in z with the print).
    const gy = BS + 50;
    if (cantilever) {
      kit.box('gantry', LOOK.blackGloss, -xU - 26, gy - 32, UZ - 26, -xU + 26, gy + 32, UZ + 26);
      kit.box('gantry', paint(col.frame, LOOK.alu), -xU + 26, gy - 12, UZ - 16, bx / 2 + 36, gy + 12, UZ + 16);
    } else {
      for (const sx of [-1, 1]) kit.box('gantry', LOOK.blackGloss, sx * xU - 18, gy - 28, UZ - 26, sx * xU + 18, gy + 28, UZ + 26);
      kit.box('gantry', LOOK.alu, -xU, gy - 10, UZ - 20, xU, gy + 10, UZ + 20);
      motor(kit, 'gantry', -xU + 40, gy, UZ - 40, 'z', 0.8);
    }
    kit.box('gantry', LOOK.rubber, -bx / 2 - 30, gy - 3, UZ + 20, bx / 2 + 30, gy + 3, UZ + 22);     // belt
    // Head on the beam's front: carriage, shroud, heater block; the nozzle tip touches the bed at home.
    kit.box('head', LOOK.black, -27, gy - 30, UZ + 20, 27, gy + 28, UZ + 28);
    kit.rbox('head', accent, -24, BS + 14, UZ + 28, 24, BS + 70, NZ + 22, 5);
    kit.box('head', LOOK.alu, -10, BS + 5, NZ - 8, 10, BS + 14, NZ + 8);
    kit.add('head', C(17, 4, 18), LOOK.rubber, 0, BS + 44, NZ + 23, PI / 2);                     // hotend fan ring
    kit.box('head', LOOK.black, 24, BS + 12, NZ - 18, 36, BS + 46, NZ + 14);                     // part blower
    kit.add('head', C(5, 12, 10), LOOK.black, 0, BS + 76, NZ - 6);                               // filament entry
    const fans = [{ parent: 'head', pos: [0, BS + 44, NZ + 25.5], axis: 'z', r: 14 }];
    // Spool on top, turning about x.
    const spools = [{ parent: 'static', pos: cantilever ? [-xU, TOP + 120, UZ] : [0, TOP + 120, UZ], r: 95, w: 62, job: true }];
    if (cantilever) kit.box('static', LOOK.grey, -xU - 6, TOP + 18, UZ - 6, -xU + 6, TOP + 120, UZ + 6);
    else kit.box('static', LOOK.grey, -6, TOP + 20, UZ - 6, 6, TOP + 120, UZ + 6);
    // AMS lite: four spools on a stand at the side.
    if ((printer.multiMaterialColors || 0) >= 4) {
      const ax = -BW / 2 - 120;
      kit.box('static', LOOK.offWhite, ax - 10, 0, NZ - 30, ax + 10, TOP - 40, NZ - 10);
      kit.box('static', LOOK.offWhite, ax - 70, 0, NZ - 70, ax + 70, 12, NZ + 30);
      spools.length = 0;
      for (let i = 0; i < 4; i++) spools.push({ parent: 'static', pos: [ax + (i % 2 ? 46 : -46), TOP - 150 + (i < 2 ? 0 : 140), NZ - 20], r: 70, w: 52, job: i === 0, fixed: [0x2a52be, 0xefebe2, 0x1d1e20, 0xf0a020][i] });
    }
    const lcd = { parent: 'static', pos: [bx / 4, BH * 0.52, NZ + BD / 2 + 0.8], rot: [-0.08, 0, 0], size: [72, 36] };
    kit.box('static', LOOK.screenOff, bx / 4 - 40, BH * 0.52 - 21, NZ + BD / 2, bx / 4 + 40, BH * 0.52 + 21, NZ + BD / 2 + 0.6);
    const lamp = { parent: 'static', pos: [-bx / 4, BH * 0.52, NZ + BD / 2 + 0.8], size: [46, 6] };
    const tip = [0, BS, NZ];
    const xmax = Math.max(BW / 2, xU + 30);
    return {
      kin: cantilever ? 'cantilever' : 'bedslinger', kit, tip, BS, NZ, fans, spools, lcd, lamp,
      nodes: { bed: 'root', gantry: 'root', head: 'gantry' },
      partAnchor: { parent: 'bed', pos: [0, BS, NZ] },
      filament: { head: [0, BS + 82, NZ - 6] },
      bounds: [-xmax - ((printer.multiMaterialColors || 0) >= 4 ? 200 : 0), 0, NZ - BD / 2 - 30, xmax, TOP + 120 + 95, NZ + BD / 2 + 10],
      floor: false,
    };
  }

  function corexy(printer, idex) {
    const [bx, by, bz] = printer.buildVolumeMM;
    const col = brandOf(printer);
    const kit = new Kit();
    const open = !printer.enclosed;
    const W = Math.max(bx + 135, idex ? bx + 190 : 0), D = by + 140, H = bz + 210;
    const NZ = 0;
    const tipY = H - 98;               // the nozzle tip, fixed in height; the bed rises to meet it at home
    const BS = tipY;
    const gantry = printer.zAxis === 'gantry';
    // A brand whose panels are white builds its enclosed machines dark (charcoal body, glass door);
    // its open frames stay light.
    const lum = (hex) => (0.2126 * ((hex >> 16) & 255) + 0.7152 * ((hex >> 8) & 255) + 0.0722 * (hex & 255)) / 255;
    const panelHex = col.panel === 0xfafafa ? (open ? 0xe9e9e6 : lum(col.frame) < 0.15 ? 0x2c2e33 : col.frame) : col.panel;
    const panel = paint(panelHex, LOOK.black);
    const frameLook = paint(col.frame, LOOK.black);
    const accent = paint(col.accent, LOOK.blackGloss);
    // Base and chassis.
    kit.rbox('static', panel, -W / 2, 0, -D / 2, W / 2, 62, D / 2, 5);
    if (open) {
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) kit.box('static', frameLook, sx * W / 2 - (sx > 0 ? 20 : 0), 62, sz * D / 2 - (sz > 0 ? 20 : 0), sx * W / 2 + (sx < 0 ? 20 : 0), H, sz * D / 2 + (sz < 0 ? 20 : 0));
      for (const sz of [-1, 1]) kit.box('static', frameLook, -W / 2, H - 20, sz * D / 2 - (sz > 0 ? 20 : 0), W / 2, H, sz * D / 2 + (sz < 0 ? 20 : 0));
      for (const sx of [-1, 1]) kit.box('static', frameLook, sx * W / 2 - (sx > 0 ? 20 : 0), H - 20, -D / 2, sx * W / 2 + (sx < 0 ? 20 : 0), H, D / 2);
    } else {
      // Walls (left, right, back), a top frame with a glass lid, a front frame with a glass door.
      kit.box('static', panel, -W / 2, 62, -D / 2, -W / 2 + 5, H, D / 2);
      kit.box('static', panel, W / 2 - 5, 62, -D / 2, W / 2, H, D / 2);
      kit.box('static', panel, -W / 2, 62, -D / 2, W / 2, H, -D / 2 + 5);
      kit.box('static', panel, -W / 2, H - 6, -D / 2, W / 2, H, -D / 2 + 26);
      kit.box('static', panel, -W / 2, H - 6, D / 2 - 26, W / 2, H, D / 2);
      for (const sx of [-1, 1]) kit.box('static', panel, sx > 0 ? W / 2 - 24 : -W / 2, H - 6, -D / 2, sx > 0 ? W / 2 : -W / 2 + 24, H, D / 2);
      kit.box('static', panel, -W / 2, 62, D / 2 - 5, -W / 2 + 22, H, D / 2);
      kit.box('static', panel, W / 2 - 22, 62, D / 2 - 5, W / 2, H, D / 2);
      kit.box('static', panel, -W / 2, H - 30, D / 2 - 5, W / 2, H, D / 2);
      kit.box('static', LOOK.steel, W / 2 - 34, H * 0.42, D / 2, W / 2 - 28, H * 0.68, D / 2 + 14);   // door handle
      kit.pane(0x9fb4c4, 0.16, W - 44, H - 92, 0, 62 + (H - 92) / 2, D / 2 - 2);                         // door glass
      kit.pane(0x9fb4c4, 0.2, W - 48, D - 52, 0, H - 3, 0, 0, -PI / 2);                                    // lid glass
      kit.box('static', LOOK.ledWhite, -W / 2 + 30, H - 38, D / 2 - 30, W / 2 - 30, H - 34, D / 2 - 26);   // chamber light
    }
    // Z: lead screws at the back corners (static), the bed on its arms.
    for (const sx of [-1, 1]) {
      kit.add('static', C(4, H - 120, 10), LOOK.gold, sx * (bx / 2 + 14), (H + 62) / 2 - 10, -by / 2 - 30);
      kit.add('static', C(4, H - 120, 10), LOOK.steel, sx * (bx / 2 + 34), (H + 62) / 2 - 10, -by / 2 - 30);
    }
    const bedGroup = gantry ? 'static' : 'bed';
    const bedTop = gantry ? 92 : BS;
    kit.box(bedGroup, LOOK.aluDark, -bx / 2 - 6, bedTop - 10, -by / 2 - 6, bx / 2 + 6, bedTop - 2, by / 2 + 6);
    kit.box(bedGroup, printer.brand === 'Bambu Lab' || printer.brand === 'Prusa Research' ? LOOK.pei : LOOK.peiBlack, -bx / 2, bedTop - 2, -by / 2, bx / 2, bedTop, by / 2);
    for (const sx of [-1, 1]) kit.box(bedGroup, LOOK.black, sx * (bx / 2 + 4) - 14, bedTop - 14, -by / 2 - 40, sx * (bx / 2 + 4) + 14, bedTop - 6, -by / 2 + 30);
    // XY at the top: rails on the side walls, the X beam (moves in y), the head (moves in x).
    const ry = tipY + 72;
    const xyGroup = gantry ? 'gantry' : 'static';
    for (const sx of [-1, 1]) kit.box(xyGroup, LOOK.alu, sx * (W / 2 - 26) - 7, ry - 8, -D / 2 + 20, sx * (W / 2 - 26) + 7, ry + 8, D / 2 - 20);
    if (gantry) for (const sx of [-1, 1]) for (const sz of [-1, 1]) kit.box('gantry', LOOK.black, sx * (W / 2 - 26) - 12, ry - 14, sz * (D / 2 - 30) - 12, sx * (W / 2 - 26) + 12, ry + 14, sz * (D / 2 - 30) + 12);
    if (gantry) for (const sz of [-1, 1]) kit.box('gantry', LOOK.alu, -W / 2 + 26, ry - 6, sz * (D / 2 - 30) - 6, W / 2 - 26, ry + 6, sz * (D / 2 - 30) + 6);
    kit.box('ycar', LOOK.blackGloss, -W / 2 + 26, ry - 7, -9, W / 2 - 26, ry + 7, 9);
    for (const sx of [-1, 1]) kit.box('ycar', LOOK.black, sx * (W / 2 - 26) - 14, ry - 12, -18, sx * (W / 2 - 26) + 14, ry + 12, 18);
    motor(kit, xyGroup, -W / 2 + 40, ry + 34, -D / 2 + 40, 'y', 0.8);
    motor(kit, xyGroup, W / 2 - 40, ry + 34, -D / 2 + 40, 'y', 0.8);
    const head = (group, dx, look) => {
      kit.rbox(group, LOOK.black, dx - 30, tipY + 14, -26, dx + 30, ry + 14, 22, 4);
      kit.rbox(group, look, dx - 31, tipY + 16, 18, dx + 31, ry + 6, 30, 6);
      kit.box(group, LOOK.alu, dx - 9, tipY + 5, -8, dx + 9, tipY + 14, 8);
      kit.add(group, C(13, 3, 16), LOOK.rubber, dx, (tipY + ry) / 2 + 6, 31.5, PI / 2);
    };
    head('head', 0, accent);
    const fans = [{ parent: 'head', pos: [0, (tipY + ry) / 2 + 6, 33.5], axis: 'z', r: 11 }];
    if (printer.id === 'bambu-h2d') kit.box('head', LOOK.alu, 12, tipY + 5, -8, 30, tipY + 14, 8);
    let head2 = null;
    if (idex) {
      head('head2', 0, paint(0x14b8a6, LOOK.blackGloss));
      fans.push({ parent: 'head2', pos: [0, (tipY + ry) / 2 + 6, 33.5], axis: 'z', r: 11 });
      head2 = { parkX: bx / 2 + 40 };
    }
    // Prusa XL: four more tools waiting in their docks at the back.
    if (printer.id === 'prusa-xl-5tool') {
      for (let i = 0; i < 4; i++) {
        const dx = -bx / 2 + 50 + i * (bx - 100) / 3;
        kit.rbox('static', accent, dx - 26, tipY + 30, -D / 2 + 24, dx + 26, ry - 4, -D / 2 + 70, 5);
        kit.box('static', LOOK.alu, dx - 30, ry - 4, -D / 2 + 20, dx + 30, ry + 6, -D / 2 + 74);
      }
    }
    // Filament: an AMS on top (Bambu, four colours), else a spool on the side.
    const spools = [];
    let topY = H;
    if ((printer.multiMaterialColors || 0) >= 4 && !open) {
      const aw = W - 30, ad = D * 0.7, ah = 112;
      kit.rbox('static', LOOK.offWhite, -aw / 2, H, -ad / 2, aw / 2, H + 24, ad / 2, 5);
      kit.box('static', LOOK.offWhite, -aw / 2, H + 24, -ad / 2, aw / 2, H + ah, -ad / 2 + 10);
      for (const sx of [-1, 1]) kit.box('static', LOOK.offWhite, sx > 0 ? aw / 2 - 8 : -aw / 2, H + 24, -ad / 2, sx > 0 ? aw / 2 : -aw / 2 + 8, H + ah, ad / 2);
      kit.pane(0x3d4248, 0.42, aw - 16, ad - 10, 0, H + ah, 2, 0, -PI / 2);
      kit.pane(0x3d4248, 0.36, aw - 16, ah - 24, 0, H + 24 + (ah - 24) / 2, ad / 2);
      for (let i = 0; i < 4; i++) spools.push({ parent: 'static', pos: [-aw / 2 + aw * (i + 0.5) / 4, H + 64, 0], r: 40, w: aw / 4 - 22, job: i === 0, fixed: [0x2a52be, 0xefebe2, 0x1d1e20, 0xf0a020][i], axis: 'z', shadow: false });
      topY = H + ah;
    } else {
      const sx = -W / 2 - 46;
      kit.box('static', LOOK.grey, sx - 6, H * 0.45, -D / 4 - 6, -W / 2, H * 0.45 + 12, -D / 4 + 6);
      spools.push({ parent: 'static', pos: [sx, H * 0.45 + 6, -D / 4], r: 95, w: 62, job: true });
      if (idex) spools.push({ parent: 'static', pos: [W / 2 + 46, H * 0.45 + 6, -D / 4], r: 95, w: 62, job: false, fixed: 0xefebe2 });
    }
    // Screen on the front of the base.
    const lcd = { parent: 'static', pos: [-W / 2 + 70, 31, D / 2 + 0.8], rot: [0, 0, 0], size: [76, 38] };
    kit.box('static', LOOK.screenOff, -W / 2 + 28, 9, D / 2, -W / 2 + 112, 53, D / 2 + 0.6);
    const lamp = { parent: 'static', pos: [W / 2 - 50, 31, D / 2 + 0.8], size: [40, 6] };
    return {
      kin: idex ? 'idex' : printer.tech === 'ADAM' ? 'metal' : 'corexy', zAxis: gantry ? 'gantry' : undefined, kit, tip: [0, tipY, NZ], BS: bedTop, NZ, fans, spools, lcd, lamp, head2,
      nodes: gantry ? { gantry: 'root', ycar: 'gantry', head: 'ycar', head2: idex ? 'ycar' : null } : { bed: 'root', ycar: 'root', head: 'ycar', head2: idex ? 'ycar' : null },
      partAnchor: { parent: gantry ? 'root' : 'bed', pos: [0, bedTop, 0] },
      filament: { head: [0, ry + 16, 0] },
      bounds: [-W / 2 - (spools.length && spools[0].r > 60 ? 100 : 0), 0, -D / 2, W / 2 + (idex ? 100 : 0), topY + 10, D / 2],
      floor: false,
    };
  }

  function vat(printer) {
    const [bx, by, bz] = printer.buildVolumeMM;
    const col = brandOf(printer);
    const kit = new Kit();
    const sla = printer.tech === 'SLA';
    const fp = printer.footprintMM || [bx + 80, by + 100];
    const W = Math.max(fp[0], bx + 70), D = Math.max(Math.min(fp[1], by + 170), by + 110);
    const H0 = sla ? 190 : 108;
    const FILM = H0 + 3;
    const VZ = 12;                                  // the vat sits a little forward of centre
    const base = sla ? LOOK.white : paint(col.frame === 0xfafafa ? 0xe9e9e6 : 0x26282c, LOOK.black);
    kit.rbox('static', base, -W / 2, 0, -D / 2, W / 2, H0, D / 2, 8);
    kit.box('static', LOOK.glassDark, -bx / 2, H0, VZ - by / 2, bx / 2, H0 + 1.5, VZ + by / 2);              // exposure screen
    // Vat: a metal tray with a clear film floor (the resin itself is its own mesh).
    const vw = bx + 14, vd = by + 14, vh = 34;
    for (const [x0, x1, z0, z1] of [[-vw / 2, -vw / 2 + 5, -vd / 2, vd / 2], [vw / 2 - 5, vw / 2, -vd / 2, vd / 2], [-vw / 2, vw / 2, -vd / 2, -vd / 2 + 5], [-vw / 2, vw / 2, vd / 2 - 5, vd / 2]]) {
      kit.box('static', LOOK.alu, x0, H0 + 1.5, VZ + z0, x1, H0 + 1.5 + vh, VZ + z1);
    }
    for (const sx of [-1, 1]) kit.box('static', LOOK.black, sx * (vw / 2 + 4) - 6, H0 + 1.5, VZ - 12, sx * (vw / 2 + 4) + 6, H0 + 18, VZ + 12);   // thumb screws
    // Z column at the back and the build plate on its arm.
    const cz = VZ - vd / 2 - 46;
    const colH = bz + 170;
    kit.box('static', LOOK.alu, -20, H0, cz - 20, 20, H0 + colH, cz + 20);
    kit.box('static', LOOK.black, -26, H0 + colH, cz - 26, 26, H0 + colH + 16, cz + 26);
    kit.box('plate', LOOK.black, -34, FILM + 30, cz - 22, 34, FILM + 82, cz + 28);
    kit.box('plate', LOOK.aluDark, -16, FILM + 52, cz + 28, 16, FILM + 70, VZ);
    kit.box('plate', LOOK.alu, -bx / 2 + 4, FILM + 2, VZ - by / 2 + 4, bx / 2 - 4, FILM + 14, VZ + by / 2 - 4);
    kit.box('plate', LOOK.aluDark, -22, FILM + 14, VZ - 22, 22, FILM + 52, VZ + 22);
    kit.add('plate', C(9, 14, 12), LOOK.black, 0, FILM + 76, VZ);
    // UV cover: tinted acrylic over everything (brand colour family), light enough to see the vat.
    const coverHex = sla ? 0xff8a3a : printer.brand === 'Phrozen' ? 0xe05050 : printer.brand === 'Anycubic' ? 0xf2c14e : 0xf5aa3a;
    const cw = W - 10, cd = D - 10, ch = colH + 26;
    kit.pane(coverHex, 0.2, cw, ch, 0, H0 + ch / 2, cd / 2);
    kit.pane(coverHex, 0.24, cw, ch, 0, H0 + ch / 2, -cd / 2);
    kit.pane(coverHex, 0.22, cd, ch, -cw / 2, H0 + ch / 2, 0, PI / 2);
    kit.pane(coverHex, 0.22, cd, ch, cw / 2, H0 + ch / 2, 0, PI / 2);
    kit.pane(coverHex, 0.26, cw, cd, 0, H0 + ch, 0, 0, -PI / 2);
    if (sla) kit.box('static', LOOK.grey, -60, H0, -D / 2 + 8, 60, H0 + 160, -D / 2 + 60);                 // resin cartridge
    const lcd = { parent: 'static', pos: [0, H0 * 0.5, D / 2 + 0.8], rot: [-0.12, 0, 0], size: [sla ? 96 : 70, sla ? 48 : 36] };
    kit.box('static', LOOK.screenOff, -(sla ? 54 : 40), H0 * 0.5 - (sla ? 28 : 21), D / 2, sla ? 54 : 40, H0 * 0.5 + (sla ? 28 : 21), D / 2 + 0.6);
    const lamp = { parent: 'static', pos: [W / 2 - 28, H0 * 0.5, D / 2 + 0.8], size: [22, 6] };
    return {
      kin: 'vat', kit, tip: [0, FILM, VZ], BS: FILM, NZ: VZ, fans: [], spools: [], lcd, lamp,
      nodes: { plate: 'root' },
      partAnchor: { parent: 'plate', pos: [0, FILM + 2, VZ], flip: true },
      vat: { w: vw - 10, d: vd - 10, y: H0 + 1.5, level: 14, z: VZ, screenY: H0 + 1.6, glow: { size: [cw - 24, Math.min(ch, 120), cd - 24], y: H0 + Math.min(ch, 120) / 2 } },
      bounds: [-W / 2, 0, -D / 2, W / 2, H0 + ch, D / 2],
      floor: false,
    };
  }

  function powder(printer) {
    const [bx, by] = printer.buildVolumeMM;
    const proc = M.powderProcess(printer);
    const kit = new Kit();
    const fp = printer.footprintMM || [900, 900];
    const W = proc === 'sls' ? Math.max(700, fp[0]) : proc === 'mjf' ? 1900 : 2000;
    const D = proc === 'sls' ? 860 : 1100;
    const H = proc === 'sls' ? 1220 : proc === 'mjf' ? 1450 : 2050;
    const body = proc === 'mjf' ? LOOK.offWhite : LOOK.white;
    const trim = proc === 'mjf' ? LOOK.grey : proc === 'dmls' ? paint(0x2b2d31, LOOK.black) : paint(0xff7a1a, LOOK.black);
    // A big window onto the chamber, so the recoater, the laser and the lamp read on a card.
    const wx = proc === 'sls' ? -40 : -W * 0.16;
    const ww = proc === 'sls' ? bx + 250 : proc === 'mjf' ? 860 : 760;
    const wh = proc === 'sls' ? 300 : proc === 'mjf' ? 380 : 440;
    const wy0 = proc === 'dmls' ? 940 : proc === 'mjf' ? 720 : 640;
    const wz = D / 2;
    // Cabinet with the window cut out (built as frames around it), plinth, vents, handles.
    kit.box('static', LOOK.black, -W / 2 + 10, 0, -D / 2 + 10, W / 2 - 10, 70, D / 2 - 10);
    kit.box('static', body, -W / 2, 70, -D / 2, W / 2, wy0, D / 2);
    kit.box('static', body, -W / 2, wy0 + wh, -D / 2, W / 2, H, D / 2);
    kit.box('static', body, -W / 2, wy0, -D / 2, wx - ww / 2, wy0 + wh, D / 2);
    kit.box('static', body, wx + ww / 2, wy0, -D / 2, W / 2, wy0 + wh, D / 2);
    kit.box('static', body, wx - ww / 2, wy0, -D / 2, wx + ww / 2, wy0 + wh, D / 2 - by - 70);
    kit.box('static', trim, wx - ww / 2 - 14, wy0 - 14, wz, wx + ww / 2 + 14, wy0, wz + 6);
    kit.box('static', trim, wx - ww / 2 - 14, wy0 + wh, wz, wx + ww / 2 + 14, wy0 + wh + 14, wz + 6);
    kit.box('static', trim, wx - ww / 2 - 14, wy0, wz, wx - ww / 2, wy0 + wh, wz + 6);
    kit.box('static', trim, wx + ww / 2, wy0, wz, wx + ww / 2 + 14, wy0 + wh, wz + 6);
    kit.box('static', trim, -W / 2, H - 30, D / 2 - 2, W / 2, H - 22, D / 2 + 2);
    for (let i = 0; i < 6; i++) kit.box('static', LOOK.grey, W / 2 - 220, 120 + i * 26, D / 2, W / 2 - 60, 132 + i * 26, D / 2 + 2);
    kit.box('static', LOOK.steel, wx - 80, wy0 - 60, wz, wx + 80, wy0 - 48, wz + 16);
    // The chamber behind the window: lit walls, the powder bed, the recoater's rails.
    const cy = wy0 + 30;                        // powder surface
    const cz0 = wz - by - 60, cz1 = wz - 10;
    const lit = proc === 'dmls' ? LOOK.chamberCool : LOOK.chamberWarm;
    kit.box('static', lit, wx - ww / 2, wy0, cz0 - 6, wx + ww / 2, wy0 + wh, cz0);
    kit.box('static', lit, wx - ww / 2, wy0 + wh - 6, cz0, wx + ww / 2, wy0 + wh, cz1);
    kit.box('static', LOOK.aluDark, wx - ww / 2, wy0, cz0, wx + ww / 2, cy - 2, cz1);
    const powderLook = proc === 'mjf' ? LOOK.powderGrey : proc === 'dmls' ? LOOK.powderMetal : LOOK.powderWhite;
    kit.box('static', powderLook, wx - bx / 2 - 30, cy - 2, cz0 + 6, wx + bx / 2 + 30, cy, cz1 - 6);
    for (const sz of [cz0 + 12, cz1 - 12]) kit.box('static', LOOK.steel, wx - ww / 2 + 6, cy + 30, sz - 4, wx + ww / 2 - 6, cy + 38, sz + 4);
    kit.pane(0x8fa6b8, 0.18, ww, wh, wx, wy0 + wh / 2, wz + 3);
    // Recoater (and for MJF the print carriage): a bar across the bed, swept in x.
    const bz0 = cz0 + 10, bz1 = cz1 - 10;
    kit.box('recoater', proc === 'dmls' ? LOOK.steel : LOOK.black, -12, cy, bz0, 12, cy + 30, bz1);
    if (proc === 'mjf') kit.box('recoater', LOOK.grey, -40, cy + 30, bz0, 40, cy + 60, bz1);
    // Touchscreen beside the window, status light tower.
    const lx = Math.min(W / 2 - 90, wx + ww / 2 + 110), ly = wy0 + wh * 0.55;
    const lcd = { parent: 'static', pos: [lx, ly, D / 2 + 0.8], rot: [0, 0, 0], size: [130, 70] };
    kit.box('static', LOOK.screenOff, lx - 72, ly - 44, D / 2, lx + 72, ly + 44, D / 2 + 0.6);
    const tx = W / 2 - 60, tz = -D / 2 + 80;
    kit.add('static', C(8, 120, 10), LOOK.steel, tx, H + 60, tz);
    [LOOK.greenDim, LOOK.amberDim, LOOK.redDim].forEach((lk, i) => kit.add('static', C(26, 34, 16), lk, tx, H + 130 + i * 36, tz));
    const tower = { x: tx, y: H + 130, z: tz, step: 36 };
    return {
      kin: 'powder', process: proc, kit, tip: [wx, cy, wz - by / 2 - 35], BS: cy, NZ: wz - by / 2 - 35, fans: [], spools: [], lcd,
      lamp: null, tower,
      nodes: { recoater: 'root' },
      partAnchor: { parent: 'root', pos: [wx, cy, (cz0 + cz1) / 2] },
      powderBed: { x: wx, y: cy, z: (cz0 + cz1) / 2, w: bx, d: by, sweep: [wx - bx / 2 - 22, wx + bx / 2 + 22], ceiling: wy0 + wh - 12 - cy },
      fuser: proc === 'mjf' ? { pos: [0, cy + 8, (bz0 + bz1) / 2], size: [70, 10, bz1 - bz0 - 8] } : null,
      bounds: [-W / 2, 0, -D / 2, W / 2, H + 230, D / 2],
      floor: true,
    };
  }

  function metalX(printer) {
    // The printer (bound-metal FFF in a heated cabinet) with its wash station and sintering furnace.
    const t = corexy({ ...printer, enclosed: true, multiMaterialColors: 0, brand: printer.brand }, false);
    const kit = t.kit;
    const H = printer.buildVolumeMM[2] + 210;
    const W = printer.buildVolumeMM[0] + 135;
    // Stand under the printer (the whole printer is lifted onto it).
    const lift = 480;
    for (const list of Object.values(kit.g)) for (const g of list) g.translate(0, lift, 0);
    for (const g of kit.glass) g.translate(0, lift, 0);
    kit.box('static', LOOK.black, -W / 2 + 20, 0, -150, W / 2 - 20, lift, 150);
    kit.box('static', LOOK.grey, -W / 2, lift - 20, -t.bounds[5] + 10, W / 2, lift, t.bounds[5] - 10);
    // Wash station (a tank with a window) and the furnace (a box with a round door), a step back.
    const wx = W / 2 + 190, sx = W / 2 + 620, sz = -120;
    kit.rbox('static', LOOK.white, wx - 150, 0, sz - 150, wx + 150, 420, sz + 150, 8);
    kit.box('static', LOOK.black, wx - 156, 420, sz - 156, wx + 156, 444, sz + 156);
    kit.box('static', LOOK.screenOff, wx - 90, 250, sz + 150, wx + 90, 350, sz + 151);
    kit.rbox('static', LOOK.white, sx - 240, 0, sz - 240, sx + 240, 780, sz + 240, 10);
    kit.add('static', C(118, 16, 28), LOOK.steel, sx, 430, sz + 240, PI / 2);
    kit.box('static', LOOK.black, sx - 190, 660, sz + 240, sx + 190, 740, sz + 241);
    const raise = (p) => [p[0], p[1] + lift, p[2]];
    return {
      ...t, kin: 'metal', kit,
      tip: raise(t.tip), BS: t.BS + lift,
      fans: t.fans.map((f) => ({ ...f, pos: raise(f.pos) })), spools: t.spools.map((s) => ({ ...s, pos: raise(s.pos) })),
      lcd: { ...t.lcd, pos: raise(t.lcd.pos) }, lamp: { ...t.lamp, pos: raise(t.lamp.pos) },
      partAnchor: { ...t.partAnchor, pos: raise(t.partAnchor.pos) }, filament: { head: raise(t.filament.head) },
      stations: { wash: { x: wx, y: 300, z: sz + 151, w: 180, h: 100 }, sinter: { x: sx, y: 430, z: sz + 249, r: 100 } },
      bounds: [t.bounds[0], 0, Math.min(t.bounds[2], sz - 240), sx + 240, H + lift + 20, Math.max(t.bounds[5], sz + 250)],
      floor: true,
    };
  }

  // ---------------------------------------------------------------------
  // Templates (built once per printer model) and rigs (one per card)
  // ---------------------------------------------------------------------
  const templates = new Map();
  function template(printer) {
    let t = templates.get(printer.id);
    if (t) return t;
    const kin = M.kinematicsOf(printer);
    const raw = kin === 'bedslinger' ? bedslinger(printer, false)
      : kin === 'cantilever' ? bedslinger(printer, true)
      : kin === 'idex' ? corexy(printer, true)
      : kin === 'vat' ? vat(printer)
      : kin === 'powder' ? powder(printer)
      : kin === 'metal' ? metalX(printer)
      : corexy(printer, false);
    // Spools: the spares that never turn (other AMS slots, a second head's spool) are painted into
    // the static mesh in their own colours; only the job's spool is a mesh of its own.
    const spoolGeo = new Map();
    const jobSpools = [];
    for (const s of raw.spools) {
      const k = s.r + 'x' + s.w;
      if (!spoolGeo.has(k)) spoolGeo.set(k, spoolParts(s.r, s.w));
      if (s.job) { jobSpools.push(s); continue; }
      const sp = spoolGeo.get(k);
      const mtx = new THREE.Matrix4().makeRotationY(s.axis === 'z' ? PI / 2 : 0).setPosition(s.pos[0], s.pos[1], s.pos[2]);
      const list = raw.kit.g[s.parent] || (raw.kit.g[s.parent] = []);
      list.push(sp.frame.clone().applyMatrix4(mtx), setAttrs(sp.fil.clone(), [s.fixed ?? 0xcccccc, 0.45, 0, 0.2, 0]).applyMatrix4(mtx));
    }
    const geos = raw.kit.build();
    const fanGeo = new Map();
    for (const f of raw.fans) if (!fanGeo.has(f.r)) fanGeo.set(f.r, fanBlades(f.r));
    let tris = 0;
    const count = (g) => { if (g) tris += (g.index ? g.index.count : g.attributes.position.count) / 3; };
    for (const g of Object.values(geos)) count(g);
    for (const f of raw.fans) count(fanGeo.get(f.r));
    for (const s of jobSpools) count(spoolGeo.get(s.r + 'x' + s.w).merged);
    t = { ...raw, spools: jobSpools, printer, kin: raw.kin || kin, geos, fanGeo, spoolGeo, triangles: tris };
    delete t.kit;
    templates.set(printer.id, t);
    return t;
  }

  // The machine's own screen: a small canvas, redrawn only when its words change.
  function makeLCD(size) {
    const cv = document.createElement('canvas');
    cv.width = 320; cv.height = 160;
    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 2;
    const mat = new THREE.MeshBasicMaterial({ map: tex, toneMapped: false });
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(size[0], size[1]), mat);
    let last = '';
    const TONE = { ok: ['#0d2a1d', '#bff5cf', '#3ddc84'], busy: ['#0c2230', '#c6ecff', '#38bdf8'], warn: ['#2e1d05', '#ffd98a', '#f59e0b'],
      done: ['#0b2a14', '#d4ffdc', '#22c55e'], idle: ['#16181c', '#d9dde2', '#8b949e'] };
    function draw(t) {
      const key = t.title + '|' + t.line + '|' + t.tone + '|' + (t.bar == null ? '' : Math.round(t.bar * 50));
      if (key === last) return false;
      last = key;
      const g = cv.getContext('2d');
      const [bg, fg, ac] = TONE[t.tone] || TONE.idle;
      g.fillStyle = bg; g.fillRect(0, 0, cv.width, cv.height);
      g.fillStyle = ac; g.fillRect(0, 0, cv.width, 6);
      const fit = (text, px, weight, maxW) => { let s = px; g.font = `${weight} ${s}px -apple-system, "Helvetica Neue", Arial, sans-serif`; while (g.measureText(text).width > maxW && s > 12) { s -= 1; g.font = `${weight} ${s}px -apple-system, "Helvetica Neue", Arial, sans-serif`; } };
      g.textBaseline = 'alphabetic';
      g.fillStyle = fg;
      fit(t.title, 34, 700, cv.width - 28); g.fillText(t.title, 14, 58);
      g.fillStyle = fg; g.globalAlpha = 0.78;
      fit(t.line || '', 24, 500, cv.width - 28); g.fillText(t.line || '', 14, 98);
      g.globalAlpha = 1;
      if (t.bar != null) {
        g.fillStyle = 'rgba(255,255,255,0.12)'; g.fillRect(14, 122, cv.width - 28, 14);
        g.fillStyle = ac; g.fillRect(14, 122, (cv.width - 28) * Math.max(0, Math.min(1, t.bar)), 14);
      }
      tex.needsUpdate = true;
      return true;
    }
    return { mesh, draw, dispose() { tex.dispose(); mat.dispose(); mesh.geometry.dispose(); } };
  }

  const STATUS = { idle: 0x30343a, ok: 0x38bdf8, busy: 0x38bdf8, warn: 0xf59e0b, done: 0x22c55e };
  function rig(printer, tier = 'high') {
    const t = template(printer);
    const mats = materials[tier];
    const root = new THREE.Group();
    root.name = 'machine:' + printer.id;
    const nodes = { root };
    const kitMeshes = [], glassMeshes = [];
    const mesh = (geo, mat, cast = true) => { const m = new THREE.Mesh(geo, mat); m.castShadow = cast; m.receiveShadow = true; return m; };
    // Moving groups, parented as the template says.
    const order = ['bed', 'gantry', 'ycar', 'head', 'head2', 'plate', 'recoater'];
    for (const name of order) {
      if (!(name in (t.nodes || {})) || t.nodes[name] === null) continue;
      const g = new THREE.Group(); g.name = name;
      nodes[name] = g;
    }
    for (const name of order) if (nodes[name]) (nodes[t.nodes[name]] || root).add(nodes[name]);
    for (const [name, geo] of Object.entries(t.geos)) {
      if (!geo || name === 'glass') continue;
      const m = mesh(geo, mats.kit, name !== 'static' || !t.floor);
      kitMeshes.push(m);
      (nodes[name] || root).add(m);
    }
    if (t.geos.glass) { const g = new THREE.Mesh(t.geos.glass, mats.glass); g.renderOrder = 2; glassMeshes.push(g); root.add(g); }
    // Fans.
    const fans = [];
    for (const f of t.fans) {
      const m = mesh(t.fanGeo.get(f.r), mats.kit, false);
      m.position.set(...f.pos);
      if (f.axis === 'x') m.rotation.y = PI / 2;
      kitMeshes.push(m);
      (nodes[f.parent] || root).add(m);
      fans.push(m);
    }
    // The job's spool: one mesh (its own copy, so its filament can take the job's colour).
    const spools = [];
    const paintSpool = (s, hex) => {
      tmpC.setHex(hex);
      const c = s.geo.attributes.color;
      for (let i = s.filStart; i < c.count; i++) c.setXYZ(i, tmpC.r, tmpC.g, tmpC.b);
      c.needsUpdate = true;
    };
    for (const s of t.spools) {
      const sg = t.spoolGeo.get(s.r + 'x' + s.w);
      const holder = new THREE.Group();
      holder.position.set(...s.pos);
      if (s.axis === 'z') holder.rotation.y = PI / 2;
      const geo = sg.merged.clone();
      const spin = mesh(geo, mats.kit, s.shadow !== false);
      kitMeshes.push(spin);
      holder.add(spin);
      (nodes[s.parent] || root).add(holder);
      const sp = { spin, geo, filStart: sg.filStart, job: true };
      paintSpool(sp, s.fixed ?? 0xcccccc);
      spools.push(sp);
    }
    // Screen and status light.
    const lcd = makeLCD(t.lcd.size);
    lcd.mesh.position.set(...t.lcd.pos);
    if (t.lcd.rot) lcd.mesh.rotation.set(...t.lcd.rot);
    (nodes[t.lcd.parent] || root).add(lcd.mesh);
    const lampMat = new THREE.MeshBasicMaterial({ color: STATUS.idle, toneMapped: false });
    let lamp = null;
    if (t.lamp) {
      lamp = new THREE.Mesh(new THREE.PlaneGeometry(t.lamp.size[0], t.lamp.size[1]), lampMat);
      lamp.position.set(...t.lamp.pos);
      root.add(lamp);
    } else if (t.tower) {
      lamp = new THREE.Mesh(new THREE.CylinderGeometry(27, 27, 32, 16), lampMat);
      lamp.position.set(t.tower.x, t.tower.y, t.tower.z);
      root.add(lamp);
    }
    // Resin in the vat: the job's resin colour; a UV flash lights it violet from below.
    let resinMat = null;
    if (t.vat) {
      resinMat = new THREE.MeshStandardMaterial({ color: 0x8d929a, roughness: 0.1, metalness: 0, transparent: true, opacity: 0.78, depthWrite: false });
      const resin = new THREE.Mesh(new THREE.BoxGeometry(t.vat.w, t.vat.level, t.vat.d), resinMat);
      resin.position.set(0, t.vat.y + t.vat.level / 2, t.vat.z);
      resin.renderOrder = 1;
      root.add(resin);
      glassMeshes.push(resin);   // (keeps its own material across tiers; listed here only for disposal)
    }
    // The flash itself: violet light filling the lower cover while the screen exposes a layer.
    let uvGlow = null;
    if (t.vat && t.vat.glow) {
      uvGlow = new THREE.Mesh(new THREE.BoxGeometry(...t.vat.glow.size),
        new THREE.MeshBasicMaterial({ color: 0x7a3cff, transparent: true, opacity: 0.2, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }));
      uvGlow.position.set(0, t.vat.glow.y, 0);
      uvGlow.renderOrder = 3;
      uvGlow.visible = false;
      root.add(uvGlow);
    }
    // MJF: the fusing lamp under the carriage, lit while it passes.
    let fuser = null;
    if (t.fuser && nodes.recoater) {
      fuser = new THREE.Mesh(new THREE.BoxGeometry(...t.fuser.size), new THREE.MeshBasicMaterial({ color: 0xffa24a, toneMapped: false }));
      fuser.position.set(...t.fuser.pos);
      fuser.visible = false;
      nodes.recoater.add(fuser);
    }
    // Nozzle (its own material so wear shows), for the nozzle classes.
    let nozzle = null, nozzleMat = null;
    if (M.NOZZLE_KINDS.has(t.kin) && nodes.head) {
      nozzleMat = new THREE.MeshStandardMaterial({ color: 0xc89b3c, roughness: 0.28, metalness: 1 });
      nozzle = new THREE.Mesh(new THREE.CylinderGeometry(4.5, 1.1, 5, 12), nozzleMat);
      nozzle.position.set(t.tip[0], t.tip[1] + 2.5, t.tip[2]);
      nodes.head.add(nozzle);
    }
    // Filament from the spool to the head: a thin line, bent, redrawn as the head moves.
    let filament = null;
    if (t.filament && spools.length && nodes.head) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(3 * 12), 3));
      filament = new THREE.Line(g, new THREE.LineBasicMaterial({ color: 0xffffff }));
      filament.frustumCulled = false;
      root.add(filament);
    }
    // Where parts go: on the bed (or hanging under a resin plate).
    const partAnchor = new THREE.Group();
    partAnchor.name = 'partAnchor';
    partAnchor.position.set(...t.partAnchor.pos);
    partAnchor.rotation.x = t.partAnchor.flip ? PI / 2 : -PI / 2;
    (nodes[t.partAnchor.parent] || root).add(partAnchor);

    const tipLocal = new THREE.Vector3(...t.tip);
    const v = new THREE.Vector3(), w = new THREE.Vector3();
    let spoolAngle = 0, fanAngle = 0, lastSpoolColor = -1;
    const zAxis = t.zAxis;
    const api = {
      t, root, nodes, partAnchor, lcd, kin: t.kin, zAxis, BS: t.BS, NZ: t.NZ, tipHome: t.tip, bounds: t.bounds, floor: t.floor,
      triangles: t.triangles,
      // Axis offsets (mm) from motion.poseFor.
      setPose(p) {
        if (nodes.bed) { nodes.bed.position.z = -(p.bedY || 0); nodes.bed.position.y = p.bedZ || 0; }
        if (nodes.gantry) nodes.gantry.position.y = p.gantryZ || 0;
        if (nodes.ycar) nodes.ycar.position.z = -(p.headY || 0);
        if (nodes.head) nodes.head.position.x = p.headX || 0;
        if (nodes.head2) nodes.head2.position.x = p.head2X != null && p.head2X !== 0 ? p.head2X : (t.head2 ? t.head2.parkX : 0);
        if (nodes.plate) nodes.plate.position.y = p.plateZ || 0;
      },
      setRecoater(x) { if (nodes.recoater) nodes.recoater.position.x = x; },
      spin(dt, spoolRate, fanOn) {
        spoolAngle += dt * spoolRate;
        for (const s of spools) s.spin.rotation.x = spoolAngle;
        if (fanOn) { fanAngle += dt * 28; for (const f of fans) f.rotation.z = fanAngle; }
      },
      setFilament(hex) {
        if (hex === lastSpoolColor) return;
        lastSpoolColor = hex;
        for (const s of spools) paintSpool(s, hex);
        if (filament) filament.material.color.setHex(hex);
      },
      setStatus(tone) { lampMat.color.setHex(STATUS[tone] ?? STATUS.idle); },
      setNozzleWear(health) {
        if (!nozzleMat) return;
        const h = Math.max(0, Math.min(1, health));
        nozzleMat.color.setRGB(0.58 * (0.55 + 0.45 * h), 0.36 * (0.5 + 0.5 * h), 0.12 * (0.6 + 0.4 * h));
        nozzleMat.roughness = 0.28 + (1 - h) * 0.55;
      },
      // The nozzle tip in world space (for the probe and the filament line).
      tipWorld(out = new THREE.Vector3()) { return nodes.head ? nodes.head.localToWorld(out.copy(tipLocal)) : out.set(...t.tip); },
      updateFilament() {
        if (!filament) return;
        const s = spools.find((x) => x.job) || spools[0];
        s.spin.getWorldPosition(v);
        nodes.head.localToWorld(w.set(...t.filament.head));
        const a = filament.geometry.attributes.position;
        const n = a.count;
        // A gentle sag from the top of the spool to the head.
        const top = v.y + 60;
        for (let i = 0; i < n; i++) {
          const f = i / (n - 1);
          const x = v.x + (w.x - v.x) * f, z = v.z + (w.z - v.z) * f;
          const y = (1 - f) * (1 - f) * top + 2 * (1 - f) * f * (Math.max(top, w.y) + 30) + f * f * w.y;
          a.setXYZ(i, x, y, z);
        }
        a.needsUpdate = true;
      },
      setTier(tier2) {
        const m = materials[tier2];
        for (const k of kitMeshes) k.material = m.kit;
        for (const g of glassMeshes) if (g.material !== resinMat) g.material = m.glass;
      },
      setResin(hex, uv) {
        if (!resinMat) return;
        resinMat.color.setHex(hex);
        resinMat.emissive.setHex(uv ? 0x8a4dff : 0x000000);
        resinMat.emissiveIntensity = uv ? 1.4 : 0;
        if (uvGlow) uvGlow.visible = !!uv;
      },
      setFuser(on) { if (fuser) fuser.visible = !!on; },
      dispose() {
        lcd.dispose();
        lampMat.dispose();
        if (lamp) lamp.geometry.dispose();
        if (nozzle) { nozzle.geometry.dispose(); nozzleMat.dispose(); }
        if (filament) { filament.geometry.dispose(); filament.material.dispose(); }
        for (const s of spools) s.geo.dispose();
        if (resinMat) { resinMat.dispose(); for (const g of glassMeshes) if (g.material === resinMat) g.geometry.dispose(); }
        if (fuser) { fuser.geometry.dispose(); fuser.material.dispose(); }
        if (uvGlow) { uvGlow.geometry.dispose(); uvGlow.material.dispose(); }
      },
    };
    if (t.tower) {
      // Stack light: green while it works or when it's done, amber when it needs someone, dark when idle.
      api.setStatus = (tone) => {
        lamp.visible = tone !== 'idle';
        lampMat.color.setHex(tone === 'warn' ? 0xf59e0b : 0x22c55e);
        lamp.position.y = t.tower.y + (tone === 'warn' ? 1 : 0) * t.tower.step;
      };
    }
    api.setPose(M.poseFor(t.kin, { x: 0, y: 0, z: 30 }, { zAxis }));
    return api;
  }

  return {
    template, rig, materials,
    // Building blocks the rooms reuse (same kit material, same merging).
    tools: { Kit, LOOK, paint, B, C, R, place, mergeList, setAttrs, kitMaterial },
    dispose() {
      for (const t of templates.values()) {
        for (const g of Object.values(t.geos)) if (g) g.dispose();
        for (const g of t.fanGeo.values()) g.dispose();
        for (const s of t.spoolGeo.values()) { s.frame.dispose(); s.fil.dispose(); s.merged.dispose(); }
      }
      templates.clear();
      for (const m of Object.values(materials)) { m.kit.dispose(); m.glass.dispose(); }
    },
  };
}
