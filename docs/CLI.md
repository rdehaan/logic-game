# Playing on your own computer: the command-line version

The game can also be played without a browser, with the programs in plain files on your own
computer. That way you can use your own editor, keep your work in git, and test your
strategy automatically. The command-line version uses the same game engine and the same
clingo as the web page, so a game is played in exactly the same way in both.

## Installing

You need [Node.js](https://nodejs.org/) (version 22 or newer) and git.

```
git clone https://github.com/rdehaan/logic-game.git
cd logic-game
npm install
npm link          # optional: makes the command `logic-game` available everywhere
```

Without `npm link`, run `node bin/logic-game.mjs` (or `npm run game --`) in the `logic-game`
folder wherever this guide says `logic-game`. Only clingo-wasm is needed to play: with
`npm install --omit=dev`, the tools for the tests of the game itself (such as a browser) are
not installed. To update later: `git pull` and `npm install` in that folder.

## Quick start

```
logic-game new my-game --example flag3      # make a game folder from an example
cd my-game
# ... write your strategy in strategy.lp, in any editor ...
logic-game check .                          # errors and warnings, with line numbers
logic-game play .                           # play the level, and see the board at every step
logic-game test . --levels 50               # how often does your strategy win?
```

`logic-game examples` lists the example games; `logic-game help` lists all commands.

## Game folders

A game folder holds one plain clingo file per program:

```
my-game/
  game.json                 the title, and which file holds which program
  auxiliary.lp              the auxiliary program (added to all programs)
  level-generation.lp       how levels are generated
  visibility.lp             what the player can observe
  nature.lp                 nature's moves
  winning-conditions.lp     when the game is won or lost
  strategy.lp               your strategy (the player's program)
  level/state.lp            the level (if there is one)
  level/settings.lp
```

The programs are the same as in the tabs of the web page; the Instructions tab of the page
explains what each of them does. Files can have other names: `game.json` says which file is
which (`"files": { "player_move_program": "src/strategy.lp", ... }`).

Wherever a command takes a game, it can also be a `.zip` file of a game folder (as the web
page downloads it), a `.json` game file (like the files in `examples/`), a project file
(downloaded from the Versions tab of the page: its current version is used), or the name of
an example (such as `flag3`).

## Commands

### `logic-game new <folder> [--example NAME]`

Makes a new game folder from an example game (by default `flag1`). The folder must not exist
yet, or be empty.

### `logic-game check <game> [--strict]`

Checks all programs for syntax errors and unsafe variables, and for mistakes with the special
predicates (the same warnings as in the editors of the page), for example a strategy that never
derives `do/1`, or that uses `at/3` where it can only see `observe(at(...))`:

```
my-game/strategy.lp:1:19: warning: at/3 never holds here: the player does not see the state ...
my-game/winning-conditions.lp:3:1: error: unsafe variables in: lose(X):-current_time(T);T>=15.; 'X' is unsafe
1 error, 1 warning.
```

Many editors can jump to `file:line:column`. A program with an error gets no warnings until the
error is fixed. With `--strict`, warnings also count as failures.

### `logic-game play <game>`

Plays a game, and shows the board as text after every step, with the moves of the player:

```
Time 3: the player did do(move(down))
  1 2 3 4 5 6 7 8
1 . . . . . . . .
2 . . . . . . . .
3 . . . P . . . .
4 . . . . . . . .
5 . . . . . . F .
6 . . . . . . . .
F = flag, P = player
```

Each object is shown with a letter (the first letter of its name that no other object has, or its label when that is a
short string, such as `"$"`). Lower-case letters are things the player does not observe, and
`~` marks cells the player cannot see. In a terminal, the cells that changed in the last step
are highlighted.

Which level is played:
- `--seed N`: level N of a test (see `test` below): generated and played with the same random
  numbers as in the test, and as the levels of *Test your strategy* in the web page;
- `--new-level`: a newly generated level (the seed is printed, to play it again);
- otherwise the level in the game (`level/state.lp`), or a new level if there is none.

Other options:
- `--step`: wait for Enter after every step;
- `--delay MS`: wait MS milliseconds after every step (to watch the game);
- `--verbose`: also show what went into the player's program and what came out of it in every
  step (as the Debug tab of the page);
- `--quiet`: only show the result.

### `logic-game test <game>`

Plays the game on many levels, without showing them, and counts how often the strategy wins.
Level N is generated with seed N, so every level can be played again exactly: the command
prints, for every level that was not won, how to play it on the command line and a link that
opens it in the web page.

```
Level 4: LOSE! (lose(timeout)) (after 16 steps)
  logic-game play my-game --seed 4   or in the browser: https://rdehaan.github.io/logic-game/#game=...&seed=4
20 levels (seeds 1 to 20): 19 won, 1 lost. (3.2 seconds)
```

- `--levels N`: the number of levels (default 20);
- `--first-seed N`: start at another level (default 1);
- `--json`: print the results as JSON (for your own scripts).

### `logic-game convert <from> <to> [--project]`

Converts a game between the formats: a folder, a `.zip` file of a folder, a `.json` game file,
or (with `--project`) a project file for the Versions tab of the web page. What to write is
decided by the name of `<to>`: `.zip`, `.json`, or else a folder.

```
logic-game convert ~/Downloads/my-project.json my-game     # a project from the web page, as a folder
logic-game convert my-game my-game.json                    # a folder as one game file (to hand in)
```

### `logic-game grade <submissions...>`

For teachers: tests the games of students, and suggests scores for the items of the rubric,
as *Test and measure* in the Grading tab of the web page (grader mode) does, for all students at
once. The result is a grading file, to import in the Grading tab (*Import grading…*): the test
results and suggestions are then there for every student, and you grade them in the page. Load
the submissions in the page too, to see the students' PDF files (the grading is kept).

`<submissions>` can be the zip file of *Download submissions* in Canvas (as it is), the zip file
of one student, game files, or folders of these (in a folder, every file is read, and every
folder in it is the submission of one student).

```
logic-game grade ~/Downloads/submissions.zip --levels 20 --csv measurements.csv
```

```
30 submissions, 20 levels each:
- doejane (1001): won 20 of 20; level generation at most 0.4 s, strategy at most 0.2 s in a step; most similar: flag9 (41%)
    suggested: 9 (2 items for you to decide: documented, visual)
- roerich (1002), late: won 12 of 20; level generation at most 1.2 s, nature's moves at most 0.1 s in a step; most similar: flag5-with-solutions (97%)
    suggested: not met: novel (then you give the grade); extra points +2 (2 items for you to decide: documented, visual)
...
Wrote grading-2026-11-26.json and measurements.csv (412.7 seconds).
```

- `--levels N`: the number of levels to play for each game (default: as in the rubric, 20);
- `--rubric FILE`: use this rubric (a `.json` file, as the Grading tab downloads it) instead of
  the default one;
- `--out FILE`: the name of the grading file (default `grading-<date>.json`; an existing file is
  never overwritten);
- `--csv FILE`: also write the measurements (wins, times, what the player does not see, NPCs,
  different levels, memory, the most similar game) and the suggested scores, one row per student;
- `--accept`: take over the suggestions as scores (as *Accept the suggestions* in the page does);
  without it, the suggestions are only suggestions, and you decide in the page.

The games are compared with the example games and with each other (the programs without
comments, spaces and names of variables): the most similar one is a hint, not proof of copying.

Submissions come from others, so `grade` is careful with them: a file in a zip file that is
larger than 100 MB when unpacked, or that is damaged, is left out (with a note); all files
together may unpack to at most 500 MB (or 4 times the size of what you give it, if that is
more), or nothing is read; symbolic links in folders are not read; and a game that cannot be
tested gets a note, and the others are still tested.

### `logic-game feedback <grading> <folder> [--format LIST]`

Writes the feedback of every student of a grading file (exported from the Grading tab with
*Export the grading*, or written by `grade`) into a folder: one file per student and format,
and `grades.csv` with the grades of all students.

```
logic-game feedback grading-2026-11-26.json feedback --format pdf,md
```

- `--format LIST`: `pdf`, `html` and/or `md` (Markdown), separated by commas (default `pdf`);
- `--rubric FILE`: grade with this rubric instead of the one in the grading file.

Pictures of the board are only drawn by the web page: the feedback written here has their captions.

### Options for all commands

- `--timeout S`: stop a call to clingo after S seconds (default 10), as on the page;
- `--max-steps N`: stop a game after N steps (default 500);
- `--no-color`: no colours (also when the environment variable `NO_COLOR` is set);
- `-h`, `--help` (or the command `help`): the list of commands and options.

Short forms: `-v` for `--verbose`, `-q` for `--quiet`.

### Permissions

The commands run under Node's permission model: they can read files, but they only write what
the command writes (the folder of `new` and `feedback`, the result of `convert`, the files of
`grade`), and they cannot start other programs. The games of students are programs written by
others: this is a second safeguard, next to refusing programs with scripts. To run a command
without it (for example to find out whether a problem comes from it), set the environment
variable `LOGIC_GAME_NO_PERMISSIONS=1`.

### Exit codes

`0` when all went well (`play`: the game was won; `test`: every level was won; `check`: no
errors; `grade`: every submission has a game, and it could be tested), `3` when not, and `1` when the command was used wrongly (for example a game that does
not exist). So the commands can be used in scripts, and in continuous integration.

## Working with git

A game folder works well with git: every program is its own file, so `git diff` shows the
changes per program, and the history of your strategy is the history of `strategy.lp`.

```
logic-game new my-game --example flag5
cd my-game
git init
git add .
git commit -m "Start from Find the flag 5"
# ... work on strategy.lp ...
git diff
git commit -am "Walk around trees"
```

The file `level/state.lp` changes whenever a new level is generated (and the files in `level/`
are removed when the level is cleared). If you do not want that in
your history, add `level/` to a `.gitignore` file (games then start with a new level).

### Together with the web page

- In the web page (Versions tab), *Download as a folder (.zip)* gives the current game as a game
  folder; *Select folder* loads a game folder.
- In Chrome and Edge, *Link a folder…* in the Versions tab links the page to a game folder on
  your computer: every change in the page is saved into the files, and changes to the files (by
  your editor, or by `git checkout`) are loaded into the page within a few seconds. A file that
  changed on disk is never overwritten by the page; the page's version is kept as a snapshot.
  So you can edit in the page, commit with git, and switch between branches.

### Testing in continuous integration

Because `test` fails (exit code 3) when a level is not won, it can check every push. For
example, for GitHub Actions, in `.github/workflows/strategy.yml` of your repository:

```yaml
name: strategy
on: [push]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: git clone --depth 1 https://github.com/rdehaan/logic-game.git /tmp/logic-game && npm --prefix /tmp/logic-game install --omit=dev
      - run: node /tmp/logic-game/bin/logic-game.mjs check . --strict
      - run: node /tmp/logic-game/bin/logic-game.mjs test . --levels 50
```

## Troubleshooting

- *`logic-game: command not found`*: run `npm link` in the `logic-game` folder, or use
  `node path/to/logic-game/bin/logic-game.mjs` instead.
- *`STOPPED! (... took too long)`*: a program took longer than the time limit (10 seconds); a
  program with a large grounding is slow. Try `--timeout 30`, or make the program smaller.
- *A game behaves differently from the web page*: check that both use the same version of the
  game (`git pull` in the `logic-game` folder), and play the same level (`--seed N` plays level
  N of *Test your strategy*).
