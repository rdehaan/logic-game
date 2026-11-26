// Reading and writing games on disk, for the command-line version (Node only).
//
// A game can be:
// - a folder in the folder format (see js/folder.js), e.g. my-game/;
// - a .zip file of such a folder (as the browser downloads it);
// - a .json game file (as the examples), or a project file (as the browser
//   downloads it: then its current version is used);
// - the name of an example game, e.g. flag3 (the file examples/flag3.json).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { files_to_game, file_names, game_to_files, make_zip, read_zip, strip_common_dir, MANIFEST } from '../js/folder.js';
import { read_file, project_file } from '../js/versions.js';
import { compact } from '../js/storage.js';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const EXAMPLES = path.join(ROOT, 'examples');

export function example_names() {
  return fs.readdirSync(EXAMPLES).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)).sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
}

// The kind of a path: 'folder', 'zip' or 'json' (by what is there, or by its name).
export function kind_of(p) {
  if (fs.existsSync(p) && fs.statSync(p).isDirectory()) return 'folder';
  if (/\.zip$/i.test(p)) return 'zip';
  if (/\.json$/i.test(p)) return 'json';
  return 'folder';
}

// Whether there is a file at p that is not a symbolic link. Files in game
// folders and folders of submissions that are symbolic links are not read: in a
// folder from someone else, one could point to any file (e.g. a key in the home
// folder), which would end up in a game or a grading file.
function plain_file(p) {
  try {
    return fs.lstatSync(p).isFile();
  } catch {
    return false;
  }
}

// Read a game. Returns { game, title, files, source } where files says which
// file holds which program (for a folder; else null), and source what was read.
// (In a folder, files that are symbolic links are not read: see plain_file.)
export async function load_game(p) {
  if (!fs.existsSync(p)) {
    const example = path.join(EXAMPLES, p.replace(/\.json$/, '') + '.json');
    if (/^[\w-]+$/.test(p.replace(/\.json$/, '')) && fs.existsSync(example)) {
      return { ...from_json(fs.readFileSync(example, 'utf8'), path.basename(example)), source: `the example ${p}` };
    }
    throw new Error(`${p} does not exist (and is not the name of an example game: ${example_names().join(', ')})`);
  }
  const kind = kind_of(p);
  if (kind === 'folder') {
    const contents = Object.create(null);
    const manifest = path.join(p, MANIFEST);
    if (plain_file(manifest)) contents[MANIFEST] = fs.readFileSync(manifest, 'utf8');
    const files = file_names(contents[MANIFEST]);
    for (const f of Object.values(files)) {
      const full = path.join(p, f);
      if (plain_file(full)) contents[f] = fs.readFileSync(full, 'utf8');
    }
    const out = files_to_game(contents);
    return { ...out, title: out.title || path.basename(path.resolve(p)), source: p };
  }
  if (kind === 'zip') {
    const all = await read_zip(new Uint8Array(fs.readFileSync(p)));
    const { paths } = strip_common_dir(Object.keys(all));
    const contents = Object.fromEntries(Object.keys(all).map((k, i) => [paths[i], all[k]]));
    const out = files_to_game(contents);
    return { ...out, title: out.title || path.basename(p, '.zip'), source: p };
  }
  return { ...from_json(fs.readFileSync(p, 'utf8'), path.basename(p)), source: p };
}

function from_json(text, filename) {
  const content = read_file(text, filename);
  if (content.kind === 'game') return { game: content.game, title: filename.replace(/\.json$/, ''), files: null, project: null };
  if (content.kind === 'project') return { game: content.project.game, title: content.project.title, files: null, project: content.project };
  throw new Error(`${filename} is a backup of several games: use a project file or a game file`);
}

// Write a game: to a folder (made if needed), a .zip file, or a .json file
// (a game file; with project: true, a project file).
export function save_game(p, game, { title = '', project = null, as_project = false, files = undefined } = {}) {
  const kind = kind_of(p);
  if (kind === 'folder') {
    const wanted = game_to_files(game, { title, files });
    for (const [f, text] of Object.entries(wanted)) {
      const full = path.join(p, f);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, text);
    }
    // (a game without a level has no level files: old ones are removed)
    for (const f of Object.values(file_names(wanted[MANIFEST]))) {
      if (!(f in wanted) && fs.existsSync(path.join(p, f))) fs.rmSync(path.join(p, f));
    }
  } else if (kind === 'zip') {
    const dir = path.basename(p).replace(/\.zip$/i, '');
    const contents = Object.fromEntries(Object.entries(game_to_files(game, { title, files })).map(([f, t]) => [dir + '/' + f, t]));
    fs.writeFileSync(p, make_zip(contents));
  } else if (as_project) {
    const data = project_file({ origin: project?.origin || 'file:' + path.basename(p), title, game, original: project?.original || game, snapshots: project?.snapshots || [] });
    fs.writeFileSync(p, JSON.stringify(data, null, 1) + '\n');
  } else {
    fs.writeFileSync(p, JSON.stringify(compact(game), null, 2) + '\n');
  }
}

// The files to read for grading, from paths on the command line: files as they
// are (zip, json, pdf), and folders: the files in a folder are read one by one,
// except that each folder in it is one student's submission (as a zip file of it).
// Symbolic links in folders are left out (see plain_file). Returns [{ name, bytes }].
export function submission_files(paths) {
  const list = [];
  const folder_zip = (dir) => {
    const files = Object.create(null);
    // (not with readdirSync's recursive: it also goes into folders that are symbolic links)
    const add = (folder, prefix) => {
      for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
        const full = path.join(folder, entry.name);
        if (entry.isDirectory()) add(full, prefix + entry.name + '/');
        else if (entry.isFile()) files[prefix + entry.name] = new Uint8Array(fs.readFileSync(full));
      }
    };
    add(dir, '');
    return make_zip(files);
  };
  for (const p of paths) {
    if (!fs.existsSync(p)) throw new Error(`${p} does not exist`);
    if (!fs.statSync(p).isDirectory()) {
      list.push({ name: path.basename(p), bytes: new Uint8Array(fs.readFileSync(p)) });
      continue;
    }
    for (const entry of fs.readdirSync(p, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith('.')) continue;
      const full = path.join(p, entry.name);
      if (entry.isDirectory()) list.push({ name: entry.name + '.zip', bytes: folder_zip(full) });
      else if (entry.isFile()) list.push({ name: entry.name, bytes: new Uint8Array(fs.readFileSync(full)) });
    }
  }
  return list;
}
