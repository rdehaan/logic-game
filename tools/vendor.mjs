// Copy the clingo-wasm package from node_modules into vendor/clingo-wasm/.
//
// To update clingo:
//   npm install --save-exact clingo-wasm@latest
//   npm run vendor
//   npm test
//
// The files are copied unchanged, so vendor/clingo-wasm/ is exactly the
// standard npm package (its dist/ folder, without the TypeScript types).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkgDir = path.join(root, 'node_modules', 'clingo-wasm');
const src = path.join(pkgDir, 'dist');
const dst = path.join(root, 'vendor', 'clingo-wasm');

if (!fs.existsSync(src)) {
  console.error(`missing ${src}: run "npm install" first`);
  process.exit(1);
}

const version = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8')).version;
fs.rmSync(dst, { recursive: true, force: true });
fs.mkdirSync(dst, { recursive: true });

const lines = [`clingo-wasm ${version}`];
const files = fs.readdirSync(src).filter((f) => !f.endsWith('.d.ts')).sort();
for (const f of files) {
  const data = fs.readFileSync(path.join(src, f));
  fs.writeFileSync(path.join(dst, f), data);
  lines.push(`${crypto.createHash('sha256').update(data).digest('hex')}  ${f}`);
}
fs.copyFileSync(path.join(pkgDir, 'LICENSE'), path.join(dst, 'LICENSE'));
fs.writeFileSync(path.join(dst, 'VERSION'), lines.join('\n') + '\n');
console.log(lines.join('\n'));
