// Tests of grading: the rubric and the grade, comments, similarity, the
// measurements of a game (with clingo) and the scores they suggest, grading
// sessions, and reading the submissions of students (Canvas' zip files).
import test from 'node:test';
import assert from 'node:assert/strict';
import clingo from 'clingo-wasm';
import { create_solver } from '../js/solver.js';
import {
  DEFAULT_RUBRIC, read_rubric, rubric_items, compute_grade, item_points, comment_stats, game_comment_stats,
  program_tokens, similarity, most_similar, full_view, level_view, state_objects, observed_objects,
  measure_game, suggest_all, apply_suggestions, static_facts, new_student, session_file, read_session,
  merge_students, grades_csv, npcs,
} from '../js/grading.js';
import { read_submissions, parse_canvas_name } from '../js/submissions.js';
import { make_zip, read_zip, game_to_files } from '../js/folder.js';
import { compute_grid_ds, label_text } from '../js/grid-visual.js';
import fs from 'node:fs';
import path from 'node:path';
import { load_examples, ROOT } from './helpers.mjs';

const solver = create_solver(clingo);
const examples = Object.fromEntries(load_examples().map(({ name, game }) => [name.replace(/\.json$/, ''), game]));
const rubric = read_rubric(DEFAULT_RUBRIC);
const all_yes = Object.fromEntries(rubric_items(rubric).map((item) => [item.id, { value: 'yes' }]));

// ---- The rubric and the grade -----------------------------------------------------

test('the default rubric: three requirements (a 6), extra points up to a 9, all of them a 10', () => {
  assert.equal(rubric.required.items.length, 3);
  assert.equal(rubric.required.grade, 6);
  assert.equal(rubric.extra.max, 9);
  assert.equal(rubric.extra.all_grade, 10);
  assert.equal(rubric.extra.items.reduce((n, item) => n + item.points, 0), 4.5);
  assert.ok(rubric_items(rubric).every((item) => item.check));
});

test('the grade: requirements, extra points, the maximum, all items, overrides', () => {
  const only_required = Object.fromEntries(rubric.required.items.map((item) => [item.id, { value: 'yes' }]));
  for (const item of rubric.extra.items) only_required[item.id] = { value: 'no' };
  assert.equal(compute_grade(rubric, only_required).grade, 6);
  // + hidden (1) + random (0.5) = 7.5
  const some = { ...only_required, hidden: { value: 'yes' }, random: { value: 'yes' } };
  assert.equal(compute_grade(rubric, some).grade, 7.5);
  // Fewer points than the full number
  assert.equal(compute_grade(rubric, { ...some, hidden: { value: 'yes', points: 0.5 } }).grade, 7);
  assert.equal(item_points(rubric.extra.items[1], { value: 'yes', points: 5 }), 1);      // (at most the points of the item)
  // All but one: at most a 9; all of them: a 10
  assert.equal(compute_grade(rubric, { ...all_yes, visual: { value: 'no' } }).grade, 9);
  assert.equal(compute_grade(rubric, all_yes).grade, 10);
  assert.equal(compute_grade(rubric, { ...all_yes, memory: { value: 'yes', points: 0.5 } }).grade, 9);
  // A requirement that is not met: the grader gives the grade
  const failed = compute_grade(rubric, { ...all_yes, novel: { value: 'no' } });
  assert.equal(failed.grade, null);
  assert.equal(failed.below_pass, true);
  assert.match(failed.text, /grader gives the grade/);
  assert.equal(compute_grade(rubric, { ...all_yes, novel: { value: 'no' } }, 4.5).grade, 4.5);
  // Not decided yet
  const partial = compute_grade(rubric, { timing: { value: 'yes' } });
  assert.equal(partial.grade, null);
  assert.equal(partial.complete, false);
  assert.match(partial.text, /so far \(8 items not decided\)/);
});

