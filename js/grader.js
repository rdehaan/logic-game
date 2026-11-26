// The Grading tab (grader mode): load the submissions of students, test and
// measure their games, grade them with a rubric, and write feedback.
//
// The page (main.js) gives this tab an `app` with what it needs from the page:
// the solver, the editors, opening a game, the board, and downloads.
import { GAME_FIELDS, SOURCE_NAMES } from './engine.js';
import {
  DEFAULT_RUBRIC, read_rubric, rubric_items, compute_grade, format_number, measure_game, suggest_all,
  apply_suggestions, most_similar, fingerprint, similarity, win_counts, level_view, session_file, read_session,
  merge_students, grades_csv, new_student, PROGRAMS, PROGRAM_NAMES, STEP_PROGRAM_NAMES, LEVELS_KEPT, npcs,
} from './grading.js';
import { read_submissions } from './submissions.js';
import { feedback_model, feedback_markdown, feedback_html, feedback_pdf, feedback_name } from './feedback.js';
import { GradingStore } from './grading-store.js';
import { board_image, board_canvas } from './board-image.js';
import { make_zip } from './folder.js';
import { same_game } from './storage.js';

const $ = (id) => document.getElementById(id);
const SAVE_DELAY_MS = 300;
const STATUS_NAMES = { new: 'not started', 'in progress': 'in progress', done: 'done' };
const VERDICT_NAMES = { win: 'won', lose: 'lost', timeout: 'timed out', stopped: 'stopped (clingo took too long)', 'no level': 'no level generated', cancelled: 'cancelled' };

function el(tag, props = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') e.className = v;
    else if (k === 'text') e.textContent = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (k === 'dataset') Object.assign(e.dataset, v);
    else if (v !== false && v != null) e.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children) if (c != null) e.append(c);
  return e;
}

const percent = (x) => (x == null ? '–' : Math.round(x * 100) + '%');

export class GraderTab {
  constructor(app) {
    this.app = app;
    this.store = new GradingStore();
    this.rubric = read_rubric(DEFAULT_RUBRIC);
    this.students = [];
    this.current = null;          // the key of the student being graded
    this.measuring = false;
    this.measure_cancelled = false;
    this.save_timers = new Map();
    this.example_prints = null;   // [{ name, fingerprint }] of the example games
    this.pdf_url = null;
    this.pdf_shown = true;
    this.last_editor = 'player_move_program';
    this.ready = this.init();
  }

  async init() {
    await this.store.init();
    try {
      const { meta, students } = await this.store.load();
      if (meta && meta.rubric) this.rubric = read_rubric(meta.rubric);
      this.students = students.map((st) => ({ ...new_student(st), ...st }));
      this.sort();
      if (meta && meta.current && this.student(meta.current)) this.current = meta.current;
    } catch (e) {
      this.status('grading-load-status', 'The grading work in this browser could not be read: ' + e.message, true);
    }
    this.wire();
    this.render_list();
    this.render_rubric_summary();
    this.render_student();
  }

  // ---- Helpers ---------------------------------------------------------------------

  student(key = this.current) {
    return this.students.find((st) => st.key === key) || null;
  }

  sort() {
    this.students.sort((a, b) => a.name.localeCompare(b.name) || a.key.localeCompare(b.key));
  }

  status(id, text, is_error = false) {
    $(id).textContent = text;
    $(id).classList.toggle('error', is_error);
  }

  save_meta() {
    return this.store.save_meta({ rubric: this.rubric, current: this.current }).catch((e) => console.warn('grading:', e));
  }

  // A student changed: save it (soon), and show the change in the list.
  changed(st, { list = true } = {}) {
    st.updated_at = new Date().toISOString();
    if (st.status === 'new') {
      st.status = 'in progress';
      $('grading-status').value = st.status;
    }
    clearTimeout(this.save_timers.get(st.key));
    this.save_timers.set(st.key, setTimeout(() => this.save_now(st), SAVE_DELAY_MS));
    if (list) this.render_list();
  }

  save_now(st) {
    clearTimeout(this.save_timers.get(st.key));
    this.save_timers.delete(st.key);
    return this.store.save_student(st).catch((e) => this.status('grading-export-status', 'Your grading could not be saved in this browser: ' + e.message, true));
  }

  async flush() {
    for (const key of [...this.save_timers.keys()]) {
      const st = this.student(key);
      if (st) await this.save_now(st);
    }
  }

  // ---- Wiring ----------------------------------------------------------------------

