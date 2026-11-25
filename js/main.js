// The page: buttons, loading and saving games, and playing a game step by step.
import clingo from '../vendor/clingo-wasm/index.web.js';
import { create_solver } from './solver.js';
import { GAME_FIELDS, GameSession, generate_level, normalize_game } from './engine.js';
import { Editors, make_example_editors } from './editors.js';
import { show_grid, clear_grid, display_win, display_lose } from './grid-visual.js';
import { board_problems } from './hints.js';
import './modal.js';

const solver = create_solver(clingo);
const editors = new Editors(solver);
make_example_editors();

// Handles for elements
const $ = (id) => document.getElementById(id);
const lock_buttons = [$('lock-button'), $('lock-button2'), $('lock-button3')];
const unlock_buttons = [$('unlock-button'), $('unlock-button2'), $('unlock-button3')];
const generate_button = $('generate-button');
const clear_button = $('clear-button');
const reset_button = $('reset-button');
const play_button = $('play-button');
const pause_button = $('pause-button');
const stop_button = $('stop-button');
const speed_selector = $('speed-selector');
const example_games = $('example-games');
const load_status = $('load-status');
const upload_status = $('upload-status');
const engine_status = $('engine-status');

const LEVEL_PROGRAMS = ['aux_program', 'level_gen_program', 'visibility_program'];
const PLAY_PROGRAMS = ['visibility_program', 'nature_program', 'goal_program', 'player_move_program'];

function set_button(button, enabled, title = '') {
  button.disabled = !enabled;
  button.title = enabled ? '' : title;
}

function set_engine_status(text, is_error = false) {
  engine_status.textContent = text;
  engine_status.classList.toggle('error', is_error);
}

// ---- Game output -------------------------------------------------------------

const game_output_elem = $('game-output');
let game_output = '';
function clear_game_output() {
  game_output = '';
  game_output_elem.textContent = '';
}
// New text goes at the top (most recent step first).
function add_to_game_output(text) {
  game_output = game_output === '' ? text : text + '\n' + game_output;
  game_output_elem.textContent = game_output;
}

// ---- States of the game engine -------------------------------------------------

let speed = Number(speed_selector.value);
let session = null;            // the game being played
let playing = false;           // a game is going on (possibly paused)
let game_paused = false;
let stop_requested = false;
let level_locked = false;

function select_speed() {
  speed = Number(speed_selector.value);
}

function lock_level_generation() {
  level_locked = true;
  lock_buttons.forEach((b) => { b.disabled = true; });
  unlock_buttons.forEach((b) => { b.disabled = playing; });
  set_button(generate_button, !playing, 'A new level cannot be generated while the game is ongoing.');
  editors.set_read_only(LEVEL_PROGRAMS, true);
}

function unlock_level_generation() {
  level_locked = false;
  lock_buttons.forEach((b) => { b.disabled = false; });
  unlock_buttons.forEach((b) => { b.disabled = true; });
  set_button(generate_button, false, 'Auxiliary, level generation and visibility programs need to be locked to generate a level.');
  set_button(clear_button, false, 'There is no level to be cleared.');
  set_button(reset_button, false, 'There is no level to be reset.');
  set_button(play_button, false, 'There is no level to play.');
  pause_button.disabled = true;
  stop_button.disabled = true;
  editors.set_read_only(LEVEL_PROGRAMS, false);
  clear_level();
  reset_debugging();
}

function clear_level() {
  editors.set_value('level_state', '');
  editors.set_value('level_settings', '');
  update_interface();
}

// Show the level in its initial state (and enable the buttons that need a level).
let preview_counter = 0;
async function update_interface() {
  const my_preview = ++preview_counter;
  if (editors.value('level_state')) {
    set_button(clear_button, true);
    set_button(reset_button, false, 'The level is already in its initial state.');
    set_button(play_button, true);
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
    set_button(clear_button, false, 'There is no level to be cleared.');
    set_button(reset_button, false, 'There is no level to be reset.');
    set_button(play_button, false, 'There is no level to play.');
    clear_grid();
  }
}

