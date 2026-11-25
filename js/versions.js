// Versions of a game: snapshots, the differences between two versions, and
// project files.
//
// - Snapshots: copies of the game that a student keeps (with a name and a
//   note), or that the page keeps automatically (before restoring an older
//   version, while editing, when a strategy is tested, ...). They are kept in
//   the browser (localStorage), per game, next to the saved work (storage.js).
//   Automatic snapshots are limited to the newest MAX_AUTO per game; naming
//   one, or writing a note for it, keeps it for good.
// - Test results: when a strategy is tested, the result is kept with the
//   snapshot of that version (one is made if there is none yet).
// - Differences: line by line (Myers' algorithm), for each program.
// - Project files: the current version, the original game and all snapshots
//   in one JSON file, to keep anywhere (e.g. in a Google Drive folder) and
//   load again on another computer. A backup file holds all games of this
//   browser.
//
// This module does not use the DOM, so the tests can run it in Node.
import { GAME_FIELDS, normalize_game } from './engine.js';
import { compact, same_game } from './storage.js';

const PREFIX = 'logic-game:versions:';
export const MAX_AUTO = 20;
export const LEVEL_FIELDS = ['level_state', 'level_settings'];
export const PROGRAM_FIELDS = GAME_FIELDS.filter((f) => !LEVEL_FIELDS.includes(f));

export const PROJECT_FORMAT = 'logic-game-project';
export const BACKUP_FORMAT = 'logic-game-backup';
const FILE_VERSION = 1;

// ---- Differences ------------------------------------------------------------------

function split_lines(text) {
  if (!text) return [];
  return text.replace(/\r\n?/g, '\n').split('\n');
}

// The shortest edit script from a to b (arrays of lines), as a list of
// 'same', 'del' (a line of a only) and 'add' (a line of b only).
function myers(a, b) {
  const n = a.length;
  const m = b.length;
  if (n === 0) return b.map(() => 'add');
  if (m === 0) return a.map(() => 'del');
  // v[k] is the furthest x on diagonal k (k = x - y); trace[d] is v before round d,
  // for the diagonals -d-1..d+1 only (that is all that round d looks at).
  const max = n + m;
  const offset = max + 1;
  const v = new Int32Array(2 * max + 3);
  const trace = [];
  let found = -1;
  for (let d = 0; d <= max && found < 0; d++) {
    trace.push(v.slice(offset - d - 1, offset + d + 2));
    for (let k = -d; k <= d; k += 2) {
      let x = (k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])) ? v[offset + k + 1] : v[offset + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) { x++; y++; }
      v[offset + k] = x;
      if (x >= n && y >= m) { found = d; break; }
    }
  }
  // Walk back from (n, m)
  const ops = [];
  let x = n;
  let y = m;
  for (let d = found; d > 0; d--) {
    const prev = trace[d];
    const at = (k) => prev[k + d + 1];
    const k = x - y;
    const prev_k = (k === -d || (k !== d && at(k - 1) < at(k + 1))) ? k + 1 : k - 1;
    const prev_x = at(prev_k);
    const prev_y = prev_x - prev_k;
    while (x > prev_x && y > prev_y) { ops.push('same'); x--; y--; }
    ops.push(x === prev_x ? 'add' : 'del');
    x = prev_x;
    y = prev_y;
  }
  while (x > 0 && y > 0) { ops.push('same'); x--; y--; }
  return ops.reverse();
}

// The lines of two texts, as [{ op: 'same' | 'del' | 'add', text, a, b }],
// where a and b are the line numbers (from 1) in the two texts (null for
// a line that is not in that text).
export function diff_lines(a_text, b_text) {
  const a = split_lines(a_text);
  const b = split_lines(b_text);
  // (the same lines at the start and at the end are not passed to myers)
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let end_a = a.length;
  let end_b = b.length;
  while (end_a > start && end_b > start && a[end_a - 1] === b[end_b - 1]) { end_a--; end_b--; }
  const script = [
    ...Array(start).fill('same'),
    ...myers(a.slice(start, end_a), b.slice(start, end_b)),
    ...Array(a.length - end_a).fill('same'),
  ];
  const out = [];
  let i = 0;
  let j = 0;
  for (const op of script) {
    if (op === 'same') out.push({ op, text: a[i], a: ++i, b: ++j });
    else if (op === 'del') out.push({ op, text: a[i], a: ++i, b: null });
    else out.push({ op, text: b[j], a: null, b: ++j });
  }
  return out;
}

