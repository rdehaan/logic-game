// The page: the buttons and the lock of the game rules, playing a game step by
// step (with what the board shows, and the Debug tab), the options, loading and
// saving games (saved work, share links, files, game folders and linked
// folders), and the wiring of the Versions tab and the tutorial.
import clingo from '../vendor/clingo-wasm/index.web.js';
import { create_solver } from './solver.js';
import { GAME_FIELDS, SOURCE_NAMES, GameSession, generate_level, normalize_game, test_strategy, replay_rng } from './engine.js';
import { Editors, make_example_editors, make_output_editor } from './editors.js';
import { facts_to_answer_set, answer_set_to_fact_lines } from './asp.js';
import { show_grid, clear_grid, display_win, display_lose, cell_of_atom, board_size, highlight_cells, on_cell_hover } from './grid-visual.js';
import { board_problems, move_hint } from './hints.js';
import { WorkStore, encode_game, decode_game, game_id, same_game } from './storage.js';
import { VersionStore, read_file, file_stem } from './versions.js';
import { VersionsTab } from './versions-tab.js';
import { Tutorial, first_games_html } from './tutorial.js';
import { files_to_game, file_names, game_to_files, make_zip, read_zip, strip_common_dir, MANIFEST } from './folder.js';
import {
  FolderLink, folder_links_supported, folder_is_empty, remember_folder, remembered_folder, forget_folder, permission,
} from './folder-link.js';
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
// time (the step of the board that is shown): the facts that went into and
// came out of each program, in a locked editor each.

let step_reports = new Map();     // step -> report
let output_messages = [];         // the other messages (verdicts, problems), newest first

function clear_game_output() {
  step_reports = new Map();
  output_messages = [];
  update_debug_view();
}

function add_to_game_output(text, step = null) {
  if (step == null) output_messages.unshift(text);
  else step_reports.set(step, text);
  update_debug_view();
}

// The whole game output as text, newest first (for the tests, and the console).
function game_output_text() {
  const steps = [...step_reports.entries()].sort((a, b) => b[0] - a[0]).map(([, text]) => text + '\n');
  return [...output_messages.map((m) => m + '\n'), ...steps].join('');
}

