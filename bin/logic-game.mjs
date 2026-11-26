#!/usr/bin/env node
// The game on the command line: play, test a strategy, check programs,
// convert between file formats, and grade the games of students. It uses the same engine and the same clingo
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
import { load_game, save_game, kind_of, example_names, submission_files, EXAMPLES } from '../cli/game-files.mjs';
import {
  DEFAULT_RUBRIC, read_rubric, rubric_items, measure_game, most_similar, fingerprint, suggest_all, apply_suggestions,
  compute_grade, format_number, win_counts, npcs, session_file, read_session, grades_csv, STEP_PROGRAM_NAMES,
} from '../js/grading.js';
import { read_submissions } from '../js/submissions.js';
import { feedback_model, feedback_markdown, feedback_html, feedback_pdf, feedback_name } from '../js/feedback.js';

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
      -v, --verbose               Also show what went into and came out of the programs
      -q, --quiet                 Only show the result
  test <game>                     Play many levels, and count how often the strategy wins
      --levels N                  The number of levels (default 20)
      --first-seed N              The seed of the first level (default 1)
      --json                      Print the results as JSON
  check <game>                    Check the programs for errors and mistakes with the special predicates
      --strict                    Also fail on warnings
  convert <from> <to>             Convert a game: to a folder, a .zip, or a .json game file
      --project                   Write a project file (for the browser's Versions tab) instead
  grade <submissions...>          Test the games of students, and suggest scores (for the Grading tab of the web page)
                                  <submissions>: Canvas' zip file of all submissions, zip files, game files,
                                  or folders of these (each folder in a folder: one student)
      --levels N                  The number of levels to play for each game (default: from the rubric, 20)
      --rubric FILE               Use this rubric (.json) instead of the default one
      --out FILE                  Write the grading file to FILE (default grading-<date>.json)
      --csv FILE                  Also write the measurements and suggested scores as CSV
      --accept                    Take over the suggestions as scores (as "Accept the suggestions")
  feedback <grading> <folder>     Write the feedback of every student of a grading file (exported from the
                                  Grading tab, or written by grade) into a folder, with grades.csv
      --format LIST               pdf, html and/or md, separated by commas (default pdf)
  examples                        List the example games
  help                            Show this help (also: --help, -h)

Options for all commands:
  --timeout S                     The time limit for each call to clingo, in seconds (default 10)
  --max-steps N                   Stop a game after N steps (default 500)
  --no-color                      No colours in the output (also when NO_COLOR is set)

The full guide: docs/CLI.md (https://github.com/rdehaan/logic-game/blob/main/docs/CLI.md).

Exit codes: 0 when all is well (play: won; test: every level won; check: no
errors; grade: every submission has a game), 1 for an error in using the
command, 3 when the game was not won, a test level was not won, check found
errors, or a submission has no game.
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
  rubric: { type: 'string' },
  out: { type: 'string' },
  csv: { type: 'string' },
  accept: { type: 'boolean' },
  format: { type: 'string' },
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
  if (kind_of(folder) !== 'folder' || (fs.existsSync(folder) && !fs.statSync(folder).isDirectory())) {
    throw new UsageError(`new makes a game folder: ${folder} is not a folder name (use convert to make a .zip or .json file)`);
  }
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
  out('In the web page (Versions tab): load it with "Select folder", or (in Chrome and Edge) link it with "Link a folder...".');
  return 0;
}

function cmd_examples() {
  for (const name of example_names()) out(name);
  return 0;
}

async function cmd_convert([from, to], values) {
  if (!from || !to) throw new UsageError('convert: from what to what? e.g. logic-game convert game.json my-game');
  if (values.project && kind_of(to) !== 'json') throw new UsageError('convert --project writes a project file: give a name that ends in .json');
  const { game, title, project, files } = await load_game(from);
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

// ---- grade, feedback ------------------------------------------------------------------------
//
// The same measurements and suggestions as the Grading tab of the web page
// (js/grading.js); the grading file that grade writes is imported there
// (Import grading...), and feedback writes the feedback of a grading file.

function load_rubric(values) {
  if (!values.rubric) return read_rubric(DEFAULT_RUBRIC);
  if (!fs.existsSync(values.rubric)) throw new UsageError(`--rubric: ${values.rubric} does not exist`);
  try {
    return read_rubric(fs.readFileSync(values.rubric, 'utf8'));
  } catch (e) {
    throw new UsageError(`--rubric: ${e.message}`);
  }
}

const seconds = (ms) => `${(ms / 1000).toFixed(1)} s`;

// The measurements of the CSV file of grade.
function measurements_csv(rubric, students) {
  const items = rubric_items(rubric);
  const header = ['student', 'canvas_id', 'late', 'game', 'levels', 'won', 'generation_s', 'slowest_step_s', 'not_seen', 'npcs',
    'different_levels', 'memory_steps', 'steps', 'most_similar', 'similarity', ...items.map((item) => 'suggested_' + item.id), 'suggested_grade'];
  const rows = students.map((st) => {
    const m = st.measurements;
    if (!m) return [st.name, st.canvas_id || '', st.late ? 'yes' : '', st.game ? 'yes' : 'no'];
    const top = (st.similar || [])[0];
    const sug = st.suggestions || {};
    const g = compute_grade(rubric, apply_suggestions(rubric, {}, sug));
    const slowest = Math.max(0, ...Object.values(m.program_ms).map((x) => x.max));
    return [st.name, st.canvas_id || '', st.late ? 'yes' : '', 'yes', m.levels.length, win_counts(m).win || 0,
      (Math.max(0, ...m.generation_ms) / 1000).toFixed(2), (slowest / 1000).toFixed(2), Object.keys(m.hidden).join(' '),
      npcs(m, rubric.checks).join(' '), m.distinct_levels, m.memory_steps, m.steps, top ? top.name : '', top ? Math.round(top.overall * 100) + '%' : '',
      ...items.map((item) => (sug[item.id] && sug[item.id].value) || ''), g.below_pass ? '' : format_number(g.computed)];
  });
  const cell = (x) => (/[",\n\r;]/.test(String(x)) ? '"' + String(x).replace(/"/g, '""') + '"' : String(x));
  return [header, ...rows].map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n';
}

async function cmd_grade(paths, values) {
  if (!paths.length) throw new UsageError('grade: which submissions? e.g. logic-game grade submissions.zip');
  const rubric = load_rubric(values);
  const levels = int_option(values, 'levels', rubric.checks.test_levels, 1);
  const max_time = int_option(values, 'max-steps', 500, 1);
  const out_file = values.out || `grading-${new Date().toISOString().slice(0, 10)}.json`;
  if (!/\.json$/i.test(out_file)) throw new UsageError('--out: the grading file is a .json file');
  if (fs.existsSync(out_file)) throw new UsageError(`${out_file} already exists: remove it, or give another name with --out`);
  if (values.csv && fs.existsSync(values.csv)) throw new UsageError(`${values.csv} already exists: remove it, or give another name with --csv`);
  const solver = make_solver(values);
  let list;
  try {
    list = submission_files(paths);
  } catch (e) {
    throw new UsageError(e.message);
  }
  const { students, notes } = await read_submissions(list);
  for (const note of notes) out('Note: ' + note);
  if (!students.length) {
    out('No submissions were found.');
    return 3;
  }
  // The games to compare with: the examples, and the other submissions
  const examples = example_names().map((name) => ({ name, fingerprint: fingerprint(JSON.parse(fs.readFileSync(path.join(EXAMPLES, name + '.json'), 'utf8'))) }));
  const prints = new Map(students.filter((st) => st.game).map((st) => [st.key, fingerprint(st.game)]));
  const progress = process.stderr.isTTY;
  const t0 = Date.now();
  out(`${students.length} submission${students.length === 1 ? '' : 's'}, ${levels} level${levels === 1 ? '' : 's'} each:`);
  let missing = 0;
  for (const [i, st] of students.entries()) {
    const who = `${st.name}${st.canvas_id ? ` (${st.canvas_id})` : ''}${st.late ? ', late' : ''}`;
    delete st.pdf_files;      // (not in a grading file)
    if (!st.game) {
      missing++;
      out(`- ${who}: ${st.warnings.join(' ')}`);
      continue;
    }
    const m = await measure_game(solver, st.game, {
      levels, max_time,
      on_progress: ({ level }) => { if (progress) process.stderr.write(`\r  ${i + 1}/${students.length} ${st.name}: level ${level} of ${levels}\u2026\x1b[K`); },
    });
    if (progress) process.stderr.write('\r\x1b[K');
    st.measurements = m;
    st.similar = most_similar(st.game, [...examples, ...students.filter((x) => x !== st && x.game).map((x) => ({ name: `${x.name} (a submission)`, fingerprint: prints.get(x.key) }))], 3);
    st.suggestions = suggest_all(rubric, m, st.similar);
    if (values.accept) st.scores = apply_suggestions(rubric, st.scores, st.suggestions);
    const g = compute_grade(rubric, apply_suggestions(rubric, {}, st.suggestions));
    const slowest = Object.entries(m.program_ms).sort((a, b) => b[1].max - a[1].max)[0];
    const top = st.similar[0];
    out(`- ${who}: won ${win_counts(m).win || 0} of ${m.levels.length}; level generation at most ${seconds(Math.max(0, ...m.generation_ms))}` +
      (slowest ? `, ${STEP_PROGRAM_NAMES[slowest[0]] || slowest[0]} at most ${seconds(slowest[1].max)} in a step` : '') +
      (top ? `; most similar: ${top.name} (${Math.round(top.overall * 100)}%)` : ''));
    const not_met = rubric.required.items.filter((item) => st.suggestions[item.id] && st.suggestions[item.id].value === 'no').map((item) => item.id);
    out(`    suggested: ${g.below_pass ? `not met: ${not_met.join(', ')} (then you give the grade); extra points +${format_number(g.points)}` : `${format_number(g.computed)}`}` +
      (g.undecided.length ? ` (${g.undecided.length} item${g.undecided.length === 1 ? '' : 's'} for you to decide: ${g.undecided.join(', ')})` : ''));
    for (const w of st.warnings) out(`    note: ${w}`);
  }
  fs.writeFileSync(out_file, JSON.stringify(session_file({ rubric, students }), null, 1) + '\n');
  if (values.csv) fs.writeFileSync(values.csv, measurements_csv(rubric, students));
  out(`\nWrote ${out_file}${values.csv ? ` and ${values.csv}` : ''} (${((Date.now() - t0) / 1000).toFixed(1)} seconds).`);
  out('In the web page (grader mode), Grading tab: Import grading... loads it; load the submissions there too, to see the PDF files.');
  return missing ? 3 : 0;
}

const FORMATS = ['pdf', 'html', 'md'];

async function cmd_feedback([file, folder], values) {
  if (!file || !folder) throw new UsageError('feedback: from which grading file, into which folder? e.g. logic-game feedback grading.json feedback');
  const formats = (values.format || 'pdf').split(',').map((f) => f.trim().toLowerCase()).filter(Boolean);
  const wrong = formats.filter((f) => !FORMATS.includes(f));
  if (wrong.length || !formats.length) throw new UsageError(`--format: ${wrong.join(', ') || '(none)'} is not one of ${FORMATS.join(', ')}`);
  if (!fs.existsSync(file)) throw new UsageError(`${file} does not exist`);
  if (fs.existsSync(folder) && !fs.statSync(folder).isDirectory()) throw new UsageError(`${folder} is not a folder`);
  let session;
  try {
    session = read_session(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    throw new UsageError(`${file}: ${e.message}`);
  }
  const rubric = values.rubric ? load_rubric(values) : session.rubric || read_rubric(DEFAULT_RUBRIC);
  fs.mkdirSync(folder, { recursive: true });
  let pictures = 0;
  let open = 0;
  for (const st of session.students) {
    const model = feedback_model(rubric, st);
    pictures += model.images.length;
    const name = path.join(folder, feedback_name(st));
    if (formats.includes('pdf')) fs.writeFileSync(name + '.pdf', feedback_pdf(model));
    if (formats.includes('html')) fs.writeFileSync(name + '.html', feedback_html(model));
    if (formats.includes('md')) fs.writeFileSync(name + '.md', feedback_markdown(model));
    const g = compute_grade(rubric, st.scores, st.grade_override);
    if (g.grade == null) open++;
    out(`- ${st.name}: ${g.text}`);
  }
  fs.writeFileSync(path.join(folder, 'grades.csv'), grades_csv(rubric, session.students));
  const n = session.students.length;
  out(`Wrote the feedback of ${n} student${n === 1 ? '' : 's'} (${formats.join(', ')}) and grades.csv into ${folder}.`);
  if (open) out(`Note: ${open} of them ${open === 1 ? 'has' : 'have'} no grade yet (items not decided, or a requirement not met without a grade given).`);
  if (pictures) out('(Pictures of the board are only drawn by the web page: here, only their captions are in the feedback.)');
  return 0;
}

// ---- Main -------------------------------------------------------------------------------

const COMMANDS = {
  new: cmd_new, play: cmd_play, test: cmd_test, check: cmd_check, convert: cmd_convert, examples: cmd_examples,
  grade: cmd_grade, feedback: cmd_feedback,
};

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
const code = await main(process.argv.slice(2));
// (all output is written before Node stops: stdout can be a pipe that is written to later)
await new Promise((resolve) => process.stdout.write('', resolve));
process.exit(code);