// The changed parts of a diff, each with up to `context` unchanged lines
// around it: [{ lines, skipped_before }], and the number of unchanged lines
// after the last part (skipped_after).
export function diff_hunks(lines, context = 3) {
  const changed = lines.map((l) => l.op !== 'same');
  const keep = lines.map((_, i) => {
    for (let j = Math.max(0, i - context); j <= Math.min(lines.length - 1, i + context); j++) if (changed[j]) return true;
    return false;
  });
  const hunks = [];
  let skipped = 0;
  let hunk = null;
  for (let i = 0; i < lines.length; i++) {
    if (!keep[i]) {
      hunk = null;
      skipped++;
      continue;
    }
    if (!hunk) {
      hunk = { lines: [], skipped_before: skipped };
      hunks.push(hunk);
      skipped = 0;
    }
    hunk.lines.push(lines[i]);
  }
  return { hunks, skipped_after: skipped };
}

// The differences between two games, for each field:
// [{ field, same, lines, added, removed }].
export function diff_games(a, b, fields = GAME_FIELDS) {
  return fields.map((field) => {
    const same = (a[field] || '') === (b[field] || '');
    const lines = same ? [] : diff_lines(a[field] || '', b[field] || '');
    return {
      field,
      same,
      lines,
      added: lines.filter((l) => l.op === 'add').length,
      removed: lines.filter((l) => l.op === 'del').length,
    };
  });
}

// ---- Snapshots ----------------------------------------------------------------------

function new_id() {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return Date.now().toString(36) + '-' + [...bytes].map((x) => x.toString(16).padStart(2, '0')).join('');
}

function clean_test(t) {
  if (!t || typeof t !== 'object' || !t.counts || typeof t.counts !== 'object') return null;
  const counts = {};
  for (const [k, n] of Object.entries(t.counts)) if (Number.isFinite(n) && n > 0) counts[k] = n;
  return { at: String(t.at || ''), levels: Number(t.levels) || Object.values(counts).reduce((x, y) => x + y, 0), counts };
}

// A snapshot read from storage or from a file (or null if it is not one).
function clean_snapshot(s) {
  if (!s || typeof s !== 'object' || !s.game || typeof s.game !== 'object') return null;
  if (!GAME_FIELDS.some((f) => typeof s.game[f] === 'string')) return null;
  return {
    id: typeof s.id === 'string' && s.id ? s.id : new_id(),
    created_at: typeof s.created_at === 'string' ? s.created_at : new Date(0).toISOString(),
    name: typeof s.name === 'string' ? s.name : '',
    note: typeof s.note === 'string' ? s.note : '',
    auto: Boolean(s.auto),
    reason: typeof s.reason === 'string' ? s.reason : '',
    game: normalize_game(s.game),
    tests: Array.isArray(s.tests) ? s.tests.map(clean_test).filter(Boolean) : [],
  };
}

function stored_snapshot(s) {
  const out = { ...s, game: compact(s.game) };
  if (!out.tests.length) delete out.tests;
  return out;
}

// The share of wins in the test results of a snapshot (or null).
export function best_test(snapshot) {
  let best = null;
  for (const t of snapshot.tests || []) {
    const n = Object.values(t.counts).reduce((x, y) => x + y, 0);
    if (n > 0 && (!best || (t.counts.win || 0) / n > best.rate)) best = { ...t, won: t.counts.win || 0, played: n, rate: (t.counts.win || 0) / n };
  }
  return best;
}

// Snapshots in a storage such as window.localStorage. For each game (named by
// its origin, as in storage.js) the record is
//   { title, original, downloaded_at, downloaded_game, game_downloaded_at,
//     game_downloaded, snapshots: [oldest first] }
// (downloaded_*: the last download of the project file; game_downloaded*: of
// the game file, which is what players hand in).
// Changes return the changed snapshot, or null when the storage cannot be used
// (blocked, or full: see `error`).
export class VersionStore {
  constructor(storage, now = () => new Date()) {
    this.storage = storage;
    this.now = now;
    this.error = null;
  }

  // The record of a game (an empty one if there is none).
  record(origin) {
    try {
      const raw = JSON.parse(this.storage.getItem(PREFIX + origin));
      if (raw && typeof raw === 'object') {
        return {
          title: typeof raw.title === 'string' ? raw.title : null,
          original: raw.original ? normalize_game(raw.original) : null,
          downloaded_at: typeof raw.downloaded_at === 'string' ? raw.downloaded_at : null,
          downloaded_game: raw.downloaded_game ? normalize_game(raw.downloaded_game) : null,
          game_downloaded_at: typeof raw.game_downloaded_at === 'string' ? raw.game_downloaded_at : null,
          game_downloaded: raw.game_downloaded ? normalize_game(raw.game_downloaded) : null,
          snapshots: Array.isArray(raw.snapshots) ? raw.snapshots.map(clean_snapshot).filter(Boolean) : [],
        };
      }
    } catch {
      // nothing stored, or not readable: an empty record
    }
    return { title: null, original: null, downloaded_at: null, downloaded_game: null, game_downloaded_at: null, game_downloaded: null, snapshots: [] };
  }

