// Tests of the command-line version (bin/logic-game.mjs), with clingo-wasm from npm.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { ROOT } from './helpers.mjs';
import { text_board } from '../js/text-board.js';
import { permission_flags } from '../cli/permissions.mjs';
import { make_zip } from '../js/folder.js';
import { read_session, merge_students, new_student } from '../js/grading.js';

const BIN = path.join(ROOT, 'bin', 'logic-game.mjs');

// Run the command; returns { code, stdout, stderr }.
function run(...args) {
  return new Promise((resolve) => {
    execFile(process.execPath, [BIN, ...args], { env: { ...process.env, NO_COLOR: '1' }, timeout: 120000 }, (error, stdout, stderr) => {
      resolve({ code: error ? error.code : 0, stdout, stderr });
    });
  });
}

function tmpdir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'logic-game-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('the board as text', () => {
  const facts = 'observe(at(1,1,player)). observe(at(2,3,flag)). observe(at(2,3,player)). observe(fog(2,1)).\n' +
    'decorate(item,1,3,tree). setting(grid_width(3)). setting(grid_height(2)).';
  assert.deepEqual(text_board(facts), [
    '   1  2  3',
    '1  P  .  t',
    '2  ~  . FP',
    'F = flag, P = player, T = tree (lower case: not observed by the player); ~ = cannot be seen',
  ]);
  assert.equal(text_board('setting(grid_width(3)).'), null);
  // Changed cells are marked with colours (only with ansi)
  const before = 'observe(at(1,1,player)). setting(grid_width(2)). setting(grid_height(1)).';
  const after = 'observe(at(1,2,player)). setting(grid_width(2)). setting(grid_height(1)).';
  assert.match(text_board(after, { previous: before, ansi: true })[1], /\x1b\[43m/);
});

test('cli: help, and wrong commands', async () => {
  const help = await run('help');
  assert.equal(help.code, 0);
  assert.match(help.stdout, /Usage: logic-game <command>/);
  assert.equal((await run()).code, 1);
  const wrong = await run('fly');
  assert.equal(wrong.code, 1);
  assert.match(wrong.stderr, /Unknown command: fly/);
  const missing = await run('play', 'no-such-game');
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /does not exist \(and is not the name of an example game: flag1,/);
  assert.equal((await run('play', 'flag1', '--seed', 'x')).code, 1);
});

