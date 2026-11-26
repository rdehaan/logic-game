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
    const text = Object.hasOwn(contents, files[field]) ? contents[files[field]] : null;
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

// The characters 128-255 of the encoding of DOS (code page 437), in which zip
// programs wrote names without the flag for UTF-8.
const CP437 = 'ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■\u00a0';

// Limits for unpacking zip files, against "zip bombs": small zip files that
// unpack to gigabytes, and would make the page or the command run out of
// memory. Real submissions stay far below them: a class of 300 students, each
// with a game file and a PDF of a few MB, unpacks to about 1 GB, from a zip
// file of nearly that size (PDF files hardly compress).
// - ZIP_MAX_ENTRY_SIZE: one file, unpacked (a scanned PDF can be tens of MB);
// - ZIP_MAX_TOTAL_SIZE, ZIP_MAX_RATIO: all files together, also those in zip
//   files inside zip files: at most 500 MB, or 4 times the size of what was
//   loaded if that is more (each level of zip files inside zip files counts:
//   a student's zip file in Canvas' zip file counts twice);
// - ZIP_MAX_ENTRIES: the number of files in one zip file.
export const ZIP_MAX_ENTRY_SIZE = 100e6;
export const ZIP_MAX_TOTAL_SIZE = 500e6;
export const ZIP_MAX_RATIO = 4;
export const ZIP_MAX_ENTRIES = 10000;

// What may still be unpacked, shared by all zip files that are read for one
// load (pass it to read_zip as `budget`). `loaded`: the number of bytes loaded.
export function zip_budget(loaded = 0) {
  const limit = Math.max(ZIP_MAX_TOTAL_SIZE, ZIP_MAX_RATIO * loaded);
  return { limit, left: limit };
}

// The error when all files together are too large: then nothing is read
// (an entry that is too large on its own is only left out).
export class ZipLimitError extends Error {}

const mb = (n) => `${Math.round(n / 1e6)} MB`;

