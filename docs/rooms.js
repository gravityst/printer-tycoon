// =====================================================================
// Print3D rooms: the workshop around each printer, chosen by the shop's level.
//
//   garage    concrete floor, pegboard and hand tools over a wooden bench
//   studio    plank floor, a wood bench, a shelf of spools and a window letting light in
//   workshop  epoxy floor, steel bench and racks of bins, a tool chest, strip lights
//   factory   a hall: polished concrete with floor markings, ribbed cladding, high windows, pallets
//
// Low-poly and vertex-coloured: a room is two meshes (walls and floor in a matte Lambert, props in
// the machines' kit material, which carries each prop's roughness, metalness and glow per vertex).
// On the Low tier a room is one unlit backdrop (floor and wall in one mesh) plus a baked soft
// shadow under the machine. Desktop machines stand on a bench; floor machines on the floor.
//
// createRooms(ctx, machines) -> { room(kind, size, tier), light(kind), dispose }
//   size: { w, d, h, floor } of the machine in mm (footprint, height, stands on the floor).
// =====================================================================

export const ROOM_LIGHT = {
  garage:   { key: [0xffdcb4, 2.7], fill: [0xb7cdfa, 0.75], hemi: [0xdde6f2, 0x6a5946, 0.6],  bg: 0x2b2926, env: 0.85 },
  studio:   { key: [0xfff0da, 2.4], fill: [0xcfe2ff, 1.35], hemi: [0xeef4ff, 0x8a7a66, 0.72], bg: 0x3a3631, env: 0.95 },
  workshop: { key: [0xfff6ea, 2.6], fill: [0xc6dbff, 0.85], hemi: [0xe7edf5, 0x56606a, 0.62], bg: 0x2a2f33, env: 1.0 },
  factory:  { key: [0xf1f5ff, 2.7], fill: [0xbdd4ff, 0.9],  hemi: [0xe5edf7, 0x4f555d, 0.66], bg: 0x252a2e, env: 1.0 },
};

