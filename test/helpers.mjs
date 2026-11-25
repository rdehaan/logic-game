// Shared helpers for the tests.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// A random number generator with a seed (mulberry32), so that random levels
// and RANDINT in the tests are the same on every run.
export function seeded_rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// The example games: [{ name, game }].
export function load_examples() {
  const dir = path.join(ROOT, 'examples');
  return fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort()
    .map((f) => ({ name: f, game: JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) }));
}

// The examples listed in index.html (value="examples/....json").
export function examples_in_page() {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  return [...html.matchAll(/value="examples\/([^"]+\.json)"/g)].map((m) => m[1]);
}