// The parts of the report of a step: [{ label, facts }] for the facts that
// went into or came out of a program ('- Player input:' and the facts on the
// next line), and [{ text }] for the other lines (problems, times).
function report_parts(report) {
  const parts = [];
  let current = null;
  for (const line of report.replace(/^## STEP \d+ ##\n/, '').split('\n')) {
    const label = /^- ([^:]+):$/.exec(line);
    if (label) {
      current = { label: label[1], facts: '' };
      parts.push(current);
    } else if (line.startsWith('- ')) {
      current = { text: line.slice(2) };
      parts.push(current);
    } else if (current && current.text != null && line.trim()) {
      current.text += '\n' + line;
    } else if (current && current.facts != null && line.trim()) {
      current.facts += line + ' ';
    }
  }
  return parts;
}

const AceRange = ace.require('ace/range').Range;
let debug_editors = [];
let debug_shown = null;      // the report (or text) that the Debug tab shows

// Facts and the board: hovering over a fact in the Debug tab highlights its
// cell on the board, and hovering over a cell highlights the facts about it
// (only while the Debug tab is open: elsewhere the highlights would only confuse).
function link_facts_to_board(editor, atoms) {
  editor.fact_atoms = atoms;
  editor.linked_markers = [];
  const cell_at = (row) => {
    const size = board_size();
    return size && atoms[row] ? cell_of_atom(atoms[row], size.width, size.height) : null;
  };
  editor.container.addEventListener('mousemove', (e) => {
    const { row } = editor.renderer.screenToTextCoordinates(e.clientX, e.clientY);
    link_cell(cell_at(row));
  });
  editor.container.addEventListener('mouseleave', () => link_cell(null));
}

// Highlight a cell (an index, or null for none) and the facts about it.
let linked_cell = null;
function link_cell(cell) {
  if (cell === linked_cell) {
    highlight_cells(cell == null ? [] : [cell]);      // (the board may have been drawn again)
    return;
  }
  linked_cell = cell;
  const size = board_size();
  for (const editor of debug_editors) {
    for (const id of editor.linked_markers) editor.session.removeMarker(id);
    editor.linked_markers = [];
    if (cell == null || !size) continue;
    editor.fact_atoms.forEach((atom, row) => {
      if (cell_of_atom(atom, size.width, size.height) === cell) {
        editor.linked_markers.push(editor.session.addMarker(new AceRange(row, 0, row, 1), 'fact-linked', 'fullLine'));
      }
    });
  }
  highlight_cells(cell == null ? [] : [cell]);
}
on_cell_hover((cell) => link_cell($('tab5').checked ? cell : null));

// Show a report in the Debug tab: a locked editor for each program's facts
// (one fact per line), and the other lines as text. With the report of the
// step before (`previous`), the facts that are new are marked, and the ones
// that are gone are listed under the editor.
// Keep the height of `elem` while its contents are made again, until the new
// contents are drawn (the editors get their height in the next frame): else the
// page is shorter for a moment, and the browser scrolls up (e.g. at every step).
function keep_height(elem) {
  elem.style.minHeight = elem.offsetHeight + 'px';
  const n = (elem.keep_height_count = (elem.keep_height_count || 0) + 1);
  requestAnimationFrame(() => requestAnimationFrame(() => {
    if (elem.keep_height_count === n) elem.style.minHeight = '';
  }));
}

function show_debug_step(report, text = '', previous = null) {
  const only = Boolean(previous && options.only_changes);
  const key = report != null ? (only ? '\u0001' : '') + report : '\0' + text;
  if (key === debug_shown) return;
  debug_shown = key;
  for (const editor of debug_editors) editor.destroy();
  debug_editors = [];
  linked_cell = null;
  const elem = $('debug-step');
  keep_height(elem);
  elem.replaceChildren();
  if (report == null) {
    const p = document.createElement('p');
    p.className = 'debug-text';
    p.textContent = text;
    elem.append(p);
    return;
  }
  const before = new Map();
  if (previous) {
    for (const part of report_parts(previous)) if (part.facts != null) before.set(part.label, facts_to_answer_set(part.facts));
    const legend = document.createElement('p');
    legend.className = 'debug-legend';
    legend.innerHTML = only
      ? 'Only what changed since the step before: <span class="fact-new-sample">new facts</span>, and facts that are gone (listed under each part).'
      : 'Compared with the step before: <span class="fact-new-sample">new facts</span> are marked, and facts that are gone are listed under each part.';
    elem.append(legend);
  }
  for (const part of report_parts(report)) {
    if (part.text != null) {
      const p = document.createElement('p');
      p.className = 'debug-text';
      p.textContent = part.text;
      elem.append(p);
      continue;
    }
    const h = document.createElement('h4');
    h.className = 'debug-program';
    h.textContent = part.label;
    elem.append(h);
    const all = facts_to_answer_set(part.facts);
    const old = before.get(part.label);
    // (only what changed: the new facts, and how many did not change)
    const was_all = new Set(old || []);
    const atoms = only ? all.filter((atom) => !was_all.has(atom)) : all;
    const unchanged = all.length - atoms.length;
    if (!atoms.length) {
      const p = document.createElement('p');
      p.className = 'debug-empty';
      p.textContent = !all.length ? '(nothing)' : `(no changes: ${unchanged} fact${unchanged > 1 ? 's' : ''} as in the step before)`;
      elem.append(p);
    } else {
      const div = document.createElement('div');
      elem.append(div);
      const editor = make_output_editor(div, answer_set_to_fact_lines(atoms));
      debug_editors.push(editor);
      link_facts_to_board(editor, atoms);
      if (old) {
        const was = new Set(old);
        atoms.forEach((atom, row) => {
          if (was.has(atom)) return;
          editor.session.addMarker(new AceRange(row, 0, row, 1), 'fact-new', 'fullLine');
          editor.session.addGutterDecoration(row, 'fact-new-gutter');
        });
      }
      if (only && unchanged) {
        const p = document.createElement('p');
        p.className = 'debug-unchanged';
        p.textContent = `\u22EF ${unchanged} unchanged fact${unchanged > 1 ? 's' : ''} not shown`;
        elem.append(p);
      }
    }
    if (old) {
      const now = new Set(all);
      const gone = old.filter((atom) => !now.has(atom));
      if (gone.length) {
        const p = document.createElement('p');
        p.className = 'debug-gone';
        p.append('Gone since the step before: ');
        gone.forEach((atom, i) => {
          if (i) p.append(' ');
          const del = document.createElement('del');
          del.textContent = atom + '.';
          p.append(del);
        });
        elem.append(p);
      }
    }
  }
}

// The Debug tab: the messages, and the report of the step of the board that is shown.
function update_debug_view() {
  $('debug-messages').textContent = output_messages.join('\n').trim();
  $('debug-messages').hidden = output_messages.length === 0;
  const snap = snapshots[shown_snapshot];
  const report = snap ? step_reports.get(snap.time + 1) : null;
  if (!snapshots.length) {
    $('debug-step-label').textContent = '';
    show_debug_step(null, output_messages.length ? '' : 'Play a game (or use Step) to see here what happens in each step.');
  } else if (!snap) {
    $('debug-step-label').textContent = '';
    show_debug_step(null, 'The game is being played…');
  } else if (report) {
    $('debug-step-label').textContent = `Step ${snap.time + 1}: the player saw the board of time ${snap.time} (on the board), and decided on a move.`;
    show_debug_step(report, '', step_reports.get(snap.time) || null);
  } else {
    $('debug-step-label').textContent = `Time ${snap.time}: the end of the game.`;
    show_debug_step(null, shown_snapshot === snapshots.length - 1 && final_verdict ? (output_messages[0] || '') : 'This step has not been played yet.');
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
  if (can_play) step_button.title = 'Play one step, then pause (Space)';
  if (can_play) play_button.title = (game_paused ? 'Go on with the game' : 'Play') + ' (Ctrl+Enter)';
  set_button(pause_button, busy && !single_step, 'There is no game going on.');
  if (!pause_button.disabled) pause_button.title = 'Pause (Space)';
  set_button(stop_button, playing, 'There is no game going on.');
  const test_button = $('test-button');
  set_button(test_button, !playing && !testing && !generating, why);
  test_button.textContent = level_locked ? 'Test' : 'Lock rules and test';

  // The lock of the game rules
  lock_button.disabled = level_locked;
  set_button(unlock_button, level_locked && !playing && !testing && !generating, why);
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
  let replay = false;      // (offer to play the level again)
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
      if (changed.length) {
        text += ` Since then, you changed: ${changed.map((k) => SOURCE_NAMES[k]).join(', ')}.`;
        replay = level_locked;
      }
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
  if (replay) {
    const button = document.createElement('button');
    button.className = 'control-button replay-button';
    button.textContent = '\u23F5 Play again';
    button.title = 'Play this level again with your changes, and come back to the time the board shows now';
    button.addEventListener('click', play_again);
    elem.append(' ', button);
  }
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
  rules_changed();
  update_controls();
}

// The game rules (may) have changed: a level made with other level programs
// is removed, and a game played with other rules is put away.
function rules_changed() {
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
  const for_game = current;
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
  if (current !== for_game) {      // (another game was opened in the meantime)
    update_controls();
    return;
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
  if (linked_cell != null) highlight_cells([linked_cell]);
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
  show_move_note(snap);
  update_debug_view();
}

// Under the timeline: why the player made no move (or several) at the time shown,
// with links to the lines of the strategy to look at.
function show_move_note(snap) {
  const note = $('move-note');
  const hint = snap && snap.moves != null && run_basis ? move_hint(run_basis.player_move_program, snap.moves, snap.player_problem) : null;
  note.hidden = !hint;
  if (!hint) {
    note.replaceChildren();
    return;
  }
  const parts = [document.createTextNode(hint.text)];
  if (hint.lines.length) {
    parts.push(document.createTextNode(` See line${hint.lines.length > 1 ? 's' : ''} `));
    hint.lines.forEach((line, i) => {
      if (i) parts.push(document.createTextNode(i === hint.lines.length - 1 ? ' and ' : ', '));
      const link = document.createElement('button');
      link.className = 'link-button';
      link.textContent = String(line);
      link.title = 'Show this line of your strategy';
      link.addEventListener('click', () => editors.go_to('player_move_program', { line, col: 1 }));
      parts.push(link);
    });
    parts.push(document.createTextNode(' of your strategy.'));
  }
  if (changed_since(run_basis).includes('player_move_program')) {
    parts.push(document.createTextNode(' (You changed your strategy since this game: play again to see what it does now.)'));
  }
  note.replaceChildren(...parts);
}

$('timeline').addEventListener('input', () => show_snapshot(Number($('timeline').value) - 1));
$('timeline-prev').addEventListener('click', () => show_snapshot(shown_snapshot - 1));
$('timeline-next').addEventListener('click', () => show_snapshot(shown_snapshot + 1));

// ---- Playing -------------------------------------------------------------------

// The number of games played until the end, and the last verdict (for the tutorial)
const results = { games: 0, verdict: null };

function end_playing() {
  const stopped = stop_requested;
  if (stopped) return_to_time = null;
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

// Play the level again (after a change), and then show the time that was
// shown before (or the end, if the game is over earlier now).
let return_to_time = null;
async function play_again() {
  return_to_time = snapshots[shown_snapshot] ? snapshots[shown_snapshot].time : null;
  await do_play();
}

// The snapshot to show when a game is over.
function end_snapshot() {
  const index = return_to_time == null ? -1 : snapshots.findIndex((x) => x.time === return_to_time);
  return_to_time = null;
  return index >= 0 ? index : snapshots.length - 1;
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
    snapshots.at(-1).player_problem = (step.problems || []).find((p) => p && p.program === 'Player program') || null;
    editors.show_run_problems(step.problems);
    if (stop_requested) continue;
    if (step.report) add_to_game_output(step.report, session.time_step);
    if (step.verdict) {
      final_verdict = step.verdict;
      add_to_game_output(step.verdict === 'win' ? step.message : step.message + problems_tip());
      end_playing();
      show_snapshot(end_snapshot());
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
    if (linked()) {
      folder_link.save(editors.game(), current.title);
      show_work_notice(null);
    } else {
      const saved = work.load(current.origin);
      show_work_notice(saved ? `Your own version, saved in this browser ${short_when(saved.saved_at)}.` : null);
    }
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
  if (folder_link && folder_link.origin !== origin) unlink_folder(false);
  game = normalize_game(game);
  current = { origin, title, original: game };
  const saved = work.load(origin);
  loading_game = true;
  try {
    if (saved) {
      await set_game(saved.game);
      show_work_notice(`Your own version, saved in this browser${saved.saved_at ? ' ' + short_when(saved.saved_at) : ''}.`);
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

// When work was saved, shortly: 'at 19:48' today, otherwise 'on 24 Nov, 19:48'.
function short_when(iso) {
  const d = new Date(iso);
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (d.toDateString() === new Date().toDateString()) return 'at ' + time;
  return 'on ' + d.toLocaleDateString([], { day: 'numeric', month: 'short', year: d.getFullYear() === new Date().getFullYear() ? undefined : 'numeric' }) + ', ' + time;
}

function show_work_notice(text) {
  show_game_title();
  if (linked()) {
    $('work-notice-text').textContent = `Linked to the folder ${folder_link.name}: changes are saved into its files, and changes to its files are loaded here.`;
    $('work-notice').hidden = false;
    $('work-notice').querySelector('button').hidden = true;
    return;
  }
  $('work-notice').querySelector('button').hidden = false;
  $('work-notice-text').textContent = text || '';
  $('work-notice').hidden = !text;
}

// ---- Game folders on the player's computer ------------------------------------------------
//
// A folder with one file per program (see folder.js): downloaded as a .zip,
// loaded (as a folder or a .zip), or linked (folder-link.js: Chrome and Edge).
// The game of a folder is saved in the browser under the origin 'folder:<name>'.

let folder_link = null;
const linked = () => Boolean(folder_link && current && current.origin === folder_link.origin);

function folder_status(text, is_error = false) {
  $('folder-status').textContent = text;
  $('folder-status').classList.toggle('error', is_error);
}

function update_folder_controls() {
  $('folder-supported').hidden = !folder_links_supported();
  $('folder-unsupported').hidden = folder_links_supported();
  $('unlink-folder-button').hidden = !folder_link;
  $('open-folder-button').textContent = folder_link ? 'Link another folder\u2026' : 'Link a folder\u2026';
  if (folder_link) folder_status(`Linked to the folder ${folder_link.name}. Changes are saved into its files.`);
  $('folder-summary').textContent = folder_link ? `(linked to ${folder_link.name})` : '';
}

function download_folder() {
  const title = current ? current.title : 'game';
  const stem = file_stem(title);
  const files = game_to_files(editors.game(), { title });
  const zip = make_zip(Object.fromEntries(Object.entries(files).map(([p, text]) => [stem + '/' + p, text])));
  save(stem + '.zip', zip, 'application/zip');
}

// Open the game of a folder ({ path: text }) that was loaded (not linked).
async function open_folder_contents(contents, name) {
  const { game, title } = files_to_game(contents);
  forget_link();
  const origin = 'folder:' + name;
  // (the folder is newer than the work on it in this browser: that is kept as a snapshot)
  const saved = work.load(origin);
  if (saved && !same_game(saved.game, game)) versions.add(origin, saved.game, { auto: true, reason: 'load' }, { title: saved.title, original: saved.original });
  work.forget(origin);
  await open_game(game, origin, title || name);
  lock_level_generation();
  return title || name;
}

async function load_folder(event) {
  const list = [...event.target.files];
  event.target.value = '';
  if (!list.length) return;
  await stop_game_if_playing();
  try {
    const { dir, paths } = strip_common_dir(list.map((f) => f.webkitRelativePath || f.name));
    const by_path = new Map(paths.map((p, i) => [p, list[i]]));
    // Only the files that game.json names (or the default names) are read
    const contents = {};
    if (by_path.has(MANIFEST)) contents[MANIFEST] = await by_path.get(MANIFEST).text();
    for (const p of new Set(Object.values(file_names(contents[MANIFEST])))) {
      const file = by_path.get(p);
      if (file && file.size <= 2e6) contents[p] = await file.text();
    }
    const title = await open_folder_contents(contents, dir || 'folder');
    upload_status.innerText = `Done loading: the folder ${dir || ''} (${title}).`;
  } catch (e) {
    upload_status.innerText = 'Loading failed: ' + e.message;
  }
}

// Link a folder that the player picks.
async function open_folder() {
  let dir;
  try {
    dir = await window.showDirectoryPicker({ id: 'logic-game', mode: 'readwrite' });
  } catch (e) {
    if (e.name !== 'AbortError') folder_status('The folder could not be opened: ' + e.message, true);
    return;
  }
  await link_folder(dir);
}

async function link_folder(dir) {
  await stop_game_if_playing();
  try {
    if (!(await permission(dir))) {
      folder_status(`No permission to use the folder ${dir.name}.`, true);
      return;
    }
    const link = new FolderLink(dir, {
      on_change: folder_changed,
      on_error: (e) => folder_status(`The folder ${dir.name}: ${e.message}`, true),
    });
    link.origin = 'folder:' + dir.name;
    if (await folder_is_empty(dir)) {
      const title = current ? current.title : dir.name;
      if (!window.confirm(`The folder ${dir.name} is empty. Save the current game (${title}) into it, one file per program, and link it?`)) return;
      if (save_timer) save_work_now();
      const game = editors.game();
      await link.save(game, dir.name);
      await link.load();
      if (folder_link) unlink_folder(false);
      folder_link = link;
      work.forget(link.origin);
      await open_game(game, link.origin, dir.name);
    } else {
      const { game, title } = await link.load();
      if (folder_link) unlink_folder(false);
      folder_link = link;
      const saved = work.load(link.origin);
      if (saved && !same_game(saved.game, game)) versions.add(link.origin, saved.game, { auto: true, reason: 'load' }, { title: saved.title, original: saved.original });
      work.forget(link.origin);
      forget_link();
      await open_game(game, link.origin, title);
    }
    lock_level_generation();
    link.watch();
    remember_folder(dir);
    $('folder-notice').hidden = true;
    update_folder_controls();
    show_work_notice(null);
  } catch (e) {
    folder_status(`The folder ${dir.name} could not be linked: ${e.message}`, true);
  }
}

// Files of the linked folder were changed outside the page.
async function folder_changed(game, fields) {
  if (!linked()) return;
  await stop_game_if_playing();
  versions_tab.auto_snapshot('folder');
  await replace_game(game, fields);
  const names = fields.map((f) => SOURCE_NAMES[f]).join(', ');
  folder_status(`Loaded the changes to ${names} from the folder ${folder_link.name} (${new Date().toLocaleTimeString()}).`);
}

function unlink_folder(forget = true) {
  if (!folder_link) return;
  folder_link.unwatch();
  const name = folder_link.name;
  folder_link = null;
  if (forget) forget_folder();
  update_folder_controls();
  folder_status(`Unlinked the folder ${name}. The game is still saved in this browser.`);
  show_work_notice(null);
}

// After a reload: offer to link the folder of last time again (the browser asks for permission).
let remembered = null;
async function offer_folder() {
  if (!folder_links_supported()) return;
  remembered = await remembered_folder();
  if (!remembered) return;
  $('relink-folder-button').hidden = false;
  $('relink-folder-button').textContent = `Link the folder ${remembered.name} again`;
  $('folder-notice-text').textContent = `Last time, the page was linked to your game folder ${remembered.name}.`;
  $('folder-notice').hidden = false;
}

async function relink_folder() {
  if (!remembered) return;
  $('folder-notice').hidden = true;
  $('relink-folder-button').hidden = true;
  await link_folder(remembered);
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

// A fresh start: forget everything the page keeps in this browser (all work and
// snapshots, the options, the tutorial, the linked folder, which sections are
// open), and load the page again, as on a first visit.
async function reset_everything() {
  if (!window.confirm('Reset everything, for a fresh start? This forgets all your work in this browser, with all snapshots, ' +
    'your options, the tutorial and the linked folder, and loads the page again as on a first visit. ' +
    '(Download a backup first to keep your work.)')) return;
  await stop_game_if_playing();
  clearTimeout(save_timer);
  save_timer = null;
  unlink_folder(false);
  try {
    const keys = [];
    for (let i = 0; i < storage.length; i++) if (storage.key(i).startsWith('logic-game:')) keys.push(storage.key(i));
    for (const key of keys) storage.removeItem(key);
  } catch {
    // (no storage: nothing was kept)
  }
  await forget_folder();
  window.location.replace(window.location.pathname);
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
      // (a level that comes with the programs, e.g. from the files of a folder)
      level_seed = null;
      reset_debugging();
      set_level_basis('loaded');
      await update_interface();
    } else if (level_locked && fields.some((f) => RULE_PROGRAMS.includes(f))) {
      rules_changed();
      update_controls();
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
  if (origin.startsWith('folder:')) return origin.slice(7);
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

// Before the game in the editors is replaced: stop a game, a test of the
// strategy, and wait for a level that is being generated.
async function stop_game_if_playing() {
  if (playing) {
    do_stop();
    while (playing) await sleep(20);
  }
  if (testing) {
    cancel_test();
    while (testing) await sleep(20);
  }
  while (generating) await sleep(20);
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
    if (/\.zip$/i.test(file.name)) {
      const all = await read_zip(new Uint8Array(await file.arrayBuffer()));
      const { dir, paths } = strip_common_dir(Object.keys(all));
      const contents = Object.fromEntries(Object.keys(all).map((k, i) => [paths[i], all[k]]));
      const title = await open_folder_contents(contents, dir || file.name.replace(/\.zip$/i, ''));
      upload_status.innerText = `Done loading: ${file.name} (${title}).`;
      event.target.value = '';
      return;
    }
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
  const game = editors.game();
  save(file_stem(current ? current.title : 'game') + '.json', JSON.stringify(game, null, 2));
  if (current) {
    versions.mark_game_downloaded(current.origin, game, { title: current.title, original: current.original });
    versions_tab.refresh();
  }
}

function save(filename, data, type = 'application/json') {
  const blob = new Blob([data], { type });
  const elem = document.createElement('a');
  elem.href = URL.createObjectURL(blob);
  elem.download = filename;
  document.body.appendChild(elem);
  elem.click();
  document.body.removeChild(elem);
}

// ---- Tabs ------------------------------------------------------------------------

// Refreshing after changing tabs
function change_tabs() {
  if (!$('tab5').checked) link_cell(null);
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
  const tested = current;     // (the test result is kept with this game)
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
      const s = versions_tab.record_test(tested, game, n, counts);
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
  share_game, revert_to_original, forget_saved_work, reset_everything, run_test, cancel_test,
  take_snapshot: () => versions_tab.take_snapshot(),
  download_project: () => versions_tab.download_project(),
  download_backup: () => versions_tab.download_backup(),
  start_tutorial,
  dismiss_tutorial: () => tutorial.dismiss_invite(),
  download_folder, open_folder, relink_folder,
  unlink_folder: () => unlink_folder(true),
  dismiss_folder_notice: () => { $('folder-notice').hidden = true; },
};
// ---- Keyboard shortcuts ------------------------------------------------------------
//
// Ctrl+Enter (Cmd+Enter on a Mac): play, also while typing in an editor.
// When not typing: Space pauses, or plays one step; the arrow keys (and Home
// and End) move through the timeline under the board.

function shortcut_play() {
  if (!$('play-button').disabled) do_play();
}

for (const key of GAME_FIELDS) {
  editors.get(key).commands.addCommand({
    name: 'play', bindKey: { win: 'Ctrl-Enter', mac: 'Command-Enter' }, exec: shortcut_play,
  });
}

// Whether the keyboard is busy elsewhere: typing, a list, a button (Space), the board (its own arrow keys).
function keys_taken(target) {
  return Boolean(target.closest && target.closest('input, textarea, select, button, [contenteditable], .ace_editor, #visual, .modal'));
}

document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
    if (e.target.closest && e.target.closest('.ace_editor')) return;      // (the editor's own command)
    e.preventDefault();
    shortcut_play();
    return;
  }
  if (e.ctrlKey || e.metaKey || e.altKey || keys_taken(e.target)) return;
  if (e.key === ' ') {
    e.preventDefault();
    if (playing && !game_paused) do_pause();
    else if (!$('step-button').disabled) do_step();
  } else if (snapshots.length && !(playing && !game_paused)) {
    const to = { ArrowLeft: shown_snapshot - 1, ArrowRight: shown_snapshot + 1, Home: 0, End: snapshots.length - 1 }[e.key];
    if (to == null) return;
    e.preventDefault();
    show_snapshot(Math.max(0, Math.min(snapshots.length - 1, to)));
  }
});

document.querySelectorAll('[data-action]').forEach((elem) => {
  const action = actions[elem.dataset.action];
  if (!action) throw new Error('unknown action ' + elem.dataset.action);
  elem.addEventListener('click', () => action());
});
speed_selector.addEventListener('change', select_speed);
$('file-input').addEventListener('change', load_game_from_file);
$('folder-input').addEventListener('change', load_folder);
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
// ?side_by_side=true&mark_changes=true&solutions=true&editor=true&internals=true&timeout=30
// (then only for this visit). Every checkbox option can be set in the URL.

const params = new URLSearchParams(window.location.search);
const OPTIONS_KEY = 'logic-game:options';
const DEFAULT_OPTIONS = { side_by_side: true, only_changes: false, mark_changes: false, solutions: false, editor: false, internals: false, timeout: solver.timeout_ms / 1000 };

function stored_options() {
  try {
    return JSON.parse(storage.getItem(OPTIONS_KEY)) || {};
  } catch {
    return {};
  }
}

const options = { ...DEFAULT_OPTIONS, ...stored_options() };
for (const [key, value] of Object.entries(DEFAULT_OPTIONS)) {
  if (typeof value === 'boolean' && params.has(key)) options[key] = ['true', '1', 'yes', ''].includes(params.get(key));
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
  if (document.body.classList.contains('side-by-side') !== Boolean(options.side_by_side)) {
    document.body.classList.toggle('side-by-side', Boolean(options.side_by_side));
    // (the editors do not notice by themselves that they changed width)
    editors.resize();
    for (const editor of debug_editors) editor.resize();
  }
  $('visual-container').classList.toggle('hide-changes', !options.mark_changes);
  $('mark-changes').checked = options.mark_changes;
  $('level-editor').style.display = options.editor ? '' : 'none';
  $('tab6').style.display = options.internals ? '' : 'none';
  document.querySelector('label[for="tab6"]').style.display = options.internals ? '' : 'none';
  if (!options.internals && $('tab6').checked) select_tab(1);
  if (options.solutions && !solutions_group.isConnected) example_games.append(solutions_group);
  if (!options.solutions && solutions_group.isConnected) solutions_group.remove();
  solver.timeout_ms = Math.max(1, Number(options.timeout) || DEFAULT_OPTIONS.timeout) * 1000;
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
}

// ---- Start ---------------------------------------------------------------------------

// Download clingo (its WebAssembly module, the largest file of the site), with
// the progress over the board. Returns a URL of the downloaded file for
// solver.init, or undefined if that did not work (then clingo loads it itself).
const CLINGO_WASM = 'vendor/clingo-wasm/clingo.wasm';
async function download_clingo() {
  const box = $('loading');
  const bar = $('loading-progress');
  const text = $('loading-text');
  const mb = (n) => (n / 1e6).toFixed(1);
  // (only shown when the download takes a while, so a quick visit does not flicker)
  const show = setTimeout(() => { box.hidden = false; }, 300);
  try {
    const response = await fetch(CLINGO_WASM);
    if (!response.ok || !response.body) return undefined;
    // (a compressed file is smaller than its contents: then the total is not known)
    const total = response.headers.get('content-encoding') ? 0 : Number(response.headers.get('content-length')) || 0;
    const reader = response.body.getReader();
    const chunks = [];
    let loaded = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      loaded += value.length;
      if (total) bar.value = loaded / total;
      else bar.removeAttribute('value');
      text.textContent = total ? `Loading clingo, the solver that runs the programs: ${mb(loaded)} of ${mb(total)} MB` :
        `Loading clingo, the solver that runs the programs: ${mb(loaded)} MB`;
    }
    text.textContent = 'Starting clingo…';
    return URL.createObjectURL(new Blob(chunks, { type: 'application/wasm' }));
  } catch {
    return undefined;
  } finally {
    clearTimeout(show);
  }
}

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
    await solver.init(download_clingo());
    set_engine_status('');
  } catch (e) {
    set_engine_status('clingo could not be loaded: ' + e.message, true);
  }
  $('loading').hidden = true;
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
  update_folder_controls();
  if (!window.location.hash && params.get('tutorial') !== 'true') await offer_folder();
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
window.logic_game = { solver, editors, clingo, work, versions, versions_tab, tutorial, game_output: game_output_text };