  write(origin, record) {
    this.error = null;
    try {
      if (!record.snapshots.length && !record.downloaded_at && !record.game_downloaded_at) {
        this.storage.removeItem(PREFIX + origin);
        return true;
      }
      const out = { snapshots: record.snapshots.map(stored_snapshot) };
      if (record.title) out.title = record.title;
      if (record.original) out.original = compact(record.original);
      if (record.downloaded_at) {
        out.downloaded_at = record.downloaded_at;
        if (record.downloaded_game) out.downloaded_game = compact(record.downloaded_game);
      }
      if (record.game_downloaded_at) {
        out.game_downloaded_at = record.game_downloaded_at;
        if (record.game_downloaded) out.game_downloaded = compact(record.game_downloaded);
      }
      this.storage.setItem(PREFIX + origin, JSON.stringify(out));
      return true;
    } catch (e) {
      this.error = this.storage ? (/quota/i.test(e.name + e.message) ? 'full' : 'blocked') : 'blocked';
      return false;
    }
  }

  // The snapshots of a game, oldest first.
  list(origin) {
    return this.record(origin).snapshots;
  }

  get(origin, id) {
    return this.list(origin).find((s) => s.id === id) || null;
  }

  // Keep a snapshot of a game. `about` is { title, original } of the game.
  // An automatic snapshot (auto: true) is not made when the programs and the
  // level are the same as in the newest snapshot; then that one is returned.
  add(origin, game, { name = '', note = '', auto = false, reason = '', tests = [] } = {}, about = {}) {
    const record = this.record(origin);
    const newest = record.snapshots.at(-1);
    if (auto && newest && same_game(newest.game, game)) return newest;
    const snapshot = {
      id: new_id(),
      created_at: this.now().toISOString(),
      name,
      note,
      auto: auto && !name && !note,
      reason,
      game: normalize_game(game),
      tests,
    };
    record.snapshots.push(snapshot);
    prune(record);
    if (about.title) record.title = about.title;
    if (about.original) record.original = normalize_game(about.original);
    return this.write(origin, record) ? snapshot : null;
  }

  // Change the name or note of a snapshot; one with a name or a note is kept for good.
  update(origin, id, { name, note }) {
    const record = this.record(origin);
    const snapshot = record.snapshots.find((s) => s.id === id);
    if (!snapshot) return null;
    if (name != null) snapshot.name = name;
    if (note != null) snapshot.note = note;
    if (snapshot.name || snapshot.note) snapshot.auto = false;
    return this.write(origin, record) ? snapshot : null;
  }

  remove(origin, id) {
    const record = this.record(origin);
    record.snapshots = record.snapshots.filter((s) => s.id !== id);
    return this.write(origin, record);
  }

  // Keep the result of testing a strategy with the version it was tested on:
  // the newest snapshot with the same programs (the level does not matter for
  // a test), or else a new automatic one.
  add_test(origin, game, result, about = {}) {
    const test = clean_test({ ...result, at: this.now().toISOString() });
    if (!test) return null;
    const record = this.record(origin);
    const snapshot = [...record.snapshots].reverse().find((s) => same_game(s.game, game, PROGRAM_FIELDS));
    if (!snapshot) return this.add(origin, game, { auto: true, reason: 'tested', tests: [test] }, about);
    snapshot.tests.push(test);
    return this.write(origin, record) ? snapshot : null;
  }

  // Remember that the project was downloaded (with this version of the game).
  mark_downloaded(origin, game, about = {}) {
    const record = this.record(origin);
    record.downloaded_at = this.now().toISOString();
    record.downloaded_game = normalize_game(game);
    if (about.title) record.title = about.title;
    if (about.original) record.original = normalize_game(about.original);
    return this.write(origin, record);
  }

  // Remember that the game file was downloaded (this version of the game).
  mark_game_downloaded(origin, game, about = {}) {
    const record = this.record(origin);
    record.game_downloaded_at = this.now().toISOString();
    record.game_downloaded = normalize_game(game);
    if (about.title) record.title = about.title;
    if (about.original) record.original = normalize_game(about.original);
    return this.write(origin, record);
  }