test('reading a rubric: defaults, and the mistakes in it', () => {
  const r = read_rubric(JSON.stringify({
    title: 'Another course', required: { grade: 5.5, items: [{ id: 'a', label: 'It works' }] },
    extra: { max: 10, items: [{ id: 'b', label: 'Fancy', points: 2, check: 'visual' }] },
  }));
  assert.equal(r.title, 'Another course');
  assert.equal(r.extra.all_grade, null);
  assert.equal(compute_grade(r, { a: { value: 'yes' }, b: { value: 'yes' } }).grade, 7.5);
  assert.ok(r.snippets.length > 0);
  assert.equal(r.checks.test_levels, 20);
  assert.throws(() => read_rubric('{'), /not valid JSON/);
  assert.throws(() => read_rubric({ format: 'logic-game-project' }), /not a rubric/);
  assert.throws(() => read_rubric({ required: { items: [{ label: 'x', check: 'magic' }] }, extra: { items: [] } }), /unknown check "magic"/);
  assert.throws(() => read_rubric({ required: { items: [] }, extra: { items: [{ label: 'x' }] } }), /has no points/);
  assert.throws(() => read_rubric({ required: { items: [{ id: 'a', label: 'x' }, { id: 'a', label: 'y' }] } }), /two items .* "a"/);
});

// ---- Comments and similarity ---------------------------------------------------------

test('comments: lines with comments and lines with code', () => {
  assert.deepEqual(comment_stats(''), { lines: 1, code_lines: 0, comment_lines: 0, ratio: 0 });
  const s = comment_stats('% The player\nat(1,1,player).\nb :- a. % why\n%* a block\n   comment *%\n"%" :- c.\n%%%\n');
  assert.equal(s.code_lines, 3);
  assert.equal(s.comment_lines, 4);       // (a line of only % is not a comment)
  const stats = game_comment_stats(examples['flag9-with-solutions']);
  assert.ok(stats.player_move_program.comment_lines > 5);
});

test('similarity: comments, spaces and the names of variables do not matter', () => {
  assert.deepEqual(program_tokens('a(X, Y) :- b(X). % hi'), ['a', '(', 'V', ',', 'V', ')', ':-', 'b', '(', 'V', ')', '.']);
  const game = examples['flag9-with-solutions'];
  const renamed = { ...game, player_move_program: game.player_move_program.replace(/\bR\b/g, 'Row').replace(/%[^\n]*/g, '% another comment').replace(/\n/g, '\n\n') };
  assert.equal(similarity(game, renamed).overall, 1);
  const other = similarity(game, examples.flag1);
  assert.ok(other.overall < 0.5, String(other.overall));
  assert.equal(other.programs.visibility_program, 1);      // (both: everything is visible)
  const top = most_similar(game, [{ name: 'flag1', game: examples.flag1 }, { name: 'flag9', game: examples.flag9 }, { name: 'copy', game: renamed }]);
  assert.deepEqual(top.map((x) => x.name), ['copy', 'flag9', 'flag1']);
});

// ---- The board with everything on it --------------------------------------------------

test('the full view: the objects the player does not see are added, faded', () => {
  const state = 'state_time(0). state_time(1). at_time(0,1,1,player). at_time(1,1,2,player). at_time(1,2,2,flag).';
  assert.deepEqual(state_objects(state), [{ row: '1', col: '2', object: 'player' }, { row: '2', col: '2', object: 'flag' }]);
  const view = 'observe(at(1,2,player)). observe(fog(2,2)). setting(grid_width(2)). setting(grid_height(2)).';
  assert.deepEqual(observed_objects(view), [{ row: '1', col: '2', object: 'player' }]);
  const full = full_view(view, state);
  const grid = compute_grid_ds(full);
  assert.deepEqual(grid.cells.get(2), ['player']);
  assert.deepEqual(grid.hidden.get(4), ['flag']);
  assert.ok(grid.fog.has(4));
  assert.equal(compute_grid_ds(level_view('at(1,1,player). at(2,2,flag).', 'setting(grid_width(2)). setting(grid_height(2)).')).cells.size, 2);
  // Not twice: a game that draws the hidden flag faded itself, or shows it under another name with the same icon
  const self_drawn = view + ' decorate(item,2,2,flag).';
  assert.deepEqual(compute_grid_ds(full_view(self_drawn, state)).hidden.get(4), ['flag']);
  const renamed = 'observe(at(1,2,player)). observe(at(2,2,seen_flag)). setting(grid_width(2)). setting(grid_height(2)). ' +
    'decorate(label,flag,font_f024). decorate(label,seen_flag,font_f024).';
  const g = compute_grid_ds(full_view(renamed, state));
  assert.deepEqual([g.cells.get(4), g.hidden.get(4)], [['seen_flag'], undefined]);
  // (an object with another icon in the same cell is added)
  const other = 'observe(at(1,2,player)). observe(at(2,2,tree)). setting(grid_width(2)). setting(grid_height(2)). decorate(label,flag,font_f024). decorate(label,tree,font_f1bb).';
  assert.deepEqual(compute_grid_ds(full_view(other, state)).hidden.get(4), ['flag']);
  // An object without a label is shown by its name
  const unlabelled = compute_grid_ds(full_view(view, state + ' at_time(1,1,1,read_map).'));
  assert.deepEqual(unlabelled.hidden.get(1), ['read_map']);
  assert.equal(label_text(unlabelled.labels.get('read_map')), 'read_map');
  assert.equal(unlabelled.labels.get('flag'), '"flag"');
});

