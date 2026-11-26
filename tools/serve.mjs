// A small static file server for trying the game locally (and for the browser tests).
//   node tools/serve.mjs [port]        (default port 8000)
// Then open http://localhost:8000/ in a browser.
//
// Opening index.html directly from disk (file://) does not work: browsers do not
// allow web workers and WebAssembly to load from file:// URLs.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.lp': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

export function createServer() {
  return http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    let pathname;
    try {
      pathname = decodeURIComponent(url.pathname);
      if (pathname.includes('\0')) throw new Error('NUL in path');
    } catch {
      res.writeHead(400, { 'Content-Type': 'text/plain' }).end('bad request');
      return;
    }
    let file = path.normalize(path.join(root, pathname));
    // (with path.sep, so that a sibling folder such as ../repo-other is not let through)
    if (file !== root && !file.startsWith(root + path.sep)) {
      res.writeHead(403).end();
      return;
    }
    if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
    fs.readFile(file, (err, data) => {
      if (err) {
        res.writeHead(404, { 'Content-Type': 'text/plain' }).end('not found');
        return;
      }
      res.writeHead(200, {
        'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream',
        'Cache-Control': 'no-cache',
      });
      res.end(data);
    });
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.argv[2] || 8000);
  // Only this computer can connect (not others on the same network)
  createServer().listen(port, '127.0.0.1', () => console.log(`Serving ${root} at http://localhost:${port}/`));
}
