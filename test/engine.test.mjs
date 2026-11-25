// Tests of the solver and the game engine, with clingo-wasm from npm.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import clingo from 'clingo-wasm';
import { create_solver } from '../js/solver.js';
import {
  GAME_FIELDS, GameSession, generate_level, normalize_game, play_headless, update_player_memory,
} from '../js/engine.js';
import { preprocess_program } from '../js/asp.js';
import { ROOT, seeded_rng, load_examples, examples_in_page } from './helpers.mjs';

const solver = create_solver(clingo);

// ---- The solver ----------------------------------------------------------------

test('solve: answer set, no answer set', async () => {
  assert.deepEqual(await solver.solve(['a.', 'b :- a.']), { status: 'ok', atoms: ['a', 'b'] });
  assert.deepEqual(await solver.solve(['a.', ':- a.']), { status: 'unsat' });
});

test('solve: errors are traced back to the part they are in', async () => {
  const result = await solver.solve([
    { source: 'engine', text: 'a.\nb.' },
    { source: 'player_move_program', text: 'c.\nd :- e(X.' },
  ]);
  assert.equal(result.status, 'error');
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].source, 'player_move_program');
  assert.equal(result.errors[0].line, 2);
  assert.equal(result.errors[0].col, 9);
  assert.match(result.errors[0].message, /syntax error/);
});

test('solve: unsafe variables are reported', async () => {
  const result = await solver.solve([{ source: 'goal_program', text: 'win :- at(R,C,player).\nlose(X) :- foo.' }]);
  assert.equal(result.status, 'error');
  assert.deepEqual(result.errors.map((e) => [e.source, e.line]), [['goal_program', 2]]);
  assert.match(result.errors[0].message, /unsafe variables.*'X' is unsafe/);
});

test('check: syntax errors and unsafe variables, without grounding', async () => {
  assert.deepEqual(await solver.check('a(1..3).\nb(X) :- a(X).'), []);
  const syntax = await solver.check('a.\nb :- c(.');
  assert.equal(syntax.length, 1);
  assert.equal(syntax[0].line, 2);
  const unsafe = await solver.check('a.\n\nb(X) :- not c(X).');
  assert.equal(unsafe.length, 1);
  assert.equal(unsafe[0].line, 3);
  // A program that would not terminate when grounded is not grounded
  assert.deepEqual(await solver.check('n(0). n(X+1) :- n(X).'), []);
});

test('a call that takes too long is stopped, and clingo keeps working', async () => {
  const quick = create_solver(clingo, { timeout_ms: 500 });
  const t0 = Date.now();
  assert.deepEqual(await quick.solve(['n(0). n(X+1) :- n(X).']), { status: 'timeout' });
  assert.ok(Date.now() - t0 < 5000);
  assert.deepEqual(await quick.solve(['a.']), { status: 'ok', atoms: ['a'] });
});

test('abort() stops a running call', async () => {
  const s = create_solver(clingo, { timeout_ms: 60000 });
  const pending = s.solve(['n(0). n(X+1) :- n(X).']);
  await new Promise((resolve) => setTimeout(resolve, 300));
  await s.abort();
  assert.deepEqual(await pending, { status: 'aborted' });
  assert.deepEqual(await s.solve(['a.']), { status: 'ok', atoms: ['a'] });
});

// ---- The engine ------------------------------------------------------------------

const GRID = 'setting(grid_width(3)). setting(grid_height(1)).\nsetting(row(1)). setting(col(1..3)).';

// A tiny game: walk right until the flag.
const WALK = normalize_game({
  aux_program: 'cell(R,C) :- setting(row(R)), setting(col(C)).',
  visibility_program: 'observe(at(R,C,O)) :- at(R,C,O).',
  player_move_program: 'do(right).',
  nature_program: 'next(R,C+1,player) :- at(R,C,player), do(right), cell(R,C+1).\nnext(R,C,flag) :- at(R,C,flag).',
  goal_program: 'win :- at(R,C,player), at(R,C,flag).\nlose(timeout) :- current_time(T), T >= 10.',
  level_state: 'at(1,1,player).\nat(1,3,flag).',
  level_settings: GRID,
});

test('a small game is won', async () => {
  const result = await play_headless(solver, WALK);
  assert.equal(result.verdict, 'win');
  assert.equal(result.steps, 3);
  assert.match(result.log.at(-1), /^WIN! \(win\)/);
});

