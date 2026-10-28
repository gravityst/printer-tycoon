// =====================================================================
// Print3D look data: the named filament palette, how each material looks and weighs, and which
// room the shop is in. Pure data and small lookups (no DOM, no THREE), shared by the renderer
// and the node tests.
// =====================================================================

// Customer colours. sim.js picks orders' colours from the same hex list (MODEL_PALETTE), so the
// index of an entry is what a seeded order draws; names are what the cards say.
export const FILAMENT_PALETTE = [
  { name: 'Signal Red',     hex: '#c62d2d' },
  { name: 'Traffic Orange', hex: '#ee6a1f' },
  { name: 'Marigold',       hex: '#f0a020' },
  { name: 'Lemon Yellow',   hex: '#f2cf1d' },
  { name: 'Lime Green',     hex: '#86b83a' },
  { name: 'Grass Green',    hex: '#2f9a46' },
  { name: 'Jade',           hex: '#1a9b7a' },
  { name: 'Teal',           hex: '#138c8c' },
  { name: 'Arctic Blue',    hex: '#3fb3d2' },
  { name: 'Sky Blue',       hex: '#4a9ad8' },
  { name: 'Cobalt Blue',    hex: '#2a52be' },
  { name: 'Indigo',         hex: '#3f3d9e' },
  { name: 'Lavender',       hex: '#8a6cc9' },
  { name: 'Grape',          hex: '#7d3fa6' },
  { name: 'Magenta',        hex: '#b8378e' },
  { name: 'Bubblegum Pink', hex: '#ec79aa' },
  { name: 'Ivory White',    hex: '#efebe2' },
  { name: 'Graphite Grey',  hex: '#47494d' },
  { name: 'Jet Black',      hex: '#1d1e20' },
  { name: 'Silver',         hex: '#a7abb0' },
];
// v4/v5 saves stored these 18 hexes; each keeps its place in the list.
export const LEGACY_PALETTE = [
  '#ef4444', '#f97316', '#f59e0b', '#eab308', '#84cc16', '#22c55e', '#10b981', '#14b8a6',
  '#06b6d4', '#0ea5e9', '#3b82f6', '#6366f1', '#8b5cf6', '#a855f7', '#d946ef', '#ec4899', '#fafafa', '#525252',
];

const hexRgb = (hex) => {
  const h = String(hex || '').replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
  return Number.isFinite(n) ? [(n >> 16) & 255, (n >> 8) & 255, n & 255] : [128, 128, 128];
};

// The palette entry for a stored colour: exact, then a legacy hex by its place, then the nearest.
export function colorOf(hex) {
  const h = String(hex || '').toLowerCase();
  const exact = FILAMENT_PALETTE.find((c) => c.hex === h);
  if (exact) return exact;
  const li = LEGACY_PALETTE.indexOf(h);
  if (li >= 0) return FILAMENT_PALETTE[li];
  const [r, g, b] = hexRgb(h);
  let best = FILAMENT_PALETTE[0], bd = Infinity;
  for (const c of FILAMENT_PALETTE) {
    const [r2, g2, b2] = hexRgb(c.hex);
    const d = (r - r2) ** 2 * 0.3 + (g - g2) ** 2 * 0.59 + (b - b2) ** 2 * 0.11;
    if (d < bd) { bd = d; best = c; }
  }
  return best;
}

// Surface finishes (physically based parameters the renderer turns into materials).
export const FINISHES = {
  satin:      { label: 'satin',               roughness: 0.42, metalness: 0,    clearcoat: 0.12, clearcoatRoughness: 0.5 },
  gloss:      { label: 'gloss',               roughness: 0.16, metalness: 0,    clearcoat: 0.8,  clearcoatRoughness: 0.08 },
  soft:       { label: 'soft touch',          roughness: 0.86, metalness: 0,    clearcoat: 0 },
  matte:      { label: 'matte',               roughness: 0.74, metalness: 0,    clearcoat: 0 },
  clear:      { label: 'clear gloss',         roughness: 0.06, metalness: 0,    clearcoat: 1,    clearcoatRoughness: 0.04, opacity: 0.55 },
  carbon:     { label: 'carbon speckle',      roughness: 0.66, metalness: 0.05, clearcoat: 0,    speckle: 1 },
  resin:      { label: 'cured resin',         roughness: 0.3,  metalness: 0,    clearcoat: 0.35, clearcoatRoughness: 0.2 },
  resinClear: { label: 'translucent resin',   roughness: 0.16, metalness: 0,    clearcoat: 0.5,  clearcoatRoughness: 0.1, opacity: 0.72 },
  powder:     { label: 'sintered nylon',      roughness: 0.93, metalness: 0,    clearcoat: 0,    grain: 1 },
  mjf:        { label: 'fused nylon',         roughness: 0.88, metalness: 0,    clearcoat: 0,    grain: 0.8 },
  sintered:   { label: 'sintered metal',      roughness: 0.58, metalness: 0.85, clearcoat: 0,    grain: 0.5 },
  bound:      { label: 'bound metal',         roughness: 0.8,  metalness: 0.25, clearcoat: 0,    grain: 0.3 },
};

