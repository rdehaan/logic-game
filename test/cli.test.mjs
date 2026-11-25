// Tests of the command-line version (bin/logic-game.mjs), with clingo-wasm from npm.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { ROOT } from './helpers.mjs';
import { text_board } from '../js/text-board.js';

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
  for (const command of ['new', 'play', 'test', 'check', 'convert', 'examples']) {
    assert.ok(guide.includes('logic-game ' + command), `${command} is not in docs/CLI.md`);
  }
  // and the Instructions tab has the basics, with a link to the guide
  const instructions = fs.readFileSync(path.join(ROOT, 'docs', 'instructions.html'), 'utf8');
  assert.match(instructions, /logic-game play/);
  assert.match(instructions, /docs\/CLI\.md/);
});
