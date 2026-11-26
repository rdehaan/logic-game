# logic-game

A logic game in which you steer the player with an answer set program (clingo, running in the
browser), with a command-line version, and a Grading tab for teachers.

Live at https://rdehaan.github.io/logic-game/ (GitHub Pages, deployed from `main` when the tests pass).

In this game, the player is not steered with the keyboard: you write a logic program (answer set
programming, with clingo) that decides the player's moves, and the rules of the game are logic
programs too. For players and students:
- a **tutorial** guides new players through a first game, and the *Find the flag* examples get
  harder step by step;
- the editors mark errors while typing, and warn about mistakes with the special predicates;
- *Test your strategy* plays many random levels, and every level can be played again exactly;
- the **Versions** tab downloads the game file to hand in, keeps snapshots of your work,
  compares versions line by line, and downloads and loads your project (also as a folder with one file per program, for git);
- a **command-line version** ([docs/CLI.md](docs/CLI.md)) plays the same games on your own
  computer, with your own editor and git.

For teachers, **grader mode** (an option) adds a *Grading* tab: load the submissions of all
students at once (Canvas' *Download submissions*), test and measure each game, grade it with a
rubric (with suggested scores, and the evidence for them), read the student's PDF next to the
rubric, and write feedback to send as a PDF, a web page or text (see *Grading, step by step*
below).

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
| `favicon.svg` | The icon of the page: the player and the flag (Font Awesome icons, CC BY 4.0) |
| `docs/instructions.html`, `docs/internals.html`, `docs/modals.html` | The texts of the Instructions and Internals tabs, and the info pop-ups (loaded into the page) |
| `css/main.css`, `css/visual.css` | The look of the page, and of the board |
| `js/main.js` | The page: the buttons and the lock of the game rules, playing a game step by step, what the board shows, the Debug tab, options, loading and saving games, game folders, and wiring up the other modules |
| `js/theme.js` | Light or dark: the choice of the switch at the top, set on the page before it is shown (a plain script, not a module) |
| `js/engine.js` | The game engine: how the programs are run and connected (no DOM) |
| `js/solver.js` | Calls clingo-wasm: time limit, stopping, reading results and errors (no DOM) |
| `js/asp.js` | Text helpers: composing programs, `RANDINT`, reading clingo's error messages (no DOM) |
| `js/analysis.js` | A light-weight analysis of programs: which predicates they derive and use (no DOM) |
| `js/hints.js` | Warnings about the special predicates of each program (`do/1`, `observe/1`, ...) (no DOM) |
| `js/storage.js` | Saved work (in the browser) and share links (no DOM) |
| `js/versions.js` | Snapshots, differences between versions, project and backup files (no DOM) |
| `js/versions-tab.js` | The Versions tab |
| `js/folder.js` | The folder format (one `.lp` file per program), and zip files (no DOM) |
| `js/folder-link.js` | Linking the page to a game folder on disk (Chrome and Edge) |
| `js/text-board.js` | The board as text, for the command-line version (no DOM) |
| `bin/logic-game.mjs` | The command-line version, also for grading (see [docs/CLI.md](docs/CLI.md)) |
| `cli/game-files.mjs` | Reading and writing games on disk for the command-line version: folders, .zip, game and project files, examples |
| `js/grader.js` | The Grading tab (grader mode) |
| `js/grading.js` | Grading: the rubric and the grade, measuring a game, comments, similarity, suggested scores, grading sessions (no DOM) |
| `js/submissions.js` | Reading the submissions of students: Canvas' zip file of all submissions, zip files, game files and PDFs (no DOM) |
| `js/feedback.js` | The feedback for a student, as Markdown, a web page and a PDF (no DOM) |
| `js/pdf.js` | A small PDF writer: text in the standard fonts, tables, code, JPEG images (no DOM) |
| `js/board-image.js` | Pictures of the board (a canvas), for the feedback |
| `js/grading-store.js` | Where the grading is kept in the browser (IndexedDB) |
| `js/tutorial.js` | The tutorial for new players (a guided first game), and the list of the first games |
| `js/grading-tutorial.js` | The grading tutorial: the steps, and the sample batch of two made-up students |
| `js/editors.js` | The code editors (Ace), and the errors and warnings shown in them |
| `js/grid-visual.js` | Drawing the board |
| `js/mode-gringo.js` | Syntax highlighting for ASP in the Ace editor |
| `js/editor-help.js` | Help in the editors: what a special predicate means (on hover), and autocompletion |
| `js/modal.js` | The info pop-ups |
| `sw.js` | Service worker: keeps the files of the game, so that it also works offline |
| `vendor/clingo-wasm/` | An unmodified copy of the clingo-wasm npm package (see `VERSION`) |
| `vendor/ace/` | The Ace editor, from the ace-builds npm package |
| `vendor/fonts/` | Open Sans and Font Awesome, from their npm packages (the page loads nothing from other sites) |
| `examples/` | The example games |
| `docs/CLI.md` | The guide to the command-line version |
| `docs/rubric.md` | The rubric file of the Grading tab, field by field |
| `stored/` | Programs referred to in the Internals tab |
| `test/` | The tests (`helpers.mjs`: what several tests share) |
| `tools/` | `serve.mjs` (local web server), `vendor.mjs` (copies clingo-wasm, the Ace editor and the fonts from `node_modules/` into `vendor/`) |

## The game rules, and what the board shows

The programs of the game rules (auxiliary, level generation, visibility, nature's moves and
winning conditions) are locked and unlocked together, at the top of the Game rules tab: a level
can only be generated, and a game only played, with locked rules, so it is always clear which
programs a game was played with. While they are unlocked, the buttons say *Lock rules and
generate level*, *Lock rules and play* and *Lock rules and test*. Locking keeps the level, unless the auxiliary or level
generation program changed since it was made. Such a level is *out of date* as soon as one of
those programs is edited: the board is grayed out, Play and Step are disabled, and *Lock rules
and generate level* is the highlighted next step. Keeping the level anyway takes an explicit
click (*Keep this level*, or *Keep the old level anyway* after locking removed it). The line below the buttons says what the board
shows (the start of a level and where it came from, or the last game), and which programs
changed since then; after a change, *Play again* plays the level again and comes back to the
time the board showed. Whether the game is the player's own version (saved in the browser) is a
short line under the title of the game. In the Debug tab, the report of one step at a time is shown (the step of
the board, with a slider): the facts that went into and came out of each program, in a locked
(highlighted, not editable) editor each, one fact per line. Compared with the step before, new
facts are marked and the facts that are gone are listed; *Show only what changed*
(`?only_changes=true`) hides the facts that stayed the same. Hovering over a fact highlights its
cell on the board, and hovering over a cell highlights the facts about it (`cell_of_atom` in
`js/grid-visual.js`: the first row and column among the arguments, at any depth); this is only
done while the Debug tab is open.

Keyboard: Ctrl+Enter (Cmd+Enter on a Mac) plays, also in the editors; when not typing, Space
pauses or plays one step, and the arrow keys (Home, End) move through the timeline. The tabs
can be reached with Tab (the arrow keys go from tab to tab), and so can the board: every cell
has a description for screen readers (`Row 2, column 8: player`), the arrow keys move from cell
to cell, and the cell with the focus is highlighted with its facts, as when hovering.

## Options

In the Control tab (kept in the browser), and in the URL for one visit (`=false` turns one off;
`=true`, `=1`, `=yes` or just the name, as in `?grader`, turn one on):
`?side_by_side=false` (on screens of 1100 pixels and wider, the board, its slider and buttons
stay in view on the left while the tabs scroll on the right; on by default), `?mark_changes=true` (mark the cells on the board that changed in the last step; off by default,
also under the slider below the board), `?solutions=true` (the example games with solutions),
`?editor=true` (the level editor in the Debug tab), `?internals=true` (the Internals tab),
`?grader=true` (grader mode: the Grading tab, and *Show everything on the board* under the board,
`?full_view=true`), `?only_changes=true` (*Show only what changed* in the Debug tab), `?timeout=30`
(the time limit for each call to clingo, in seconds).

Other URL options: `?file=flag3` (load an example; without it, the page opens *Find the flag 1
(with solution)*, `examples/flag1-with-solutions.json`), `?tutorial=true` (start the tutorial), and
`?tab=N` (open a tab). The tabs are numbered by their place in `index.html`, not by the order in
which they are shown: 1 Control, 2 Instructions, 3 Game rules, 4 Strategy, 5 Debug, 7 Versions,
6 Internals (only with `internals=true`) and 8 Grading (only with `grader=true`).

Colors: the switch at the top right of the page chooses *Auto* (light or dark, as the browser or
the system is set; the default), *Light* or *Dark*, and the choice is kept in the browser. In dark
mode the board stays white, because games choose the colors of its cells for a white board.
Printed pages are always light.

## Feedback for players

The page tries to explain what went wrong:
- syntax errors and unsafe variables are marked in the editors while typing;
- warnings about the special predicates of each program, e.g. a player strategy that never
  derives `do/1`, uses `at/3` instead of `observe(at(...))`, misspells `remember/1`, uses the
  wrong number of arguments, or makes moves that the nature's moves program does not react to;
- when a program has no answer set, the constraints that are violated are named;
- when the player made no move (or several) at the time the board shows, a note below the
  buttons says why: an error in the strategy, no answer set, no rule for `do/1` that applied, or
  rules that apply at the same time, with links to the lines (`move_hint` in `js/hints.js`);
- problems with the level (no board size, objects outside of the board) are shown under the board;
- all errors and warnings are listed in the Debug tab, and a lost game points to them.

The special predicates of each program are listed in `INTERFACES` in `js/hints.js`; they must
match what `js/engine.js` passes between the programs.

## Testing a strategy

*Test your strategy* (in the Strategy tab) plays the game on many random levels without
drawing them, and lists the levels that were not won. Level *n* is generated and played with
random numbers from seed *n*, so each of them can be played again exactly (*Load this level*),
or shared as a link (`#game=...&seed=n`). Under the list, any level of the last test (also one
that was won) can be loaded or linked to by its number.

## Grader mode (for teachers)

Grader mode is an option in the Control tab (anyone can turn it on; `?grader=true` in a link).
It adds the *Grading* tab, and a switch under the board, *Show everything on the board*: the
objects that the player does not see are drawn faded (`full_view` in `js/grading.js`: the
objects of the game state that are not observed become `decorate(item,R,C,O)`).

- **Loading.** The zip file of Canvas' *Download submissions* is loaded as it is: Canvas names
  every file `<name>_<user id>_<submission id>_<file>` (`_LATE_` after the name when it was late),
  so the files are grouped per student; zip files in it (also in a folder) are unpacked, and the
  first game or project file (or game folder) and all PDF files of a student are used. A zip file
  of one student, and game files and PDFs on their own, work too (`js/submissions.js`).
- **Grading a student.** *Grade* loads the student's game into the page (saved under the origin
  `grading:<key>`, so the grader's changes never change what was handed in, and *Back to what was
  handed in* undoes them); the student's PDF is shown next to the rubric (above it, when the tab is
  narrower than 960 pixels).