  wire() {
    $('grading-input').addEventListener('change', (e) => this.load_files(e));
    $('grading-import').addEventListener('change', (e) => this.import_session(e));
    $('grading-rubric-input').addEventListener('change', (e) => this.load_rubric(e));
    $('grading-status').addEventListener('change', () => {
      const st = this.student();
      if (!st) return;
      st.status = $('grading-status').value;
      this.changed(st);
      if (st.status === 'new') this.render_list();
    });
    $('grading-comment').addEventListener('input', () => {
      const st = this.student();
      if (!st) return;
      st.comment = $('grading-comment').value;
      this.changed(st, { list: false });
    });
    $('grading-override').addEventListener('input', () => {
      const st = this.student();
      if (!st) return;
      const v = $('grading-override').value;
      st.grade_override = v === '' ? null : Number(v);
      this.changed(st);
      this.render_grade();
    });
    $('grading-include-tests').addEventListener('change', () => {
      const st = this.student();
      if (!st) return;
      st.include_tests = $('grading-include-tests').checked;
      this.changed(st, { list: false });
    });
    $('grading-pdf-select').addEventListener('change', () => this.show_pdf());
    $('grading-snippets').addEventListener('change', () => {
      this.rubric.snippets = $('grading-snippets').value.split('\n').map((x) => x.trim()).filter(Boolean);
      this.save_meta();
      this.render_snippets();
    });
    const select = $('grading-note-program');
    for (const field of [...PROGRAMS, 'level_state', 'level_settings']) select.append(el('option', { value: field, text: SOURCE_NAMES[field] }));
    select.value = 'player_move_program';
    for (const field of GAME_FIELDS) {
      const editor = this.app.editors.get(field);
      editor.on('focus', () => { this.last_editor = field; });
    }
    $('grading-students').addEventListener('click', (e) => {
      const button = e.target.closest('button[data-key]');
      if (button) this.open_student(button.dataset.key);
    });
  }

  actions() {
    return {
      grading_prev: () => this.step_student(-1),
      grading_next: () => this.step_student(1),
      grading_measure: () => this.measure(),
      grading_cancel: () => this.cancel_measure(),
      grading_accept: () => this.accept_suggestions(),
      grading_add_note: () => this.add_note(),
      grading_note_cursor: () => this.note_cursor(),
      grading_add_image: () => this.add_image(),
      grading_pdf_feedback: () => this.download_feedback('pdf'),
      grading_html_feedback: () => this.download_feedback('html'),
      grading_md_feedback: () => this.download_feedback('md'),
      grading_preview: () => this.preview(),
      grading_copy_md: () => this.copy_markdown(),
      grading_pdf_tab: () => this.pdf_in_tab(),
      grading_pdf_toggle: () => this.toggle_pdf(),
      grading_compare: () => this.compare_all(),
      grading_csv: () => this.download_csv(),
      grading_all_feedback: () => this.download_all_feedback(),
      grading_export: () => this.export_session(),
      grading_forget: () => this.forget_all(true),
      grading_download_rubric: () => this.app.download('rubric.json', JSON.stringify(this.rubric, null, 2)),
      grading_default_rubric: () => this.set_rubric(read_rubric(DEFAULT_RUBRIC), 'The default rubric is used.'),
    };
  }

  // The tab was opened.
  shown() {
    if (this.current) this.render_student();
  }

  // ---- Loading submissions ------------------------------------------------------------