// ---- Measurements and suggestions (with clingo) ------------------------------------------

test('measuring a game: an attacker that moves, random levels, the memory', async () => {
  const game = examples['flag9-with-solutions'];
  const m = await measure_game(solver, game, { levels: 3 });
  assert.deepEqual(m.levels.map((l) => l.verdict), ['win', 'win', 'win']);
  assert.equal(m.distinct_levels, 3);
  assert.equal(m.sample_levels.length, 3);
  assert.ok(m.moved.attacker > 0 && m.moved.player > 0);
  assert.deepEqual(npcs(m), ['attacker']);
  assert.deepEqual(m.hidden, {});
  assert.ok(m.memory_steps > 0);
  assert.ok(m.statics.randint && m.statics.remembers && m.statics.reads_memory);
  assert.ok(m.generation_ms.length === 3 && m.program_ms.player.max > 0);
  // Survives the trip through JSON (it is saved with the student)
  assert.deepEqual(JSON.parse(JSON.stringify(m)), m);

  const sug = suggest_all(rubric, m, most_similar(game, [{ name: 'Find the flag 9', game: examples.flag9 }, { name: 'Find the flag 1', game: examples.flag1 }]));
  assert.equal(sug.timing.value, 'yes');
  assert.equal(sug.npc.value, 'yes');
  assert.match(sug.npc.evidence, /attacker/);
  assert.equal(sug.random.value, 'yes');
  assert.equal(sug.new_levels.value, 'yes');
  assert.equal(sug.hidden.value, 'no');
  assert.equal(sug.memory.value, 'yes');
  assert.equal(sug.visual.value, '');           // (always the grader)
  assert.match(sug.novel.evidence, /Find the flag 9 \(57%\)/);
  // Suggestions only fill in what the grader did not decide
  const scores = apply_suggestions(rubric, { npc: { value: 'no', note: 'the attacker is part of the level' } }, sug);
  assert.equal(scores.npc.value, 'no');
  assert.equal(scores.random.value, 'yes');
  assert.equal(scores.random.suggested, true);
  assert.equal(scores.visual, undefined);
});

test('measuring a game: hidden objects, a game without randomness or memory that does not win', async () => {
  const hidden = await measure_game(solver, examples['flag5-with-solutions'], { levels: 2 });
  assert.ok(hidden.hidden.flag > 0);
  assert.equal(suggest_all(rubric, hidden).hidden.value, 'yes');

  const plain = examples.flag1;      // (no strategy: the player does not move)
  const m = await measure_game(solver, plain, { levels: 2, max_time: 30 });
  assert.deepEqual(m.levels.map((l) => l.verdict), ['lose', 'lose']);
  assert.equal(m.distinct_levels, 1);
  const sug = suggest_all(rubric, m);
  assert.equal(sug.random.value, 'no');
  assert.equal(sug.new_levels.value, 'no');
  assert.equal(sug.memory.value, 'no');
  assert.equal(sug.npc.value, 'no');
  assert.equal(sug.novel.value, '');           // (not compared)
  assert.equal(static_facts(plain).randint, false);
});

test('measuring a game: a level generation that fails, and canceling', async () => {
  const broken = { ...examples['flag9-with-solutions'], level_gen_program: 'a. :- a.' };
  const m = await measure_game(solver, broken, { levels: 2 });
  assert.deepEqual(m.levels.map((l) => l.verdict), ['no level', 'no level']);
  let n = 0;
  const c = await measure_game(solver, examples['flag9-with-solutions'], { levels: 5, cancelled: () => n++ > 0 });
  assert.equal(c.cancelled, true);
  assert.ok(c.levels.length < 5);
});

// ---- Grading sessions -----------------------------------------------------------------