  // Add snapshots (from a project file); the ones that are already there (the same id) are skipped.
  // Returns the number of snapshots added, or null if they could not be stored.
  merge(origin, snapshots, about = {}) {
    const record = this.record(origin);
    const ids = new Set(record.snapshots.map((s) => s.id));
    const added = snapshots.map(clean_snapshot).filter((s) => s && !ids.has(s.id));
    record.snapshots = [...record.snapshots, ...added].sort((x, y) => x.created_at.localeCompare(y.created_at));
    if (about.title && !record.title) record.title = about.title;
    if (about.original && !record.original) record.original = normalize_game(about.original);
    return this.write(origin, record) ? added.length : null;
  }

  forget(origin) {
    try {
      this.storage.removeItem(PREFIX + origin);
    } catch {
      // nothing to do
    }
  }

  // The names of all games with snapshots.
  origins() {
    try {
      const out = [];
      for (let i = 0; i < this.storage.length; i++) {
        const key = this.storage.key(i);
        if (key && key.startsWith(PREFIX)) out.push(key.slice(PREFIX.length));
      }
      return out.sort();
    } catch {
      return [];
    }
  }

  forget_all() {
    for (const origin of this.origins()) this.forget(origin);
  }
}

// Only the newest MAX_AUTO automatic snapshots are kept.
function prune(record) {
  let autos = record.snapshots.filter((s) => s.auto).length;
  record.snapshots = record.snapshots.filter((s) => !(s.auto && autos-- > MAX_AUTO));
}

// About how many bytes the page uses in a storage (localStorage keeps text as UTF-16).
export function storage_used(storage) {
  try {
    let n = 0;
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i);
      if (key && key.startsWith('logic-game:')) n += 2 * (key.length + (storage.getItem(key) || '').length);
    }
    return n;
  } catch {
    return 0;
  }
}

// ---- Project files ------------------------------------------------------------------

// A project: { origin, title, original, game, snapshots, saved_at }.
export function project_file(project, now = new Date()) {
  return {
    format: PROJECT_FORMAT,
    format_version: FILE_VERSION,
    exported_at: now.toISOString(),
    origin: project.origin,
    title: project.title,
    saved_at: project.saved_at || null,
    game: compact(project.game),
    original: project.original ? compact(project.original) : null,
    snapshots: (project.snapshots || []).map(stored_snapshot),
  };
}

export function backup_file(projects, now = new Date()) {
  return {
    format: BACKUP_FORMAT,
    format_version: FILE_VERSION,
    exported_at: now.toISOString(),
    projects: projects.map((p) => project_file(p, now)),
  };
}

function read_project(p, filename) {
  if (!p || typeof p !== 'object' || !p.game || typeof p.game !== 'object') throw new Error('a project in the file has no game');
  const origin = typeof p.origin === 'string' && /^[a-z]+:./.test(p.origin) ? p.origin : 'file:' + filename;
  return {
    origin,
    title: typeof p.title === 'string' && p.title ? p.title : filename,
    saved_at: typeof p.saved_at === 'string' ? p.saved_at : null,
    game: normalize_game(p.game),
    original: p.original && typeof p.original === 'object' ? normalize_game(p.original) : null,
    snapshots: Array.isArray(p.snapshots) ? p.snapshots.map(clean_snapshot).filter(Boolean) : [],
  };
}

// What is in a file that was uploaded:
//   { kind: 'game', game } (a game, as in the examples),
//   { kind: 'project', project }, or { kind: 'backup', projects }.
// Throws if it is none of these.
export function read_file(text, filename = 'file') {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('this is not a game or project file (it is not JSON)');
  }
  if (!data || typeof data !== 'object') throw new Error('this is not a game or project file');
  if (data.format === PROJECT_FORMAT || data.format === BACKUP_FORMAT) {
    if (Number(data.format_version) > FILE_VERSION) throw new Error('this file was made by a newer version of the page: reload the page');
  }
  if (data.format === PROJECT_FORMAT) return { kind: 'project', project: read_project(data, filename) };
  if (data.format === BACKUP_FORMAT) {
    if (!Array.isArray(data.projects)) throw new Error('the backup has no games');
    return { kind: 'backup', projects: data.projects.map((p) => read_project(p, filename)) };
  }
  if (!GAME_FIELDS.some((f) => typeof data[f] === 'string')) throw new Error('this is not a game or project file (it has none of the programs)');
  return { kind: 'game', game: normalize_game(data) };
}

// A file name from a title, e.g. 'Find the flag 3' -> 'find-the-flag-3'.
export function file_stem(title) {
  return (title || 'game').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'game';
}