export function createRooms(ctx, machines) {
  const { THREE } = ctx;
  const tools = machines.tools;
  const { Kit, C } = tools;
  const PI = Math.PI;

  const shellMat = new THREE.MeshLambertMaterial({ vertexColors: true });
  shellMat.customProgramCacheKey = () => 'p3d-room-shell';
  const backdropMat = new THREE.MeshBasicMaterial({ vertexColors: true });
  backdropMat.customProgramCacheKey = () => 'p3d-room-backdrop';
  const kitMats = { high: machines.materials.high.kit, medium: machines.materials.medium.kit, low: machines.materials.low.kit };

  // A soft round shadow, baked once into a small texture (the Low tier's only shadow).
  const shadowTex = (() => {
    const cv = document.createElement('canvas');
    cv.width = cv.height = 128;
    const g = cv.getContext('2d');
    const grd = g.createRadialGradient(64, 64, 8, 64, 64, 62);
    grd.addColorStop(0, 'rgba(0,0,0,0.62)');
    grd.addColorStop(0.55, 'rgba(0,0,0,0.32)');
    grd.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = grd; g.fillRect(0, 0, 128, 128);
    const t = new THREE.CanvasTexture(cv);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  })();
  const shadowMat = new THREE.MeshBasicMaterial({ map: shadowTex, transparent: true, depthWrite: false, toneMapped: false });

  const m = (hex, r = 0.85, met = 0, cc = 0, glow = 0) => [hex, r, met, cc, glow];
  const K = {
    wood: m(0x9a6a3e, 0.6, 0, 0.2), woodDark: m(0x6e4a2b, 0.65), birch: m(0xd6b88c, 0.55, 0, 0.25), white: m(0xeceae4, 0.6), steel: m(0x8b9096, 0.38, 0.85),
    steelDark: m(0x4b5056, 0.45, 0.8), blue: m(0x3e5e8c, 0.5, 0.3, 0.3), red: m(0xb8322a, 0.4, 0.2, 0.6), yellow: m(0xe0b23a, 0.5, 0, 0.3),
    card: m(0xb48a5a, 0.9), peg: m(0xc8a679, 0.85), hole: m(0x5e4a31, 0.9), terracotta: m(0xb5643c, 0.8), leaf: m(0x3e8e4f, 0.7),
    glowWhite: m(0xf4f8ff, 0.5, 0, 0, 2.0), glowSky: m(0xdcecff, 0.5, 0, 0, 1.5), epoxy: m(0x6c7a76, 0.22, 0.05, 0.9), polished: m(0x9b9d9f, 0.42, 0.05, 0.5),
    line: m(0xe5b52a, 0.6), walk: m(0x4f7d5c, 0.6), rubber: m(0x1d1e20, 0.9),
  };
  const SPOOL_COLORS = [0xc62d2d, 0xee6a1f, 0xf2cf1d, 0x2f9a46, 0x138c8c, 0x2a52be, 0x7d3fa6, 0xec79aa, 0xefebe2, 0x1d1e20];

  // Shell: floor and walls as coloured quads (a few strips for planks, blocks, corrugation).
  function quad(list, hex, x0, y0, z0, x1, y1, z1, axis) {
    // axis: 'y' = horizontal (floor) quad, 'z' = facing +z (back wall), 'x' = facing +x (left wall)
    const g = axis === 'y' ? new THREE.PlaneGeometry(Math.abs(x1 - x0), Math.abs(z1 - z0)).rotateX(-PI / 2)
      : axis === 'z' ? new THREE.PlaneGeometry(Math.abs(x1 - x0), Math.abs(y1 - y0))
      : new THREE.PlaneGeometry(Math.abs(z1 - z0), Math.abs(y1 - y0)).rotateY(PI / 2);
    g.translate((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
    g.deleteAttribute('uv');
    const n = g.attributes.position.count, c = new THREE.Color(hex), col = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) { col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b; }
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    list.push(g);
  }

  function frameOf(size) {
    const w = Math.max(250, size.w), d = Math.max(220, size.d), h = Math.max(250, size.h);
    const floorY = size.floor ? 0 : -900;
    const zb = -(d / 2 + (size.floor ? 520 : 230));
    const xL = -(w / 2 + Math.max(900, 1.5 * w)), xR = w / 2 + Math.max(1300, 1.9 * w);
    const yT = floorY + Math.max(2700, h + 1700 - floorY * 0.2);
    const zF = d / 2 + Math.max(2200, 3 * d);
    return { w, d, h, floorY, zb, xL, xR, yT, zF, floor: size.floor };
  }

  // ---------------------------------------------------------------------
  function bench(kit, f, top, legs) {
    const bx = f.w / 2 + 430, z0 = -(f.d / 2 + 140), z1 = f.d / 2 + 170;
    kit.box('p', top, -bx, -42, z0, bx, 0, z1);
    for (const sx of [-1, 1]) for (const z of [z0 + 40, z1 - 40]) kit.box('p', legs, sx * (bx - 50) - 25, f.floorY, z - 25, sx * (bx - 50) + 25, -42, z + 25);
    kit.box('p', legs, -bx + 40, -720, z0 + 30, bx - 40, -700, z1 - 30);   // lower shelf
    return { bx, z0, z1 };
  }

  function garage(f) {
    const shell = [], kit = new Kit();
    quad(shell, 0x8b8883, f.xL, f.floorY, f.zb, f.xR, f.floorY, f.zF, 'y');
    quad(shell, 0x7d7a75, -f.w * 0.9, f.floorY + 0.5, f.d * 0.2, f.w * 0.4, f.floorY + 0.5, f.d * 1.2, 'y');     // oil stain
    quad(shell, 0xb5b0a6, f.xL, f.floorY, f.zb, f.xR, f.floorY + 1300, f.zb, 'z');
    quad(shell, 0xc8c2b6, f.xL, f.floorY + 1300, f.zb, f.xR, f.yT, f.zb, 'z');
    // The garage door on the left: ribbed white panels.
    for (let i = 0; i < 8; i++) quad(shell, i % 2 ? 0xd9d5cc : 0xe3dfd7, f.xL, f.floorY + i * 300, f.zb, f.xL, f.floorY + (i + 1) * 300, f.zF * 0.5, 'x');
    if (!f.floor) {
      const b = bench(kit, f, K.wood, K.steelDark);
      // Pegboard over the bench, with its holes and a few hand tools.
      const px = f.w / 2 + 280, py0 = 160, py1 = Math.min(f.h + 520, 1300);
      kit.box('p', K.peg, -px, py0, f.zb + 1, px, py1, f.zb + 10);
      const cols = 22, rows = 9;
      for (let i = 0; i < cols; i++) for (let j = 0; j < rows; j++) {
        const g = new THREE.PlaneGeometry(7, 7);
        kit.add('p', g, K.hole, -px + (i + 0.5) * (2 * px / cols), py0 + (j + 0.5) * ((py1 - py0) / rows), f.zb + 10.6);
      }
      const ty = py0 + (py1 - py0) * 0.55;
      kit.box('p', K.steel, -px + 60, ty - 120, f.zb + 12, -px + 76, ty + 60, f.zb + 18);                      // wrench
      kit.add('p', C(22, 6, 12), K.steel, -px + 68, ty + 80, f.zb + 15, PI / 2);
      kit.box('p', K.woodDark, -px + 140, ty - 140, f.zb + 12, -px + 156, ty + 40, f.zb + 22);                // hammer
      kit.box('p', K.steelDark, -px + 118, ty + 40, f.zb + 10, -px + 178, ty + 70, f.zb + 26);
      kit.box('p', K.red, px - 160, ty - 60, f.zb + 12, px - 144, ty + 30, f.zb + 22);                         // screwdrivers
      kit.box('p', K.yellow, px - 120, ty - 70, f.zb + 12, px - 104, ty + 30, f.zb + 22);
      kit.box('p', K.blue, px - 80, ty - 50, f.zb + 12, px - 64, ty + 30, f.zb + 22);
      // Under the bench: a red toolbox and paint cans.
      kit.box('p', K.red, -b.bx + 80, -700, b.z0 + 60, -b.bx + 420, -520, b.z0 + 300);
      kit.box('p', K.steel, -b.bx + 200, -520, b.z0 + 160, -b.bx + 300, -500, b.z0 + 200);
      [[0x3d6fb6, 140], [0xd6b13a, 300], [0xe9e9e6, 460]].forEach(([hex, x]) => kit.add('p', C(80, 200, 12), m(hex, 0.5, 0.3, 0.3), b.bx - x, -600, b.z0 + 160));
    } else {
      kit.box('p', K.card, f.xL + 300, 0, f.zb + 40, f.xL + 900, 500, f.zb + 600);
      kit.box('p', K.card, f.xL + 360, 500, f.zb + 80, f.xL + 760, 800, f.zb + 480);
    }
    kit.box('p', K.glowWhite, -f.w * 0.6, f.floorY + 2150, f.zb + 2, f.w * 0.6, f.floorY + 2180, f.zb + 30);       // shop light
    return { shell, kit };
  }

  function studio(f) {
    const shell = [], kit = new Kit();
    const planks = 18, span = f.zF - f.zb;
    for (let i = 0; i < planks; i++) quad(shell, [0xb7875a, 0xa8784c, 0xc19361][i % 3], f.xL, f.floorY, f.zb + i * span / planks, f.xR, f.floorY, f.zb + (i + 1) * span / planks, 'y');
    quad(shell, 0xdcd5c6, f.xL, f.floorY, f.zb, f.xR, f.yT, f.zb, 'z');
    quad(shell, 0x5c6c8d, -f.w * 1.1, f.floorY + 1, f.d * 0.3, f.w * 1.3, f.floorY + 1, f.d * 2.2, 'y');            // rug
    // Left wall with a window (built around the opening), sage green.
    const wz0 = f.zb + 300, wz1 = f.zb + 300 + Math.max(900, f.d * 1.6), wy0 = f.floorY + 1000, wy1 = f.floorY + 2100;
    quad(shell, 0xc6d0c4, f.xL, f.floorY, f.zb, f.xL, wy0, f.zF * 0.6, 'x');
    quad(shell, 0xc6d0c4, f.xL, wy1, f.zb, f.xL, f.yT, f.zF * 0.6, 'x');
    quad(shell, 0xc6d0c4, f.xL, wy0, f.zb, f.xL, wy1, wz0, 'x');
    quad(shell, 0xc6d0c4, f.xL, wy0, wz1, f.xL, wy1, f.zF * 0.6, 'x');
    const g = new THREE.PlaneGeometry(wz1 - wz0, wy1 - wy0).rotateY(PI / 2);
    kit.add('p', g, K.glowSky, f.xL + 2, (wy0 + wy1) / 2, (wz0 + wz1) / 2);
    kit.box('p', K.white, f.xL + 2, wy0 - 20, wz0 - 20, f.xL + 40, wy0, wz1 + 20);
    kit.box('p', K.white, f.xL + 2, wy1, wz0 - 20, f.xL + 30, wy1 + 20, wz1 + 20);
    kit.box('p', K.white, f.xL + 2, wy0, (wz0 + wz1) / 2 - 10, f.xL + 30, wy1, (wz0 + wz1) / 2 + 10);
    kit.box('p', K.white, f.xL + 2, (wy0 + wy1) / 2 - 10, wz0, f.xL + 30, (wy0 + wy1) / 2 + 10, wz1);
    if (!f.floor) {
      const b = bench(kit, f, K.birch, K.white);
      // A shelf of spools on the back wall.
      const sx = f.w / 2 + 300, sy = Math.min(f.h + 260, 900);
      for (const y of [sy, sy + 280]) kit.box('p', K.woodDark, -sx, y - 20, f.zb + 1, sx, y, f.zb + 200);
      let k = 0;
      for (const y of [sy, sy + 280]) for (let x = -sx + 110; x < sx - 80; x += 190) {
        const hex = SPOOL_COLORS[k++ % SPOOL_COLORS.length];
        kit.add('p', C(95, 70, 16), m(0x4b4e54, 0.5), x, y + 95, f.zb + 100, PI / 2);
        kit.add('p', C(78, 74, 16), m(hex, 0.45, 0, 0.2), x, y + 95, f.zb + 100, PI / 2);
      }
      // A plant at the end of the bench.
      const px = b.bx - 150;
      kit.add('p', C(70, 150, 12, 90), K.terracotta, px, 75, b.z0 + 120);
      for (let i = 0; i < 6; i++) kit.add('p', new THREE.ConeGeometry(40, 260, 5), K.leaf, px + Math.cos(i) * 40, 260, b.z0 + 120 + Math.sin(i) * 40, Math.sin(i) * 0.4, 0, Math.cos(i) * 0.4);
    } else {
      kit.box('p', K.woodDark, f.xR - 900, 0, f.zb + 20, f.xR - 300, 1500, f.zb + 400);
    }
    // A framed print on the wall.
    kit.box('p', K.woodDark, -f.w / 2 - 520, f.floorY + 1500, f.zb + 1, -f.w / 2 - 120, f.floorY + 2000, f.zb + 12);
    kit.box('p', m(0x2a52be, 0.8), -f.w / 2 - 500, f.floorY + 1520, f.zb + 13, -f.w / 2 - 320, f.floorY + 1980, f.zb + 14);
    kit.box('p', m(0xf0a020, 0.8), -f.w / 2 - 320, f.floorY + 1520, f.zb + 13, -f.w / 2 - 140, f.floorY + 1760, f.zb + 14);
    return { shell, kit };
  }

  function workshop(f) {
    const shell = [], kit = new Kit();
    kit.box('p', K.epoxy, f.xL, f.floorY - 4, f.zb, f.xR, f.floorY, f.zF);
    quad(shell, 0x969ca0, f.xL, f.floorY, f.zb, f.xR, f.floorY + 1050, f.zb, 'z');
    quad(shell, 0xd2ab38, f.xL, f.floorY + 1050, f.zb, f.xR, f.floorY + 1120, f.zb, 'z');
    quad(shell, 0xb6bbbf, f.xL, f.floorY + 1120, f.zb, f.xR, f.yT, f.zb, 'z');
    quad(shell, 0xa7adb2, f.xL, f.floorY, f.zb, f.xL, f.yT, f.zF * 0.6, 'x');
    if (!f.floor) {
      const b = bench(kit, f, K.steel, K.blue);
      kit.box('p', K.red, -b.bx - 700, f.floorY, f.zb + 40, -b.bx - 120, f.floorY + 1000, f.zb + 520);   // tool chest
      for (let i = 0; i < 5; i++) kit.box('p', K.steel, -b.bx - 660, f.floorY + 120 + i * 170, f.zb + 521, -b.bx - 160, f.floorY + 140 + i * 170, f.zb + 530);
    }
    // Racks of bins on the right.
    const rx = (f.floor ? f.w / 2 + 500 : f.w / 2 + 560);
    for (const x of [rx, rx + 900]) kit.box('p', K.blue, x, f.floorY, f.zb + 10, x + 50, f.floorY + 2200, f.zb + 60);
    const bins = [K.red, m(0x2f6fb5, 0.5, 0, 0.4), K.yellow];
    for (let s = 0; s < 4; s++) {
      const y = f.floorY + 300 + s * 480;
      kit.box('p', K.steel, rx, y - 16, f.zb + 10, rx + 950, y, f.zb + 520);
      for (let i = 0; i < 4; i++) kit.box('p', bins[(s + i) % 3], rx + 70 + i * 215, y, f.zb + 60, rx + 250 + i * 215, y + 200, f.zb + 420);
    }
    for (const x of [-f.w * 0.7, f.w * 0.3]) kit.box('p', K.glowWhite, x - 400, f.floorY + 2300, f.zb + 2, x + 400, f.floorY + 2330, f.zb + 40);
    return { shell, kit };
  }

  function factory(f) {
    const shell = [], kit = new Kit();
    kit.box('p', K.polished, f.xL, f.floorY - 4, f.zb, f.xR, f.floorY, f.zF);
    // Floor markings: a yellow box round the machine and a green walkway in front.
    const mx = f.w / 2 + 260, mz0 = -f.d / 2 - 200, mz1 = f.d / 2 + 260;
    for (const [x0, z0, x1, z1] of [[-mx, mz0, mx, mz0 + 60], [-mx, mz1 - 60, mx, mz1], [-mx, mz0, -mx + 60, mz1], [mx - 60, mz0, mx, mz1]]) kit.box('p', K.line, x0, f.floorY, z0, x1, f.floorY + 1.5, z1);
    kit.box('p', K.walk, f.xL, f.floorY, mz1 + 400, f.xR, f.floorY + 1.5, mz1 + 1300);
    // Back wall: a painted dado and ribbed metal cladding above it (the ribs are thin boxes, so the
    // light gives them relief without stripes), high windows.
    const dado = f.floorY + 1150;
    quad(shell, 0x5f676f, f.xL, f.floorY, f.zb, f.xR, dado, f.zb, 'z');
    quad(shell, 0x9ba2a8, f.xL, dado, f.zb, f.xR, f.yT, f.zb, 'z');
    for (let x = f.xL + 120; x < f.xR - 60; x += 240) kit.box('p', m(0x7f868c, 0.85, 0), x - 14, dado + 4, f.zb + 1, x + 14, f.yT, f.zb + 6);
    kit.box('p', K.steelDark, f.xL, dado - 6, f.zb + 1, f.xR, dado + 6, f.zb + 9);
    quad(shell, 0x969da3, f.xL, f.floorY, f.zb, f.xL, f.yT, f.zF * 0.6, 'x');
    for (let i = 0; i < 5; i++) {
      const x = f.xL + 500 + i * (f.xR - f.xL - 1000) / 4;
      kit.box('p', K.glowSky, x - 300, f.yT - 700, f.zb + 1, x + 300, f.yT - 300, f.zb + 4);
    }
    // A steel column in the far corner (a safety band at its foot), pallets of boxes.
    const cx = f.xL + 170;
    kit.box('p', K.steelDark, cx - 50, f.floorY, f.zb + 30, cx + 50, f.yT, f.zb + 130);
    kit.box('p', K.yellow, cx - 53, f.floorY, f.zb + 27, cx + 53, f.floorY + 240, f.zb + 133);
    const px = f.w / 2 + 700;
    kit.box('p', K.woodDark, px, f.floorY, f.zb + 120, px + 1200, f.floorY + 140, f.zb + 920);
    kit.box('p', K.card, px + 40, f.floorY + 140, f.zb + 160, px + 560, f.floorY + 560, f.zb + 560);
    kit.box('p', K.card, px + 600, f.floorY + 140, f.zb + 200, px + 1140, f.floorY + 480, f.zb + 860);
    kit.box('p', K.card, px + 120, f.floorY + 560, f.zb + 200, px + 500, f.floorY + 860, f.zb + 520);
    if (!f.floor) bench(kit, f, K.steel, K.steelDark);
    return { shell, kit };
  }

  // The Low tier's whole room: floor and wall in one unlit mesh with baked light.
  function backdrop(kind, f) {
    const pal = {
      garage: [0x8f6a45, 0xb3ada2, 0x6e6a64], studio: [0xc9a97e, 0xddd6c7, 0xa98a63], workshop: [0x8f949a, 0xb2b7bb, 0x5f6b67], factory: [0x9b9d9f, 0x8f969c, 0x6f7377],
    }[kind] || [0x888888, 0xaaaaaa, 0x666666];
    const top = 0;
    const zb = f.zb;
    const pos = [], col = [];
    const c = new THREE.Color();
    const quadV = (a, b, cc, d) => { pos.push(...a.p, ...b.p, ...cc.p, ...a.p, ...cc.p, ...d.p); for (const q of [a, b, cc, a, cc, d]) { c.setHex(q.h).multiplyScalar(q.s); col.push(c.r, c.g, c.b); } };
    const surf = pal[0];
    quadV({ p: [f.xL, top, f.zF], h: surf, s: 0.95 }, { p: [f.xR, top, f.zF], h: surf, s: 0.95 }, { p: [f.xR, top, zb], h: surf, s: 0.7 }, { p: [f.xL, top, zb], h: surf, s: 0.7 });
    quadV({ p: [f.xL, top, zb], h: pal[1], s: 0.62 }, { p: [f.xR, top, zb], h: pal[1], s: 0.62 }, { p: [f.xR, f.yT, zb], h: pal[1], s: 0.9 }, { p: [f.xL, f.yT, zb], h: pal[1], s: 0.9 });
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    g.computeVertexNormals();
    return g;
  }

  const cache = new Map();
  const BUILD = { garage, studio, workshop, factory };
  function geometryFor(kind, size) {
    const f = frameOf(size);
    const key = [kind, Math.round(f.w / 40), Math.round(f.d / 40), Math.round(f.h / 80), f.floor ? 1 : 0].join('|');
    let e = cache.get(key);
    if (e) return e;
    const built = (BUILD[kind] || garage)(f);
    const shell = built.shell.length ? tools.mergeList(built.shell) : null;
    const props = built.kit.build().p || null;
    const back = backdrop(kind, f);
    let tris = 0;
    for (const g of [shell, props]) if (g) tris += (g.index ? g.index.count : g.attributes.position.count) / 3;
    e = { shell, props, back, f, triangles: tris, key };
    cache.set(key, e);
    return e;
  }

  function room(kind, size, tier = 'high') {
    const e = geometryFor(kind, size);
    const group = new THREE.Group();
    group.name = 'room:' + kind;
    const full = new THREE.Group();
    const shell = e.shell ? new THREE.Mesh(e.shell, shellMat) : null;
    const props = e.props ? new THREE.Mesh(e.props, kitMats[tier]) : null;
    for (const mm of [shell, props]) if (mm) { mm.receiveShadow = true; mm.castShadow = false; full.add(mm); }
    const back = new THREE.Mesh(e.back, backdropMat);
    // The baked shadow under the machine (Low only).
    const sh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1).rotateX(-PI / 2), shadowMat);
    sh.scale.set(size.w * 1.35, 1, size.d * 1.45);
    sh.position.y = 0.8;
    sh.renderOrder = 1;
    group.add(full, back, sh);
    const api = {
      group, kind, key: e.key, triangles: e.triangles, frame: e.f,
      setTier(t) {
        const low = t === 'low';
        full.visible = !low;
        back.visible = low;
        sh.visible = low;
        if (props) props.material = kitMats[t] || kitMats.high;
      },
      dispose() { sh.geometry.dispose(); },
    };
    api.setTier(tier);
    return api;
  }

  return {
    room, light: (kind) => ROOM_LIGHT[kind] || ROOM_LIGHT.garage, materials: { shellMat, backdropMat, shadowMat, kitMats },
    dispose() {
      for (const e of cache.values()) { if (e.shell) e.shell.dispose(); if (e.props) e.props.dispose(); e.back.dispose(); }
      cache.clear();
      shellMat.dispose(); backdropMat.dispose(); shadowMat.dispose(); shadowTex.dispose();
    },
  };
}