async function do_generate() {
  generate_button.disabled = true;
  editors.clear_run_problems();
  const level = await generate_level(solver, editors.game());
  generate_button.disabled = !level_locked || playing;
  editors.set_value('level_state', level.level_state);
  editors.set_value('level_settings', level.level_settings);
  reset_debugging();
  if (level.problem) {
    editors.show_run_problems([level.problem]);
    add_to_game_output('Level generation: ' + level.problem.text + '\n  (no level generated)\n');
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

// ---- Playing -------------------------------------------------------------------

function start_playing_interface() {
  playing = true;
  unlock_buttons.forEach((b) => { b.disabled = true; });
  set_button(clear_button, false, 'The level cannot be cleared while the game is ongoing.');
  set_button(reset_button, false, 'The level cannot be reset while the game is ongoing.');
  set_button(generate_button, false, 'A new level cannot be generated while the game is ongoing.');
  pause_button.disabled = false;
  stop_button.disabled = false;
  editors.set_read_only(PLAY_PROGRAMS, true);
}

function end_playing() {
  const stopped = stop_requested;
  playing = false;
  session = null;
  game_paused = false;
  stop_requested = false;
  unlock_buttons.forEach((b) => { b.disabled = !level_locked; });
  set_button(clear_button, true);
  set_button(generate_button, level_locked, 'Auxiliary, level generation and visibility programs need to be locked to generate a level.');
  play_button.disabled = false;
  pause_button.disabled = true;
  stop_button.disabled = true;
  editors.set_read_only(PLAY_PROGRAMS, false);
  editors.set_read_only(LEVEL_PROGRAMS, level_locked);
  if (stopped) {
    update_interface();
  } else {
    set_button(reset_button, true);
  }
}

async function do_play() {
  play_button.disabled = true;
  if (!game_paused) {
    start_playing_interface();
    clear_game_output();
    editors.clear_run_problems();
    const verbose_checkbox = $('verbose');
    session = new GameSession(solver, editors.game(), { verbose: verbose_checkbox ? verbose_checkbox.checked : true });
    const start = await session.start();
    editors.show_run_problems(start.problems);
    if (session.verdict) {
      if (start.report) add_to_game_output(start.report);
      add_to_game_output(start.message + problems_tip());
      display_lose();
      end_playing();
      return;
    }
  }
  game_paused = false;
  pause_button.disabled = false;
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
      play_button.disabled = false;
      return;
    }
    show_grid(session.view());
    const step = await session.step();
    editors.show_run_problems(step.problems);
    if (stop_requested) continue;
    if (step.report) add_to_game_output(step.report);
    if (step.verdict) {
      add_to_game_output(step.verdict === 'win' ? step.message : step.message + problems_tip());
      if (step.verdict === 'win') display_win(); else display_lose();
      end_playing();
      return;
    }
    await sleep(speed);
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
}

function reset_level() {
  update_interface();
  reset_debugging();
}

// ---- Loading and saving games ----------------------------------------------------

function set_game(game) {
  game = normalize_game(game);
  editors.clear_run_problems();
  editors.set_game(game);
  reset_debugging();
  return update_interface();
}

async function load_game_from_path(path) {
  const response = await fetch(path);
  if (!response.ok) throw new Error(`could not load ${path} (${response.status})`);
  await set_game(await response.json());
}

async function stop_game_if_playing() {
  if (playing) {
    do_stop();
    while (playing) await sleep(20);
  }
}

async function load_game() {
  load_status.innerText = 'Loading..';
  await stop_game_if_playing();
  try {
    await load_game_from_path(example_games.value);
    lock_level_generation();
    load_status.innerText = 'Done loading..';
  } catch (e) {
    load_status.innerText = 'Loading failed: ' + e.message;
  }
}

async function load_game_from_file(event) {
  const file = event.target.files.item(0);
  if (!file) return;
  await stop_game_if_playing();
  try {
    await set_game(JSON.parse(await file.text()));
    lock_level_generation();
    upload_status.innerText = 'Done loading..';
  } catch (e) {
    upload_status.innerText = 'Loading failed: ' + e.message;
  }
}

function download_game() {
  const game = {};
  for (const key of GAME_FIELDS) game[key] = editors.value(key);
  save('game.json', JSON.stringify(game, null, 2));
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
}

// ---- Wiring ------------------------------------------------------------------------

const actions = {
  do_generate, clear_level, reset_level, do_play, do_pause, do_stop,
  lock_level_generation, unlock_level_generation, update_interface, load_game, download_game,
};
document.querySelectorAll('[data-action]').forEach((elem) => {
  const action = actions[elem.dataset.action];
  if (!action) throw new Error('unknown action ' + elem.dataset.action);
  elem.addEventListener('click', () => action());
});
speed_selector.addEventListener('change', select_speed);
$('file-input').addEventListener('change', load_game_from_file);
document.querySelectorAll('input[name="tabs"]').forEach((tab) => tab.addEventListener('change', change_tabs));

// ---- Options in the URL ---------------------------------------------------------------

const params = new URLSearchParams(window.location.search);

// Only show the (explicit) level editor if specified in the URL
if (params.get('editor') !== 'true') {
  $('level-editor').style.display = 'none';
}
// Only show the internals tab if specified in the URL
if (params.get('internals') !== 'true') {
  $('tab6').style.display = 'none';
  document.querySelector('label[for="tab6"]').style.display = 'none';
}
// Only show solutions if called for in the URL
if (params.get('solutions') !== 'true') {
  document.querySelector('#example-games optgroup[label="Solutions"]').remove();
}
// Select a particular tab if specified in the URL
const tab = params.get('tab');
if (['1', '2', '3', '4', '5'].includes(tab) || (tab === '6' && params.get('internals') === 'true')) {
  $('tab' + tab).checked = true;
  reset_tab_color();
}
// Per-call time limit for clingo (in seconds), e.g. ?timeout=30
if (Number(params.get('timeout')) > 0) {
  solver.timeout_ms = Number(params.get('timeout')) * 1000;
}

// ---- Start ---------------------------------------------------------------------------

async function start() {
  lock_level_generation();
  const file = params.get('file');
  const path = file ? 'examples/' + file + '.json' : 'examples/flag1-with-solutions.json';
  set_engine_status('Loading clingo..');
  const loading = load_game_from_path(path).catch((e) => {
    load_status.innerText = 'Loading failed: ' + e.message;
  });
  try {
    await solver.init();
    set_engine_status('');
  } catch (e) {
    set_engine_status('clingo could not be loaded: ' + e.message, true);
  }
  await loading;
  document.body.dataset.ready = 'true';   // (for the browser tests)
}
start();

// (for debugging in the browser console)
window.logic_game = { solver, editors, clingo };
