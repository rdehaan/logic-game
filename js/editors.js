// The code editors (Ace), and the feedback shown in them.
//
// Feedback comes from three places:
// - live checks: shortly after an editor changes, its program is checked on
//   its own for syntax errors and unsafe variables (solver.check);
// - hints: the programs are analyzed together for mistakes with the special
//   predicates, such as a player's program that never derives do/1 (hints.js);
// - runs: when a program fails while generating a level or playing, the
//   errors that clingo reports (or the constraints that are violated) are
//   traced back to the editor they are in.
// Feedback is shown as a marker in the editor's gutter (hover for the
// message), as an underline, and in a list under the editor. Tabs that hold
// an editor with errors or warnings are marked, and all errors and warnings
// are listed in the Debug tab.
import { GAME_FIELDS, SOURCE_NAMES } from './engine.js';
import { preprocess_program } from './asp.js';
import { game_hints, INTERFACES } from './hints.js';

const CHECK_DELAY_MS = 400;
const HINT_DELAY_MS = 300;

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

const SEVERITY_ORDER = { error: 0, warning: 1, info: 2 };

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
  // On narrow screens (phones), long lines are wrapped
  const narrow = window.matchMedia('(max-width: 650px)');
  editor.session.setUseWrapMode(narrow.matches);
  narrow.addEventListener('change', () => editor.session.setUseWrapMode(narrow.matches));
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

// A line above an editor that says which special predicates the program gets and passes on.
function interface_line(key) {
  const iface = INTERFACES[key];
  if (!iface) return null;
  const p = document.createElement('p');
  p.className = 'editor-interface';
  const list = (sigs) => sigs.map((s) => `<tt>${s.replace('/*', '')}</tt>`).join(', ');
  p.innerHTML = (iface.inputs.length ? `Gets: ${list(iface.inputs)} (and the auxiliary program).` : 'Gets: only the auxiliary program.') +
    ` Passes on: ${list(iface.outputs)}.`;
  return p;
}