// How each material looks and weighs. `color: null` takes the customer's colour; anything else is
// the colour the material comes in. Densities in g/cm³ (printed parts; sintered nylon is a little
// porous).
export const MATERIAL_LOOK = {
  'pla':                  { finish: 'satin',      color: null,      density: 1.24 },
  'pla-plus':             { finish: 'satin',      color: null,      density: 1.22 },
  'petg':                 { finish: 'gloss',      color: null,      density: 1.27 },
  'tpu-95a':              { finish: 'soft',       color: null,      density: 1.21 },
  'abs':                  { finish: 'matte',      color: null,      density: 1.04 },
  'asa':                  { finish: 'matte',      color: null,      density: 1.07 },
  'pc':                   { finish: 'clear',      color: null,      density: 1.20, tint: 0.3 },
  'nylon-pa12':           { finish: 'matte',      color: '#e9e3d3', density: 1.01 },
  'pa-cf':                { finish: 'carbon',     color: '#26272a', density: 1.17 },
  'peek':                 { finish: 'satin',      color: '#c4a676', density: 1.30 },
  'resin-standard':       { finish: 'resin',      color: '#8d929a', density: 1.12 },
  'resin-tough':          { finish: 'resin',      color: '#4a4d52', density: 1.15 },
  'resin-flexible':       { finish: 'resinClear', color: '#d8cba6', density: 1.10 },
  'resin-castable':       { finish: 'resinClear', color: '#6a46a0', density: 1.08 },
  'resin-engineering':    { finish: 'resin',      color: '#9aa0a6', density: 1.18 },
  'resin-surgical-guide': { finish: 'resinClear', color: '#e9dfb8', density: 1.18 },
  'onyx':                 { finish: 'carbon',     color: '#1e1f22', density: 1.18 },
  'nylon-white':          { finish: 'matte',      color: '#f1f1ec', density: 1.10 },
  'fiber-carbon':         { finish: 'carbon',     color: '#1e1f22', density: 1.40 },
  'fiber-kevlar':         { finish: 'matte',      color: '#cfa12e', density: 1.20 },
  'fiber-fiberglass':     { finish: 'matte',      color: '#f0f0ea', density: 1.50 },
  'sls-pa12':             { finish: 'powder',     color: '#ece9e2', density: 0.95 },
  'sls-pa11':             { finish: 'powder',     color: '#e6dfcf', density: 1.00 },
  'sls-pa12-gf':          { finish: 'powder',     color: '#dcddd8', density: 1.22 },
  'sls-tpu':              { finish: 'powder',     color: '#e8e6e2', density: 1.10 },
  'mjf-pa12':             { finish: 'mjf',        color: '#7e8086', density: 1.01 },
  'mjf-pa11':             { finish: 'mjf',        color: '#717379', density: 1.05 },
  'mjf-tpu':              { finish: 'mjf',        color: '#8c8e93', density: 1.10 },
  'mjf-pa12-gb':          { finish: 'mjf',        color: '#9a9ca0', density: 1.30 },
  'metal-ss316l':         { finish: 'sintered',   color: '#a3a6aa', density: 7.9 },
  'metal-ss17-4ph':       { finish: 'sintered',   color: '#9fa2a6', density: 7.8 },
  'metal-h13':            { finish: 'sintered',   color: '#80848a', density: 7.8 },
  'metal-a2':             { finish: 'sintered',   color: '#83878c', density: 7.86 },
  'metal-d2':             { finish: 'sintered',   color: '#7f8388', density: 7.7 },
  'metal-alsi10mg':       { finish: 'sintered',   color: '#b6b9bc', density: 2.67 },
  'metal-ti6al4v':        { finish: 'sintered',   color: '#9c9da1', density: 4.43 },
  'metal-inconel-625':    { finish: 'sintered',   color: '#a09d97', density: 8.44 },
  'metal-inconel-718':    { finish: 'sintered',   color: '#9d9a94', density: 8.19 },
  'metal-maraging':       { finish: 'sintered',   color: '#868a90', density: 8.1 },
  'metal-copper':         { finish: 'sintered',   color: '#b5704b', density: 8.9 },
};
const FALLBACK = { finish: 'satin', color: null, density: 1.2 };
export const BOUND_METAL = { finish: 'bound', color: '#6f7277' };   // Metal X parts before the furnace

// What a part looks like: colour, finish and the palette name (null for a material's own colour).
// `boundMetal` is the Metal X green part, grey and dull until it is sintered.
export function lookFor(materialId, colorHex, opts = {}) {
  const m = MATERIAL_LOOK[materialId] || FALLBACK;
  if (opts.boundMetal) return { ...FINISHES.bound, finishId: 'bound', color: BOUND_METAL.color, colorName: null, density: m.density };
  const f = FINISHES[m.finish] || FINISHES.satin;
  if (m.color) return { ...f, finishId: m.finish, color: m.color, colorName: null, density: m.density };
  const pal = colorOf(colorHex);
  let color = pal.hex;
  if (m.tint != null) {   // clear materials carry only a hint of the colour
    const [r, g, b] = hexRgb(pal.hex);
    const mix = (c) => Math.round(235 + (c - 235) * m.tint);
    color = '#' + [mix(r), mix(g), mix(b)].map((v) => Math.max(0, Math.min(255, v)).toString(16).padStart(2, '0')).join('');
  }
  return { ...f, finishId: m.finish, color, colorName: pal.name, density: m.density };
}
export const densityOf = (materialId) => (MATERIAL_LOOK[materialId] || FALLBACK).density;

// The shop's room follows its reputation tier in this round (round 3 moves it to the workshop
// ladder): garage and hobbyist in the garage, studio, pro in the workshop, then the factory.
export const ROOMS = ['garage', 'studio', 'workshop', 'factory'];
export function roomFor(reputation) {
  const r = reputation || 0;
  return r >= 150 ? 'factory' : r >= 75 ? 'workshop' : r >= 25 ? 'studio' : 'garage';
}