test('winning conditions are checked before the first move', async () => {
  const result = await play_headless(solver, { ...WALK, level_state: 'at(1,3,player).\nat(1,3,flag).' });
  assert.equal(result.verdict, 'win');
  assert.equal(result.steps, 1);
});

test('the engine stops after max_time steps', async () => {
  const result = await play_headless(solver, { ...WALK, goal_program: '' }, { max_time: 4 });
  assert.equal(result.verdict, 'timeout');
  assert.equal(result.steps, 5);
});

test('an error in the player program is reported with its line, and the game goes on', async () => {
  const game = { ...WALK, player_move_program: '% walk\ndo(right) :- observe(at(R,C,player).' };
  const session = new GameSession(solver, game);
  await session.start();
  const step = await session.step();
  assert.equal(step.verdict, null);
  assert.match(step.report, /Player program: error:\n {4}Player strategy, line 2, column 36: syntax error/);
  assert.match(step.report, /\(no moves, memory unchanged\)/);
  assert.equal(step.problems[0].result.errors[0].source, 'player_move_program');
});

test('a program that does not terminate stops the game', async () => {
  const quick = create_solver(clingo, { timeout_ms: 500 });
  const result = await play_headless(quick, { ...WALK, nature_program: 'n(0). n(X+1) :- n(X).' });
  assert.equal(result.verdict, 'stopped');
  assert.match(result.log.at(-1), /^STOPPED! \(Nature program: clingo took longer than/);
});

test('the player remembers and forgets', async () => {
  const facts = (text) => text.split(' ').filter(Boolean).sort();
  let r = await update_player_memory(solver, '', 'remember(a). remember(b).');
  assert.deepEqual(facts(r.player_memory), ['memory(a).', 'memory(b).']);
  r = await update_player_memory(solver, r.player_memory, 'forget(a). remember(c).');
  assert.deepEqual(facts(r.player_memory), ['memory(b).', 'memory(c).']);
  const unchanged = await update_player_memory(solver, r.player_memory, '');
  assert.equal(unchanged.player_memory, r.player_memory);
});

test('nature can wipe the player memory', async () => {
  const game = {
    ...WALK,
    player_move_program: 'do(right). remember(seen).',
    nature_program: WALK.nature_program + '\nwipe_player_memory :- current_time(1).',
  };
  const result = await play_headless(solver, game);
  assert.match(result.log.join('\n'), /Player memory wiped by nature/);
});

// ---- The examples -----------------------------------------------------------------

const examples = load_examples();

test('every example listed in the page exists', () => {
  const names = new Set(examples.map((e) => e.name));
  for (const name of examples_in_page()) assert.ok(names.has(name), name);
});

test('the programs of the examples have no syntax errors', async () => {
  for (const { name, game } of examples) {
    for (const field of GAME_FIELDS) {
      const errors = await solver.check(preprocess_program(game[field] || ''));
      assert.deepEqual(errors, [], `${name}: ${field}`);
    }
  }
});

for (const { name, game } of examples.filter((e) => e.name.includes('with-solutions'))) {
  test(`${name}: the solution wins`, async () => {
    for (const seed of [1, 2]) {
      const rng = seeded_rng(seed);
      const level = await generate_level(solver, normalize_game(game), rng);
      assert.equal(level.problem, null);
      const result = await play_headless(solver, { ...game, ...level }, { rng });
      assert.equal(result.verdict, 'win', `seed ${seed}: ${result.log.at(-1)}`);
      assert.doesNotMatch(result.log.join('\n'), /error/, `seed ${seed}`);
    }
  });
}

// ---- The vendored copy of clingo-wasm -----------------------------------------------

test('vendor/clingo-wasm is the clingo-wasm package from package.json', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const version = fs.readFileSync(path.join(ROOT, 'vendor', 'clingo-wasm', 'VERSION'), 'utf8').split('\n')[0];
  assert.equal(version, `clingo-wasm ${pkg.devDependencies['clingo-wasm']}`,
    'run "npm run vendor" after changing the version of clingo-wasm');
  const dist = path.join(ROOT, 'node_modules', 'clingo-wasm', 'dist');
  for (const f of ['index.web.js', 'clingo.js', 'clingo.wasm']) {
    assert.ok(fs.readFileSync(path.join(dist, f)).equals(fs.readFileSync(path.join(ROOT, 'vendor', 'clingo-wasm', f))),
      `vendor/clingo-wasm/${f} differs from node_modules: run "npm run vendor"`);
  }
});
