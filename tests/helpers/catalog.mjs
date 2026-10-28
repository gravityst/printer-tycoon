// Loads the game's own data files into the same catalog game.js builds, for node tests.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as Sim from '../../docs/sim.js';

const root = new URL('../../', import.meta.url);
export const readJSON = (rel) => JSON.parse(readFileSync(fileURLToPath(new URL(rel, root)), 'utf8'));
export const readText = (rel) => readFileSync(fileURLToPath(new URL(rel, root)), 'utf8');

export const printersJson = readJSON('docs/data/printers.json');
export const materialsJson = readJSON('docs/data/materials.json');
export const productsJson = readJSON('docs/data/products.json');
export const cat = Sim.makeCatalog(printersJson, materialsJson, productsJson);

// The four v4 saves, as the exact strings the untouched game wrote.
export const FIXTURES = ['save-fresh', 'save-early', 'save-before', 'save-stress-20'];
export const fixtureText = (name) => readText(`tests/fixtures/${name}.json`);
export const fixture = (name) => JSON.parse(fixtureText(name));

export { Sim };
