// A link between the page and a game folder on the player's computer (with the
// File System Access API, in Chrome and Edge): every change in the page is
// saved into the files of the folder, and changes to the files made outside
// the browser (in an editor, or by git) are loaded into the page.
//
// The folder is in the folder format of folder.js. The handle of the folder
// is kept in IndexedDB, so that the page can offer to link it again after a
// reload (the browser asks the player for permission again).
import { files_to_game, file_names, game_to_files, same_text, MANIFEST } from './folder.js';
import { GAME_FIELDS } from './engine.js';

export const POLL_MS = 2000;

export function folder_links_supported() {
  return typeof window !== 'undefined' && typeof window.showDirectoryPicker === 'function';
}

// ---- Reading and writing files in a directory handle ------------------------------------

async function file_handle(dir, p, create = false) {
  const parts = p.split('/');
  let d = dir;
  for (const part of parts.slice(0, -1)) d = await d.getDirectoryHandle(part, { create });
  return d.getFileHandle(parts.at(-1), { create });
}

// The text and the time of the last change of a file, or null if there is no such file.
async function read_file(dir, p) {
  try {
    const file = await (await file_handle(dir, p)).getFile();
    return { text: await file.text(), modified: file.lastModified };
  } catch (e) {
    if (e.name === 'NotFoundError' || e.name === 'TypeMismatchError') return null;
    throw e;
  }
}

async function remove_file(dir, p) {
  const parts = p.split('/');
  let d = dir;
  try {
    for (const part of parts.slice(0, -1)) d = await d.getDirectoryHandle(part);
    await d.removeEntry(parts.at(-1));
  } catch (e) {
    if (e.name !== 'NotFoundError') throw e;
  }
}

async function write_file(dir, p, text) {
  const writable = await (await file_handle(dir, p, true)).createWritable();
  await writable.write(text);
  await writable.close();
}

// The contents of a game folder: { path: text } for game.json and the program files.
export async function read_folder(dir) {
  const contents = {};
  const manifest = await read_file(dir, MANIFEST);
  if (manifest) contents[MANIFEST] = manifest.text;
  const files = file_names(contents[MANIFEST]);
  const modified = {};
  for (const p of new Set(Object.values(files))) {
    const f = await read_file(dir, p);
    if (f) {
      contents[p] = f.text;
      modified[p] = f.modified;
    }
  }
  return { contents, files, modified };
}

// Whether a folder is empty (apart from files such as .git and .DS_Store).
export async function folder_is_empty(dir) {
  for await (const name of dir.keys()) if (!name.startsWith('.')) return false;
  return true;
}

// ---- The link ---------------------------------------------------------------------------

export class FolderLink {
  // on_change(game, fields): called with the game in the folder when files were
  // changed outside the page (fields: the programs that changed).
  constructor(dir, { on_change = () => {}, on_error = () => {} } = {}) {
    this.dir = dir;
    this.name = dir.name;
    this.on_change = on_change;
    this.on_error = on_error;
    this.files = null;          // which file holds which program
    this.known = {};            // path -> the text that the page last read or wrote
    this.title = '';
    this.timer = null;
    this.busy = Promise.resolve();
  }

  // Read the game in the folder: { game, title } (throws if it has none).
  async load() {
    const { contents, files } = await read_folder(this.dir);
    const { game, title } = files_to_game(contents);
    this.files = files;
    this.known = { ...contents };
    this.title = title || this.name;
    return { game, title: this.title };
  }

  // Write a game into the folder (only the files that changed). The writes
  // are done one after the other.
  save(game, title = this.title) {
    this.busy = this.busy.then(() => this.write(game, title)).catch((e) => this.on_error(e));
    return this.busy;
  }

  async write(game, title) {
    if (title) this.title = title;
    const wanted = game_to_files(game, { title: this.title, files: this.files || undefined });
    if (!this.files) this.files = file_names(wanted[MANIFEST]);
    for (const [p, text] of Object.entries(wanted)) {
      if (p === MANIFEST && this.known[MANIFEST] != null) continue;     // (keep the player's game.json)
      if (this.known[p] != null && same_text(this.known[p], text)) continue;
      if (this.known[p] == null && !text) continue;                       // (no empty files for missing programs)
      // A file that was changed outside the page since it was read is not
      // overwritten: check() loads it (and the page's version is kept as a snapshot)
      const now = await read_file(this.dir, p);
      if (now && !same_text(now.text, this.known[p] ?? '')) continue;
      await write_file(this.dir, p, text);
      this.known[p] = text;
    }
    // Files that the game does not have any more (the level, when it was cleared)
    for (const p of Object.keys(this.known)) {
      if (p === MANIFEST || p in wanted) continue;
      const now = await read_file(this.dir, p);
      if (now && !same_text(now.text, this.known[p])) continue;      // (changed outside the page)
      await remove_file(this.dir, p);
      delete this.known[p];
    }
  }

  // Look for changes made outside the page, every POLL_MS (while the page is visible).
  watch() {
    this.unwatch();
    this.timer = setInterval(() => {
      if (typeof document !== 'undefined' && document.hidden) return;
      this.busy = this.busy.then(() => this.check()).catch((e) => this.on_error(e));
    }, POLL_MS);
  }

  unwatch() {
    clearInterval(this.timer);
    this.timer = null;
  }

  async check() {
    const { contents } = await read_folder(this.dir);
    const changed = Object.keys({ ...contents, ...this.known })
      .filter((p) => p !== MANIFEST && !same_text(contents[p] ?? '', this.known[p] ?? ''));
    const manifest_changed = (contents[MANIFEST] ?? null) !== (this.known[MANIFEST] ?? null);
    if (!changed.length && !manifest_changed) return;
    let out;
    try {
      out = files_to_game(contents);
    } catch (e) {
      this.on_error(e);
      return;
    }
    this.files = out.files;
    this.known = { ...contents };
    if (out.title) this.title = out.title;
    const fields = GAME_FIELDS.filter((f) => changed.includes(out.files[f]));
    if (fields.length) await this.on_change(out.game, fields);
  }
}

// ---- Remembering the folder (IndexedDB) --------------------------------------------------

const DB = 'logic-game';
const STORE = 'folders';

function db() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function idb(mode, f) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const t = d.transaction(STORE, mode);
    const request = f(t.objectStore(STORE));
    t.oncomplete = () => resolve(request ? request.result : undefined);
    t.onerror = () => reject(t.error);
  });
}

export async function remember_folder(dir) {
  try {
    await idb('readwrite', (s) => s.put(dir, 'last'));
  } catch {
    // (then the page cannot offer to link it again)
  }
}

export async function remembered_folder() {
  try {
    return (await idb('readonly', (s) => s.get('last'))) || null;
  } catch {
    return null;
  }
}

export async function forget_folder() {
  try {
    await idb('readwrite', (s) => s.delete('last'));
  } catch {
    // nothing to do
  }
}

// Ask for permission to read and write a folder (needs a click of the player,
// except right after it was picked). Returns whether it was given.
export async function permission(dir) {
  const opts = { mode: 'readwrite' };
  if (!dir.queryPermission) return true;
  if ((await dir.queryPermission(opts)) === 'granted') return true;
  return (await dir.requestPermission(opts)) === 'granted';
}
