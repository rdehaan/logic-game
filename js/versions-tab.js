// The Versions tab: snapshots (also the automatic ones, see REASONS), comparing
// versions, project files and the backup of everything, and the list of all
// games with saved work in this browser. (Share links, plain game files and
// game folders on that tab are handled in main.js.)
//
// The page (main.js) passes in what this tab needs from it (`app`):
//   current()              -> { origin, title, original } of the game being edited (or null)
//   game()                 -> the game in the editors
//   replace(game, fields)  -> puts (some fields of) a game into the editors, and saves it
//   title_of(origin)       -> a title for a game without one
//   can_open(origin), open(origin)  -> open a game from the list
//   download(filename, text)
import { GAME_FIELDS, SOURCE_NAMES } from './engine.js';
import { same_game } from './storage.js';
import { diff_games, diff_hunks, best_test, project_file, backup_file, file_stem, storage_used, PROGRAM_FIELDS } from './versions.js';

export const AUTO_INTERVAL_MS = 10 * 60 * 1000;

const REASONS = {
  restore: 'before restoring an older version',
  take: 'before taking a program from another version',
  revert: 'before going back to the original',
  load: 'before loading a file',
  editing: 'while editing',
  tested: 'when testing the strategy',
  folder: 'before loading changes from the folder',
};

const $ = (id) => document.getElementById(id);

function el(tag, attrs = {}, ...children) {
  const elem = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') elem.className = v;
    else if (k === 'on') for (const [event, f] of Object.entries(v)) elem.addEventListener(event, f);
    else if (v != null && v !== false) elem.setAttribute(k, v === true ? '' : v);
  }
  elem.append(...children.filter((c) => c != null && c !== false));
  return elem;
}

function button(text, on_click, title = null) {
  return el('button', { class: 'control-button', type: 'button', title, on: { click: on_click } }, text);
}

