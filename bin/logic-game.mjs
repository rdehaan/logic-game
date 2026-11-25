#!/usr/bin/env node
// The game on the command line: play, test a strategy, check programs, and
// convert between file formats. It uses the same engine and the same clingo
// (clingo-wasm) as the page, so games are played exactly as in the browser.
//
//   node bin/logic-game.mjs help
import { parseArgs } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import clingo from 'clingo-wasm';
import { create_solver } from '../js/solver.js';
import { GAME_FIELDS, SOURCE_NAMES, GameSession, replay_rng, test_strategy, normalize_game } from '../js/engine.js';
import { preprocess_program } from '../js/asp.js';
import { game_hints } from '../js/hints.js';
import { encode_game } from '../js/storage.js';
import { text_board } from '../js/text-board.js';
import { load_game, save_game, kind_of, example_names } from '../cli/game-files.mjs';

const SITE = 'https://rdehaan.github.io/logic-game/';

const HELP = `The logic game on the command line.

Usage: logic-game <command> [options]

A <game> is a folder (one .lp file per program, with game.json), a .zip of
such a folder, a .json game or project file, or the name of an example (e.g. flag3).

Commands:
  new <folder> [--example NAME]   Start a game folder from an example (default: flag1)
  play <game>                     Play a game, and show the board at every step
      --seed N                    Play level N of a test (generated with seed N, as in the browser)
      --new-level                 Generate a new level (also when the game has a level)
      --step                      Wait for Enter after every step
      --delay MS                  Wait MS milliseconds after every step
      --verbose                   Also show what went into and came out of the programs
      --quiet                     Only show the result
  test <game>                     Play many levels, and count how often the strategy wins
      --levels N                  The number of levels (default 20)
      --first-seed N              The seed of the first level (default 1)
      --json                      Print the results as JSON
  check <game>                    Check the programs for errors and mistakes with the special predicates
      --strict                    Also fail on warnings
  convert <from> <to>             Convert a game: to a folder, a .zip, or a .json game file
      --project                   Write a project file (for the browser's Versions tab) instead
  examples                        List the example games

Options for all commands:
  --timeout S                     The time limit for each call to clingo, in seconds (default 10)
  --max-steps N                   Stop a game after N steps (default 500)
  --no-color                      No colours in the output

Exit codes: 0 when all is well (play: won; test: every level won; check: no
errors), 1 for an error in using the command, 3 when the game was not won, a
test level was not won, or check found errors.
`;