  async load_files(event) {
    const files = [...event.target.files];
    event.target.value = '';
    if (!files.length) return;
    this.status('grading-load-status', 'Reading the submissions…');
    $('grading-notes').replaceChildren();
    try {
      const list = await Promise.all(files.map(async (f) => ({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) })));
      const { students, notes } = await read_submissions(list);
      let added = 0;
      let replaced = 0;
      for (const st of students) {
        const old = this.student(st.key);
        if (old) {
          // (loaded again: the submission is replaced, the grading is kept)
          Object.assign(old, { files: st.files, warnings: st.warnings, game: st.game, game_file: st.game_file, pdfs: st.pdfs, late: st.late, name: st.name });
          await this.store.forget_student(old.key);
          await this.store.save_student(old);
          replaced++;
        } else {
          this.students.push(st);
          await this.store.save_student(st);
          added++;
        }
        await this.store.save_pdfs(st.key, st.pdf_files || []);
      }
      this.sort();
      const n = students.length;
      this.status('grading-load-status', n ? `Loaded ${n} submission${n > 1 ? 's' : ''}` +
        (replaced ? ` (${added} new, ${replaced} loaded again: their grading is kept)` : '') + '.' : 'No submissions were found in these files.', !n);
      for (const note of notes) $('grading-notes').append(el('li', { text: note }));
      this.render_list();
      if (n === 1) await this.open_student(students[0].key);
    } catch (e) {
      this.status('grading-load-status', 'Loading failed: ' + e.message, true);
    }
  }

  // ---- The list of students -------------------------------------------------------------

  render_list() {
    const table = $('grading-students');
    const body = table.querySelector('tbody');
    body.replaceChildren();
    table.hidden = !this.students.length;
    $('grading-batch').hidden = !this.students.length;
    const done = this.students.filter((st) => st.status === 'done').length;
    $('grading-count').textContent = this.students.length ? `(${this.students.length} student${this.students.length > 1 ? 's' : ''}, ${done} done)` : '';
    for (const st of this.students) {
      const g = compute_grade(this.rubric, st.scores, st.grade_override);
      const row = el('tr', { class: st.key === this.current ? 'current' : '' },
        el('td', {}, st.name, st.late ? el('span', { class: 'grading-late', text: ' late' }) : null,
          !st.game ? el('span', { class: 'grading-late', text: ' no game' }) : null),
        el('td', { class: 'grading-status-' + st.status.replace(' ', '-'), text: STATUS_NAMES[st.status] || st.status }),
        el('td', { text: g.grade != null ? format_number(g.grade) : g.computed != null && !g.below_pass && Object.keys(st.scores).length ? `(${format_number(g.computed)})` : '' }),
        el('td', {}, el('button', { class: 'control-button', dataset: { key: st.key }, text: st.key === this.current ? 'Grading' : 'Grade' })));
      body.append(row);
    }
  }

  step_student(delta) {
    const i = this.students.findIndex((st) => st.key === this.current);
    const next = this.students[i + delta];
    if (next) this.open_student(next.key);
  }

  // Open a student: their game goes into the editors, their PDF next to the rubric.
  async open_student(key) {
    const st = this.student(key);
    if (!st) return;
    await this.flush();
    this.current = key;
    this.save_meta();
    this.render_list();
    this.render_student();
    if (st.game) {
      await this.app.open_game(st.game, 'grading:' + st.key, st.name);
    }
    this.render_game_line();
    $('grading-student').scrollIntoView({ block: 'start' });
  }

  // ---- One student ------------------------------------------------------------------------

  render_student() {
    const st = this.student();
    $('grading-student').hidden = !st;
    if (!st) return;
    const i = this.students.indexOf(st);
    $('grading-name').textContent = st.name + (st.canvas_id ? ` (${st.canvas_id})` : '') + (st.late ? ' — late' : '');
    $('grading-prev').disabled = i <= 0;
    $('grading-next').disabled = i >= this.students.length - 1;
    $('grading-status').value = st.status;
    $('grading-files').textContent = st.files.length ? 'Files: ' + st.files.map((f) => f.replace(/^.*\//, '')).join(', ') : '';
    $('grading-warnings').replaceChildren(...st.warnings.map((w) => el('li', { text: w })));
    $('grading-comment').value = st.comment;
    $('grading-override').value = st.grade_override ?? '';
    $('grading-include-tests').checked = st.include_tests;
    $('grading-levels').value = String(this.rubric.checks.test_levels);
    $('grading-rubric-title').textContent = this.rubric.title ? `(${this.rubric.title})` : '';
    // The PDF files
    const select = $('grading-pdf-select');
    select.replaceChildren(...st.pdfs.map((name) => el('option', { value: name, text: name.replace(/^.*\//, '') })));
    select.hidden = st.pdfs.length < 2;
    this.show_pdf();
    this.render_game_line();
    this.render_results();
    this.render_rubric();
    this.render_snippets();
    this.render_notes();
    this.render_images();
    this.status('grading-export-status', '');
  }

  // Whether the game in the editors is the one that was handed in.
  render_game_line() {
    const st = this.student();
    const line = $('grading-game-line');
    if (!st) return;
    const current = this.app.current();
    if (!st.game) {
      line.textContent = 'No game was found in this submission, so there is nothing to test.';
    } else if (!current || current.origin !== 'grading:' + st.key) {
      line.replaceChildren('The game of another student (or another game) is on the page. ',
        el('button', { class: 'link-button', text: 'Load the game of ' + st.name, onclick: () => this.open_student(st.key) }));
    } else if (!same_game(this.app.game(), st.game)) {
      line.replaceChildren('The game on the page is the game of this student, with your changes (what was handed in is kept). ',
        el('button', { class: 'link-button', text: 'Back to what was handed in', onclick: () => this.app.revert() }));
    } else {
      line.textContent = `The game on the page is the game of this student${st.game_file ? ` (${st.game_file.replace(/^.*\//, '')})` : ''}.`;
    }
  }

  async show_pdf() {
    const st = this.student();
    if (this.pdf_url) URL.revokeObjectURL(this.pdf_url);
    this.pdf_url = null;
    const frame = $('grading-pdf');
    const has = st && st.pdfs.length > 0;
    $('grading-no-pdf').hidden = has;
    $('grading-pdf-tab').hidden = !has;
    $('grading-pdf-toggle').hidden = !has;
    $('grading-pdf-pane').classList.toggle('collapsed', !has || !this.pdf_shown);
    $('grading-pdf-toggle').textContent = this.pdf_shown ? 'Hide the PDF' : 'Show the PDF';
    if (!has) {
      frame.removeAttribute('src');
      frame.hidden = true;
      return;
    }
    const name = $('grading-pdf-select').value || st.pdfs[0];
    const bytes = await this.store.pdf(st.key, name);
    if (this.student() !== st) return;
    if (!bytes) {
      frame.hidden = true;
      $('grading-no-pdf').hidden = false;
      $('grading-no-pdf').textContent = `The PDF file ${name.replace(/^.*\//, '')} is not in this browser (load the submissions again).`;
      return;
    }
    this.pdf_url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
    frame.hidden = !this.pdf_shown;
    frame.src = this.pdf_url;
  }

  pdf_in_tab() {
    if (this.pdf_url) window.open(this.pdf_url, '_blank');
  }

  toggle_pdf() {
    this.pdf_shown = !this.pdf_shown;
    this.show_pdf();
  }

  // ---- Measuring --------------------------------------------------------------------------

  async examples() {
    if (this.example_prints) return this.example_prints;
    const prints = [];
    for (const { name, path } of this.app.examples()) {
      try {
        const response = await fetch(path);
        if (response.ok) prints.push({ name, fingerprint: fingerprint(await response.json()) });
      } catch {
        // (offline: compared with fewer games)
      }
    }
    this.example_prints = prints;
    return prints;
  }

  // The games most similar to this student's: [{ name, overall, programs }].
  async similar_games(st, game) {
    const others = [...await this.examples(),
      ...this.students.filter((x) => x !== st && x.game).map((x) => ({ name: `${x.name} (a submission)`, game: x.game }))];
    return most_similar(game, others, 3);
  }

  async measure() {
    const st = this.student();
    if (!st || this.measuring) return;
    if (!st.game) {
      this.status('grading-progress', 'There is no game to test.');
      return;
    }
    if (this.app.busy()) await this.app.stop();
    const game = this.app.current() && this.app.current().origin === 'grading:' + st.key ? this.app.game() : st.game;
    const levels = Math.max(1, Math.min(500, Number($('grading-levels').value) || this.rubric.checks.test_levels));
    this.measuring = true;
    this.measure_cancelled = false;
    $('grading-measure').disabled = true;
    $('grading-cancel').hidden = false;
    const t0 = performance.now();
    try {
      const m = await measure_game(this.app.solver, game, {
        levels,
        cancelled: () => this.measure_cancelled,
        on_progress: ({ level }) => { $('grading-progress').textContent = `Level ${level} of ${levels}…`; },
      });
      st.measurements = m;
      st.measured_game = same_game(game, st.game) ? null : game;
      st.similar = await this.similar_games(st, game);
      st.suggestions = suggest_all(this.rubric, m, st.similar);
      this.changed(st);
      $('grading-progress').textContent = (m.cancelled ? `Cancelled after ${m.levels.length} levels` : 'Done') +
        ` (${((performance.now() - t0) / 1000).toFixed(1)} seconds).`;
    } catch (e) {
      $('grading-progress').textContent = 'Testing failed: ' + e.message;
    } finally {
      this.measuring = false;
      $('grading-measure').disabled = false;
      $('grading-cancel').hidden = true;
    }
    if (this.student() === st) {
      this.render_results();
      this.render_rubric();
    }
  }

  cancel_measure() {
    if (!this.measuring) return;
    this.measure_cancelled = true;
    this.app.solver.abort();
  }

  render_results() {
    const st = this.student();
    const box = $('grading-results');
    box.replaceChildren();
    const m = st && st.measurements;
    if (!m) return;
    if (st.measured_game) box.append(el('p', { class: 'versions-help', text: 'Measured with your changes to the game (not exactly what was handed in).' }));
    // Test results
    const counts = win_counts(m);
    const summary = Object.entries(counts).map(([v, n]) => `${n} ${VERDICT_NAMES[v] || v}`).join(', ');
    box.append(el('p', {}, el('b', { text: 'New levels: ' }), `${m.levels.length} played: ${summary}.`));
    const failed = m.levels.filter((l) => l.verdict !== 'win');
    if (failed.length) {
      const list = el('ul', { class: 'test-results' });
      for (const l of failed) {
        const li = el('li', {}, `Level ${l.seed}: ${l.message || VERDICT_NAMES[l.verdict] || l.verdict}` + (l.steps ? ` (after ${l.steps} steps)` : ''));
        if (l.verdict !== 'no level') li.append(' ', el('button', { class: 'control-button', text: 'Load this level', onclick: () => this.app.load_seeded_level(l.seed) }));
        list.append(li);
      }
      box.append(list);
    }
    // Timing
    const gen = m.generation_ms.length ? Math.max(...m.generation_ms) : 0;
    const mean = m.generation_ms.length ? m.generation_ms.reduce((a, b) => a + b, 0) / m.generation_ms.length : 0;
    const timing = el('table', { class: 'saved-games grading-timing' },
      el('thead', {}, el('tr', {}, el('th', { text: 'Time in clingo' }), el('th', { text: 'longest' }), el('th', { text: 'on average' }))));
    const tbody = el('tbody');
    const slow = (ms, limit) => (ms > limit * 1000 ? 'grading-slow' : '');
    tbody.append(el('tr', {}, el('td', { text: 'Level generation' }), el('td', { class: slow(gen, this.rubric.checks.generation_seconds), text: `${(gen / 1000).toFixed(2)} s` }), el('td', { text: `${(mean / 1000).toFixed(2)} s` })));
    for (const [p, x] of Object.entries(m.program_ms)) {
      tbody.append(el('tr', {}, el('td', { text: `${STEP_PROGRAM_NAMES[p] || p} (in one step)` }),
        el('td', { class: slow(x.max, this.rubric.checks.step_seconds), text: `${(x.max / 1000).toFixed(2)} s` }),
        el('td', { text: `${(x.total / Math.max(1, x.steps) / 1000).toFixed(2)} s` })));
    }
    const games = m.levels.filter((l) => l.ms != null);
    if (games.length) {
      const longest = Math.max(...games.map((l) => l.ms));
      tbody.append(el('tr', {}, el('td', { text: 'A whole game' }), el('td', { text: `${(longest / 1000).toFixed(1)} s` }),
        el('td', { text: `${(games.reduce((a, l) => a + l.ms, 0) / games.length / 1000).toFixed(1)} s` })));
    }
    timing.append(tbody);
    box.append(el('div', { class: 'table-wrapper' }, timing));
    // What the player does not see, what moves, the memory
    const hidden = Object.entries(m.hidden);
    box.append(el('p', {}, el('b', { text: 'Not seen by the player: ' }),
      hidden.length ? hidden.map(([o, n]) => `${o} (${n} of ${m.steps} steps)`).join(', ') : `nothing (in ${m.steps} steps)${m.fog ? '; some cells are fog' : ''}`,
      hidden.length ? el('span', { class: 'versions-help', text: ' — see them with "Show everything on the board" under the board' }) : null));
    const moved = Object.entries(m.moved);
    const npc = new Set(npcs(m, this.rubric.checks));
    box.append(el('p', {}, el('b', { text: 'Objects that moved: ' }),
      moved.length ? moved.map(([o, n]) => `${o}${npc.has(o) ? ' (NPC)' : ''} in ${n} steps`).join(', ') : 'none'));
    const sf = m.statics;
    box.append(el('p', {}, el('b', { text: 'Memory: ' }),
      sf.remembers ? `the strategy derives remember/1${sf.reads_memory ? ' and uses memory/1' : ', but does not use memory/1'}; the memory was not empty in ${m.memory_steps} of ${m.steps} steps` +
        (sf.wipes_memory ? '; nature wipes the memory' : '') : 'the strategy does not derive remember/1'));
    // Comments
    const comments = sf.comments;
    box.append(el('p', {}, el('b', { text: 'Comments (comment lines / code lines): ' }),
      PROGRAMS.filter((f) => comments[f].code_lines > 0).map((f) => `${PROGRAM_NAMES[f]} ${comments[f].comment_lines}/${comments[f].code_lines}`).join(', ')));
    // Similar games
    if (st.similar && st.similar.length) {
      const sim = el('table', { class: 'saved-games grading-similar' },
        el('thead', {}, el('tr', {}, el('th', { text: 'Most similar' }), el('th', { text: 'all' }),
          ...PROGRAMS.map((f) => el('th', { text: PROGRAM_NAMES[f] })))));
      const sb = el('tbody');
      for (const x of st.similar) {
        sb.append(el('tr', {}, el('td', { text: x.name }), el('td', { class: x.overall >= this.rubric.checks.similar ? 'grading-slow' : '', text: percent(x.overall) }),
          ...PROGRAMS.map((f) => el('td', { text: percent(x.programs[f]) }))));
      }
      sim.append(sb);
      box.append(el('div', { class: 'table-wrapper' }, sim),
        el('p', { class: 'versions-help', text: 'Similarity of the programs without comments, spaces and the names of variables: a hint, not a proof.' }));
    }
    // The first levels, small, to see whether they are random
    if (m.sample_levels.length) {
      const strip = el('div', { class: 'grading-levels' });
      box.append(el('p', {}, el('b', { text: `Different levels: ${m.distinct_levels} of ${m.levels.length}` }),
        m.sample_levels.length > 1 ? ` (the first ${Math.min(LEVELS_KEPT, m.sample_levels.length)} different ones; click one to load it)` : ''), strip);
      for (const lv of m.sample_levels) {
        const fig = el('button', { class: 'grading-level', title: `Load level ${lv.seed} onto the board`, onclick: () => this.app.load_seeded_level(lv.seed) });
        strip.append(fig);
        board_canvas(level_view(lv.level_state, lv.level_settings)).then((canvas) => {
          if (canvas) fig.append(canvas);
          fig.append(el('span', { text: `level ${lv.seed}` }));
        });
      }
    }
  }

  // ---- The rubric ---------------------------------------------------------------------------

  render_rubric() {
    const st = this.student();
    const box = $('grading-rubric');
    box.replaceChildren();
    if (!st) return;
    const sug = st.suggestions || (st.measurements ? suggest_all(this.rubric, st.measurements, st.similar) : {});
    $('grading-accept').disabled = !Object.values(sug).some((s) => s && s.value);
    const section = (title, items) => {
      box.append(el('p', { class: 'grading-section', text: title }));
      for (const item of items) box.append(this.item_row(st, item, sug[item.id]));
    };
    const items = rubric_items(this.rubric);
    section(`Required (together: grade ${format_number(this.rubric.required.grade)})`, items.filter((x) => x.required));
    if (this.rubric.extra.items.length) {
      section(`Extra points (up to ${format_number(this.rubric.extra.max)}` +
        (this.rubric.extra.all_grade != null ? `; all of them: ${format_number(this.rubric.extra.all_grade)}` : '') + ')', items.filter((x) => !x.required));
    }
    this.render_grade();
  }

  item_row(st, item, sug) {
    const score = st.scores[item.id] || { value: '', points: null, note: '' };
    const set = (patch) => {
      st.scores[item.id] = { ...(st.scores[item.id] || { value: '', points: null, note: '' }), ...patch, suggested: false };
      this.changed(st);
      this.render_grade();
    };
    const row = el('div', { class: 'grading-item' + (score.value ? ' decided' : ''), dataset: { item: item.id } });
    const select = el('select', { 'aria-label': item.label },
      el('option', { value: '', text: '—' }),
      el('option', { value: 'yes', text: item.required ? 'met' : 'yes' }),
      el('option', { value: 'no', text: item.required ? 'not met' : 'no' }));
    select.value = score.value || '';
    select.addEventListener('change', () => {
      set({ value: select.value });
      row.classList.toggle('decided', Boolean(select.value));
      row.classList.remove('from-suggestion');
    });
    row.append(el('div', { class: 'grading-item-head' }, select,
      el('span', { class: 'grading-item-label', text: item.label }),
      item.points != null ? el('span', { class: 'summary-note', text: ` (${format_number(item.points)})` }) : null));
    if (item.points != null) {
      const points = el('input', { type: 'number', min: 0, max: item.points, step: 0.25, class: 'grading-points', 'aria-label': 'Points for ' + item.label, placeholder: 'all', title: `Fewer points than all ${format_number(item.points)} (leave empty for all of them)` });
      points.value = score.points ?? '';
      points.addEventListener('input', () => set({ points: points.value === '' ? null : Number(points.value) }));
      const label = el('label', { class: 'inline-check grading-points-label' }, 'points: ', points);
      // (only for an item that gets points)
      const show = () => { label.hidden = select.value !== 'yes'; };
      select.addEventListener('change', show);
      show();
      row.querySelector('.grading-item-head').append(label);
    }
    if (score.suggested) row.classList.add('from-suggestion');
    if (sug && (sug.value || sug.evidence)) {
      const line = el('p', { class: 'grading-suggestion' });
      if (sug.value) line.append(el('b', { text: `Suggested: ${item.required ? (sug.value === 'yes' ? 'met' : 'not met') : sug.value}. ` }));
      line.append(sug.evidence || '');
      if (sug.value && sug.value !== score.value) {
        line.append(' ', el('button', { class: 'link-button', text: 'Take this', onclick: () => { select.value = sug.value; set({ value: sug.value }); this.render_rubric(); } }));
      }
      row.append(line);
    }
    const note = el('input', { type: 'text', class: 'grading-item-note', placeholder: 'Note for the student (optional)', 'aria-label': 'Note on ' + item.label });
    note.value = score.note || '';
    note.addEventListener('input', () => {
      st.scores[item.id] = { ...(st.scores[item.id] || { value: '', points: null }), note: note.value };
      this.changed(st, { list: false });
    });
    row.append(note);
    return row;
  }

  render_grade() {
    const st = this.student();
    if (!st) return;
    const g = compute_grade(this.rubric, st.scores, st.grade_override);
    $('grading-grade').textContent = g.text;
    $('grading-grade').classList.toggle('error', g.below_pass && (st.grade_override == null || st.grade_override === ''));
  }

  accept_suggestions() {
    const st = this.student();
    if (!st || !st.measurements) return;
    const sug = st.suggestions || suggest_all(this.rubric, st.measurements, st.similar);
    st.scores = apply_suggestions(this.rubric, st.scores, sug);
    this.changed(st);
    this.render_rubric();
  }

  // ---- Feedback: comments, notes, pictures ----------------------------------------------------

  render_snippets() {
    const list = $('grading-snippet-list');
    list.replaceChildren(...this.rubric.snippets.map((text) => el('button', {
      class: 'control-button grading-snippet', text, title: 'Insert into the comment',
      onclick: () => this.insert_snippet(text),
    })));
    if (document.activeElement !== $('grading-snippets')) $('grading-snippets').value = this.rubric.snippets.join('\n');
  }

  insert_snippet(text) {
    const area = $('grading-comment');
    const start = area.selectionStart ?? area.value.length;
    const end = area.selectionEnd ?? area.value.length;
    const before = area.value.slice(0, start);
    const sep = before && !before.endsWith('\n') ? '\n' : '';
    area.value = before + sep + text + area.value.slice(end);
    const pos = (before + sep + text).length;
    area.setSelectionRange(pos, pos);
    area.dispatchEvent(new Event('input'));
    area.focus();
  }

  note_cursor() {
    const field = this.last_editor;
    const editor = this.app.editors.get(field);
    $('grading-note-program').value = field;
    $('grading-note-line').value = String(editor.getCursorPosition().row + 1);
    $('grading-note-text').focus();
  }

  add_note() {
    const st = this.student();
    if (!st) return;
    const text = $('grading-note-text').value.trim();
    if (!text) {
      $('grading-note-text').focus();
      return;
    }
    const field = $('grading-note-program').value;
    const line = Math.max(1, Number($('grading-note-line').value) || 1);
    const source = (this.app.current() && this.app.current().origin === 'grading:' + st.key ? this.app.game() : st.game || {})[field] || '';
    st.line_notes.push({ field, line, text, quote: source.split('\n')[line - 1] ?? '' });
    st.line_notes.sort((a, b) => GAME_FIELDS.indexOf(a.field) - GAME_FIELDS.indexOf(b.field) || a.line - b.line);
    $('grading-note-text').value = '';
    this.changed(st, { list: false });
    this.render_notes();
  }

  render_notes() {
    const st = this.student();
    const list = $('grading-line-notes');
    list.replaceChildren();
    if (!st) return;
    st.line_notes.forEach((n, i) => {
      list.append(el('li', {},
        el('button', { class: 'link-button', text: `${SOURCE_NAMES[n.field]}, line ${n.line}`, title: 'Show this line', onclick: () => this.app.go_to(n.field, n.line) }),
        ': ', n.text, el('code', { class: 'grading-quote', text: n.quote }),
        el('button', { class: 'link-button', text: 'remove', onclick: () => { st.line_notes.splice(i, 1); this.changed(st, { list: false }); this.render_notes(); } })));
    });
  }

  add_image() {
    const st = this.student();
    if (!st) return;
    const facts = this.app.board_facts();
    if (!facts) {
      this.status('grading-export-status', 'There is no board to add.', true);
      return;
    }
    const caption = $('grading-image-caption').value.trim() || this.app.board_caption();
    st.images.push({ caption, facts });
    $('grading-image-caption').value = '';
    this.changed(st, { list: false });
    this.render_images();
  }

  render_images() {
    const st = this.student();
    const list = $('grading-images');
    list.replaceChildren();
    if (!st) return;
    st.images.forEach((img, i) => {
      const li = el('li', {});
      const caption = el('input', { type: 'text', 'aria-label': 'Caption', value: img.caption });
      caption.addEventListener('input', () => { img.caption = caption.value; this.changed(st, { list: false }); });
      li.append(caption, el('button', { class: 'link-button', text: 'remove', onclick: () => { st.images.splice(i, 1); this.changed(st, { list: false }); this.render_images(); } }));
      list.append(li);
      board_canvas(img.facts).then((canvas) => { if (canvas) li.prepend(canvas); });
    });
  }

  // ---- Feedback documents ---------------------------------------------------------------------

  async images(st) {
    const out = [];
    for (const img of st.images) out.push(await board_image(img.facts));
    return out;
  }

  async feedback_file(st, format) {
    const model = feedback_model(this.rubric, st);
    if (format === 'md') return { name: feedback_name(st) + '.md', data: feedback_markdown(model), type: 'text/markdown' };
    const images = await this.images(st);
    if (format === 'html') return { name: feedback_name(st) + '.html', data: feedback_html(model, images.map((x) => x || {})), type: 'text/html' };
    return { name: feedback_name(st) + '.pdf', data: feedback_pdf(model, images.map((x) => (x ? x.jpeg : null))), type: 'application/pdf' };
  }

  async download_feedback(format) {
    const st = this.student();
    if (!st) return;
    try {
      const f = await this.feedback_file(st, format);
      this.app.download(f.name, f.data, f.type);
      this.status('grading-export-status', `Downloaded ${f.name}.`);
    } catch (e) {
      this.status('grading-export-status', 'The feedback could not be made: ' + e.message, true);
    }
  }

  async preview() {
    const st = this.student();
    if (!st) return;
    const f = await this.feedback_file(st, 'html');
    const url = URL.createObjectURL(new Blob([f.data], { type: 'text/html' }));
    window.open(url, '_blank');
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }

  async copy_markdown() {
    const st = this.student();
    if (!st) return;
    const text = feedback_markdown(feedback_model(this.rubric, st));
    try {
      await navigator.clipboard.writeText(text);
      this.status('grading-export-status', 'The feedback is copied to the clipboard (as text).');
    } catch {
      this.status('grading-export-status', 'The clipboard could not be used: download the text instead.', true);
    }
  }

  // ---- All students ---------------------------------------------------------------------------

  compare_all() {
    const games = this.students.filter((st) => st.game);
    const prints = games.map((st) => ({ st, f: fingerprint(st.game) }));
    const pairs = [];
    for (let i = 0; i < prints.length; i++) {
      for (let j = i + 1; j < prints.length; j++) {
        const s = similarity(prints[i].f, prints[j].f);
        pairs.push({ a: prints[i].st, b: prints[j].st, ...s });
      }
    }
    pairs.sort((x, y) => y.overall - x.overall);
    const box = $('grading-pairs');
    box.replaceChildren();
    const shown = pairs.filter((p) => p.overall >= this.rubric.checks.different).slice(0, 20);
    if (!pairs.length) {
      box.append(el('p', { class: 'versions-help', text: 'There are fewer than two games to compare.' }));
      return;
    }
    box.append(el('p', { class: 'versions-help', text: shown.length
      ? `The most similar pairs of the ${games.length} games (${percent(this.rubric.checks.different)} or more; without comments, spaces and the names of variables):`
      : `No two of the ${games.length} games are ${percent(this.rubric.checks.different)} similar or more (the most similar: ${pairs[0].a.name} and ${pairs[0].b.name}, ${percent(pairs[0].overall)}).` }));
    if (!shown.length) return;
    const table = el('table', { class: 'saved-games grading-similar' },
      el('thead', {}, el('tr', {}, el('th', { text: 'Students' }), el('th', { text: 'all' }), ...PROGRAMS.map((f) => el('th', { text: PROGRAM_NAMES[f] })))));
    const body = el('tbody');
    for (const p of shown) {
      body.append(el('tr', {}, el('td', { text: `${p.a.name} – ${p.b.name}` }),
        el('td', { class: p.overall >= this.rubric.checks.similar ? 'grading-slow' : '', text: percent(p.overall) }),
        ...PROGRAMS.map((f) => el('td', { text: percent(p.programs[f]) }))));
    }
    table.append(body);
    box.append(el('div', { class: 'table-wrapper' }, table));
  }

  download_csv() {
    this.app.download('grades.csv', grades_csv(this.rubric, this.students), 'text/csv');
  }

  async download_all_feedback() {
    const formats = ['pdf', 'html', 'md'].filter((f) => $('grading-format-' + f).checked);
    if (!formats.length) {
      this.status('grading-batch-status', 'Choose at least one format.', true);
      return;
    }
    const files = {};
    let n = 0;
    try {
      for (const st of this.students) {
        this.status('grading-batch-status', `Making the feedback of ${st.name}…`);
        for (const format of formats) {
          const f = await this.feedback_file(st, format);
          files['feedback/' + f.name] = f.data;
        }
        n++;
      }
      files['feedback/grades.csv'] = grades_csv(this.rubric, this.students);
      this.app.download('feedback.zip', make_zip(files), 'application/zip');
      this.status('grading-batch-status', `Downloaded the feedback of ${n} student${n === 1 ? '' : 's'} (feedback.zip, with grades.csv).`);
    } catch (e) {
      this.status('grading-batch-status', 'The feedback could not be made: ' + e.message, true);
    }
  }

  async export_session() {
    await this.flush();
    const data = session_file({ rubric: this.rubric, students: this.students.map(({ pdf_files, ...st }) => st) });
    this.app.download(`grading-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(data, null, 1));
    this.status('grading-batch-status', 'Exported the grading (without the PDF files of the students).');
  }

  async import_session(event) {
    const file = event.target.files.item(0);
    event.target.value = '';
    if (!file) return;
    try {
      const { rubric, students } = read_session(await file.text());
      await this.flush();
      if (!this.students.length && rubric) this.rubric = rubric;
      const merged = merge_students(this.students, students);
      this.students = merged.students;
      this.sort();
      for (const st of this.students) await this.store.save_student(st);
      await this.save_meta();
      this.render_list();
      this.render_student();
      this.render_rubric_summary();
      this.status('grading-batch-status', `Imported ${file.name}: ${merged.added} student${merged.added === 1 ? '' : 's'} added, ` +
        `${merged.updated} updated (theirs was changed later), ${merged.kept} kept as they were` +
        (merged.measured ? `, ${merged.measured} with their test results added` : '') + '.' +
        (merged.added ? ' Their PDF files are not in a grading file: load the submissions to see them.' : ''));
    } catch (e) {
      this.status('grading-batch-status', 'Importing failed: ' + e.message, true);
    }
  }

  async forget_all(ask) {
    if (ask && !window.confirm('Remove all students, with all your grading of them, from this browser? (Export the grading first to keep it.)')) return;
    for (const t of this.save_timers.values()) clearTimeout(t);
    this.save_timers.clear();
    await this.store.clear();
    this.students = [];
    this.current = null;
    await this.save_meta();
    $('grading-pairs').replaceChildren();
    this.render_list();
    this.render_student();
    this.status('grading-batch-status', ask ? 'All students were removed.' : '');
  }

  // ---- The rubric file -------------------------------------------------------------------------

  async load_rubric(event) {
    const file = event.target.files.item(0);
    event.target.value = '';
    if (!file) return;
    try {
      this.set_rubric(read_rubric(await file.text()), `Loaded the rubric ${file.name}.`);
    } catch (e) {
      this.status('grading-rubric-status', 'The rubric could not be loaded: ' + e.message, true);
    }
  }

  set_rubric(rubric, message) {
    this.rubric = rubric;
    for (const st of this.students) if (st.measurements) st.suggestions = suggest_all(rubric, st.measurements, st.similar);
    this.save_meta();
    this.render_rubric_summary();
    this.render_list();
    this.render_student();
    this.status('grading-rubric-status', message);
  }

  render_rubric_summary() {
    const r = this.rubric;
    const box = $('grading-rubric-summary');
    box.replaceChildren(
      el('p', {}, el('b', { text: r.title || '(no title)' })),
      el('p', { text: `Required (together grade ${format_number(r.required.grade)}): ` + r.required.items.map((x) => x.label).join('; ') + '.' }),
      el('p', { text: `Extra (up to ${format_number(r.extra.max)}${r.extra.all_grade != null ? `, all: ${format_number(r.extra.all_grade)}` : ''}): ` +
        r.extra.items.map((x) => `${x.label} (${format_number(x.points)})`).join('; ') + '.' }),
    );
  }
}
