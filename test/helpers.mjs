// Shared helpers for the tests.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// seeded_rng lives in js/asp.js (the page uses it too)
export { seeded_rng } from '../js/asp.js';

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