- **Test and measure** (`measure_game`) plays levels 1 to *n* as *Test your strategy* does (so a
  level can be loaded onto the board to watch it), and keeps how long level generation and each
  program in each step took, how each game ended, which objects the player did not see (the game
  state compared with what was observed), which objects moved, whether the memory was used, and
  how many different levels were generated (the first ones are shown small). The game is also
  compared with the example games and the other submissions: the programs as tokens, without
  comments and spaces, with every variable written as `V`, and the Jaccard index of runs of five
  tokens (a hint for the grader, not proof of copying). *Compare all submissions* lists the most
  similar pairs.
- **The rubric** is a JSON file (`"format": "logic-game-rubric"`, explained field by field in
  [docs/rubric.md](docs/rubric.md)): required items, extra items with points, thresholds for the
  suggestions (`checks`), and standard comments. When all required items are met, the grade is the
  grade of the required items (by default 6) plus the points of the extra items, at most the maximum
  (by default 9); when all extra items get all their points, the grade is the grade for all of them
  (by default 10). When a required item is not met, the grader gives the grade (`compute_grade` in
  `js/grading.js`). The default is the rubric of the logic game assignment (`DEFAULT_RUBRIC`);
  download it, change it and load it for another assignment.
  Each item has a `check` (`timing`, `novelty`, `comments`, `visual`, `hidden`, `npc`, `random`,
  `new_levels`, `memory`) that suggests a score with its evidence (`suggest` in `js/grading.js`).
  Suggestions never decide by themselves: *Accept the suggestions* fills in only the items that are
  not decided yet. A required item that is not met leaves the grade to the grader (*Give another grade*).
