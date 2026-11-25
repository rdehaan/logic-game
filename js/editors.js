// The code editors (Ace), and the errors shown in them.
//
// Errors come from two places:
// - live checks: shortly after an editor changes, its program is checked on
//   its own for syntax errors and unsafe variables (solver.check);
// - runs: when a program fails while generating a level or playing, the
//   errors that clingo reports are traced back to the editor they are in.
// Errors are shown as a marker in the editor's gutter (hover for the
// message), as an underline, and in a list under the editor. The tab that
// holds an editor with errors is marked too.
import { GAME_FIELDS } from './engine.js';
import { preprocess_program } from './asp.js';

const CHECK_DELAY_MS = 400;

// Which tab each editor is on (the id of the tab's radio button).
const TAB_OF = {
  aux_program: 'tab3',
  level_gen_program: 'tab3',
  visibility_program: 'tab3',
  nature_program: 'tab3',
  goal_program: 'tab3',
  player_move_program: 'tab4',
  level_settings: 'tab5',
  level_state: 'tab5',
};

function make_editor(id) {
  const editor = ace.edit(id);
  editor.setTheme('ace/theme/textmate');
  editor.$blockScrolling = Infinity;
  editor.setOptions({
    useSoftTabs: true,
    tabSize: 2,
    maxLines: Infinity,
    mode: 'ace/mode/gringo',
    autoScrollEditorIntoView: true,
    useWorker: false,
  });
  return editor;
}

// Read-only editors for the example code in the instructions.
export function make_example_editors() {
  document.querySelectorAll('.example-code').forEach((elem, i) => {
    elem.id = 'example' + i;
    const editor = make_editor(elem.id);
    editor.setReadOnly(true);
    editor.resize();
  });
}

export class Editors {
  constructor(solver) {
    this.solver = solver;
    this.editors = {};
    this.live_errors = {};      // key -> errors from the last live check
    this.run_errors = {};       // key -> errors from the last run
    this.markers = {};          // key -> Ace marker ids
    this.timers = {};
    this.checks_enabled = true;
    for (const key of GAME_FIELDS) {
      const editor = make_editor(key);
      this.editors[key] = editor;
      this.live_errors[key] = [];
      this.run_errors[key] = [];
      this.markers[key] = [];
      const list = document.createElement('ul');
      list.className = 'editor-problems';
      list.id = key + '-problems';
      editor.container.after(list);
      editor.session.on('change', () => this.changed(key));
    }
  }

  get(key) { return this.editors[key]; }
  value(key) { return this.editors[key].getValue(); }

  set_value(key, text) {
    this.editors[key].setValue(text || '', 1);
  }

  // The current contents of all editors, as a game object.
  game() {
    const game = {};
    for (const key of GAME_FIELDS) game[key] = this.value(key);
    return game;
  }

  set_game(game) {
    for (const key of GAME_FIELDS) this.set_value(key, game[key]);
  }

  set_read_only(keys, read_only) {
    for (const key of keys) {
      const editor = this.editors[key];
      editor.setReadOnly(read_only);
      editor.container.classList.toggle('locked', read_only);
    }
  }

  resize() {
    for (const key of GAME_FIELDS) this.editors[key].resize();
  }

  // An editor changed: its errors from runs are outdated, check it again soon.
  changed(key) {
    this.run_errors[key] = [];
    this.show(key);
    clearTimeout(this.timers[key]);
    this.timers[key] = setTimeout(() => this.check(key), CHECK_DELAY_MS);
  }

  async check(key) {
    if (!this.checks_enabled) return;
    const text = this.value(key);
    const errors = await this.solver.check(preprocess_program(text));
    if (errors === null) return;               // aborted or timed out
    if (this.value(key) !== text) return;      // changed in the meantime
    this.live_errors[key] = errors;
    this.show(key);
  }

  async check_all() {
    await Promise.all(GAME_FIELDS.map((key) => this.check(key)));
  }

  // Show the errors of a run (problems as reported by the engine).
  show_run_problems(problems) {
    const by_key = {};
    for (const p of problems) {
      if (!p || p.result.status !== 'error') continue;
      for (const e of p.result.errors) {
        if (!e.source || !this.editors[e.source]) continue;
        (by_key[e.source] ||= []).push(e);
      }
    }
    for (const [key, errors] of Object.entries(by_key)) {
      const known = new Set(this.run_errors[key].map(signature));
      for (const e of errors) {
        if (!known.has(signature(e))) {
          this.run_errors[key].push(e);
          known.add(signature(e));
        }
      }
      this.show(key);
    }
  }

  clear_run_problems() {
    for (const key of GAME_FIELDS) {
      if (this.run_errors[key].length) {
        this.run_errors[key] = [];
        this.show(key);
      }
    }
  }

  errors_of(key) {
    const seen = new Set(this.live_errors[key].map(signature));
    return [...this.live_errors[key], ...this.run_errors[key].filter((e) => !seen.has(signature(e)))];
  }

  // Draw the errors of one editor.
  show(key) {
    const editor = this.editors[key];
    const session = editor.session;
    const errors = this.errors_of(key);
    const Range = ace.require('ace/range').Range;

    for (const id of this.markers[key]) session.removeMarker(id);
    this.markers[key] = [];
    session.setAnnotations(errors.map((e) => ({
      row: Math.max(0, (e.line || 1) - 1),
      column: Math.max(0, (e.col || 1) - 1),
      text: e.message,
      type: e.severity === 'error' ? 'error' : 'warning',
    })));
    for (const e of errors) {
      if (e.line == null) continue;
      const range = new Range(e.line - 1, e.col - 1, (e.end_line || e.line) - 1, Math.max(e.col, (e.end_col || e.col + 1) - 1));
      this.markers[key].push(session.addMarker(range, 'clingo-error-marker', 'text', false));
    }

    const list = document.getElementById(key + '-problems');
    list.replaceChildren(...errors.map((e) => {
      const item = document.createElement('li');
      item.textContent = (e.line != null ? `Line ${e.line}, column ${e.col}: ` : '') + e.message;
      if (e.line != null) {
        item.title = 'Click to go to this line';
        item.addEventListener('click', () => {
          editor.gotoLine(e.line, e.col - 1, true);
          editor.focus();
        });
      }
      return item;
    }));
    editor.container.classList.toggle('has-errors', errors.length > 0);
    this.update_tab_markers();
  }

  update_tab_markers() {
    const tabs = new Set();
    for (const key of GAME_FIELDS) {
      if (this.errors_of(key).length) tabs.add(TAB_OF[key]);
    }
    for (const tab of new Set(Object.values(TAB_OF))) {
      const label = document.querySelector(`label[for="${tab}"]`);
      if (label) label.classList.toggle('has-errors', tabs.has(tab));
    }
  }
}

function signature(e) {
  return `${e.line}:${e.col}:${e.message}`;
}
