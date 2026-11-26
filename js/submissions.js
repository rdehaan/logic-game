// Reading the submissions of students, for grading:
// - the zip file that Canvas gives for "Download all submissions": one file per
//   submitted file, named <name>_<user id>_<submission id>_<file name> (with
//   _LATE_ after the name when it was late), where each file can be a zip file
//   of its own (with the game file and the PDF), a game file or a PDF;
// - the zip file of one student (a game file and a PDF, or a game folder);
// - game files (.json) or PDF files on their own.
//
// The game of a submission is the first file that is a game or project file
// (or a game folder, see folder.js); every PDF is kept, to read next to the rubric.
//
// This module does not use the DOM.
import { read_zip, zip_budget, ZipLimitError, files_to_game, strip_common_dir, MANIFEST, DEFAULT_FILES } from './folder.js';
import { read_file } from './versions.js';
import { new_student } from './grading.js';

// <name>_<LATE_><user id>_<submission id>_<file name> (Canvas' names for submitted files).
const CANVAS_NAME = /^([^_/]+)_(late_)?(\d+)_(\d+)_(.+)$/i;

export function parse_canvas_name(name) {
  const base = name.replace(/^.*\//, '');
  const m = CANVAS_NAME.exec(base);
  if (!m) return null;
  return { name: m[1], late: Boolean(m[2]), user_id: m[3], submission_id: m[4], file: m[5] };
}

const is_zip = (name, bytes) => /\.zip$/i.test(name) || (bytes && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 3 && bytes[3] === 4);
const is_pdf = (name, bytes) => /\.pdf$/i.test(name) || (bytes && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46);
const ignored = (path) => /(^|\/)(__MACOSX|\.DS_Store|Thumbs\.db)(\/|$)/.test(path) || /(^|\/)\._/.test(path);
const decode = (bytes) => new TextDecoder().decode(bytes);

// The files of a submission, with zip files unpacked (also zip files inside zip
// files, up to a few levels): { path: Uint8Array }. `budget`: see zip_budget in
// folder.js (when it runs out, a ZipLimitError is thrown).
// (Objects without a prototype: a file can be named '__proto__'.)
async function unpack(files, warnings, budget, depth = 0) {
  const out = Object.create(null);
  for (const [path, bytes] of Object.entries(files)) {
    if (ignored(path)) continue;
    if (is_zip(path, bytes) && depth < 3) {
      let inner;
      const skipped = [];
      try {
        inner = await read_zip(bytes, { binary: true, skipped, budget });
      } catch (e) {
        if (e instanceof ZipLimitError) throw e;
        warnings.push(`${path.replace(/^.*\//, '')} could not be unpacked: ${e.message}.`);
        out[path] = bytes;
        continue;
      }
      for (const x of skipped) warnings.push(`${x.name.replace(/^.*\//, '')} in ${path.replace(/^.*\//, '')} ${x.reason}.`);
      const stem = path.replace(/\.zip$/i, '');
      for (const [p, b] of Object.entries(await unpack(inner, warnings, budget, depth + 1))) out[stem + '/' + p] = b;
    } else {
      out[path] = bytes;
    }
  }
  return out;
}

// The game and the PDFs among the files of one submission ({ path: Uint8Array }).
// Returns { game, game_file, pdfs: [{ name, bytes }], files: [paths], warnings }.
export async function read_submission(raw, budget = zip_budget()) {
  const warnings = [];
  const files = await unpack(raw, warnings, budget);
  const paths = Object.keys(files).sort();
  let game = null;
  let game_file = null;
  const short = (p) => p.replace(/^.*\//, '');
  // Game and project files
  for (const p of paths.filter((x) => /\.json$/i.test(x))) {
    try {
      const text = decode(files[p]);
      // (game.json can also be the description of a game folder: see below)
      if (short(p) === MANIFEST && /"format"\s*:\s*"logic-game-folder"/.test(text)) continue;
      const content = read_file(text, short(p));
      const g = content.kind === 'game' ? content.game : content.kind === 'project' ? content.project.game : null;
      if (!g) continue;
      if (game) {
        warnings.push(`There is more than one game file: ${short(p)} is not used (${short(game_file)} is).`);
        continue;
      }
      game = g;
      game_file = p;
    } catch (e) {
      warnings.push(`${short(p)}: ${e.message}`);
    }
  }
  // A game folder (one .lp file per program)
  if (!game) {
    const dirs = new Set(paths.filter((p) => short(p) === MANIFEST || short(p) === DEFAULT_FILES.player_move_program)
      .map((p) => p.slice(0, p.length - short(p).length)));
    for (const dir of dirs) {
      const contents = {};
      for (const p of paths) if (p.startsWith(dir) && /\.(lp|json)$/i.test(p)) contents[p.slice(dir.length)] = decode(files[p]);
      try {
        game = files_to_game(contents).game;
        game_file = dir || '(folder)';
        break;
      } catch (e) {
        warnings.push(`${dir || 'the folder'}: ${e.message}`);
      }
    }
  }
  if (!game) warnings.push('No game file was found in this submission.');
  const pdfs = paths.filter((p) => is_pdf(p, files[p])).map((p) => ({ name: p, bytes: files[p] }));
  if (!pdfs.length) warnings.push('No PDF file was found in this submission.');
  return { game, game_file, pdfs, files: paths, warnings };
}

// Read what the grader loaded: a list of { name, bytes } (zip, json or pdf files).
// Returns { students: [student (see new_student in grading.js) with pdfs as
// [{ name, bytes }]], notes: [text] }.
// - Files with Canvas' names (also inside a zip file of all submissions) are
//   grouped by student (user id).
// - Any other zip file is the submission of one student (named after the file),
//   unless it holds files with Canvas' names.
// - Other files are one student each.
// Zip files are unpacked within the limits in folder.js (ZIP_MAX_...): a file
// that is too large is left out with a note or warning; when all together
// are too large, a ZipLimitError is thrown.
export async function read_submissions(list) {
  const groups = new Map();      // key -> { name, canvas_id, late, files: { path: bytes } }
  const notes = [];
  const budget = zip_budget(list.reduce((n, x) => n + x.bytes.length, 0));
  const add = (key, info, path, bytes) => {
    if (!groups.has(key)) groups.set(key, { ...info, files: Object.create(null) });
    const g = groups.get(key);
    g.late = g.late || info.late;
    g.files[path] = bytes;
  };
  const add_canvas = (c, path, bytes) => add('canvas:' + c.user_id, { name: c.name, canvas_id: c.user_id, late: c.late }, c.file, bytes);
  for (const { name, bytes } of list) {
    const c = parse_canvas_name(name);
    if (c) {
      add_canvas(c, name, bytes);
      continue;
    }
    if (is_zip(name, bytes)) {
      let inner;
      const skipped = [];
      try {
        inner = await read_zip(bytes, { binary: true, skipped, budget });
      } catch (e) {
        if (e instanceof ZipLimitError) throw e;
        notes.push(`${name}: ${e.message}`);
        continue;
      }
      for (const x of skipped) notes.push(`${name}: ${x.name} was left out: it ${x.reason}.`);
      const entries = Object.entries(inner).filter(([p]) => !ignored(p));
      const canvas = entries.filter(([p]) => parse_canvas_name(p));
      if (canvas.length) {
        for (const [p, b] of canvas) add_canvas(parse_canvas_name(p), p, b);
        const other = entries.length - canvas.length;
        if (other) notes.push(`${name}: ${other} file${other > 1 ? 's' : ''} without a student's name (as Canvas names them) ${other > 1 ? 'were' : 'was'} left out.`);
        continue;
      }
      const stem = name.replace(/^.*\//, '').replace(/\.zip$/i, '');
      const { paths } = strip_common_dir(entries.map(([p]) => p));
      entries.forEach(([, b], i) => add('file:' + stem, { name: stem, canvas_id: null, late: false }, paths[i], b));
      continue;
    }
    const stem = name.replace(/^.*\//, '').replace(/\.(json|pdf)$/i, '');
    add('file:' + stem, { name: stem, canvas_id: null, late: false }, name.replace(/^.*\//, ''), bytes);
  }
  const students = [];
  for (const [key, g] of groups) {
    const sub = await read_submission(g.files, budget);
    const st = new_student({
      key, name: g.name, canvas_id: g.canvas_id, late: g.late, files: sub.files, warnings: sub.warnings,
      game: sub.game, game_file: sub.game_file, pdfs: sub.pdfs.map((p) => p.name),
    });
    st.pdf_files = sub.pdfs;
    students.push(st);
  }
  students.sort((a, b) => a.name.localeCompare(b.name));
  return { students, notes };
}
