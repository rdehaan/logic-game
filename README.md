# logic-game
A Logic Game

Live at https://rdehaan.github.io/logic-game/ (GitHub Pages, deployed from `main` when the tests pass).

## How it works

The site is static: plain HTML, CSS and JavaScript (ES modules), with no build step.
clingo runs in the browser, compiled to WebAssembly, using the standard
[clingo-wasm](https://github.com/domoritz/clingo-wasm) package. clingo runs in a
web worker, so the page stays responsive; a call to clingo that takes longer than
10 seconds is stopped (change the limit with `?timeout=30` in the URL).

To keep games fast, the engine only passes the current state of the game to the programs
(not the whole history), unless a program uses `at_time` or `state_time`; the game output
shows how long clingo took for each program in each step.

| File | What it does |
| --- | --- |
| `index.html` | The page (including the Instructions and Internals tabs) |
| `js/main.js` | Buttons, loading/saving games, playing a game step by step |
| `js/engine.js` | The game engine: how the programs are run and connected (no DOM) |
| `js/solver.js` | Calls clingo-wasm: time limit, stopping, reading results and errors (no DOM) |
| `js/asp.js` | Text helpers: composing programs, `RANDINT`, reading clingo's error messages (no DOM) |
| `js/analysis.js` | A light-weight analysis of programs: which predicates they derive and use (no DOM) |
| `js/hints.js` | Warnings about the special predicates of each program (`do/1`, `observe/1`, ...) (no DOM) |
| `js/storage.js` | Saved work (in the browser) and share links (no DOM) |
| `js/editors.js` | The code editors (Ace), and the errors and warnings shown in them |
| `js/grid-visual.js` | Drawing the board |
| `js/ace.js`, `js/mode-gringo.js` | The Ace editor, and syntax highlighting for ASP |
| `vendor/clingo-wasm/` | An unmodified copy of the clingo-wasm npm package (see `VERSION`) |
| `vendor/fonts/` | Open Sans and Font Awesome, from their npm packages (the page loads nothing from other sites) |
| `examples/` | The example games |
| `test/` | The tests |
| `tools/` | `serve.mjs` (local web server), `vendor.mjs` (copies clingo-wasm into `vendor/`) |

## Feedback for players

The page tries to explain what went wrong:
- syntax errors and unsafe variables are marked in the editors while typing;
- warnings about the special predicates of each program, e.g. a player's program that never
  derives `do/1`, uses `at/3` instead of `observe(at(...))`, misspells `remember/1`, uses the
  wrong number of arguments, or makes moves that nature's program does not react to;
- when a program has no answer set, the constraints that are violated are named;
- problems with the level (no board size, objects outside of the board) are shown under the board;
- all errors and warnings are listed in the Debug tab, and a lost game points to them.

The special predicates of each program are listed in `INTERFACES` in `js/hints.js`; they must
match what `js/engine.js` passes between the programs.

## Testing a strategy

*Test your strategy* (in the Strategy tab) plays the game on many random levels without
drawing them, and lists the levels that were not won. Level *n* is generated and played with
random numbers from seed *n*, so each of them can be played again exactly (*Load this level*),
or shared as a link (`#game=...&seed=n`).

## Saving and sharing

Changes are saved in the browser automatically (localStorage), separately for each game
(example, uploaded file or shared link); loading that game again brings them back, with a
button to go back to the original. *Share current game* in the Control tab makes a link that
contains the whole game, compressed, after `#game=`; that part of a URL never reaches the
server, so nothing is uploaded.

## Development

You need [Node.js](https://nodejs.org/) 22 or newer.

```
npm install                          # once: clingo-wasm and Playwright, for the tests
npx playwright install chromium      # once: the browser for the browser tests
npm run serve                        # then open http://localhost:8000/
npm test                             # all tests (takes about a minute)
npm run test:unit                    # only the tests that do not need a browser
```

Opening `index.html` directly from disk does not work (browsers do not run web
workers from `file://` URLs); use `npm run serve`.

The tests (in `test/`, run with Node's built-in test runner) check:
- `asp.test.mjs`: the text helpers and the board (no clingo needed);
- `hints.test.mjs`: the analysis of programs and the warnings about special predicates
  (no clingo needed); the example games get no warnings;
- `storage.test.mjs`: share links (every example survives the round trip) and saved work;
- `engine.test.mjs`: the solver and the game engine, with clingo; every program of every
  example is free of syntax errors, and every example solution wins (on fixed random levels);
- `browser.test.mjs`: the page in Chromium: playing, generating levels, errors and warnings
  shown in the editors, programs that do not terminate, Stop, Pause, URL options, uploading a game,
  saved work, share links, and that nothing is loaded from other sites (fonts included).

The tests run on GitHub for every push and pull request (`.github/workflows/test-and-deploy.yml`).
On a push to `main`, the same workflow then publishes the site to GitHub Pages, but only if the
tests pass. This needs a one-time setting on GitHub: *Settings > Pages > Build and deployment >
Source: GitHub Actions* (instead of *Deploy from a branch*).
To use a Chromium that is already installed, set `CHROMIUM_PATH` to its executable.

### Updating clingo (or the fonts)

```
npm install --save-exact clingo-wasm@latest
npm run vendor
npm test
```

and commit `package.json`, `package-lock.json` and `vendor/`. (The same works for
`@fortawesome/fontawesome-free` and `@fontsource/open-sans`.)
A test fails if `vendor/clingo-wasm/` does not match the version in `package.json`.