test('cli: a new game folder, checked, played and tested', async (t) => {
  const dir = path.join(tmpdir(t), 'my-game');
  const made = await run('new', dir, '--example', 'flag3-with-solutions');
  assert.equal(made.code, 0, made.stderr);
  assert.ok(fs.existsSync(path.join(dir, 'strategy.lp')));
  assert.match(fs.readFileSync(path.join(dir, 'strategy.lp'), 'utf8'), /do\(move/);
  assert.equal((await run('new', dir)).code, 1);       // (not over an existing folder)
  const check = await run('check', dir);
  assert.equal(check.code, 0, check.stdout);
  assert.match(check.stdout, /No problems found/);
  // The level of the folder, played to the end
  const play = await run('play', dir);
  assert.equal(play.code, 0, play.stdout + play.stderr);
  assert.match(play.stdout, /^The level of the game file\.\n\nTime 0\n {2}1 2 3 4 5 6 7 8\n1 /);
  assert.match(play.stdout, /Time 1: the player did do\(move\(\w+\)\)/);
  assert.match(play.stdout, /\nWIN! \(win\) \(at time \d+\)\n$/);
  // A level of the test: the same as in the browser (and in test)
  const seeded = await run('play', dir, '--seed', '2', '--quiet');
  assert.match(seeded.stdout, /^WIN! \(win\) \(at time \d+\)\n$/);
  const tested = await run('test', dir, '--levels', '3', '--json');
  assert.equal(tested.code, 0);
  const results = JSON.parse(tested.stdout);
  assert.equal(results.won, 3);
  assert.deepEqual(results.results.map((r) => r.seed), [1, 2, 3]);
  // A strategy with mistakes
  fs.writeFileSync(path.join(dir, 'strategy.lp'), 'do(move(down)) :- at(R,C,player).\nfoo(X) :- bar.\n');
  const bad = await run('check', dir);
  assert.equal(bad.code, 3);
  assert.match(bad.stdout, new RegExp(`${path.join(dir, 'strategy.lp').replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}:2:1: error: unsafe variables`));
  assert.match(bad.stdout, /1 error, \d+ warnings?\./);
  fs.writeFileSync(path.join(dir, 'strategy.lp'), 'do(move(down)) :- at(R,C,player).\n');
  const warned = await run('check', dir);
  assert.equal(warned.code, 0);
  assert.match(warned.stdout, /strategy\.lp:1:\d+: warning: at\/3 never holds here/);
  assert.equal((await run('check', dir, '--strict')).code, 3);
  // A test that does not win every level
  const lost = await run('test', dir, '--levels', '2', '--max-steps', '5');
  assert.equal(lost.code, 3);
  assert.match(lost.stdout, /Level 1: .*\n {2}logic-game play .* --seed 1 {3}or in the browser: https:\/\/.*#game=[\w-]+&seed=1\n/);
  assert.match(lost.stdout, /2 levels \(seeds 1 to 2\): /);
});

test('cli: converting between game files, project files, folders and zip files', async (t) => {
  const tmp = tmpdir(t);
  const folder = path.join(tmp, 'g');
  const zip = path.join(tmp, 'g.zip');
  const json = path.join(tmp, 'g.json');
  const project = path.join(tmp, 'p.json');
  const again = path.join(tmp, 'again');
  assert.equal((await run('convert', 'flag6-with-solutions', folder)).code, 0);
  assert.equal((await run('convert', folder, zip)).code, 0);
  assert.equal((await run('convert', zip, json)).code, 0);
  assert.equal((await run('convert', json, project, '--project')).code, 0);
  assert.equal((await run('convert', project, again)).code, 0);
  for (const f of ['strategy.lp', 'nature.lp', 'level/state.lp', 'level-generation.lp']) {
    assert.equal(fs.readFileSync(path.join(again, f), 'utf8'), fs.readFileSync(path.join(folder, f), 'utf8'), f);
  }
  const original = JSON.parse(fs.readFileSync(path.join(ROOT, 'examples', 'flag6-with-solutions.json'), 'utf8'));
  assert.equal(JSON.parse(fs.readFileSync(json, 'utf8')).player_move_program, original.player_move_program.replace(/\n+$/, ''));
  assert.equal(JSON.parse(fs.readFileSync(project, 'utf8')).format, 'logic-game-project');
  // A game without a level, written over a folder with a level: the level files go
  const no_level = path.join(tmp, 'no-level.json');
  fs.writeFileSync(no_level, JSON.stringify({ ...original, level_state: '', level_settings: '' }));
  assert.equal((await run('convert', no_level, folder)).code, 0);
  assert.equal(fs.existsSync(path.join(folder, 'level', 'state.lp')), false);
  assert.equal(fs.existsSync(path.join(folder, 'strategy.lp')), true);
  // Wrong uses
  const wrong_project = await run('convert', 'flag1', path.join(tmp, 'c.zip'), '--project');
  assert.equal(wrong_project.code, 1);
  assert.match(wrong_project.stderr, /ends in \.json/);
  assert.equal(fs.existsSync(path.join(tmp, 'c.zip')), false);
  const wrong_new = await run('new', path.join(tmp, 'n.zip'));
  assert.equal(wrong_new.code, 1);
  assert.match(wrong_new.stderr, /new makes a game folder/);
  const examples = await run('examples');
  assert.match(examples.stdout, /^flag1\nflag1-with-solutions\nflag2\n/);
});

test('cli: every command and option is in the guide (docs/CLI.md) and in the help', async () => {
  const guide = fs.readFileSync(path.join(ROOT, 'docs', 'CLI.md'), 'utf8');
  const help = (await run('help')).stdout;
  const source = fs.readFileSync(BIN, 'utf8');
  const options = [...source.matchAll(/^ {2}'?([\w-]+)'?: \{ type:/gm)].map((m) => m[1]).filter((o) => o !== 'help');
  assert.ok(options.length > 10);
  for (const o of options) {
    assert.ok(help.includes('--' + o), `--${o} is not in the help`);
    assert.ok(guide.includes('--' + o), `--${o} is not in docs/CLI.md`);
  }
  for (const command of ['new', 'play', 'test', 'check', 'convert', 'examples', 'grade', 'feedback']) {
    assert.ok(guide.includes('logic-game ' + command), `${command} is not in docs/CLI.md`);
  }
  // and the Instructions tab has the basics, with a link to the guide
  const instructions = fs.readFileSync(path.join(ROOT, 'docs', 'instructions.html'), 'utf8');
  assert.match(instructions, /logic-game play/);
  assert.match(instructions, /docs\/CLI\.md/);
});

// ---- Grading -----------------------------------------------------------------------------

const example = (name) => fs.readFileSync(path.join(ROOT, 'examples', name + '.json'), 'utf8');
const PDF = new TextEncoder().encode('%PDF-1.4\n%%EOF\n');

test("cli: grade Canvas' download of all submissions, then write the feedback", async (t) => {
  const tmp = tmpdir(t);
  const zip = path.join(tmp, 'submissions.zip');
  fs.writeFileSync(zip, make_zip({
    'janssenalice_1001_5001_hw3.zip': make_zip({ 'hw3/game.json': example('flag9-with-solutions'), 'hw3/report.pdf': PDF }),
    'debruijnbob_LATE_1002_5002_game.json': example('flag5-with-solutions'),
    'smitcarol_1003_5003_notes.txt': 'no game',
  }));
  const out = path.join(tmp, 'grading.json');
  const csv = path.join(tmp, 'm.csv');
  const graded = await run('grade', zip, '--levels', '2', '--out', out, '--csv', csv);
  assert.equal(graded.code, 3, graded.stderr);      // (Carol handed in no game)
  assert.match(graded.stdout, /^3 submissions, 2 levels each:\n/);
  assert.match(graded.stdout, /- debruijnbob \(1002\), late: won 2 of 2; level generation at most [\d.]+ s.*most similar: flag5-with-solutions \(100%\)\n {4}suggested: not met: novel/);
  assert.match(graded.stdout, /- janssenalice \(1001\): won 2 of 2;/);
  assert.match(graded.stdout, /- smitcarol \(1003\): No game file was found/);
  assert.match(graded.stdout, /Wrote .*grading\.json and .*m\.csv/);
  // The grading file: for the Grading tab of the web page
  const session = read_session(fs.readFileSync(out, 'utf8'));
  const alice = session.students.find((st) => st.canvas_id === '1001');
  assert.deepEqual(alice.measurements.levels.map((l) => l.verdict), ['win', 'win']);
  assert.equal(alice.suggestions.npc.value, 'yes');
  assert.deepEqual(alice.scores, {});       // (without --accept: only suggestions)
  assert.equal(alice.pdf_files, undefined);
  assert.deepEqual(alice.pdfs, ['hw3/hw3/report.pdf']);
  const lines = fs.readFileSync(csv, 'utf8').trim().split('\r\n');
  assert.match(lines[0], /^student,canvas_id,late,game,levels,won,generation_s,slowest_step_s,not_seen,npcs,/);
  assert.match(lines[1], /^debruijnbob,1002,yes,yes,2,2,[\d.]+,[\d.]+,flag,,/);
  assert.match(lines[2], /^janssenalice,1001,,yes,2,2,[\d.]+,[\d.]+,,attacker,2,/);
  assert.equal(lines[3], 'smitcarol,1003,,no');
  // Not over an existing file
  const again = await run('grade', zip, '--out', out);
  assert.equal(again.code, 1);
  assert.match(again.stderr, /already exists/);
  // With --accept, the suggestions are scores
  const accepted = path.join(tmp, 'accepted.json');
  assert.equal((await run('grade', zip, '--levels', '1', '--out', accepted, '--accept')).code, 3);
  const bob = read_session(fs.readFileSync(accepted, 'utf8')).students.find((st) => st.canvas_id === '1002');
  assert.equal(bob.scores.hidden.value, 'yes');
  assert.equal(bob.scores.novel.value, 'no');

  // The feedback of all students
  const folder = path.join(tmp, 'feedback');
  const fb = await run('feedback', accepted, folder, '--format', 'pdf,md');
  assert.equal(fb.code, 0, fb.stderr);
  assert.deepEqual(fs.readdirSync(folder).sort(), ['feedback-debruijnbob-1002.md', 'feedback-debruijnbob-1002.pdf', 'feedback-janssenalice-1001.md',
    'feedback-janssenalice-1001.pdf', 'feedback-smitcarol-1003.md', 'feedback-smitcarol-1003.pdf', 'grades.csv']);
  assert.match(fs.readFileSync(path.join(folder, 'feedback-debruijnbob-1002.md'), 'utf8'), /The game is novel \(in some way\): \*\*not met\*\*/);
  assert.equal(fs.readFileSync(path.join(folder, 'feedback-janssenalice-1001.pdf')).subarray(0, 8).toString(), '%PDF-1.4');
  assert.match(fb.stdout, /Note: 3 of them have no grade yet/);
  const wrong = await run('feedback', accepted, folder, '--format', 'docx');
  assert.equal(wrong.code, 1);
  assert.match(wrong.stderr, /--format: docx is not one of pdf, html, md/);
  assert.equal((await run('feedback', path.join(tmp, 'm.csv'), folder)).code, 1);
});

test('cli: grade folders (each folder in it: one student), with another rubric', async (t) => {
  const tmp = tmpdir(t);
  const dir = path.join(tmp, 'subs');
  fs.mkdirSync(path.join(dir, 'jane', 'report'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'jane', 'game.json'), example('flag1-with-solutions'));
  fs.writeFileSync(path.join(dir, 'jane', 'report', 'jane.pdf'), PDF);
  fs.writeFileSync(path.join(dir, 'rich.json'), example('flag2-with-solutions'));
  const rubric = path.join(tmp, 'rubric.json');
  fs.writeFileSync(rubric, JSON.stringify({ title: 'Another course', required: { grade: 5, items: [{ id: 'wins', label: 'It wins', check: 'new_levels' }] }, extra: { max: 10, items: [] } }));
  const out = path.join(tmp, 'g.json');
  const graded = await run('grade', dir, '--levels', '1', '--rubric', rubric, '--out', out);
  assert.equal(graded.code, 0, graded.stdout + graded.stderr);
  assert.match(graded.stdout, /- jane: won 1 of 1;.*\n {4}suggested: 5\n/);
  assert.match(graded.stdout, /- rich: won 1 of 1;/);
  const session = read_session(fs.readFileSync(out, 'utf8'));
  assert.equal(session.rubric.title, 'Another course');
  assert.deepEqual(session.students.find((st) => st.name === 'jane').pdfs, ['report/jane.pdf']);
  const bad = await run('grade', dir, '--rubric', path.join(tmp, 'g.json'), '--out', path.join(tmp, 'x.json'));
  assert.equal(bad.code, 1);
  assert.match(bad.stderr, /--rubric: this is not a rubric/);
});

test('importing a grading file adds the test results of students that were not tested yet', () => {
  const mine = { ...new_student({ key: 'canvas:1', name: 'jane' }), comment: 'mine', status: 'in progress', updated_at: '2026-02-01T00:00:00Z' };
  const theirs = { ...new_student({ key: 'canvas:1', name: 'jane' }), measurements: { levels: [] }, suggestions: { a: { value: 'yes' } }, updated_at: '2026-01-01T00:00:00Z' };
  const merged = merge_students([mine], [theirs]);
  assert.equal(merged.measured, 1);
  assert.equal(merged.students[0].comment, 'mine');
  assert.deepEqual(merged.students[0].measurements, { levels: [] });
  assert.deepEqual(merged.students[0].suggestions, { a: { value: 'yes' } });
});

test('cli: runs under the permission model: it only writes what the command writes, and starts no programs', async (t) => {
  const flags = permission_flags([]);
  if (!flags) return;       // (a Node version without the permission model)
  const tmp = tmpdir(t);
  const allowed = path.join(tmp, 'out');
  const probe = `
    const fs = require('node:fs');
    const { Worker } = require('node:worker_threads');
    const tries = {
      write_in: () => { fs.mkdirSync(${JSON.stringify(path.join(allowed, 'a'))}, { recursive: true }); fs.writeFileSync(${JSON.stringify(path.join(allowed, 'a', 'x.txt'))}, 'x'); },
      write_next_to: () => fs.writeFileSync(${JSON.stringify(path.join(tmp, 'outside.txt'))}, 'x'),
      read: () => fs.readFileSync(${JSON.stringify(path.join(ROOT, 'package.json'))}),
      program: () => require('node:child_process').execFileSync(process.execPath, ['-e', '1']),
      worker: () => new Worker('1', { eval: true }).terminate(),
    };
    const result = {};
    for (const [name, f] of Object.entries(tries)) {
      try { f(); result[name] = 'yes'; } catch (e) { result[name] = e.code; }
    }
    console.log(JSON.stringify(result));`;
  const result = await new Promise((resolve, reject) => {
    execFile(process.execPath, [...permission_flags([allowed]), '-e', probe], (error, stdout, stderr) => (error ? reject(error) : resolve({ stdout, stderr })));
  });
  assert.deepEqual(JSON.parse(result.stdout), { write_in: 'yes', write_next_to: 'ERR_ACCESS_DENIED', read: 'yes', program: 'ERR_ACCESS_DENIED', worker: 'yes' });
  assert.equal(result.stderr, '');      // (no warnings)
  assert.ok(fs.existsSync(path.join(allowed, 'a', 'x.txt')));
  assert.ok(!fs.existsSync(path.join(tmp, 'outside.txt')));
});

test('cli: output into a program that stops reading (e.g. head) ends quietly', async () => {
  const child = spawn(process.execPath, [BIN, 'examples'], { stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.destroy();
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d; });
  const code = await new Promise((resolve) => child.on('close', resolve));
  assert.equal(stderr, '');
  assert.equal(code, 0);
});