// Unpack deflated data, a piece at a time, so that unpacking stops as soon as
// the result is longer than `max` bytes (then it returns null), and not after.
async function inflate(bytes, max) {
  const PIECE = 16 * 1024;
  let at = 0;
  const input = new ReadableStream({
    pull(controller) {
      if (at >= bytes.length) {
        controller.close();
        return;
      }
      controller.enqueue(bytes.slice(at, at + PIECE));
      at += PIECE;
    },
  });
  const reader = input.pipeThrough(new DecompressionStream('deflate-raw')).getReader();
  const chunks = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.length;
    if (length > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(length);
  let i = 0;
  for (const c of chunks) {
    out.set(c, i);
    i += c.length;
  }
  return out;
}

// The files in a zip file: { path: text } (directories and files of macOS'
// resource forks are left out); with { binary: true }: { path: Uint8Array }.
// Zip files as zip programs write them are read: also with Zip64 fields (for
// large files, which some programs write for any file), with data before the
// zip file itself, and with names in the old encoding of DOS.
// An entry that cannot be read (encrypted, compressed with another method
// than deflate, larger than ZIP_MAX_ENTRY_SIZE when unpacked, or damaged:
// another unpacked size than the zip file says, or data that it shares with
// another entry) makes the whole file fail, unless `skipped` is a list: then
// it is left out, and { name, reason } is added to the list.
// `budget` (see zip_budget) is what may be unpacked in all; when it runs out,
// a ZipLimitError is thrown. A zip file with more than ZIP_MAX_ENTRIES files
// is refused.
export async function read_zip(bytes, { binary = false, skipped = null, budget = zip_budget(bytes.length) } = {}) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u16 = (i) => view.getUint16(i, true);
  const u32 = (i) => view.getUint32(i, true);
  const u64 = (i) => Number(view.getBigUint64(i, true));
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 65535); i--) {
    if (u32(i) === 0x06054b50) { end = i; break; }
  }
  if (end < 0) throw new Error('this is not a zip file (or only a part of one: download it again)');
  let count = u16(end + 10);
  let cd_size = u32(end + 12);
  let cd_offset = u32(end + 16);
  let cd_end = end;
  // Zip64: the real numbers are in the Zip64 end of the central directory
  if (end >= 20 && u32(end - 20) === 0x07064b50) {
    const at = u64(end - 12);
    if (at + 56 <= bytes.length && u32(at) === 0x06064b50) {
      count = u64(at + 32);
      cd_size = u64(at + 40);
      cd_offset = u64(at + 48);
      cd_end = at;
    }
  }
  // (data in front of the zip file, e.g. a self-extracting archive: all offsets shift)
  const shift = Math.max(0, cd_end - (cd_offset + cd_size));
  const utf8 = new TextDecoder('utf-8', { fatal: true });
  const dec = new TextDecoder();
  const name_of = (raw, flags) => {
    if (flags & 0x0800) return dec.decode(raw);
    try {
      return utf8.decode(raw);
    } catch {
      return [...raw].map((b) => (b < 128 ? String.fromCharCode(b) : CP437[b - 128])).join('');
    }
  };
  if (count > ZIP_MAX_ENTRIES) throw new Error(`this zip file has too many files (${count}; at most ${ZIP_MAX_ENTRIES} can be read)`);
  // First the list of entries (from the central directory), then their data
  const entries = [];
  let p = cd_offset + shift;
  for (let k = 0; k < count; k++) {
    if (p + 46 > bytes.length || u32(p) !== 0x02014b50) throw new Error('the zip file is damaged (or only a part of one: download it again)');
    const flags = u16(p + 8);
    const method = u16(p + 10);
    let size = u32(p + 20);
    let original = u32(p + 24);
    const name_length = u16(p + 28);
    const extra_length = u16(p + 30);
    const comment_length = u16(p + 32);
    let local = u32(p + 42);
    const name = name_of(bytes.subarray(p + 46, p + 46 + name_length), flags);
    // Zip64 sizes and offset, in the extra field (only those that do not fit in 32 bits)
    for (let e = p + 46 + name_length; e + 4 <= p + 46 + name_length + extra_length;) {
      const id = u16(e);
      const len = u16(e + 2);
      if (id === 0x0001) {
        let f = e + 4;
        if (original === 0xFFFFFFFF && f + 8 <= e + 4 + len) { original = u64(f); f += 8; }
        if (size === 0xFFFFFFFF && f + 8 <= e + 4 + len) { size = u64(f); f += 8; }
        if (local === 0xFFFFFFFF && f + 8 <= e + 4 + len) { local = u64(f); f += 8; }
      }
      e += 4 + len;
    }
    p += 46 + name_length + extra_length + comment_length;
    if (name.endsWith('/') || name.startsWith('__MACOSX/') || /(^|\/)\.DS_Store$/.test(name)) continue;
    local += shift;
    const entry = { name, flags, method, size, original, local, start: local, end: local, problem: null };
    if (local + 30 > bytes.length || u32(local) !== 0x04034b50) {
      entry.problem = 'is damaged';
    } else {
      entry.data_start = local + 30 + u16(local + 26) + u16(local + 28);
      entry.end = entry.data_start + size;
      if (entry.end > bytes.length) entry.problem = 'is damaged (its data is not all in the zip file)';
    }
    entries.push(entry);
  }
  // Entries whose data overlap (e.g. several entries with the same data: a way
  // to make a zip bomb) are damaged
  const by_start = entries.filter((e) => !e.problem).sort((a, b) => a.start - b.start);
  let last = null;
  for (const e of by_start) {
    if (last && e.start < last.end) {
      e.problem = last.problem = 'is damaged (its data overlaps with that of another file in the zip file)';
    }
    if (!last || e.end > last.end) last = e;
  }
  // (a normal object, but '__proto__' as a file name is a file, not its prototype)
  const out = {};
  const put = (name, value) => Object.defineProperty(out, name, { value, enumerable: true, writable: true, configurable: true });
  for (const { name, flags, method, size, original, data_start, problem } of entries) {
    const skip = (reason) => {
      if (!skipped) throw new Error(`${name} in the zip file ${reason}`);
      skipped.push({ name, reason });
    };
    if (flags & 1) {
      skip('is encrypted (with a password)');
      continue;
    }
    if (method !== 0 && method !== 8) {
      skip(`is compressed in a way that is not supported (method ${method}${{ 9: ', deflate64', 12: ', bzip2', 14: ', LZMA', 93: ', zstd', 95: ', xz', 98: ', PPMd' }[method] || ''}): make the zip file with another program`);
      continue;
    }
    if (problem) {
      skip(problem);
      continue;
    }
    if (original > ZIP_MAX_ENTRY_SIZE) {
      skip(`is too large when unpacked (${mb(original)}; at most ${mb(ZIP_MAX_ENTRY_SIZE)} can be read)`);
      continue;
    }
    if (original > budget.left) {
      throw new ZipLimitError(`the files in the zip file are too large together when unpacked (more than ${mb(budget.limit)}, ` +
        `in all the zip files that were loaded at once): load fewer at a time`);
    }
    const raw = bytes.subarray(data_start, data_start + size);
    let data;
    try {
      data = method === 0 ? (size === original ? raw.slice() : null) : await inflate(raw, original);
    } catch {
      skip('is damaged (it cannot be unpacked)');
      continue;
    }
    if (!data || data.length !== original) {
      skip('is damaged (its size when unpacked is not the one the zip file gives)');
      continue;
    }
    budget.left -= original;
    put(name, binary ? data : dec.decode(data));
  }
  return out;
}