function when(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return isNaN(d) ? '' : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

export function snapshot_label(s) {
  return s.name || (s.auto ? 'Automatic snapshot ' + (REASONS[s.reason] || s.reason || '') : 'Snapshot');
}

function test_badge(s) {
  const best = best_test(s);
  if (!best) return null;
  const runs = s.tests.length > 1 ? ` (best of ${s.tests.length} tests)` : '';
  return el('span', { class: 'snapshot-badge tested', title: `Tested on ${when(best.at)}${runs}` },
    `Test: ${best.won} of ${best.played} won`);
}

// A short description of the changes from game a to game b, e.g.
// "Player strategy +3 −1, Winning conditions +1".
function change_summary(a, b, fields = PROGRAM_FIELDS) {
  const parts = diff_games(a, b, fields).filter((d) => !d.same)
    .map((d) => `${SOURCE_NAMES[d.field]} ${d.added ? '+' + d.added : ''}${d.added && d.removed ? ' ' : ''}${d.removed ? '−' + d.removed : ''}`.trim());
  return parts.join(', ');
}

export class VersionsTab {
  constructor({ versions, work, storage, app }) {
    this.versions = versions;
    this.work = work;
    this.storage = storage;
    this.app = app;
    this.last_snapshot_time = Date.now();
    this.editing = null;      // id of the snapshot whose name and note are being edited
    this.dirty = true;
    $('show-auto').addEventListener('change', () => this.render_list());
    for (const id of ['diff-from', 'diff-to', 'diff-level']) $(id).addEventListener('change', () => this.render_diff());
    $('snapshot-name').addEventListener('keydown', (e) => { if (e.key === 'Enter') this.take_snapshot(); });
    // The sections that are opened stay open (in this browser)
    for (const details of document.querySelectorAll('details[data-remember]')) {
      const key = 'logic-game:open:' + details.dataset.remember;
      try {
        if (this.storage && this.storage.getItem(key) === 'true') details.open = true;
      } catch {
        // (closed)
      }
      details.addEventListener('toggle', () => {
        try {
          if (this.storage) this.storage.setItem(key, String(details.open));
        } catch {
          // (only for this visit)
        }
      });
    }
  }

  get visible() {
    return $('tab7').checked;
  }

  about() {
    const c = this.app.current();
    return c ? { title: c.title, original: c.original } : {};
  }

  // ---- Making snapshots -------------------------------------------------------------

  status(text, is_error = false) {
    $('snapshot-status').textContent = text;
    $('snapshot-status').classList.toggle('error', is_error);
  }

  storage_problem() {
    return this.versions.error === 'full'
      ? 'The browser’s storage is full: download the project file (or a backup), then delete snapshots you do not need.'
      : 'This browser does not allow saving snapshots (for example in a private window).';
  }

  take_snapshot() {
    const c = this.app.current();
    if (!c) return;
    const name = $('snapshot-name').value.trim();
    const note = $('snapshot-note').value.trim();
    const s = this.versions.add(c.origin, this.app.game(), { name, note }, this.about());
    if (!s) {
      this.status(this.storage_problem(), true);
      return;
    }
    this.last_snapshot_time = Date.now();
    $('snapshot-name').value = '';
    $('snapshot-note').value = '';
    this.status(`Kept: ${snapshot_label(s)}.`);
    this.refresh();
  }

  // Keep the current version before it is replaced (unless it is the original,
  // which can always be restored). Returns false if it could not be kept.
  auto_snapshot(reason) {
    const c = this.app.current();
    if (!c) return true;
    const game = this.app.game();
    if (same_game(game, c.original)) return true;
    const s = this.versions.add(c.origin, game, { auto: true, reason }, this.about());
    if (s) this.last_snapshot_time = Date.now();
    return Boolean(s);
  }

  // After the work was saved: every AUTO_INTERVAL_MS while editing, keep a snapshot.
  after_save() {
    const c = this.app.current();
    if (c && Date.now() - this.last_snapshot_time >= AUTO_INTERVAL_MS) {
      const game = this.app.game();
      const newest = this.versions.list(c.origin).at(-1);
      if (!same_game(game, newest ? newest.game : c.original, PROGRAM_FIELDS)) this.auto_snapshot('editing');
      this.last_snapshot_time = Date.now();
    }
    this.refresh();
  }

  // A (new) game was opened.
  opened() {
    this.last_snapshot_time = Date.now();
    this.editing = null;
    this.status('');
    this.refresh();
  }

  // Keep a test result with the version that was tested; returns the snapshot (or null).
  // (c: the game that was tested, as app.current() was when the test started)
  record_test(c, game, levels, counts) {
    if (!c) return null;
    const s = this.versions.add_test(c.origin, game, { levels, counts }, { title: c.title, original: c.original });
    if (s) this.refresh();
    return s;
  }

  async restore(s, fields = GAME_FIELDS) {
    const whole = fields.length === GAME_FIELDS.length;
    const what = whole ? `"${snapshot_label(s)}"` : `the ${SOURCE_NAMES[fields[0]]} of "${snapshot_label(s)}"`;
    if (!window.confirm(`Replace your current version with ${what}? (Your current version is kept as a snapshot first.)`)) return;
    if (!this.auto_snapshot(whole ? 'restore' : 'take') &&
        !window.confirm(`Your current version could not be kept as a snapshot. ${this.storage_problem()}\n\nReplace it anyway?`)) return;
    await this.app.replace(s.game, fields);
    this.status(whole ? `Restored: ${snapshot_label(s)}.` : `Took the ${SOURCE_NAMES[fields[0]]} of ${snapshot_label(s)}.`);
    this.refresh();
  }

  remove(s) {
    if (!window.confirm(`Delete the snapshot "${snapshot_label(s)}"?`)) return;
    this.versions.remove(this.app.current().origin, s.id);
    this.refresh();
  }

  compare(from_value, to_value = 'current') {
    this.render_selects();
    $('diff-from').value = from_value;
    $('diff-to').value = to_value;
    this.render_diff();
    $('compare-heading').closest('details').open = true;
    $('compare-heading').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  // ---- Showing ----------------------------------------------------------------------

  // Show the tab again (now if it is visible, else when it is opened).
  refresh() {
    if (!this.visible) {
      this.dirty = true;
      return;
    }
    this.dirty = false;
    const c = this.app.current();
    $('versions-title').textContent = c ? c.title : 'this game';
    $('snapshot-button').disabled = !c;
    this.render_list();
    this.render_selects();
    this.render_diff();
    this.render_reminder();
    this.render_overview();
  }

  shown() {
    if (this.dirty) this.refresh();
  }

  snapshots() {
    const c = this.app.current();
    return c ? this.versions.list(c.origin) : [];
  }

  render_list() {
    const list = $('snapshot-list');
    const c = this.app.current();
    if (!c) {
      list.replaceChildren();
      return;
    }
    const game = this.app.game();
    const all = this.snapshots();
    const named = all.filter((s) => !s.auto).length;
    $('snapshot-count').textContent = all.length ? `(${all.length}${named && named < all.length ? `, ${named} kept by you` : ''})` : '';
    const show_auto = $('show-auto').checked;
    const items = [];

    // The current version
    const newest = all.at(-1);
    const same_as = [...all].reverse().find((s) => same_game(s.game, game));
    let state;
    if (same_as) state = `The same as the snapshot "${snapshot_label(same_as)}".`;
    else if (newest) state = 'Changed since the newest snapshot: ' + (change_summary(newest.game, game, GAME_FIELDS) || 'no changes') + '.';
    else if (same_game(game, c.original)) state = 'The same as the original game.';
    else state = 'Changed from the original: ' + change_summary(c.original, game, GAME_FIELDS) + '.';
    items.push(el('li', { class: 'snapshot-item current' },
      el('div', { class: 'snapshot-head' }, el('span', { class: 'snapshot-name' }, 'Current version'),
        el('span', { class: 'snapshot-meta' }, state)),
      el('div', { class: 'snapshot-buttons' },
        newest ? button('Compare with the newest snapshot', () => this.compare(newest.id)) : null,
        button('Compare with the original', () => this.compare('original')))));

    // The snapshots, newest first
    let hidden = 0;
    for (let i = all.length - 1; i >= 0; i--) {
      const s = all[i];
      if (s.auto && !show_auto) {
        hidden++;
        continue;
      }
      items.push(this.snapshot_item(s, i > 0 ? all[i - 1].game : c.original, i > 0 ? 'the snapshot before' : 'the original', game));
    }
    if (!all.length) items.push(el('li', { class: 'versions-help' }, 'There are no snapshots of this game yet.'));
    if (hidden) items.push(el('li', { class: 'versions-help' }, `(${hidden} automatic snapshot${hidden > 1 ? 's are' : ' is'} not shown.)`));
    list.replaceChildren(...items);
  }

  snapshot_item(s, before, before_name, current_game) {
    const changes = change_summary(before, s.game);
    const is_current = same_game(s.game, current_game);
    const head = el('div', { class: 'snapshot-head' },
      el('span', { class: 'snapshot-name' }, snapshot_label(s)),
      el('span', { class: 'snapshot-meta' }, when(s.created_at)),
      is_current ? el('span', { class: 'snapshot-badge' }, '= current version') : null,
      test_badge(s));
    const meta = el('div', { class: 'snapshot-meta' },
      changes ? `Changes from ${before_name}: ${changes}` : `No changes to the programs from ${before_name}.`);
    const item = el('li', { class: 'snapshot-item' + (s.auto ? ' auto' : ''), 'data-id': s.id }, head, meta);
    if (this.editing === s.id) {
      const name = el('input', { type: 'text', maxlength: '100', 'aria-label': 'Name', placeholder: 'Name' });
      const note = el('textarea', { rows: '2', maxlength: '2000', 'aria-label': 'Note', placeholder: 'Note' });
      name.value = s.name;
      note.value = s.note;
      const save = () => {
        if (!this.versions.update(this.app.current().origin, s.id, { name: name.value.trim(), note: note.value.trim() })) {
          this.status(this.storage_problem(), true);
        }
        this.editing = null;
        this.render_list();
        this.render_selects();
      };
      item.append(el('div', { class: 'snapshot-form' }, name, note,
        el('div', { class: 'snapshot-buttons' }, button('Save', save), button('Cancel', () => { this.editing = null; this.render_list(); }))));
      setTimeout(() => name.focus(), 0);
      return item;
    }
    if (s.note) item.append(el('p', { class: 'snapshot-note' }, s.note));
    item.append(el('div', { class: 'snapshot-buttons' },
      button('Compare with current', () => this.compare(s.id)),
      button('Restore', () => this.restore(s), 'Replace the current version with this one (the current version is kept as a snapshot first)'),
      button(s.name || s.note ? 'Edit name and note' : 'Name and keep', () => { this.editing = s.id; this.render_list(); }),
      button('Delete', () => this.remove(s))));
    return item;
  }

  // The versions to compare: 'current', 'original', or the id of a snapshot.
  version(value) {
    const c = this.app.current();
    if (value === 'current') return { label: 'the current version', game: this.app.game() };
    if (value === 'original') return c ? { label: 'the original', game: c.original } : null;
    const s = this.snapshots().find((x) => x.id === value);
    return s ? { label: `"${snapshot_label(s)}"`, game: s.game, snapshot: s } : null;
  }

  render_selects() {
    const all = this.snapshots();
    const options = () => [
      el('option', { value: 'current' }, 'Current version'),
      el('option', { value: 'original' }, 'Original game'),
      ...[...all].reverse().map((s) => el('option', { value: s.id }, `${snapshot_label(s)} (${when(s.created_at)})`)),
    ];
    // By default: the newest snapshot that differs from the current version (or the
    // original) against the current version; again so when the snapshots change.
    const game = this.app.game();
    const differs = [...all].reverse().find((s) => !same_game(s.game, game));
    const defaults = { 'diff-from': differs ? differs.id : 'original', 'diff-to': 'current' };
    const key = all.map((s) => s.id).join();
    const reset = key !== this.snapshot_key;
    this.snapshot_key = key;
    for (const id of ['diff-from', 'diff-to']) {
      const select = $(id);
      const before = select.value;
      select.replaceChildren(...options());
      select.value = !reset && before && this.version(before) ? before : defaults[id];
    }
  }

  render_diff() {
    const out = $('diff-output');
    const from = this.version($('diff-from').value);
    const to = this.version($('diff-to').value);
    if (!from || !to) {
      out.replaceChildren();
      return;
    }
    const fields = $('diff-level').checked ? GAME_FIELDS : PROGRAM_FIELDS;
    const diffs = diff_games(from.game, to.game, fields);
    const changed = diffs.filter((d) => !d.same);
    const unchanged = diffs.filter((d) => d.same).map((d) => SOURCE_NAMES[d.field]);
    // Taking a program from the other version is possible when one of them is the current version
    const from_value = $('diff-from').value;
    const to_value = $('diff-to').value;
    const other = to_value === 'current' && from_value !== 'current' ? from
      : from_value === 'current' && to_value !== 'current' ? to : null;
    const parts = [];
    if (!changed.length) {
      parts.push(el('p', {}, from_value === to_value ? 'Choose two different versions to compare.' : `There are no differences${fields === PROGRAM_FIELDS ? ' in the programs' : ''}.`));
    } else {
      parts.push(el('p', { class: 'versions-help' }, `Lines only in ${from.label} are red (−), lines only in ${to.label} are green (+).`));
    }
    for (const d of changed) {
      const take = other ? button(`Use the ${SOURCE_NAMES[d.field]} of ${other.label}`, () => this.take(other, d.field)) : null;
      parts.push(el('div', { class: 'diff-program', 'data-field': d.field },
        el('h4', {}, SOURCE_NAMES[d.field],
          el('span', { class: 'diff-counts' },
            d.added ? el('span', { class: 'plus' }, `+${d.added} `) : null,
            d.removed ? el('span', { class: 'minus' }, `−${d.removed}`) : null),
          take),
        render_lines(d.lines)));
    }
    if (changed.length && unchanged.length) parts.push(el('p', { class: 'diff-unchanged' }, 'No changes: ' + unchanged.join(', ') + '.'));
    out.replaceChildren(...parts);
  }

  async take(version, field) {
    if (version.snapshot) return this.restore(version.snapshot, [field]);
    // (the original)
    await this.restore({ name: 'the original game', game: version.game }, [field]);
  }

  // ---- Files and the list of games ------------------------------------------------------

  project(origin) {
    const c = this.app.current();
    const saved = this.work.load(origin);
    const record = this.versions.record(origin);
    const is_current = c && c.origin === origin;
    const original = (is_current ? c.original : null) || (saved && saved.original) || record.original;
    const game = is_current ? this.app.game() : saved ? saved.game : original || (record.snapshots.at(-1) || {}).game;
    return {
      origin,
      title: (is_current ? c.title : null) || (saved && saved.title) || record.title || this.app.title_of(origin),
      original,
      game,
      saved_at: saved ? saved.saved_at : null,
      snapshots: record.snapshots,
    };
  }

  download_project(origin = null) {
    const c = this.app.current();
    origin = origin || (c && c.origin);
    if (!origin) return;
    const p = this.project(origin);
    if (!p.game) return;
    const date = new Date().toISOString().slice(0, 10);
    this.app.download(`${file_stem(p.title)}-project-${date}.json`, JSON.stringify(project_file(p), null, 1));
    this.versions.mark_downloaded(origin, p.game, { title: p.title, original: p.original });
    this.refresh();
  }

  all_origins() {
    return [...new Set([...this.work.origins(), ...this.versions.origins()])].sort();
  }

  download_backup() {
    const projects = this.all_origins().map((o) => this.project(o)).filter((p) => p.game);
    const date = new Date().toISOString().slice(0, 10);
    this.app.download(`logic-game-backup-${date}.json`, JSON.stringify(backup_file(projects), null, 1));
    for (const p of projects) this.versions.mark_downloaded(p.origin, p.game, { title: p.title, original: p.original });
    this.refresh();
  }

  // Under the button to download the game file (what players hand in):
  // whether the current version was downloaded.
  render_game_reminder() {
    const elem = $('game-reminder');
    const c = this.app.current();
    elem.classList.remove('attention');
    if (!c) {
      elem.textContent = '';
      return;
    }
    const record = this.versions.record(c.origin);
    const game = this.app.game();
    if (!record.game_downloaded_at) {
      elem.textContent = same_game(game, c.original) ? '' : `You have not downloaded the game file of ${c.title} yet.`;
      return;
    }
    if (record.game_downloaded && same_game(game, record.game_downloaded)) {
      elem.textContent = `You downloaded the game file on ${when(record.game_downloaded_at)}: that is your current version.`;
      return;
    }
    elem.textContent = `You changed ${c.title} since you downloaded the game file on ${when(record.game_downloaded_at)}: ` +
      'download it again to hand in your current version.';
    elem.classList.add('attention');
  }

  render_reminder() {
    this.render_game_reminder();
    const elem = $('download-reminder');
    const c = this.app.current();
    if (!c) {
      elem.textContent = '';
      return;
    }
    const record = this.versions.record(c.origin);
    const game = this.app.game();
    if (!record.downloaded_at) {
      const work_done = record.snapshots.length || !same_game(game, c.original);
      elem.textContent = work_done ? `You have not downloaded the project file of ${c.title} yet.` : '';
      return;
    }
    const changed = !record.downloaded_game || !same_game(game, record.downloaded_game) ||
      record.snapshots.some((s) => s.created_at > record.downloaded_at);
    elem.textContent = `You last downloaded the project file of ${c.title} on ${when(record.downloaded_at)}` +
      (changed ? '; there are changes since then.' : '; nothing has changed since then.');
  }

  render_overview() {
    const c = this.app.current();
    const origins = this.all_origins();
    const rows = origins.map((origin) => {
      const p = this.project(origin);
      const n = p.snapshots.length;
      return el('tr', { class: c && c.origin === origin ? 'current' : null },
        el('td', {}, p.title + (c && c.origin === origin ? ' (open now)' : '')),
        el('td', {}, p.saved_at ? when(p.saved_at) : 'the same as the original'),
        el('td', {}, String(n)),
        el('td', { class: 'buttons' },
          c && c.origin === origin ? null
            : this.app.can_open(origin, p) ? button('Open', () => this.app.open(origin, p)) : null, ' ',
          p.game ? button('Download', () => this.download_project(origin), 'Download the project file of this game') : null, ' ',
          button('Forget', () => this.forget(origin, p.title))));
    });
    $('saved-games').hidden = rows.length === 0;
    $('saved-games').querySelector('tbody').replaceChildren(...rows);
    $('saved-work-status').textContent = !this.storage ? 'This browser does not allow saving work.'
      : rows.length === 0 ? 'There is no saved work.' : `There is saved work for ${rows.length} game${rows.length > 1 ? 's' : ''}.`;
    $('forget-button').disabled = rows.length === 0;
    $('backup-button').disabled = rows.length === 0;
    const used = storage_used(this.storage);
    $('storage-used').textContent = !used ? '' : `This uses ${used < 1e4 ? 'less than 0.01' : 'about ' + (used / 1e6).toFixed(used < 1e5 ? 2 : 1)} MB of the browser's storage (browsers allow about 5 MB).`;
  }

  forget(origin, title) {
    if (!window.confirm(`Forget your work on ${title} in this browser, with all its snapshots? (Download the project file first to keep it.)`)) return;
    this.work.forget(origin);
    this.versions.forget(origin);
    this.app.forgot(origin);
    this.refresh();
  }
}

// The lines of a diff: the changed parts, with a few lines around them.
function render_lines(lines) {
  const pre = el('pre', { class: 'diff' });
  const { hunks, skipped_after } = diff_hunks(lines, 3);
  const skip = (n) => el('span', { class: 'diff-skip' }, `⋯ ${n} unchanged line${n > 1 ? 's' : ''}`);
  for (const hunk of hunks) {
    if (hunk.skipped_before) pre.append(skip(hunk.skipped_before));
    for (const l of hunk.lines) {
      const mark = l.op === 'add' ? '+ ' : l.op === 'del' ? '− ' : '  ';
      pre.append(el('span', { class: 'diff-' + l.op },
        el('span', { class: 'line-no' }, l.a ?? ''), el('span', { class: 'line-no' }, l.b ?? ''),
        mark + l.text));
    }
  }
  if (skipped_after) pre.append(skip(skipped_after));
  return pre;
}