- **Feedback**: a comment (with standard comments to insert), notes on lines of the programs
  (*Use the cursor's line*: the line of the cursor in the editor used last), pictures of the board
  as it is shown (kept as facts, drawn when the feedback is made), the notes of the items, and the
  test results if the grader adds them. Per student as a PDF (`js/pdf.js`: no library is needed,
  the PDF uses the standard fonts), a web page (one file, with the pictures in it) or Markdown; for
  all students as a zip file, with the grades as CSV (`grades.csv`, also on its own; a table for a
  spreadsheet, not in the format of Canvas' gradebook import).
- **Keeping the work.** Everything is kept in the browser (IndexedDB, `js/grading-store.js`;
  *Remove all students* and *Reset everything* remove it). *Export the grading* gives a JSON file (`"format":
  "logic-game-grading"`) with the rubric and all students, without their PDF files; *Import
  grading* merges one: students that are not there yet are added, and of a student in both, the
  version that was changed last is kept (to share the work between graders).
- **On the command line**, `logic-game grade <submissions>` tests all submissions at once and writes
  a grading file to import in the Grading tab (with the test results and suggestions of every
  student), and `logic-game feedback <grading file> <folder>` writes the feedback of all students
  (see [docs/CLI.md](docs/CLI.md)). Importing adds the test results of students that were not tested
  in the page yet.
- **The grading tutorial** (`js/grading-tutorial.js`) is offered on the first visit of the Grading
  tab, and can be started again from it (*Take the grading tutorial*). It walks through the tab with a
  sample zip file that it makes itself (two made-up students, `studenta` and `studentb`, with the
  names Canvas gives files), in a sample session that is kept in memory only
  (`enter_sample`/`leave_sample` in `js/grader.js`): the grader's own grading is put aside, and
  comes back when the tutorial is closed.

## Grading, step by step (for teachers)

1. **Turn on grader mode**: in the Control tab, *Grader mode*, or open the page with
   `?grader=true` (https://rdehaan.github.io/logic-game/?grader=true&tab=8). The *Grading* tab
   appears. The first time, it offers a short tutorial with two made-up students.
2. **Download the submissions**: in Canvas, on the page of the assignment, *Download submissions*.
   This gives one zip file with the files of all students, named after the student
   (`doejane_12345_678901_hw3.zip`, with `_LATE_` after the name when it was late). Keep it as it is:
   there is no need to unpack it.
3. **Optionally, test all submissions at once** on the command line (see
   [docs/CLI.md](docs/CLI.md)): `logic-game grade submissions.zip` plays every game on new levels
   (20, unless the rubric or `--levels` says otherwise), suggests scores, and writes `grading-<date>.json`. In the Grading tab, load it with
   *Import grading…*: every student is then there with the test results and suggestions.
4. **Load the same zip file in the page**: *Load submissions* in the Grading tab. This is needed
   even after importing a grading file, because grading files do not contain the students' PDF
   files. Students that are already there keep their grading.
5. **Grade each student**: *Grade* (in the list) loads the student's game into the page, and shows
   their PDF next to the rubric. *Test and measure* (unless the imported file already did) plays the
   game on new levels and suggests a score for each item, with the evidence; *Accept the
   suggestions* fills in the items you did not decide yet. Decide every item (and give fewer points
   where needed), write a comment (standard comments are one click), add notes on lines of the
   programs and pictures of the board, and set the status to *done*. ▶ goes to the next student.
6. **Share the work with co-graders**: *Export the grading (.json)* gives a file with all grading
   work (without the PDF files). A co-grader loads the same zip file and imports that file with
   *Import grading…*; for a student graded by both, the version that was changed last is kept.
   Export your grading regularly anyway, to keep it safe.
7. **Download the feedback and the grades**: *Download all feedback (.zip)* gives a zip file with
   one feedback file per student (PDF, web page and/or text) and `grades.csv`; *Download the grades
   (.csv)* gives only `grades.csv`. Its columns are `student`, `canvas_id` (the user id from the
   file names), `late`, `status`, `grade` (empty when the grade is not final), one column per item
   of the rubric (`met`/`not met` as `yes`/`no`, or the points of an extra item) and `comment`.
8. **Put the grades and feedback in Canvas.** `grades.csv` is not in the format that Canvas'
   gradebook imports, so the grades are entered by hand: for each student, enter the grade in Canvas
   (for example in SpeedGrader), and attach their feedback file to a comment on their submission (or
   paste the text of *Copy as text* into the comment). The file names say whose feedback it is
   (`feedback-<name>-<user id>.pdf`).
9. **Remove the data when you are done.** The grading is kept in the browser that was used, in
   IndexedDB (the database `logic-game-grading`): the names and Canvas user ids of the students,
   their games, scores, comments, grades, and their PDF files. *Remove all students* (in the Grading
   tab) removes all of it from this browser; *Reset everything* (in the Versions tab) removes it
   too, with everything else the page keeps. When you changed the game of a student in the page, that
   version is kept as saved work, like any game (the Versions tab, *Everything in this browser*:
   forget it there, or use *Forget all saved work*). Export the grading first if you want to keep it.

The grading pop-up (the ⓘ at the top of the Grading tab) has a short version of these steps, and
the grading tutorial shows them in the page.

## Saving, versions and sharing

Everything about keeping work is in the *Versions* tab. It starts with what students need most:
*Download the game file* (a plain game file, like the examples: what they hand in), with a line
under it that says whether the current version was downloaded, and *Load a file or a folder*.
The rest is in sections that open when clicked (and stay open, in that browser): snapshots with
comparing, the project file, working in a folder, share links, and everything in the browser.
- Changes are saved in the browser automatically (localStorage), separately for each game
  (example, uploaded file or shared link); loading that game again brings them back, with a
  button to go back to the original.
- *Snapshots*: versions that a student keeps, with a name and a note. The page also keeps
  automatic snapshots: every 10 minutes while editing, when a strategy is tested, and before the
  current version is replaced (by restoring an older version, taking a program from another
  version, going back to the original, loading a file over saved work, or changes to the files
  of a linked folder). Only the newest 20 automatic ones per game are kept, unless they are given
  a name or a note.
- The result of *Test your strategy* is kept with the snapshot of the version that was tested.
- *Compare versions*: a line-by-line diff (Myers' algorithm) of each program, between any two of
  the current version, the original and the snapshots; a single program can be taken from an
  older version.
- *Project file*: one JSON file (`"format": "logic-game-project"`) with the current version, the
  original game and all snapshots; students keep it anywhere (e.g. in a cloud storage folder)
  and load it again on another computer. A *backup* file holds all games of the browser.
  Game files can be loaded too; *Download as a folder (.zip)* gives a game folder (see below).
- *Everything in this browser*: all games with saved work or snapshots, to open, download or
  forget, and how much of the browser's storage they use.
  *Reset everything* is a fresh start: it removes every `logic-game:` key from localStorage (work,
  snapshots, options, tutorial, open sections) and the remembered folder (IndexedDB), and loads
  the page again without the query.
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
logic-game grade submissions.zip             # for teachers: test all submissions (Canvas' zip file)
logic-game help
```

In the browser (Versions tab): *Download as a folder (.zip)*, and *Select folder* (or *Select file* for a `.zip`)
to load one. In Chrome and Edge, *Link a folder…* links the page to a game folder on disk
(`js/folder-link.js`, with the File System Access API): every change in the page is written
into the files, and changes to the files (by an editor, or by `git checkout`) are loaded into
the page within a few seconds, after an automatic snapshot of the page's version. A file that
changed on disk is never overwritten by the page. After a reload, the page offers to link the
folder again (the browser asks for permission).

The full guide to the command-line version is [docs/CLI.md](docs/CLI.md); the Instructions
tab of the page has the basics (*Playing on your own computer*).

`play`, `test` and `check` exit with code 3 when the game is not won, a level of the test is
not won, or there are errors (and `grade` when a submission has no game, or it could not be tested), so they can be used in scripts and in CI.

## Offline use

After the first visit, the game also works without a network connection (`sw.js`): the
files it needs are stored in the browser. Online, the files still come from the network
first, so a new version of the site is used right away. When the page loads a new file,
add it to `PRECACHE` in `sw.js` (a test checks this).

On the first visit, the page downloads clingo (`clingo.wasm`, 2.6 MB, the largest file by far)
itself, with a progress bar over the board, and hands the downloaded file to clingo's worker
(`download_clingo` in `js/main.js`). Calls to clingo wait until it is loaded, without their time
limit running (`init` in `js/solver.js`), so that a slow connection does not make clingo
load twice. The small files the worker needs afterwards are prefetched (`index.html`).
Measured with a throttled connection: about 4 s on 10 Mbit/s, 17 s on 2 Mbit/s; later visits
take about 0.4 s.

## Development

You need [Node.js](https://nodejs.org/) 22 or newer.

```
npm install                          # once: clingo-wasm, and for development Playwright, Ace and the fonts
npx playwright install chromium      # once: the browser for the browser tests
npm run serve                        # then open http://localhost:8000/ (npm run serve -- 8080: another port)
npm test                             # all tests (takes a few minutes)
npm run test:unit                    # only the tests that do not need a browser
npm run test:browser                 # only the tests in the browser
npm run lint                         # ESLint (eslint.config.js): mistakes such as unused variables
npm run game -- play flag3           # the command-line version (see docs/CLI.md)
```

Opening `index.html` directly from disk does not work (browsers do not run web
workers from `file://` URLs); use `npm run serve`.

Without a browser, the tests in `browser.test.mjs` are *skipped*, not failed, so `npm test`
still passes: look for `# skipped` in the summary. Run `npx playwright install chromium`, or set
`CHROMIUM_PATH` to the executable of a Chromium that is already installed. On CI (where the
environment variable `CI` is set) a missing browser is an error instead.

The tests (in `test/`, run with Node's built-in test runner) check:
- `asp.test.mjs`: the text helpers and the board (no clingo needed);
- `hints.test.mjs`: the analysis of programs and the warnings about special predicates
  (no clingo needed); the example games get no warnings;
- `storage.test.mjs`: share links (every example survives the round trip) and saved work;
- `folder.test.mjs`: the folder format (every example survives the round trip) and zip files
  (also zip bombs, which are not unpacked);
- `cli.test.mjs`: the command-line version (new, check, play, test, convert, grade, feedback, the board as text),
  that every command and option is in its help and in docs/CLI.md, and its safeguards (Node's
  permission model, no control characters or formulas from submissions in its output, no symbolic links);
- `versions.test.mjs`: differences (checked against a longest common subsequence), snapshots,
  test results, a full storage, and project and backup files;
- `grading.test.mjs`: the rubric and the grade, comments, similarity, the full board, measuring
  games and the suggested scores (with clingo), grading sessions (export, import, merge, CSV), and
  reading submissions (Canvas' zip file, zip files of one student, game folders, bytes in zip files,
  and zip files as zip programs write them: Zip64, data in front, names in the encoding of DOS,
  entries that cannot be read; `test/fixtures/zips/`);
- `feedback.test.mjs`: the feedback as Markdown, a web page and a PDF, and the PDF writer;
- `engine.test.mjs`: the solver and the game engine, with clingo; every program of every
  example is free of syntax errors, every example solution wins (on fixed random levels), the
  history is only kept when it is needed, and tests of a strategy can be repeated exactly;
- `browser.test.mjs`: the page in Chromium: playing (also step by step, with the slider and the
  Debug tab), generating levels, the lock of the game rules and the line under the board, errors
  and warnings shown in the editors, programs that do not terminate, Stop, Pause, options (in the
  Control tab and the URL), loading files, saved work, share links, snapshots, comparing and
  restoring versions, project and backup files, game folders (download, load, link), testing a
  strategy, the tutorial, help in the editors, boards of all sizes, the page on a phone, offline
  use, grader mode (the whole board; loading Canvas' download, testing, grading, feedback in
  every format, keeping the grading, exporting and importing it, the grading tutorial and its sample
  session), and that nothing is loaded from
  other sites (fonts included).

The tests run on GitHub for every push and pull request (`.github/workflows/test-and-deploy.yml`):
all of them (and `npm run lint`) on Linux, and the tests without a browser also on Windows and
macOS, each with Node 22, 24 and 26, since teachers run the command-line version on their own
computers. On a push to `main`, the same workflow then publishes the site to GitHub Pages, but only if the
tests pass (see *Deploying your own copy* below).
To use a Chromium that is already installed, set `CHROMIUM_PATH` to its executable.

### Updating clingo, Ace or the fonts

```
npm install --save-exact clingo-wasm@latest
npm run vendor
npm test
```

and commit `package.json`, `package-lock.json` and `vendor/`. (The same works for
`ace-builds`, `@fortawesome/fontawesome-free` and `@fontsource/open-sans`.)
A checklist:

- `npm run vendor` (`tools/vendor.mjs`) empties and rewrites `vendor/clingo-wasm/`, `vendor/ace/`
  and `vendor/fonts/`; commit the files it removed too (`git add -A vendor/`).
- A test fails if `vendor/clingo-wasm/` does not match the version in `package.json`
  (`vendor/clingo-wasm/VERSION` lists the files with their checksums).
- If the file names of clingo-wasm changed (look at `git status vendor/clingo-wasm/`), update the
  prefetch links at the top of `index.html` and `PRECACHE` in `sw.js`. Only the browser tests
  notice a missing file (the offline test checks that `PRECACHE` holds every file the page loads),
  so run them: `npm run test:browser`, with Chromium installed.
- The same goes for new font files (`vendor/fonts/`) and Ace files (`vendor/ace/`) that the page loads.
- Play a game in the page (`npm run serve`), also once after a reload with the network turned off
  in the browser's developer tools, to see that the offline copy works.

### Adding an example game

1. Put the game file in `examples/` (for example, download it from the Versions tab with *Download
   the game file*). A version with a winning strategy goes in a file of its own, named
   `...-with-solutions.json`: the tests check that its strategy wins on fixed random levels, and
   that every example has no syntax errors and gets no warnings.
2. Add an `<option>` for it to the list of example games in `index.html` (`id="example-games"`;
   the games with solutions go in the `optgroup` *Solutions*, shown with `?solutions=true`). A test
   checks that every listed file exists.
3. Add it to `PRECACHE` in `sw.js`, so that it also works offline.
4. Optionally, add it to `FIRST_GAMES` in `js/tutorial.js`: the games offered at the end of the
   tutorial and in the Control tab.

The command-line version (`logic-game examples`, `--example NAME`) and the similarity check of the
Grading tab read `examples/` by themselves.

### Notes for contributors

- Modules that the Node tests import (`engine.js`, `asp.js`, `analysis.js`, `hints.js`,
  `storage.js`, `versions.js`, `folder.js`, `grading.js`, `submissions.js`, `feedback.js`,
  `pdf.js`, `text-board.js`, `solver.js`, and the command-line version) must not use the DOM
  (`document`, `window`, ...): the table at the top says which ones (*no DOM*).
- `docs/CLI.md` must mention every command and every option of `bin/logic-game.mjs`, and the
  help of the command must list them: a test checks both (`cli.test.mjs`).
- A new file that the page loads goes into `PRECACHE` in `sw.js` (a browser test checks this).
- The texts use American spelling, and the names of the editors for the programs: *Player
  strategy*, *Nature's moves*, *Winning conditions* (and *Auxiliary program*, *Level generation*,
  *Visibility program*).
- Run `npm run test:unit` while working, and `npm run lint` and `npm test` (with the browser
  tests) before a commit. A new test file `test/*.test.mjs` is part of both test commands.

## Deploying your own copy

The site is static, so any web server can serve it; the workflow publishes it to GitHub Pages.
For a copy (a fork) of your own on GitHub:

1. **Turn on GitHub Pages, once**: in the repository, *Settings > Pages > Build and deployment >
   Source: GitHub Actions* (instead of *Deploy from a branch*).
2. **Push to `main`**: the workflow (`.github/workflows/test-and-deploy.yml`) runs the tests, and
   when they pass, publishes the site. What is published is every file in the repository except
   the ones for development: everything that `git ls-files` lists, without `test/`, `tools/`,
   `.github/`, `package.json`, `package-lock.json`, `eslint.config.js` and `.gitignore` (the step *Collect the files of
   the site*). So `index.html`, `favicon.svg`, `.nojekyll`, `css/`, `js/`, `docs/`, `examples/`,
   `vendor/`, `stored/`, `sw.js`, and also `bin/`, `cli/`, `README.md` and `LICENSE`. Files that are
   not committed (such as `node_modules/`) are never published.
3. **Change the addresses of the original** to those of your copy. They are written out in:
   - `package.json`: `homepage` (the address of the site) and `repository`; the command-line
     version takes from there the links to levels that `logic-game test` prints, and the link to
     the guide in its help;
   - `docs/CLI.md`: the `git clone` address, the example output of `test`, and the example
     workflow for continuous integration;
   - `docs/instructions.html`: the `git clone` address and the link to the guide, in *Playing on
     your own computer*;
   - `README.md`: the address of the live site, the `git clone` address, and the link in
     *Grading, step by step*.

   (`grep -rn rdehaan --exclude-dir=node_modules --exclude-dir=vendor .` finds them all.)

To serve the site anywhere else, copy the same files to a web server. Serve them over HTTPS (or
from `localhost`): otherwise the browser does not run the service worker, and the game does not
work offline. (`tools/serve.mjs` shows which content types the files need.)

## License

MIT (see [LICENSE](LICENSE)). The bundled libraries in `vendor/` have their own licenses (in their
folders): clingo-wasm (Apache 2.0), the Ace editor (BSD), Open Sans (SIL OFL 1.1) and Font Awesome
Free (the fonts under SIL OFL 1.1, the icons under CC BY 4.0).