const OPTIONS = {
  example: { type: 'string' },
  seed: { type: 'string' },
  'new-level': { type: 'boolean' },
  step: { type: 'boolean' },
  delay: { type: 'string' },
  verbose: { type: 'boolean', short: 'v' },
  quiet: { type: 'boolean', short: 'q' },
  levels: { type: 'string' },
  'first-seed': { type: 'string' },
  json: { type: 'boolean' },
  strict: { type: 'boolean' },
  project: { type: 'boolean' },
  timeout: { type: 'string' },
  'max-steps': { type: 'string' },
  'no-color': { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
};

class UsageError extends Error {}

function int_option(values, name, fallback, min = 0) {
  if (values[name] == null) return fallback;
  const n = Number(values[name]);
  if (!Number.isInteger(n) || n < min) throw new UsageError(`--${name} must be a whole number of at least ${min}`);
  return n;
}

function out(line = '') {
  process.stdout.write(line + '\n');
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function make_solver(values) {
  const timeout = values.timeout != null ? Number(values.timeout) : 10;
  if (!(timeout > 0)) throw new UsageError('--timeout must be a number of seconds');
  return create_solver(clingo, { timeout_ms: timeout * 1000 });
}

// ---- new, examples, convert -----------------------------------------------------------

async function cmd_new([folder], values) {
  if (!folder) throw new UsageError('new: which folder? e.g. logic-game new my-game');
  if (fs.existsSync(folder) && fs.readdirSync(folder).length) throw new UsageError(`${folder} already exists and is not empty`);
  const example = values.example || 'flag1';
  const { game, title } = await load_game(example);
  save_game(folder, game, { title: path.basename(path.resolve(folder)) + ` (from ${title})` });
  out(`Made the game folder ${folder} from the example ${example}:`);
  for (const f of fs.readdirSync(folder, { recursive: true }).map(String).sort()) {
    if (fs.statSync(path.join(folder, f)).isFile()) out('  ' + path.join(folder, f));
  }
  out();
  out('Write your strategy in ' + path.join(folder, 'strategy.lp') + ', then:');
  out(`  logic-game check ${folder}`);
  out(`  logic-game play ${folder}`);
  out(`  logic-game test ${folder}`);
  out('In the browser, load the folder in the Versions tab (or open it there, in Chrome and Edge).');
  return 0;
}

function cmd_examples() {
  for (const name of example_names()) out(name);
  return 0;
}

async function cmd_convert([from, to], values) {
  if (!from || !to) throw new UsageError('convert: from what to what? e.g. logic-game convert game.json my-game');
  const { game, title, project, files } = await load_game(from);
  if (fs.existsSync(to) && kind_of(to) !== 'folder' && fs.statSync(to).isDirectory()) throw new UsageError(`${to} is a folder`);
  save_game(to, game, { title, project, as_project: values.project, files: files || undefined });
  out(`Wrote ${to} (${values.project ? 'a project file' : kind_of(to) === 'json' ? 'a game file' : kind_of(to) === 'zip' ? 'a zip file of a game folder' : 'a game folder'}).`);
  return 0;
}

// ---- check -----------------------------------------------------------------------------

async function cmd_check([p], values) {
  if (!p) throw new UsageError('check: which game?');
  const { game, files } = await load_game(p);
  const solver = make_solver(values);
  const where = (field) => (files ? path.join(kind_of(p) === 'folder' ? p : '', files[field]) : SOURCE_NAMES[field]);
  const problems = [];
  const with_errors = new Set();
  for (const field of GAME_FIELDS) {
    const errors = await solver.check(preprocess_program(game[field], () => 0));
    if (errors === null) {
      problems.push({ field, severity: 'error', line: null, message: 'clingo took too long to check this program' });
      continue;
    }
    if (errors.length) with_errors.add(field);
    for (const e of errors) problems.push({ field, ...e, severity: 'error' });
  }
  const hints = game_hints(game, with_errors);
  for (const field of GAME_FIELDS) for (const h of hints[field] || []) problems.push({ field, ...h });
  const order = { error: 0, warning: 1, info: 2 };
  problems.sort((a, b) => GAME_FIELDS.indexOf(a.field) - GAME_FIELDS.indexOf(b.field) || (a.line ?? 0) - (b.line ?? 0) || order[a.severity] - order[b.severity]);
  for (const x of problems) {
    const at = where(x.field) + (x.line != null ? `:${x.line}` + (x.col != null ? `:${x.col}` : '') : '');
    out(`${at}: ${x.severity === 'info' ? 'note' : x.severity}: ${x.message.replace(/\n/g, '\n    ')}`);
  }
  const count = (s) => problems.filter((x) => x.severity === s).length;
  const errors = count('error');
  const warnings = count('warning');
  out(problems.length ? `${errors} error${errors === 1 ? '' : 's'}, ${warnings} warning${warnings === 1 ? '' : 's'}.` : 'No problems found.');
  return errors || (values.strict && warnings) ? 3 : 0;
}

// ---- play -------------------------------------------------------------------------------

async function cmd_play([p], values) {
  if (!p) throw new UsageError('play: which game?');
  const ansi = process.stdout.isTTY && !values['no-color'] && !process.env.NO_COLOR;
  const loaded = await load_game(p);
  let game = loaded.game;
  const solver = make_solver(values);
  const max_time = int_option(values, 'max-steps', 500, 1);
  const delay = int_option(values, 'delay', 0);
  let seed = values.seed != null ? int_option(values, 'seed', 1, 1) : null;
  let rng = Math.random;
  if (seed == null && (values['new-level'] || !game.level_state)) seed = 1 + Math.floor(Math.random() * 1e6);
  if (seed != null) {
    const r = await replay_rng(solver, game, seed);
    if (r.level.problem) {
      out('No level could be generated: ' + r.level.problem.text);
      return 3;
    }
    game = { ...game, level_state: r.level.level_state, level_settings: r.level.level_settings };
    rng = r.rng;
    if (!values.quiet) out(`Level ${seed} (generated with seed ${seed}; play it again with --seed ${seed}).`);
  } else if (!values.quiet) {
    out('The level of the game file.');
  }

  // (not verbose: the reports of the steps only have the problems)
  const session = new GameSession(solver, game, { rng, max_time, verbose: Boolean(values.verbose) });
  const quiet = values.quiet;
  const show = (facts, previous) => {
    if (quiet) return;
    const board = text_board(facts, { previous, ansi, legend: true });
    out(board ? board.join('\n') : '(the board cannot be drawn: the level settings have no grid size)');
  };
  const input = values.step && process.stdin.isTTY ? readline.createInterface({ input: process.stdin, output: process.stdout }) : null;
  try {
    const start = await session.start();
    if (!quiet) out(`\nTime 0`);
    show(session.view());
    if (session.verdict) {
      out(start.report + start.message);
      return 3;
    }
    let previous = session.view();
    let message = '';
    while (!session.verdict) {
      if (input) await input.question('(Enter: next step) ');
      const step = await session.step();
      if (!quiet && step.report.trim()) out(step.report.trimEnd());
      if (step.verdict) {
        message = step.message;
        break;
      }
      if (!quiet) {
        const moves = (step.moves || '').trim();
        out(`\nTime ${session.time_step}: ${moves ? 'the player did ' + moves.replace(/\.$/, '').replace(/\. /g, ', ') : 'the player did nothing'}`);
      }
      show(session.view(), previous);
      previous = session.view();
      if (delay) await sleep(delay);
    }
    // (the verdict is about the state before the moves of the last step)
    out((quiet ? '' : '\n') + message.trim() + ` (at time ${session.time_step - 1})`);
    return session.verdict === 'win' ? 0 : 3;
  } finally {
    if (input) input.close();
  }
}

// ---- test -------------------------------------------------------------------------------

async function cmd_test([p], values) {
  if (!p) throw new UsageError('test: which game?');
  const { game } = await load_game(p);
  const solver = make_solver(values);
  const levels = int_option(values, 'levels', 20, 1);
  const first_seed = int_option(values, 'first-seed', 1, 1);
  const max_time = int_option(values, 'max-steps', 500, 1);
  const code = await encode_game(normalize_game(game));
  const counts = {};
  const t0 = Date.now();
  const results = await test_strategy(solver, game, {
    levels, first_seed, max_time,
    on_level: (r) => {
      counts[r.verdict] = (counts[r.verdict] || 0) + 1;
      if (!values.json && r.verdict !== 'win') {
        out(`Level ${r.seed}: ${r.message}${r.steps ? ` (after ${r.steps} steps)` : ''}`);
        out(`  logic-game play ${p} --seed ${r.seed}   or in the browser: ${SITE}#game=${code}&seed=${r.seed}`);
      }
    },
  });
  const won = counts.win || 0;
  if (values.json) {
    out(JSON.stringify({ levels: results.length, won, counts, results }, null, 2));
  } else {
    const names = { win: 'won', lose: 'lost', timeout: 'timed out', stopped: 'stopped (clingo took too long)', 'no level': 'no level generated' };
    const parts = Object.entries(names).filter(([k]) => counts[k]).map(([k, name]) => `${counts[k]} ${name}`);
    out(`${results.length} level${results.length === 1 ? '' : 's'} (seeds ${first_seed} to ${first_seed + results.length - 1}): ${parts.join(', ')}. (${((Date.now() - t0) / 1000).toFixed(1)} seconds)`);
  }
  return won === results.length ? 0 : 3;
}

// ---- Main -------------------------------------------------------------------------------

const COMMANDS = { new: cmd_new, play: cmd_play, test: cmd_test, check: cmd_check, convert: cmd_convert, examples: cmd_examples };

async function main(argv) {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true });
  } catch (e) {
    process.stderr.write(e.message + '\n\n' + HELP);
    return 1;
  }
  const [command, ...rest] = parsed.positionals;
  if (!command || command === 'help' || parsed.values.help) {
    out(HELP);
    return command || parsed.values.help ? 0 : 1;
  }
  const run = COMMANDS[command];
  if (!run) {
    process.stderr.write(`Unknown command: ${command}\n\n${HELP}`);
    return 1;
  }
  try {
    return await run(rest, parsed.values);
  } catch (e) {
    process.stderr.write((e instanceof UsageError ? '' : 'Error: ') + e.message + '\n');
    return 1;
  }
}

// (clingo runs in a worker thread, which would keep Node running)
process.exit(await main(process.argv.slice(2)));
