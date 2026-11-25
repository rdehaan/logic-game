// The page: buttons, loading and saving games, and playing a game step by step.
import clingo from '../vendor/clingo-wasm/index.web.js';
import { create_solver } from './solver.js';
import { GAME_FIELDS, SOURCE_NAMES, GameSession, generate_level, normalize_game, test_strategy, replay_rng } from './engine.js';
import { Editors, make_example_editors } from './editors.js';
import { show_grid, clear_grid, display_win, display_lose } from './grid-visual.js';
import { board_problems } from './hints.js';
import { WorkStore, encode_game, decode_game, game_id, same_game } from './storage.js';
import { VersionStore, read_file, file_stem } from './versions.js';
import { VersionsTab } from './versions-tab.js';
import { Tutorial, first_games_html } from './tutorial.js';
import './modal.js';

const solver = create_solver(clingo);
const editors = new Editors(solver);

// The texts of the Instructions and Internals tabs, and the info pop-ups, are
// in docs/*.html; they are put into the elements with data-include.
async function load_fragments() {
  await Promise.all([...document.querySelectorAll('[data-include]')].map(async (elem) => {
    const response = await fetch(elem.dataset.include);
    if (!response.ok) throw new Error(`could not load ${elem.dataset.include} (${response.status})`);
    elem.innerHTML = await response.text();     // (files of the site itself)
  }));
  make_example_editors();
}
const fragments = load_fragments();

// Handles for elements
const $ = (id) => document.getElementById(id);
const lock_button = $('lock-button');
const unlock_button = $('unlock-button');
const generate_button = $('generate-button');
const clear_button = $('clear-button');
const reset_button = $('reset-button');
const play_button = $('play-button');
const pause_button = $('pause-button');
const stop_button = $('stop-button');
const step_button = $('step-button');
const speed_selector = $('speed-selector');
const example_games = $('example-games');
const load_status = $('load-status');
const upload_status = $('upload-status');
const engine_status = $('engine-status');

// The game rules: locked while playing (and needed to be locked to play)
const RULE_PROGRAMS = ['aux_program', 'level_gen_program', 'visibility_program', 'nature_program', 'goal_program'];
// The programs that make the level
const LEVEL_GEN_PROGRAMS = ['aux_program', 'level_gen_program'];

function set_button(button, enabled, title = '') {
  button.disabled = !enabled;
  button.title = enabled ? '' : title;
}

function set_engine_status(text, is_error = false) {
  engine_status.textContent = text;
  engine_status.classList.toggle('error', is_error);
}

// ---- Game output -------------------------------------------------------------
//
// The reports of the steps of the last game. The Debug tab shows one step at a
// time (the step of the board that is shown), or all of them at once.

const game_output_elem = $('game-output');
let step_reports = new Map();     // step -> report
let output_messages = [];         // the other messages (verdicts, problems), newest first

function clear_game_output() {
  game_output_elem.textContent = '';
  step_reports = new Map();
  output_messages = [];
  update_debug_view();
}
// New text goes at the top (most recent step first). Each piece is its own
// text node, so that adding a step does not rewrite the whole output.
// A step's report can be clicked to show the board at that step.
function add_to_game_output(text, step = null) {
  if (step == null) {
    game_output_elem.prepend(document.createTextNode(text + '\n'));
    output_messages.unshift(text);
    update_debug_view();
    return;
  }
  step_reports.set(step, text);
  const span = document.createElement('span');
  span.className = 'output-step';
  span.textContent = text + '\n';
  span.title = 'Click to see the board at this step';
  // (the board that the player saw in this step)
  span.addEventListener('click', () => show_snapshot(snapshots.findIndex((x) => x.time === step - 1)));
  game_output_elem.prepend(span);
}