test('a grading session: export, import, merge, and the grades as CSV', () => {
  const a = new_student({ key: 'canvas:1', name: 'doejane', canvas_id: '1', game: examples.flag1 });
  const b = new_student({ key: 'canvas:2', name: 'roe, "rich"', canvas_id: '2' });
  a.scores = { ...all_yes };
  a.comment = 'Nice;\nwell done';
  a.status = 'done';
  const file = JSON.stringify(session_file({ rubric, students: [a, b] }));
  const back = read_session(file);
  assert.equal(back.students.length, 2);
  assert.deepEqual(back.students[0].scores, a.scores);
  assert.equal(back.rubric.title, rubric.title);
  assert.throws(() => read_session('{"format":"logic-game-project"}'), /not a grading file/);

  // Theirs changed later: theirs is kept; ours changed later: ours is kept; new ones are added
  const ours = [{ ...a, updated_at: '2026-01-02T00:00:00Z' }, { ...b, updated_at: '2026-01-01T00:00:00Z' }];
  const theirs = [
    { ...a, comment: 'older', updated_at: '2026-01-01T00:00:00Z' },
    { ...b, comment: 'newer', status: 'done', game: null, updated_at: '2026-01-03T00:00:00Z' },
    new_student({ key: 'canvas:3', name: 'third' }),
  ];
  const merged = merge_students(ours, theirs);
  assert.deepEqual([merged.added, merged.updated, merged.kept], [1, 1, 1]);
  assert.equal(merged.students.find((s) => s.key === 'canvas:1').comment, 'Nice;\nwell done');
  assert.equal(merged.students.find((s) => s.key === 'canvas:2').comment, 'newer');

  const csv = grades_csv(rubric, [a, b]);
  const lines = csv.trim().split('\r\n');
  assert.equal(lines[0], 'student,canvas_id,late,status,grade,timing,novel,documented,visual,hidden,npc,random,new_levels,memory,comment');
  assert.ok(lines[1].startsWith('doejane,1,,done,10,yes,yes,yes,0.5,1,1,0.5,0.5,1,"Nice;'));
  assert.ok(csv.includes('"roe, ""rich""",2,,new,'));
});

// ---- Reading submissions ------------------------------------------------------------------

const PDF = new TextEncoder().encode('%PDF-1.4\n%%EOF\n');

test("Canvas' names for submitted files", () => {
  assert.deepEqual(parse_canvas_name('doejane_12345_678901_hw3.zip'),
    { name: 'doejane', late: false, user_id: '12345', submission_id: '678901', file: 'hw3.zip' });
  assert.equal(parse_canvas_name('submissions/doejane_LATE_12345_678901_my_game-1.json').late, true);
  assert.equal(parse_canvas_name('doejane_LATE_12345_678901_my_game-1.json').file, 'my_game-1.json');
  assert.equal(parse_canvas_name('game.json'), null);
});

