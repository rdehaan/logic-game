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
| `index.html` | The page |
| `docs/instructions.html`, `docs/internals.html`, `docs/modals.html` | The texts of the Instructions and Internals tabs, and the info pop-ups (loaded into the page) |
| `js/main.js` | Buttons, loading/saving games, playing a game step by step |
| `js/engine.js` | The game engine: how the programs are run and connected (no DOM) |
| `js/solver.js` | Calls clingo-wasm: time limit, stopping, reading results and errors (no DOM) |
| `js/asp.js` | Text helpers: composing programs, `RANDINT`, reading clingo's error messages (no DOM) |
| `js/analysis.js` | A light-weight analysis of programs: which predicates they derive and use (no DOM) |
| `js/hints.js` | Warnings about the special predicates of each program (`do/1`, `observe/1`, ...) (no DOM) |
| `js/storage.js` | Saved work (in the browser) and share links (no DOM) |
| `js/versions.js` | Snapshots, differences between versions, project and backup files (no DOM) |
| `js/versions-tab.js` | The Versions tab |
| `js/folder.js` | The folder format (one `.lp` file per program), and zip files (no DOM) |
| `js/text-board.js` | The board as text, for the command-line version (no DOM) |
| `bin/logic-game.mjs`, `cli/` | The command-line version |
| `js/tutorial.js` | The tutorial for new players (a guided first game), and the list of the first games |
| `js/editors.js` | The code editors (Ace), and the errors and warnings shown in them |
| `js/grid-visual.js` | Drawing the board |
| `js/mode-gringo.js` | Syntax highlighting for ASP in the Ace editor |
| `js/editor-help.js` | Help in the editors: what a special predicate means (on hover), and autocompletion |
| `sw.js` | Service worker: keeps the files of the game, so that it also works offline |
| `vendor/clingo-wasm/` | An unmodified copy of the clingo-wasm npm package (see `VERSION`) |
| `vendor/ace/` | The Ace editor, from the ace-builds npm package |
| `vendor/fonts/` | Open Sans and Font Awesome, from their npm packages (the page loads nothing from other sites) |
| `examples/` | The example games |
| `test/` | The tests |
| `tools/` | `serve.mjs` (local web server), `vendor.mjs` (copies clingo-wasm into `vendor/`) |

## The game rules, and what the board shows

The programs of the game rules (auxiliary, level generation, visibility, nature's moves and
winning conditions) are locked and unlocked together, at the top of the Game rules tab: a level
can only be generated, and a game only played, with locked rules, so it is always clear which
programs a game was played with. While they are unlocked, the buttons say *Lock rules and
generate level*, *Lock rules and play*. Locking keeps the level, unless the auxiliary or level
generation program changed since it was made. The line under the board says what the board
shows (the start of a level and where it came from, or the last game), and which programs
changed since then. In the Debug tab, the report of one step at a time is shown (the step of
the board, with a slider), or all of them.

## Options

In the Control tab (kept in the browser), or in the URL for one visit:
`?solutions=true` (the example games with solutions), `?editor=true` (the level editor in the
Debug tab), `?internals=true` (the Internals tab), `?timeout=30` (the time limit for each call
to clingo, in seconds); also whether the cells that changed in the last step are marked.
Other URL options: `?file=flag3` (load an example), `?tab=4` (open a tab), `?tutorial=true`.

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

## Saving, versions and sharing

Everything about keeping work is in the *Versions* tab:
- Changes are saved in the browser automatically (localStorage), separately for each game
  (example, uploaded file or shared link); loading that game again brings them back, with a
  button to go back to the original.
- *Snapshots*: versions that a student keeps, with a name and a note. The page also keeps
  automatic snapshots (before restoring an older version or going back to the original, before
  loading a file over saved work, every 10 minutes while editing, and when a strategy is tested);
  only the newest 20 automatic ones per game are kept, unless they are given a name or a note.
- The result of *Test your strategy* is kept with the snapshot of the version that was tested.
- *Compare versions*: a line-by-line diff (Myers' algorithm) of each program, between any two of
  the current version, the original and the snapshots; a single program can be taken from an
  older version.
- *Project file*: one JSON file (`"format": "logic-game-project"`) with the current version, the
  original game and all snapshots; students keep it anywhere (e.g. in a Google Drive folder)
  and load it again on another computer. A *backup* file holds all games of the browser.
  Uploading a plain game file (like the examples) works as before.
- *Share current game* makes a link that contains the whole game, compressed, after `#game=`;
  that part of a URL never reaches the server, so nothing is uploaded.

## Working on your own computer (with git)

A game can be kept as a folder with one plain clingo file per program, which works well
with git (a diff per program) and with any editor:

```
my-game/
  game.json                 the title, and which file holds which program
  auxiliary.lp
  level-generation.lp
  visibility.lp
  nature.lp
  winning-conditions.lp
  strategy.lp
  level/state.lp            the level (if there is one)
  level/settings.lp
```

The command-line version plays games from such folders (and from `.zip` files of them,
`.json` game and project files, and the examples), with the same engine and the same clingo
as the page, so results are the same as in the browser:

```
git clone https://github.com/rdehaan/logic-game.git && cd logic-game
npm install                                  # once (needs Node.js 22 or newer)
npm link                                     # optional: makes the command logic-game available
                                             # (or use: node bin/logic-game.mjs ...)
logic-game new ~/my-game --example flag3     # start a game folder from an example
logic-game check ~/my-game                   # errors and warnings, as file:line:column
logic-game play ~/my-game                    # play the level, with the board as text
logic-game play ~/my-game --seed 7 --step    # level 7 of a test, one step at a time
logic-game test ~/my-game --levels 50        # how often does the strategy win?
logic-game convert game.json ~/my-game       # between folders, .zip, game and project files
logic-game help
```

`play`, `test` and `check` exit with code 3 when the game is not won, a level of the test is
not won, or there are errors, so they can be used in scripts and in CI.



After the first visit, the game also works without a network connection (`sw.js`): the
files it needs are stored in the browser. Online, the files still come from the network
first, so a new version of the site is used right away. When the page loads a new file,
add it to `PRECACHE` in `sw.js` (a test checks this).

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
- `folder.test.mjs`: the folder format (every example survives the round trip) and zip files;
- `cli.test.mjs`: the command-line version (new, check, play, test, convert);
- `versions.test.mjs`: differences (checked against a longest common subsequence), snapshots,
  test results, a full storage, and project and backup files;
- `engine.test.mjs`: the solver and the game engine, with clingo; every program of every
  example is free of syntax errors, and every example solution wins (on fixed random levels);
- `browser.test.mjs`: the page in Chromium: playing, generating levels, errors and warnings
  shown in the editors, programs that do not terminate, Stop, Pause, URL options, uploading a game,
  saved work, share links, snapshots, comparing and restoring versions, project and backup files,
  and that nothing is loaded from other sites (fonts included).

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
`ace-builds`, `@fortawesome/fontawesome-free` and `@fontsource/open-sans`.)
A test fails if `vendor/clingo-wasm/` does not match the version in `package.json`.