// The Debug tab: the messages, and the report of the step of the board that is shown.
function update_debug_view() {
  const all = $('show-all-output').checked;
  game_output_elem.hidden = !all;
  $('debug-steps').hidden = all;
  $('debug-messages').textContent = output_messages.join('\n').trim();
  $('debug-messages').hidden = all || output_messages.length === 0;
  const snap = snapshots[shown_snapshot];
  const report = snap ? step_reports.get(snap.time + 1) : null;
  const elem = $('debug-step');
  if (!snapshots.length) {
    $('debug-step-label').textContent = '';
    elem.textContent = output_messages.length ? '' : 'Play a game (or use Step) to see here what happens in each step.';
  } else if (!snap) {
    $('debug-step-label').textContent = '';
    elem.textContent = 'The game is being played…';
  } else if (report) {
    $('debug-step-label').textContent = `Step ${snap.time + 1}: the player saw the board of time ${snap.time} (shown above), and decided on a move.`;
    elem.textContent = report.replace(/^## STEP \d+ ##\n/, '');
  } else {
    $('debug-step-label').textContent = `Time ${snap.time}: the end of the game.`;
    elem.textContent = shown_snapshot === snapshots.length - 1 && final_verdict ? (output_messages[0] || '') : 'This step has not been played yet.';
  }
  // The slider of the Debug tab follows the one under the board
  const slider = $('debug-timeline');
  slider.max = $('timeline').max;
  slider.value = $('timeline').value;
  slider.disabled = $('timeline').disabled;
  $('debug-prev').disabled = $('timeline-prev').disabled;
  $('debug-next').disabled = $('timeline-next').disabled;
  $('debug-steps').classList.toggle('empty', snapshots.length === 0);
}

$('show-all-output').addEventListener('change', () => {
  set_option('all_output', $('show-all-output').checked);
  update_debug_view();
});
$('debug-timeline').addEventListener('input', () => show_snapshot(Number($('debug-timeline').value) - 1));
$('debug-prev').addEventListener('click', () => show_snapshot(shown_snapshot - 1));
$('debug-next').addEventListener('click', () => show_snapshot(shown_snapshot + 1));

// ---- States of the game engine -------------------------------------------------

let speed = Number(speed_selector.value);
let session = null;            // the game being played
let playing = false;           // a game is going on (possibly paused)
let game_paused = false;
let stop_requested = false;
let single_step = false;
let level_locked = false;      // the game rules are locked (needed to generate a level and to play)
let generating = false;
// The seed of the level in the editors, if it is a level from a test (or from a
// link to one): then Play plays it with the same random numbers as the test did.
let level_seed = null;
let testing = false;
let test_cancelled = false;

// What the board is based on:
// - level_basis: where the level came from ({ source, at, programs }), with the
//   programs that made it (the auxiliary and level generation programs);
// - run_basis: all programs and the level when the last game was started.
let level_basis = null;
let run_basis = null;
let board_notice = '';         // a message about the last change to the level

function select_speed() {
  speed = Number(speed_selector.value);
}

const level_programs = () => Object.fromEntries(LEVEL_GEN_PROGRAMS.map((k) => [k, editors.value(k)]));

function set_level_basis(source) {
  level_basis = editors.value('level_state') ? { source, at: new Date(), programs: level_programs() } : null;
}

// The fields that changed since a game (an object with all fields).
function changed_since(game) {
  if (!game) return [];
  return GAME_FIELDS.filter((k) => (game[k] || '') !== editors.value(k));
}

// ---- The buttons, and what the board shows ------------------------------------------

function set_label(button, icon, text) {
  button.textContent = icon + ' ' + text;
}

// Enable the buttons that can be used now, and say why the others cannot.
function update_controls() {
  const has_level = Boolean(editors.value('level_state'));
  const busy = playing && !game_paused;
  const idle = !playing && !testing && !generating;
  const why = playing ? 'Not while a game is going on (Stop ends it).' : testing ? 'Not while the strategy is being tested.' : generating ? 'A level is being generated.' : '';

  set_label(generate_button, '⎚', level_locked ? 'Generate level' : 'Lock rules and generate level');
  set_button(generate_button, idle, why);
  if (idle) generate_button.title = level_locked ? 'Make a new level with the level generation program' : 'Lock the game rules (so that they cannot be changed during a game), and make a new level with them';
  set_button(clear_button, idle && has_level, why || 'There is no level.');
  set_button(reset_button, idle && has_level && snapshots.length > 0, why || (has_level ? 'The level is already in its initial state.' : 'There is no level.'));
  if (!reset_button.disabled) reset_button.title = 'Show the level as it was before the game';

  const can_play = has_level && (!playing || game_paused) && !testing && !generating;
  set_label(play_button, '⏵', game_paused ? 'Resume' : level_locked ? 'Play' : 'Lock rules and play');
  set_button(play_button, can_play, !has_level ? 'There is no level: generate one first.' : why);
  set_button(step_button, can_play, !has_level ? 'There is no level: generate one first.' : why);
  if (can_play) step_button.title = 'Play one step, then pause';
  set_button(pause_button, busy && !single_step, 'There is no game going on.');
  set_button(stop_button, playing, 'There is no game going on.');
  const test_button = $('test-button');
  set_button(test_button, !playing && !testing && !generating, why);
  test_button.textContent = level_locked ? 'Test' : 'Lock rules and test';

  // The lock of the game rules
  lock_button.disabled = level_locked;
  set_button(unlock_button, level_locked && !playing && !testing, why);
  $('rules-lock').classList.toggle('unlocked', !level_locked);
  $('section-game-rules').classList.toggle('rules-unlocked', !level_locked);
  $('rules-lock-text').textContent = level_locked
    ? 'The game rules are locked: games are played with these programs. Unlock them to change them.'
    : 'The game rules are unlocked: you can change them. Lock them again to generate a level or play.';
  editors.set_read_only(RULE_PROGRAMS, level_locked || playing);
  editors.set_read_only(['player_move_program'], playing);
  update_board_status();
}

// The line under the board: what it shows, and what changed since.
function update_board_status() {
  const elem = $('board-status');
  const parts = [];
  const has_level = Boolean(editors.value('level_state'));
  if (generating) {
    parts.push('Generating a level…');
  } else if (testing) {
    parts.push('Testing the strategy on many levels… (see the Strategy tab)');
  } else if (playing && !game_paused) {
    parts.push('Playing… The programs cannot be changed during a game.');
  } else if (playing) {
    parts.push(`Paused at time ${snapshots.length ? snapshots.at(-1).time : 0}. Play goes on, Step plays one step, Stop ends the game.`);
  } else {
    if (board_notice) parts.push(board_notice);
    if (!has_level) {
      if (!board_notice) parts.push('There is no level: generate one.');
    } else if (snapshots.length && run_basis) {
      const t = snapshots.at(-1).time;
      const verdict = final_verdict ? final_verdict.toUpperCase() : 'stopped';
      let text = `The board shows the last game (${verdict} at time ${t}).`;
      const changed = changed_since(run_basis);
      if (changed.length) text += ` Since then, you changed: ${changed.map((k) => SOURCE_NAMES[k]).join(', ')}. Play again to see what the game does now.`;
      parts.push(text);
    } else if (level_basis) {
      const from = level_basis.source === 'generated' ? `generated at ${level_basis.at.toLocaleTimeString()}`
        : level_basis.source === 'loaded' ? 'from the game that was loaded'
          : level_basis.source;
      parts.push(`The board shows the start of the level (${from}).`);
    } else {
      parts.push('The board shows the start of the level.');
    }
    if (!level_locked) parts.push('The game rules are unlocked, so they can be changed: lock them to play.');
  }
  elem.textContent = parts.join(' ');
  elem.classList.toggle('attention', !level_locked || (!playing && changed_since(run_basis).length > 0 && snapshots.length > 0));
}

function lock_level_generation() {
  lock_rules();
}

// Lock the game rules. A level that was made with other versions of the level
// programs is removed; a game that was played with other rules is put away.
function lock_rules() {
  if (level_locked) return;
  level_locked = true;
  if (editors.value('level_state') && level_basis &&
      LEVEL_GEN_PROGRAMS.some((k) => level_basis.programs[k] !== editors.value(k))) {
    clear_level();
    board_notice = 'The level was removed: it was made with another version of the auxiliary or level generation program. Generate a new level.';
  } else if (snapshots.length && run_basis && RULE_PROGRAMS.some((k) => run_basis[k] !== editors.value(k))) {
    reset_debugging();
    update_interface();
  } else if (editors.value('level_state') && !snapshots.length) {
    update_interface();      // (e.g. the visibility program changed)
  }
  update_controls();
}

function unlock_rules() {
  if (playing || testing) return;
  level_locked = false;
  update_controls();
}

// (the names of the actions in older versions of the page)
const unlock_level_generation = unlock_rules;

function clear_level() {
  level_seed = null;
  level_basis = null;
  board_notice = '';
  editors.set_value('level_state', '');
  editors.set_value('level_settings', '');
  reset_debugging();
  update_interface();
}

// Show the level in its initial state.
let preview_counter = 0;
async function update_interface() {
  const my_preview = ++preview_counter;
  update_controls();
  if (editors.value('level_state')) {
    const preview = new GameSession(solver, editors.game());
    const start = await preview.start();
    if (my_preview !== preview_counter || playing) return;   // outdated
    editors.show_run_problems(start.problems);
    show_grid(preview.view());
    show_board_message([
      ...board_problems(preview.view(), editors.value('level_state')),
      ...start.problems.map((p) => p.program + ': ' + p.text),
    ]);
  } else {
    show_board_message([]);
    clear_grid();
  }
}

// The level editor: show the level that was typed there.
function show_edited_level() {
  level_seed = null;
  reset_debugging();
  set_level_basis('typed in the level editor');
  board_notice = '';
  return update_interface();
}

async function do_generate() {
  lock_rules();
  level_seed = null;
  generating = true;
  board_notice = '';
  update_controls();
  editors.clear_run_problems();
  let level;
  try {
    level = await generate_level(solver, editors.game());
  } finally {
    generating = false;
  }
  editors.set_value('level_state', level.level_state);
  editors.set_value('level_settings', level.level_settings);
  reset_debugging();
  set_level_basis('generated');
  if (level.problem) {
    editors.show_run_problems([level.problem]);
    add_to_game_output('Level generation: ' + level.problem.text + '\n  (no level generated)\n');
    board_notice = 'No level was generated: ' + level.problem.text.split('\n')[0] + ' (see the Debug tab).';
  }
  await update_interface();
}

// Problems with the level, shown under the board.
function show_board_message(messages) {
  const elem = $('board-message');
  elem.textContent = messages.join('\n');
  elem.hidden = messages.length === 0;
}

// After a game that was not won: point to the errors and warnings, if any.
function problems_tip() {
  const n = editors.count('error') + editors.count('warning');
  if (n === 0) return '';
  return `(There ${n > 1 ? 'are' : 'is'} ${n} error${n > 1 ? 's or warnings' : ' or warning'} in the programs that may explain this: see "Errors and warnings" above the game output.)\n`;
}

// ---- Looking back ------------------------------------------------------------------

// The board at every time of the game: [{ time, view, moves }], where moves
// are the moves the player made when it saw this board (in step time+1).
let snapshots = [];
let shown_snapshot = -1;
let final_verdict = null;

function clear_snapshots() {
  snapshots = [];
  shown_snapshot = -1;
  final_verdict = null;
  update_timeline();
}

function record_snapshot(time, view) {
  snapshots.push({ time, view, moves: null });
}

// Show the board as it was at a step (an index into snapshots).
function show_snapshot(index) {
  if (index < 0 || index >= snapshots.length) return;
  shown_snapshot = index;
  const snap = snapshots[index];
  show_grid(snap.view, index > 0 ? snapshots[index - 1].view : null);
  if (index === snapshots.length - 1 && final_verdict) {
    if (final_verdict === 'win') display_win(); else display_lose();
  }
  update_timeline();
}

// The timeline under the board: usable while the game is paused, and after it ended.
function update_timeline() {
  const box = $('timeline-box');
  box.hidden = snapshots.length === 0;
  const busy = playing && !game_paused;
  const slider = $('timeline');
  slider.max = String(Math.max(1, snapshots.length));
  slider.value = String(shown_snapshot + 1);
  slider.disabled = busy || snapshots.length < 2;
  $('timeline-prev').disabled = busy || shown_snapshot <= 0;
  $('timeline-next').disabled = busy || shown_snapshot >= snapshots.length - 1;
  const snap = snapshots[shown_snapshot];
  if (snap) {
    const last = shown_snapshot === snapshots.length - 1;
    let what = '';
    if (snap.moves != null) what = snap.moves ? `the player moved ${snap.moves.replace(/\.$/, '').replace(/\. /g, ', ')}` : 'the player made no move';
    else if (last && final_verdict) what = final_verdict.toUpperCase();
    $('timeline-label').textContent = `Time ${snap.time} of ${snapshots.at(-1).time}` + (what ? `: ${what}` : '');
  } else {
    $('timeline-label').textContent = '';
  }
  update_debug_view();
}

$('timeline').addEventListener('input', () => show_snapshot(Number($('timeline').value) - 1));
$('timeline-prev').addEventListener('click', () => show_snapshot(shown_snapshot - 1));
$('timeline-next').addEventListener('click', () => show_snapshot(shown_snapshot + 1));

// ---- Playing -------------------------------------------------------------------

// The number of games played until the end, and the last verdict (for the tutorial)
const results = { games: 0, verdict: null };

function end_playing() {
  const stopped = stop_requested;
  results.games++;
  results.verdict = stopped ? 'stopped' : final_verdict || 'lose';
  single_step = false;
  playing = false;
  session = null;
  game_paused = false;
  stop_requested = false;
  update_timeline();
  if (stopped) {
    run_basis = null;
    update_interface();
  } else {
    update_controls();
  }
}

// Play one step, then pause (starting a game if there is none).
async function do_step() {
  single_step = true;
  await do_play();
}

async function do_play() {
  if (!level_locked) {
    lock_rules();
    if (!editors.value('level_state')) {
      single_step = false;
      return;
    }
  }
  if (!game_paused) {
    playing = true;
    board_notice = '';
    clear_game_output();
    clear_snapshots();
    update_controls();
    editors.clear_run_problems();
    const verbose_checkbox = $('verbose');
    const game = editors.game();
    run_basis = game;
    session = new GameSession(solver, game, { rng: await play_rng(game), verbose: verbose_checkbox ? verbose_checkbox.checked : true });
    const start = await session.start();
    editors.show_run_problems(start.problems);
    if (session.verdict) {
      if (start.report) add_to_game_output(start.report);
      add_to_game_output(start.message + problems_tip());
      display_lose();
      end_playing();
      return;
    }
    record_snapshot(0, session.view());
  }
  game_paused = false;
  update_controls();
  update_timeline();
  await play_loop();
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function play_loop() {
  while (true) {
    if (stop_requested) {
      end_playing();
      reset_debugging();
      return;
    }
    if (game_paused) {
      show_snapshot(snapshots.length - 1);
      update_controls();
      return;
    }
    // (at the speed 'Instant', the board is only drawn at the end)
    if (speed >= 0) show_snapshot(snapshots.length - 1);
    else shown_snapshot = -1;
    const step = await session.step();
    snapshots.at(-1).moves = step.verdict ? null : (step.moves || '');
    editors.show_run_problems(step.problems);
    if (stop_requested) continue;
    if (step.report) add_to_game_output(step.report, session.time_step);
    if (step.verdict) {
      final_verdict = step.verdict;
      add_to_game_output(step.verdict === 'win' ? step.message : step.message + problems_tip());
      end_playing();
      show_snapshot(snapshots.length - 1);
      return;
    }
    record_snapshot(session.time_step, session.view());
    if (single_step) {
      single_step = false;
      game_paused = true;
      show_snapshot(snapshots.length - 1);
      continue;
    }
    await sleep(Math.max(0, speed));
  }
}

function do_pause() {
  game_paused = true;
  pause_button.disabled = true;
}

function do_stop() {
  if (!playing) return;
  stop_requested = true;
  if (game_paused) {
    end_playing();
    reset_debugging();
  } else {
    // Stop clingo if it is busy (e.g. with a program that does not terminate)
    solver.abort();
  }
}

function reset_debugging() {
  clear_game_output();
  clear_snapshots();
  run_basis = null;
}

function reset_level() {
  reset_debugging();
  update_interface();
}

// ---- Loading and saving games ----------------------------------------------------

function set_game(game) {
  level_seed = null;
  board_notice = '';
  game = normalize_game(game);
  editors.clear_run_problems();
  editors.set_game(game);
  reset_debugging();
  set_level_basis('loaded');
  return update_interface();
}

// ---- The game being edited, saved work and share links --------------------------------

let storage = null;
try {
  storage = window.localStorage;
} catch {
  // no storage (e.g. blocked by the browser): work is not saved
}
const work = new WorkStore(storage);
const versions = new VersionStore(storage);
const SAVE_DELAY_MS = 500;

// Where the game being edited was loaded from: { origin, title, original }.
// Changes are saved under `origin`.
let current = null;
let save_timer = null;

function save_work_now() {
  clearTimeout(save_timer);
  save_timer = null;
  if (current) {
    work.save(current.origin, editors.game(), current.original, current.title);
    const saved = work.load(current.origin);
    show_work_notice(saved ? `You are working on your own version of ${current.title}` +
      ` (saved ${new Date(saved.saved_at).toLocaleString()}), saved in this browser.` : null);
    versions_tab.after_save();
  }
}

editors.on_change = (key) => {
  if (key === 'level_state') update_controls(); else update_board_status();
  if (!current || loading_game) return;
  clearTimeout(save_timer);
  save_timer = setTimeout(save_work_now, SAVE_DELAY_MS);
};
window.addEventListener('pagehide', () => { if (save_timer) save_work_now(); });

let loading_game = false;

// Load a game; if there is saved work for it, load that instead.
async function open_game(game, origin, title) {
  if (save_timer) save_work_now();
  game = normalize_game(game);
  current = { origin, title, original: game };
  const saved = work.load(origin);
  loading_game = true;
  try {
    if (saved) {
      await set_game(saved.game);
      const when = saved.saved_at ? ' (saved ' + new Date(saved.saved_at).toLocaleString() + ')' : '';
      show_work_notice(`You are working on your own version of ${title}${when}, saved in this browser.`);
    } else {
      await set_game(game);
      show_work_notice(null);
    }
  } finally {
    loading_game = false;
  }
  versions_tab.opened();
}

function show_game_title() {
  $('game-title').textContent = current ? current.title.replace(/^the /, (m) => m[0].toUpperCase() + m.slice(1)) : '';
}

function show_work_notice(text) {
  show_game_title();
  $('work-notice-text').textContent = text || '';
  $('work-notice').hidden = !text;
}

async function revert_to_original() {
  if (!current) return;
  if (!window.confirm(`Throw away your changes to ${current.title}, and go back to the original?`)) return;
  await stop_game_if_playing();
  clearTimeout(save_timer);
  save_timer = null;
  versions_tab.auto_snapshot('revert');
  work.forget(current.origin);
  await open_game(current.original, current.origin, current.title);
}

async function forget_saved_work() {
  if (!window.confirm('Forget all your saved work in this browser, with all snapshots? (Download a backup first to keep it. The game stays as it is on the page until you load it again.)')) return;
  clearTimeout(save_timer);
  save_timer = null;
  work.forget_all();
  versions.forget_all();
  show_work_notice(null);
  versions_tab.refresh();
}

// Put (some fields of) a game into the editors, as if the player typed it, and save it.
async function replace_game(game, fields = GAME_FIELDS) {
  await stop_game_if_playing();
  if (fields.length === GAME_FIELDS.length) {
    await set_game(game);
    lock_level_generation();
  } else {
    for (const field of fields) editors.set_value(field, game[field]);
    if (fields.some((f) => f === 'level_state' || f === 'level_settings')) {
      level_seed = null;
      await update_interface();
    }
  }
  save_work_now();
}

// A title for a game that was saved without one (by an older version of the page).
function title_of(origin) {
  const m = /^example:(.*)$/.exec(origin);
  if (m) {
    const option = [...example_games.options].find((o) => o.value === `examples/${m[1]}.json`);
    return option ? option.textContent : m[1];
  }
  if (origin.startsWith('file:')) return origin.slice(5);
  if (origin.startsWith('shared:')) return 'a shared game';
  if (origin.startsWith('tutorial:')) return 'the tutorial game';
  return origin;
}

// Open a game from the list of saved work (p: what versions_tab knows about it).
function can_open(origin, p) {
  return origin.startsWith('example:') || Boolean(p.original);
}

async function open_saved(origin, p) {
  await stop_game_if_playing();
  forget_link();
  if (origin.startsWith('example:')) await load_game_from_path(`examples/${origin.slice(8)}.json`, p.title);
  else await open_game(p.original, origin, p.title);
  lock_level_generation();
}

// Put a project (from a file) into this browser: its snapshots are added, and its
// current version becomes the saved work (the work that was there is kept as a snapshot).
function import_project(p) {
  if (save_timer) save_work_now();
  const about = { title: p.title, original: p.original };
  const existing = work.load(p.origin);
  if (existing && !same_game(existing.game, p.game)) {
    versions.add(p.origin, existing.game, { auto: true, reason: 'load' }, about);
  }
  if (versions.merge(p.origin, p.snapshots, about) == null && p.snapshots.length) {
    throw new Error('the snapshots could not be saved in this browser (its storage is full, or blocked)');
  }
  if (p.original) work.save(p.origin, p.game, p.original, p.title);
  else work.save(p.origin, p.game, null, p.title);
}

const versions_tab = new VersionsTab({
  versions, work, storage,
  app: {
    current: () => current,
    game: () => editors.game(),
    replace: replace_game,
    title_of,
    can_open,
    open: open_saved,
    download: save,
    forgot: (origin) => {
      if (current && current.origin === origin) {
        clearTimeout(save_timer);
        save_timer = null;
        show_work_notice(null);
      }
    },
  },
});

async function load_game_from_path(path, title) {
  const response = await fetch(path);
  if (!response.ok) throw new Error(`could not load ${path} (${response.status})`);
  const name = path.replace(/^.*\//, '').replace(/\.json$/, '');
  await open_game(await response.json(), 'example:' + name, title || name);
}

// Load the game in the link (#game=...), if there is one. Returns whether there was one.
async function load_game_from_link() {
  const m = /^#game=([A-Za-z0-9_-]+)(?:&seed=(\d+))?$/.exec(window.location.hash);
  if (!m) return false;
  const game = await decode_game(m[1]);
  await open_game(game, 'shared:' + await game_id(game), 'the shared game');
  if (m[2]) await load_seeded_level(Number(m[2]));
  return true;
}

// The link points to an example or a file from now on, not to a shared game.
function forget_link() {
  if (window.location.hash) history.replaceState(null, '', window.location.pathname + window.location.search);
}

async function share_game() {
  const code = await encode_game(editors.game());
  const link = link_to(code, level_seed);
  $('share-box').hidden = false;
  $('share-link').value = link;
  $('share-link').select();
  try {
    await navigator.clipboard.writeText(link);
    $('share-status').textContent = 'The link is copied to the clipboard.';
  } catch {
    $('share-status').textContent = 'Copy the link above.';
  }
}

async function stop_game_if_playing() {
  if (playing) {
    do_stop();
    while (playing) await sleep(20);
  }
}

async function load_game() {
  load_status.innerText = 'Loading\u2026';
  await stop_game_if_playing();
  try {
    forget_link();
    const option = example_games.selectedOptions[0];
    await load_game_from_path(example_games.value, option ? option.textContent : null);
    lock_level_generation();
    load_status.innerText = `Done loading: ${option ? option.textContent : 'the game'}.`;
  } catch (e) {
    load_status.innerText = 'Loading failed: ' + e.message;
  }
}

async function load_game_from_file(event) {
  const file = event.target.files.item(0);
  if (!file) return;
  await stop_game_if_playing();
  try {
    const content = read_file(await file.text(), file.name);
    if (content.kind === 'backup') {
      const n = content.projects.length;
      if (!window.confirm(`This backup holds ${n} game${n > 1 ? 's' : ''}. Load ${n > 1 ? 'them' : 'it'} into this browser? (Your work on these games in this browser is kept as snapshots.)`)) {
        upload_status.innerText = '';
        event.target.value = '';
        return;
      }
      for (const p of content.projects) import_project(p);
      if (current) await open_game(current.original, current.origin, current.title);
      upload_status.innerText = `Done loading: ${n} game${n > 1 ? 's' : ''}. Open them from the list "Everything in this browser" below.`;
    } else {
      forget_link();
      if (content.kind === 'project') {
        const p = content.project;
        import_project(p);
        await open_game(p.original || p.game, p.origin, p.title);
        upload_status.innerText = `Done loading the project ${p.title} (${p.snapshots.length} snapshot${p.snapshots.length === 1 ? '' : 's'}).`;
      } else {
        await open_game(content.game, 'file:' + file.name, file.name);
        upload_status.innerText = `Done loading: ${file.name}.`;
      }
      lock_level_generation();
    }
  } catch (e) {
    upload_status.innerText = 'Loading failed: ' + e.message;
  }
  event.target.value = '';
}

function download_game() {
  save(file_stem(current ? current.title : 'game') + '.json', JSON.stringify(editors.game(), null, 2));
}

function save(filename, data) {
  const blob = new Blob([data], { type: 'application/json' });
  const elem = document.createElement('a');
  elem.href = URL.createObjectURL(blob);
  elem.download = filename;
  document.body.appendChild(elem);
  elem.click();
  document.body.removeChild(elem);
}

// ---- Tabs ------------------------------------------------------------------------

function reset_tab_color() {
  document.querySelector('label[for="tab2"]').style.color = '#bbb';
}

// Refreshing after changing tabs
function change_tabs() {
  reset_tab_color();
  editors.resize();
  upload_status.innerText = '';
  load_status.innerText = '';
  versions_tab.shown();
}

function select_tab(n) {
  $('tab' + n).checked = true;
  change_tabs();
}

// ---- Testing a strategy on many levels ------------------------------------------------


// The random numbers for playing the current level.
async function play_rng(game) {
  if (level_seed == null) return Math.random;
  const { rng, level } = await replay_rng(solver, game, level_seed);
  if (level.level_state === game.level_state && level.level_settings === game.level_settings) return rng;
  level_seed = null;      // the level was changed
  return Math.random;
}

// Put level `seed` (as in a test) into the editors.
async function load_seeded_level(seed) {
  await stop_game_if_playing();
  const { level } = await replay_rng(solver, editors.game(), seed);
  editors.set_value('level_state', level.level_state);
  editors.set_value('level_settings', level.level_settings);
  reset_debugging();
  set_level_basis(`level ${seed} of the test`);
  await update_interface();
  level_seed = seed;
  show_board_message([`This is level ${seed} of the test. Play plays it exactly as in the test.`]);
}

function link_to(code, seed = null) {
  const query = new URLSearchParams(window.location.search);
  query.delete('file');
  return window.location.origin + window.location.pathname + (query.size ? '?' + query : '') +
    '#game=' + code + (seed != null ? '&seed=' + seed : '');
}

async function copy_text(text, status_elem) {
  try {
    await navigator.clipboard.writeText(text);
    status_elem.textContent = 'The link is copied to the clipboard.';
  } catch {
    window.prompt('Copy this link:', text);
  }
}

async function run_test() {
  if (playing || testing) return;
  const levels = Math.max(1, Math.min(1000, Number($('test-levels').value) || 20));
  lock_rules();
  testing = true;
  test_cancelled = false;
  update_controls();
  $('test-cancel').hidden = false;
  $('test-summary').textContent = '';
  $('test-results').replaceChildren();
  const game = editors.game();
  const code = await encode_game(game);
  const counts = {};
  const t0 = performance.now();
  try {
    await test_strategy(solver, game, {
      levels,
      cancelled: () => test_cancelled,
      on_level: (r) => {
        counts[r.verdict] = (counts[r.verdict] || 0) + 1;
        $('test-progress').textContent = `Level ${r.seed} of ${levels} played..`;
        $('test-summary').textContent = test_summary(counts);
        if (r.verdict !== 'win') $('test-results').append(test_result_item(r, code));
      },
    });
  } finally {
    testing = false;
    $('test-cancel').hidden = true;
    update_controls();
    const n = Object.values(counts).reduce((a, b) => a + b, 0);
    $('test-progress').textContent = (test_cancelled ? `Cancelled after ${n} levels` : `Done`) +
      ` (${((performance.now() - t0) / 1000).toFixed(1)} seconds).`;
    // The result is kept with this version of the programs (see the Versions tab)
    if (!test_cancelled && n > 0) {
      const s = versions_tab.record_test(game, n, counts);
      if (s) $('test-summary').append(' ', test_kept_note(s));
    }
  }
}

function test_kept_note(s) {
  const a = document.createElement('a');
  a.href = '?tab=7';
  a.dataset.tab = '7';
  a.className = 'tab-link';
  a.textContent = s.name ? `(Kept with the snapshot "${s.name}" in the Versions tab.)` : '(Kept with this version in the Versions tab.)';
  return a;
}

function test_summary(counts) {
  const n = Object.values(counts).reduce((a, b) => a + b, 0);
  const names = { win: 'won', lose: 'lost', timeout: 'timed out (500 steps)', stopped: 'stopped (clingo took too long)', 'no level': 'no level generated' };
  const parts = Object.entries(names).filter(([k]) => counts[k]).map(([k, name]) => `${counts[k]} ${name}`);
  return `${n} level${n > 1 ? 's' : ''}: ${parts.join(', ')}.`;
}

function test_result_item(r, code) {
  const li = document.createElement('li');
  const text = document.createElement('span');
  text.textContent = `Level ${r.seed}: ${r.message}` + (r.steps ? ` (after ${r.steps} steps)` : '');
  li.append(text);
  if (r.verdict !== 'no level') {
    const load = document.createElement('button');
    load.className = 'control-button';
    load.textContent = 'Load this level';
    load.addEventListener('click', () => load_seeded_level(r.seed));
    const link = document.createElement('button');
    link.className = 'control-button';
    link.textContent = 'Copy link';
    link.addEventListener('click', () => copy_text(link_to(code, r.seed), $('test-progress')));
    li.append(' ', load, ' ', link);
  }
  return li;
}

function cancel_test() {
  if (!testing) return;
  test_cancelled = true;
  solver.abort();
}

// ---- The tutorial ----------------------------------------------------------------------

const TUTORIAL_ORIGIN = 'tutorial:flag1';
const tutorial = new Tutorial({
  storage,
  app: {
    // A fresh copy of Find the flag 1 (work from an earlier tutorial is forgotten)
    open_game: async () => {
      await stop_game_if_playing();
      forget_link();
      if (save_timer) save_work_now();
      work.forget(TUTORIAL_ORIGIN);
      versions.forget(TUTORIAL_ORIGIN);
      const response = await fetch('examples/flag1.json');
      if (!response.ok) throw new Error(`could not load the tutorial game (${response.status})`);
      await open_game(await response.json(), TUTORIAL_ORIGIN, 'the tutorial game (Find the flag 1)');
      lock_level_generation();
    },
    load_example,
    results: () => results,
    select_tab,
    program: () => editors.value('player_move_program'),
    set_program: async (text) => {
      await stop_game_if_playing();
      editors.set_value('player_move_program', text);
    },
    snapshots: () => (current ? versions.list(current.origin).length : 0),
  },
});

// Load an example game (e.g. 'flag2'), and go to the strategy.
async function load_example(name) {
  await stop_game_if_playing();
  forget_link();
  const path = `examples/${name}.json`;
  example_games.value = path;
  await load_game_from_path(path, title_of('example:' + name));
  lock_level_generation();
  select_tab(4);
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

// The buttons for the first games in the Control tab
$('first-games').innerHTML = first_games_html();      // (the page's own text)
$('first-games').addEventListener('click', (e) => {
  const game = e.target.closest('button[data-example]');
  if (game) load_example(game.dataset.example);
});

async function start_tutorial() {
  try {
    await tutorial.start();
  } catch (e) {
    tutorial.stop();
    set_engine_status('The tutorial could not be started: ' + e.message, true);
  }
}

// ---- Wiring ------------------------------------------------------------------------

const actions = {
  do_generate, clear_level, reset_level, do_play, do_pause, do_step, do_stop,
  lock_level_generation, unlock_level_generation, lock_rules, unlock_rules, update_interface: show_edited_level, load_game, download_game,
  share_game, revert_to_original, forget_saved_work, run_test, cancel_test,
  take_snapshot: () => versions_tab.take_snapshot(),
  download_project: () => versions_tab.download_project(),
  download_backup: () => versions_tab.download_backup(),
  start_tutorial,
  dismiss_tutorial: () => tutorial.dismiss_invite(),
};
document.querySelectorAll('[data-action]').forEach((elem) => {
  const action = actions[elem.dataset.action];
  if (!action) throw new Error('unknown action ' + elem.dataset.action);
  elem.addEventListener('click', () => action());
});
speed_selector.addEventListener('change', select_speed);
$('file-input').addEventListener('change', load_game_from_file);
document.querySelectorAll('input[name="tabs"]').forEach((tab) => tab.addEventListener('change', change_tabs));
// Links to a tab (they also work as plain links, e.g. opened in a new window)
document.addEventListener('click', (e) => {
  const link = e.target.closest && e.target.closest('a.tab-link[data-tab]');
  if (!link || e.ctrlKey || e.metaKey || e.shiftKey) return;
  e.preventDefault();
  select_tab(link.dataset.tab);
  window.scrollTo({ top: $('tab1').getBoundingClientRect().top + window.scrollY - 10 });
});
// Work saved in another window (of the same browser)
window.addEventListener('storage', (e) => {
  if (!e.key || e.key.startsWith('logic-game:')) versions_tab.refresh();
});

// ---- Options --------------------------------------------------------------------------
//
// Set in the Control tab (and kept in this browser), or in the URL, e.g.
// ?solutions=true&editor=true&internals=true&timeout=30 (then only for this visit).

const params = new URLSearchParams(window.location.search);
const OPTIONS_KEY = 'logic-game:options';
const DEFAULT_OPTIONS = { mark_changes: true, solutions: false, editor: false, internals: false, timeout: solver.timeout_ms / 1000, all_output: false };

function stored_options() {
  try {
    return JSON.parse(storage.getItem(OPTIONS_KEY)) || {};
  } catch {
    return {};
  }
}

const options = { ...DEFAULT_OPTIONS, ...stored_options() };
for (const key of ['solutions', 'editor', 'internals']) {
  if (params.has(key)) options[key] = params.get(key) === 'true';
}
if (Number(params.get('timeout')) > 0) options.timeout = Number(params.get('timeout'));

function set_option(key, value) {
  options[key] = value;
  try {
    storage.setItem(OPTIONS_KEY, JSON.stringify({ ...stored_options(), [key]: value }));
  } catch {
    // (only for this visit)
  }
  apply_options();
}

const solutions_group = document.querySelector('#example-games optgroup[label="Solutions"]');

function apply_options() {
  $('visual-container').classList.toggle('hide-changes', !options.mark_changes);
  $('mark-changes').checked = options.mark_changes;
  $('level-editor').style.display = options.editor ? '' : 'none';
  $('tab6').style.display = options.internals ? '' : 'none';
  document.querySelector('label[for="tab6"]').style.display = options.internals ? '' : 'none';
  if (!options.internals && $('tab6').checked) select_tab(1);
  if (options.solutions && !solutions_group.isConnected) example_games.append(solutions_group);
  if (!options.solutions && solutions_group.isConnected) solutions_group.remove();
  solver.timeout_ms = Math.max(1, Number(options.timeout) || DEFAULT_OPTIONS.timeout) * 1000;
  $('show-all-output').checked = options.all_output;
  for (const input of document.querySelectorAll('[data-option]')) {
    if (input.type === 'checkbox') input.checked = Boolean(options[input.dataset.option]);
    else if (document.activeElement !== input) input.value = String(options[input.dataset.option]);
  }
  update_debug_view();
}

for (const input of document.querySelectorAll('[data-option]')) {
  input.addEventListener('change', () => {
    const key = input.dataset.option;
    if (input.type === 'checkbox') set_option(key, input.checked);
    else if (Number(input.value) > 0) set_option(key, Number(input.value));
  });
}
$('mark-changes').addEventListener('change', () => set_option('mark_changes', $('mark-changes').checked));
apply_options();

// Select a particular tab if specified in the URL
const tab = params.get('tab');
if (['1', '2', '3', '4', '5', '7'].includes(tab) || (tab === '6' && options.internals)) {
  $('tab' + tab).checked = true;
  reset_tab_color();
}

// ---- Start ---------------------------------------------------------------------------

async function start() {
  lock_level_generation();
  const file = params.get('file');
  const path = file ? 'examples/' + file + '.json' : 'examples/flag1-with-solutions.json';
  set_engine_status('Loading clingo..');
  let link_error = null;
  const option = [...example_games.options].find((o) => o.value === path);
  const loading = load_game_from_link()
    .catch((e) => {
      link_error = 'The link could not be read: ' + e.message;
      return false;
    })
    .then((from_link) => from_link || load_game_from_path(path, option ? option.textContent : null))
    .catch((e) => {
      load_status.innerText = 'Loading failed: ' + e.message;
    });
  try {
    await solver.init();
    set_engine_status('');
  } catch (e) {
    set_engine_status('clingo could not be loaded: ' + e.message, true);
  }
  await loading;
  try {
    await fragments;
  } catch (e) {
    console.error(e);
    load_status.innerText = 'Some texts could not be loaded: ' + e.message;
  }
  if (link_error) set_engine_status(link_error, true);
  // The tutorial: with ?tutorial=true, or offered to new players (not to those who open a shared game)
  if (params.get('tutorial') === 'true') start_tutorial();
  else if (!window.location.hash && !work.origins().length && !versions.origins().length) tutorial.invite();
  // Keep the files of the game, so that it also works offline (see sw.js)
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch((e) => console.warn('no offline use:', e));
  }
  document.body.dataset.ready = 'true';   // (for the browser tests)
}
start();

// Opening another share link in the same tab only changes the part after '#'
window.addEventListener('hashchange', async () => {
  await stop_game_if_playing();
  try {
    if (await load_game_from_link()) lock_level_generation();
  } catch (e) {
    load_status.innerText = 'The link could not be read: ' + e.message;
  }
});

// (for debugging in the browser console)
window.logic_game = { solver, editors, clingo, work, versions, versions_tab, tutorial };