export class Editors {
  constructor(solver) {
    this.solver = solver;
    this.editors = {};
    this.live_errors = {};      // key -> errors from the last live check
    this.run_errors = {};       // key -> errors from the last run
    this.hints = {};            // key -> hints about the special predicates
    this.markers = {};          // key -> Ace marker ids
    this.timers = {};
    this.hint_timer = null;
    this.on_change = null;      // called with the key of an editor that changed
    for (const key of GAME_FIELDS) {
      const editor = make_editor(key);
      this.editors[key] = editor;
      this.live_errors[key] = [];
      this.run_errors[key] = [];
      this.hints[key] = [];
      this.markers[key] = [];
      const line = interface_line(key);
      if (line) editor.container.before(line);
      const list = document.createElement('ul');
      list.className = 'editor-problems';
      list.id = key + '-problems';
      editor.container.after(list);
      editor.session.on('change', () => this.changed(key));
    }
    this.summary = document.getElementById('problems-summary');
    this.notice = document.getElementById('problems-notice');
    if (this.notice) {
      this.notice.addEventListener('click', () => {
        document.getElementById('tab5').checked = true;
        document.getElementById('tab5').dispatchEvent(new Event('change'));
        if (this.summary) this.summary.scrollIntoView({ block: 'nearest' });
      });
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
    if (this.on_change) this.on_change(key);
    this.run_errors[key] = [];
    this.show(key);
    clearTimeout(this.timers[key]);
    this.timers[key] = setTimeout(() => this.check(key), CHECK_DELAY_MS);
  }

  async check(key) {
    const text = this.value(key);
    const errors = await this.solver.check(preprocess_program(text));
    if (errors === null) return;               // aborted or timed out
    if (this.value(key) !== text) return;      // changed in the meantime
    this.live_errors[key] = errors;
    this.show(key);
    this.schedule_hints();
  }

  async check_all() {
    await Promise.all(GAME_FIELDS.map((key) => this.check(key)));
  }

  schedule_hints() {
    clearTimeout(this.hint_timer);
    this.hint_timer = setTimeout(() => this.update_hints(), HINT_DELAY_MS);
  }

  // Analyze all programs (except those with syntax errors) for hints.
  update_hints() {
    const skip = new Set(GAME_FIELDS.filter((key) => this.live_errors[key].length > 0));
    let hints;
    try {
      hints = game_hints(this.game(), skip);
    } catch (e) {
      console.error('hints failed:', e);
      return;
    }
    for (const key of GAME_FIELDS) {
      this.hints[key] = hints[key] || [];
      this.show(key);
    }
  }

  // Show the errors of a run (problems as reported by the engine).
  show_run_problems(problems) {
    const by_key = {};
    for (const p of problems) {
      if (!p) continue;
      if (p.result.status === 'error') {
        for (const e of p.result.errors) {
          if (e.source && this.editors[e.source]) (by_key[e.source] ||= []).push(e);
        }
      } else if (p.result.status === 'unsat' && p.result.violated) {
        for (const v of p.result.violated) {
          if (!this.editors[v.source]) continue;
          (by_key[v.source] ||= []).push({
            line: v.line, col: v.col, end_line: v.line, end_col: v.col + 2, severity: 'warning',
            message: `This constraint was violated during the game, so ${p.program === 'Level generation' ? 'level generation' : 'the ' + p.program.toLowerCase()} had no answer set (see the game output).`,
          });
        }
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

  // All feedback for one editor, most serious first.
  errors_of(key) {
    const seen = new Set();
    const out = [];
    for (const e of [...this.live_errors[key], ...this.run_errors[key], ...this.hints[key]]) {
      if (seen.has(signature(e))) continue;
      seen.add(signature(e));
      out.push(e);
    }
    return out.sort((a, b) => (SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]) || ((a.line || 0) - (b.line || 0)));
  }

  // The number of errors and warnings in all editors.
  count(severity) {
    return GAME_FIELDS.reduce((n, key) => n + this.errors_of(key).filter((e) => e.severity === severity).length, 0);
  }

  // Draw the feedback of one editor.
  show(key) {
    const editor = this.editors[key];
    const session = editor.session;
    const errors = this.errors_of(key);
    const Range = ace.require('ace/range').Range;

    for (const id of this.markers[key]) session.removeMarker(id);
    this.markers[key] = [];
    session.setAnnotations(errors.filter((e) => e.line != null || e.severity === 'error').map((e) => ({
      row: Math.max(0, (e.line || 1) - 1),
      column: Math.max(0, (e.col || 1) - 1),
      text: e.message,
      type: e.severity,
    })));
    for (const e of errors) {
      if (e.line == null) continue;
      const range = new Range(e.line - 1, e.col - 1, (e.end_line || e.line) - 1, Math.max(e.col, (e.end_col || e.col + 1) - 1));
      this.markers[key].push(session.addMarker(range, 'feedback-marker feedback-' + e.severity, 'text', false));
    }

    const list = document.getElementById(key + '-problems');
    list.replaceChildren(...errors.map((e) => this.list_item(key, e, false)));
    editor.container.classList.toggle('has-errors', errors.some((e) => e.severity === 'error'));
    editor.container.classList.toggle('has-warnings', errors.some((e) => e.severity === 'warning'));
    this.update_markers();
  }

  list_item(key, e, with_program) {
    const item = document.createElement('li');
    item.className = 'severity-' + e.severity;
    const label = { error: 'Error', warning: 'Warning', info: 'Note' }[e.severity];
    const where = [with_program ? SOURCE_NAMES[key] : null, e.line != null ? `line ${e.line}` : null].filter(Boolean).join(', ');
    item.textContent = `${label}${where ? ' (' + where + ')' : ''}: ${e.message}`;
    item.title = 'Click to go to the program';
    item.addEventListener('click', () => this.go_to(key, e));
    return item;
  }

  // Show an editor (switching tabs if needed), at the line of a message.
  go_to(key, e) {
    const tab = document.getElementById(TAB_OF[key]);
    if (tab && !tab.checked) {
      tab.checked = true;
      tab.dispatchEvent(new Event('change'));
    }
    const editor = this.editors[key];
    editor.container.scrollIntoView({ block: 'center' });
    if (e.line != null) editor.gotoLine(e.line, e.col - 1, true);
    editor.focus();
  }

  // Mark the tabs, and list all errors and warnings in the Debug tab.
  update_markers() {
    const error_tabs = new Set();
    const warning_tabs = new Set();
    const items = [];
    for (const key of GAME_FIELDS) {
      for (const e of this.errors_of(key)) {
        if (e.severity === 'error') error_tabs.add(TAB_OF[key]);
        if (e.severity === 'warning') warning_tabs.add(TAB_OF[key]);
        if (e.severity !== 'info') items.push(this.list_item(key, e, true));
      }
    }
    for (const tab of new Set(Object.values(TAB_OF))) {
      const label = document.querySelector(`label[for="${tab}"]`);
      if (!label) continue;
      label.classList.toggle('has-errors', error_tabs.has(tab));
      label.classList.toggle('has-warnings', !error_tabs.has(tab) && warning_tabs.has(tab));
    }
    if (this.summary) {
      this.summary.replaceChildren(...items);
      this.summary.parentElement.hidden = items.length === 0;
    }
    if (this.notice) {
      const errors = this.count('error');
      const warnings = this.count('warning');
      const parts = [errors ? `${errors} error${errors > 1 ? 's' : ''}` : null, warnings ? `${warnings} warning${warnings > 1 ? 's' : ''}` : null].filter(Boolean);
      this.notice.textContent = parts.length ? `⚠ ${parts.join(', ')} in the programs` : '';
      this.notice.hidden = parts.length === 0;
      this.notice.classList.toggle('has-errors', errors > 0);
    }
  }
}

function signature(e) {
  return `${e.line}:${e.col}:${e.message}`;
}
