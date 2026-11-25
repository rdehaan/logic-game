# logic-game
A Logic Game

Live at https://rdehaan.github.io/logic-game/ (GitHub Pages, deployed from `main`).

## How it works

The site is static: plain HTML, CSS and JavaScript (ES modules), with no build step.
clingo runs in the browser, compiled to WebAssembly, using the standard
[clingo-wasm](https://github.com/domoritz/clingo-wasm) package. clingo runs in a
web worker, so the page stays responsive; a call to clingo that takes longer than
10 seconds is stopped (change the limit with `?timeout=30` in the URL).

| File | What it does |
| --- | --- |
| `index.html` | The page (including the Instructions and Internals tabs) |
| `js/main.js` | Buttons, loading/saving games, playing a game step by step |
| `js/engine.js` | The game engine: how the programs are run and connected (no DOM) |
| `js/solver.js` | Calls clingo-wasm: time limit, stopping, reading results and errors (no DOM) |
| `js/asp.js` | Text helpers: composing programs, `RANDINT`, reading clingo's error messages (no DOM) |
| `js/editors.js` | The code editors (Ace), and the errors shown in them |
| `js/grid-visual.js` | Drawing the board |
| `js/ace.js`, `js/mode-gringo.js` | The Ace editor, and syntax highlighting for ASP |
| `vendor/clingo-wasm/` | An unmodified copy of the clingo-wasm npm package (see `VERSION`) |
| `examples/` | The example games |
| `test/` | The tests |
| `tools/` | `serve.mjs` (local web server), `vendor.mjs` (copies clingo-wasm into `vendor/`) |

## Development

You need [Node.js](https://nodejs.org/) 22 or newer.

```
npm install                          # once: clingo-wasm and Playwright, for the tests
npx playwright install chromium      # once: the browser for the browser tests
npm run serve                        # then open http://localhost:8000/
npm test                             # all tests (takes about two minutes)
npm run test:unit                    # only the tests that do not need a browser
```

Opening `index.html` directly from disk does not work (browsers do not run web
workers from `file://` URLs); use `npm run serve`.

The tests (in `test/`, run with Node's built-in test runner) check:
- `asp.test.mjs`: the text helpers and the board (no clingo needed);
- `engine.test.mjs`: the solver and the game engine, with clingo; every program of every
  example is free of syntax errors, and every example solution wins (on fixed random levels);
- `browser.test.mjs`: the page in Chromium: playing, generating levels, errors shown in the
  editors, programs that do not terminate, Stop, Pause, URL options, uploading a game.

The tests run on GitHub for every push (`.github/workflows/test.yml`).
To use a Chromium that is already installed, set `CHROMIUM_PATH` to its executable.

### Updating clingo

```
npm install --save-exact clingo-wasm@latest
npm run vendor
npm test
```

and commit `package.json`, `package-lock.json` and `vendor/clingo-wasm/`.
A test fails if `vendor/clingo-wasm/` does not match the version in `package.json`.
