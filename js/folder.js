// Games as folders: one plain clingo file per program, so that they work well
// with git (a diff per program) and can be run with clingo directly.
//
//   my-game/
//     game.json                 { format, format_version, title, files: { field: path } }
//     auxiliary.lp
//     level-generation.lp
//     visibility.lp
//     nature.lp
//     winning-conditions.lp
//     strategy.lp
//     level/state.lp            the level (only when there is one)
//     level/settings.lp
//
// game.json may name other files for the programs (paths relative to the
// folder); without game.json the default names are used.
//
// Also: reading and writing .zip files (to download a folder from the browser).
//
// This module does not use the DOM (the command-line version uses it too).
import { GAME_FIELDS, normalize_game } from './engine.js';

export const FOLDER_FORMAT = 'logic-game-folder';
export const MANIFEST = 'game.json';

export const DEFAULT_FILES = {
  aux_program: 'auxiliary.lp',
  level_gen_program: 'level-generation.lp',
  visibility_program: 'visibility.lp',
  nature_program: 'nature.lp',
  goal_program: 'winning-conditions.lp',
  player_move_program: 'strategy.lp',
  level_state: 'level/state.lp',
  level_settings: 'level/settings.lp',
};

const LEVEL_FIELDS = ['level_state', 'level_settings'];

// A text ends with exactly one newline (as most editors write it), except an empty one.
function with_newline(text) {
  return text ? text.replace(/\r\n?/g, '\n').replace(/\n*$/, '\n') : '';
}

// Compare a text from a file with a text in the editors.
export function same_text(a, b) {
  return with_newline(a || '') === with_newline(b || '');
}

function safe_path(p) {
  if (typeof p !== 'string' || !p || p.startsWith('/') || p.includes('\\') || p.split('/').some((x) => x === '..' || x === '')) {
    throw new Error(`game.json: "${p}" is not a path inside the folder`);
  }
  return p;
}

// The files of a folder for a game: { path: text } (the level only if there is one).
export function game_to_files(game, { title = '', files = DEFAULT_FILES } = {}) {
  game = normalize_game(game);
  const out = {};
  const manifest = { format: FOLDER_FORMAT, format_version: 1, title: title || undefined, files: {} };
  for (const field of GAME_FIELDS) {
    const p = files[field] || DEFAULT_FILES[field];
    manifest.files[field] = p;
    if (LEVEL_FIELDS.includes(field) && !game.level_state && !game.level_settings) continue;
    out[p] = with_newline(game[field]);
  }
  out[MANIFEST] = JSON.stringify(manifest, null, 2) + '\n';
  return out;
}

// Which file holds which program: { field: path } (from game.json, or the default names).
export function file_names(manifest_text) {
  if (manifest_text == null) return { ...DEFAULT_FILES };
  let m;
  try {
    m = JSON.parse(manifest_text);
  } catch (e) {
    throw new Error('game.json is not valid JSON: ' + e.message);
  }
  if (!m || typeof m !== 'object') throw new Error('game.json is not a game description');
  if (m.format && m.format !== FOLDER_FORMAT) throw new Error(`game.json: unknown format "${m.format}"`);
  if (Number(m.format_version) > 1) throw new Error('game.json was made by a newer version of the game: update it');
  const files = { ...DEFAULT_FILES };
  for (const field of GAME_FIELDS) if (m.files && m.files[field] != null) files[field] = safe_path(m.files[field]);
  return files;
}

// A game from the files of a folder ({ path: text }, paths relative to the folder).
// Returns { game, title, files }. Files that are missing give empty programs; a
// folder without any of the programs is refused.
export function files_to_game(contents) {
  const files = file_names(contents[MANIFEST]);
  let title = '';
  if (contents[MANIFEST] != null) {
    const m = JSON.parse(contents[MANIFEST]);
    if (typeof m.title === 'string') title = m.title;
  }
  const game = {};
  let found = 0;
  for (const field of GAME_FIELDS) {
    const text = contents[files[field]];
    if (text != null) found++;
    // (the trailing newline that editors add is not part of the program)
    game[field] = text == null ? '' : text.replace(/\r\n?/g, '\n').replace(/\n+$/, '');
  }
  if (!found) throw new Error(`this folder has none of the programs of a game (such as ${DEFAULT_FILES.player_move_program}${contents[MANIFEST] == null ? ', and no game.json' : ''})`);
  return { game: normalize_game(game), title, files };
}