test("reading Canvas' download of all submissions", async () => {
  const folder = game_to_files(examples.flag3, { title: 'as a folder' });
  const all = make_zip({
    // A zip file with the game and the PDF (in a folder)
    'doejane_101_901_hw3.zip': make_zip({ 'hw3/my-game.json': JSON.stringify(examples.flag9), 'hw3/report.pdf': PDF, '__MACOSX/hw3/._report.pdf': 'x' }),
    // The game file and the PDF, handed in apart (late)
    'roerich_LATE_102_902_game.json': JSON.stringify(examples.flag1),
    'roerich_LATE_102_903_report.pdf': PDF,
    // A game folder (one .lp file per program) in a zip file, without a PDF
    'smitcarol_103_904_folder.zip': make_zip(Object.fromEntries(Object.entries(folder).map(([p, t]) => ['game/' + p, t]))),
    // Nothing useful
    'baddave_104_905_notes.txt': 'hello',
    'readme.txt': 'not a submission',
  });
  const { students, notes } = await read_submissions([{ name: 'submissions.zip', bytes: all }]);
  assert.deepEqual(students.map((s) => [s.name, s.canvas_id, s.late]), [['baddave', '104', false], ['doejane', '101', false], ['roerich', '102', true], ['smitcarol', '103', false]]);
  const [dave, jane, rich, carol] = students;
  assert.equal(jane.game.player_move_program, examples.flag9.player_move_program);
  assert.deepEqual(jane.pdfs, ['hw3/hw3/report.pdf']);
  assert.deepEqual([...jane.pdf_files[0].bytes], [...PDF]);
  assert.deepEqual(jane.warnings, []);
  assert.equal(rich.game.level_gen_program, examples.flag1.level_gen_program);
  assert.equal(rich.pdfs.length, 1);
  assert.equal(carol.game.nature_program, examples.flag3.nature_program);
  assert.match(carol.warnings.join(' '), /No PDF/);
  assert.equal(dave.game, null);
  assert.match(dave.warnings.join(' '), /No game file/);
  assert.match(notes.join(' '), /1 file without a student's name/);
});

test('reading the zip file of one student, and loose files', async () => {
  const one = make_zip({ 'hw3/game.json': JSON.stringify(examples.flag2), 'hw3/hw3.pdf': PDF, 'hw3/extra.json': '{"a": 1}' });
  const { students } = await read_submissions([
    { name: 'janedoe-hw3.zip', bytes: one },
    { name: 'other.json', bytes: new TextEncoder().encode(JSON.stringify(examples.flag4)) },
  ]);
  assert.deepEqual(students.map((s) => s.name), ['janedoe-hw3', 'other']);
  assert.equal(students[0].game.goal_program, examples.flag2.goal_program);
  assert.equal(students[0].pdfs.length, 1);
  assert.match(students[0].warnings.join(' '), /extra\.json: this is not a game or project file/);
  assert.equal(students[1].game.goal_program, examples.flag4.goal_program);
});

test('zip files with bytes', async () => {
  const bytes = new Uint8Array([0, 1, 2, 255, 128]);
  const back = await read_zip(make_zip({ 'a.bin': bytes, 'b.txt': 'text' }), { binary: true });
  assert.deepEqual([...back['a.bin']], [...bytes]);
  assert.equal(new TextDecoder().decode(back['b.txt']), 'text');
  assert.deepEqual(await read_zip(make_zip({ 'b.txt': 'text' })), { 'b.txt': 'text' });
});

// Zip files as real zip programs write them (made with Python's zipfile and Info-ZIP's zip):
// test/fixtures/zips/. Each is a download of all submissions, with doejane (a zip file
// with game.json and report.pdf) and roerich (a game file).
const fixture = async (name) => read_submissions([{ name: 'submissions.zip', bytes: new Uint8Array(fs.readFileSync(path.join(ROOT, 'test', 'fixtures', 'zips', name))) }]);

test('zip files with Zip64 fields (sizes and offsets in the central directory, and the Zip64 end record)', async () => {
  const { students, notes } = await fixture('zip64.zip');
  assert.deepEqual(notes, []);
  assert.deepEqual(students.map((s) => [s.name, Boolean(s.game), s.pdfs.length]), [['doejane', true, 1], ['roerich', true, 0]]);
});

test('an entry that cannot be read is left out, with the reason; the rest is read', async () => {
  const bz = await fixture('bzip2.zip');
  assert.deepEqual(bz.students.map((s) => s.name), ['doejane']);
  assert.match(bz.notes.join(' '), /roerich_12346_678902_game\.json was left out: it is compressed in a way that is not supported \(method 12, bzip2\)/);
  // (in the zip file of a student: a warning for that student)
  const enc = await fixture('encrypted.zip');
  assert.deepEqual(enc.students.map((s) => s.name), ['doejane', 'roerich']);
  assert.match(enc.students[0].warnings[0], /notes\.txt in hw3\.zip is encrypted/);
  // Without a list for what is left out, the whole file fails (as before), saying which entry
  await assert.rejects(read_zip(new Uint8Array(fs.readFileSync(path.join(ROOT, 'test', 'fixtures', 'zips', 'bzip2.zip')))), /roerich_12346_678902_game\.json in the zip file is compressed/);
});

test('zip files with data in front of them, and names in the encoding of DOS', async () => {
  const pre = await fixture('prefixed.zip');
  assert.deepEqual(pre.students.map((s) => [s.name, Boolean(s.game), s.pdfs.length]), [['doejane', true, 1]]);
  const dos = await fixture('dosname.zip');
  assert.deepEqual(dos.students.map((s) => [s.name, s.canvas_id, Boolean(s.game)]), [['m\u00fcllerjan', '12347', true]]);
  await assert.rejects(read_zip(new Uint8Array([1, 2, 3])), /not a zip file \(or only a part of one/);
});
