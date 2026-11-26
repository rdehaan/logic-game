// Service worker: makes the game work offline (e.g. with bad Wi-Fi in a classroom).
//
// - On the first visit, the files the game needs are stored (PRECACHE).
// - Online, every file comes from the network as usual (so a new version of the
//   site is used right away), and the stored copy is updated.
// - Offline, or when the network does not answer within NETWORK_TIMEOUT_MS,
//   the stored copy is used.
//
// A test (test/browser.test.mjs) checks that PRECACHE holds every file the page loads.

const CACHE = 'logic-game';
const NETWORK_TIMEOUT_MS = 4000;

const PRECACHE = [
  './',
  'index.html',
  'favicon.svg',
  'docs/instructions.html',
  'docs/internals.html',
  'docs/modals.html',
  'css/main.css',
  'css/visual.css',
  'vendor/ace/ace.js',
  'vendor/ace/ext-language_tools.js',
  'vendor/ace/theme-textmate.js',
  'js/mode-gringo.js',
  'js/analysis.js',
  'js/asp.js',
  'js/editors.js',
  'js/editor-help.js',
  'js/engine.js',
  'js/grid-visual.js',
  'js/hints.js',
  'js/main.js',
  'js/modal.js',
  'js/solver.js',
  'js/storage.js',
  'js/versions.js',
  'js/versions-tab.js',
  'js/tutorial.js',
  'js/folder.js',
  'js/folder-link.js',
  'js/grading.js',
  'js/grading-store.js',
  'js/grader.js',
  'js/submissions.js',
  'js/feedback.js',
  'js/pdf.js',
  'js/board-image.js',
  'vendor/clingo-wasm/index.web.js',
  'vendor/clingo-wasm/client.js',
  'vendor/clingo-wasm/stream.js',
  'vendor/clingo-wasm/threads.js',
  'vendor/clingo-wasm/witnesses.js',
  'vendor/clingo-wasm/run.worker.js',
  'vendor/clingo-wasm/worker.js',
  'vendor/clingo-wasm/run.js',
  'vendor/clingo-wasm/clingo.js',
  'vendor/clingo-wasm/clingo.wasm',
  'vendor/fonts/fonts.css',
  'vendor/fonts/fa-solid-900.woff2',
  'vendor/fonts/fa-regular-400.woff2',
  'vendor/fonts/fa-brands-400.woff2',
  'vendor/fonts/fa-v4compatibility.woff2',
  'vendor/fonts/open-sans-latin-400-normal.woff2',
  'vendor/fonts/open-sans-latin-600-normal.woff2',
  'vendor/fonts/open-sans-latin-700-normal.woff2',
  'vendor/fonts/open-sans-latin-ext-400-normal.woff2',
  'vendor/fonts/open-sans-latin-ext-600-normal.woff2',
  'vendor/fonts/open-sans-latin-ext-700-normal.woff2',
  ...[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11].map((n) => `examples/flag${n}.json`),
  ...[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => `examples/flag${n}-with-solutions.json`),
  'examples/flag11-with-solutions-a.json',
  'examples/flag11-with-solutions-b.json',
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await cache.addAll(PRECACHE);
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) return;
  event.respondWith(network_first(request));
});

async function network_first(request) {
  const cache = await caches.open(CACHE);
  // The page itself is stored once, whatever its options (?file=..., ?tab=...)
  const key = request.mode === 'navigate' ? new URL('./', self.location).href : request;
  const network = fetch(request).then((response) => {
    if (response.ok && response.type === 'basic') cache.put(key, response.clone());
    return response;
  });
  const timeout = new Promise((resolve) => setTimeout(resolve, NETWORK_TIMEOUT_MS, null));
  try {
    const response = await Promise.race([network, timeout]);
    if (response) return response;
  } catch {
    // offline: use the stored copy below
  }
  const stored = await cache.match(key, { ignoreSearch: request.mode === 'navigate' });
  if (stored) return stored;
  return network;     // nothing stored: wait for the network after all
}