// The paths in a list that belong to a folder that was selected as a whole:
// a common first directory (e.g. "my-game/strategy.lp") is taken off.
export function strip_common_dir(paths) {
  const parts = paths.map((p) => p.split('/'));
  if (parts.length && parts.every((x) => x.length > 1 && x[0] === parts[0][0])) {
    return { dir: parts[0][0], paths: parts.map((x) => x.slice(1).join('/')) };
  }
  return { dir: null, paths };
}

// ---- Zip files ----------------------------------------------------------------------
// Only what is needed for folders of files: writing without compression
// (any zip program can read that), reading without compression or with
// deflate (as zip programs write). Files are text, or bytes (Uint8Array: e.g.
// the PDF files and the zip files inside a download of all submissions, which
// the grader reads).

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function dos_time(date) {
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: ((Math.max(1980, date.getFullYear()) - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

// A zip file (Uint8Array) of { path: text or Uint8Array }.
export function make_zip(files, date = new Date()) {
  const enc = new TextEncoder();
  const { time, date: day } = dos_time(date);
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [path, text] of Object.entries(files)) {
    const name = enc.encode(path);
    const data = text instanceof Uint8Array ? text : enc.encode(text);
    const crc = crc32(data);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(6, 0x0800, true);          // UTF-8 names
    local.setUint16(8, 0, true);               // stored
    local.setUint16(10, time, true);
    local.setUint16(12, day, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, data.length, true);
    local.setUint32(22, data.length, true);
    local.setUint16(26, name.length, true);
    locals.push(new Uint8Array(local.buffer), name, data);
    const central = new DataView(new ArrayBuffer(46));
    central.setUint32(0, 0x02014b50, true);
    central.setUint16(4, 20, true);
    central.setUint16(6, 20, true);
    central.setUint16(8, 0x0800, true);
    central.setUint16(10, 0, true);
    central.setUint16(12, time, true);
    central.setUint16(14, day, true);
    central.setUint32(16, crc, true);
    central.setUint32(20, data.length, true);
    central.setUint32(24, data.length, true);
    central.setUint16(28, name.length, true);
    central.setUint32(42, offset, true);
    centrals.push(new Uint8Array(central.buffer), name);
    offset += 30 + name.length + data.length;
  }
  const central_size = centrals.reduce((n, x) => n + x.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, Object.keys(files).length, true);
  end.setUint16(10, Object.keys(files).length, true);
  end.setUint32(12, central_size, true);
  end.setUint32(16, offset, true);
  const parts = [...locals, ...centrals, new Uint8Array(end.buffer)];
  const out = new Uint8Array(parts.reduce((n, x) => n + x.length, 0));
  let i = 0;
  for (const p of parts) {
    out.set(p, i);
    i += p.length;
  }
  return out;
}

async function inflate(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// The files in a zip file: { path: text } (directories and files of macOS'
// resource forks are left out); with { binary: true }: { path: Uint8Array }.
export async function read_zip(bytes, { binary = false } = {}) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 65535); i--) {
    if (view.getUint32(i, true) === 0x06054b50) { end = i; break; }
  }
  if (end < 0) throw new Error('this is not a zip file');
  const count = view.getUint16(end + 10, true);
  let p = view.getUint32(end + 16, true);
  const dec = new TextDecoder();
  const out = {};
  for (let k = 0; k < count; k++) {
    if (view.getUint32(p, true) !== 0x02014b50) throw new Error('the zip file is damaged');
    const method = view.getUint16(p + 10, true);
    const size = view.getUint32(p + 20, true);
    const name_length = view.getUint16(p + 28, true);
    const extra_length = view.getUint16(p + 30, true);
    const comment_length = view.getUint16(p + 32, true);
    const local = view.getUint32(p + 42, true);
    const name = dec.decode(bytes.subarray(p + 46, p + 46 + name_length));
    p += 46 + name_length + extra_length + comment_length;
    if (name.endsWith('/') || name.startsWith('__MACOSX/') || /(^|\/)\.DS_Store$/.test(name)) continue;
    const data_start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    const raw = bytes.subarray(data_start, data_start + size);
    let data;
    if (method === 0) data = raw.slice();
    else if (method === 8) data = await inflate(raw);
    else throw new Error(`the zip file uses a compression that is not supported (${name})`);
    out[name] = binary ? data : dec.decode(data);
  }
  return out;
}
