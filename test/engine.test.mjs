// Tests of the solver and the game engine, with clingo-wasm from npm.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import clingo from 'clingo-wasm';
import { create_solver } from '../js/solver.js';
import {
  GAME_FIELDS, GameSession, generate_level, normalize_game, play_headless, update_player_memory, needs_history,
  test_strategy, replay_rng,
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

test('scripts are refused: in Node, Lua could run shell commands', async () => {
  const marker = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lg-script-')), 'ran');
  const lua = `#script (lua)\nos.execute("echo x > ${marker}")\n#end.\nmove(up).`;
  const result = await solver.solve([
    { source: 'engine', text: 'a.' },
    { source: 'player_move_program', text: `% my strategy\n${lua}` },
  ]);
  assert.equal(result.status, 'error');
  assert.deepEqual(result.errors.map((e) => [e.source, e.line, e.col]), [['player_move_program', 2, 1]]);
  assert.match(result.errors[0].message, /#script.*not allowed/);
  const checked = await solver.check(`a.\n${lua}`);
  assert.deepEqual(checked.map((e) => e.line), [2]);
  assert.ok(!fs.existsSync(marker), 'the script ran');
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

test('no answer set: the violated constraint is reported', async () => {
  const game = {
    ...WALK,
    player_move_program: 'do(right). do(left).',
    nature_program: '% one move per step\n:- do(X), do(Y), X != Y.\n' + WALK.nature_program,
  };
  const session = new GameSession(solver, game);
  await session.start();
  const step = await session.step();
  assert.match(step.report, /- Nature program: no answer set, because this constraint is violated:\n {4}Nature's moves, line 2: :- do\(X\), do\(Y\), X != Y\.\n {4}The player made 2 moves in this step \(do\(right\)\. do\(left\)\.\);\n {4}maybe nature allows only one move per step\.\n {2}\(state unchanged\)/);
  assert.deepEqual(step.problems[0].result.violated, [{ source: 'nature_program', line: 2, col: 1, text: ':- do(X), do(Y), X != Y.' }]);
});

test('no answer set without a violated constraint', async () => {
  const session = new GameSession(solver, { ...WALK, player_move_program: 'a :- not a.' });
  await session.start();
  const step = await session.step();
  assert.match(step.report, /- Player program: no answer set\n {2}\(no moves, memory unchanged\)/);
});

test('a program that does not terminate stops the game', async () => {
  const quick = create_solver(clingo, { timeout_ms: 500 });
  const result = await play_headless(quick, { ...WALK, nature_program: 'n(0). n(X+1) :- n(X).' });
  assert.equal(result.verdict, 'stopped');
  assert.match(result.log.at(-1), /^STOPPED! \(Nature program: clingo took longer than/);
});

test('the player remembers and forgets', async () => {
  const facts = (text) => text.split(' ').filter(Boolean).sort();
  let r = update_player_memory('', 'remember(a). remember(b).');
  assert.deepEqual(facts(r.player_memory), ['memory(a).', 'memory(b).']);
  r = update_player_memory(r.player_memory, 'forget(a). remember(c).');
  assert.deepEqual(facts(r.player_memory), ['memory(b).', 'memory(c).']);
  const unchanged = update_player_memory(r.player_memory, '');
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

test('memory: values are compared exactly, also with strings and nested terms', () => {
  const r = update_player_memory('memory(seen(1,2)). memory("a. b").', 'forget("a. b"). remember(seen(1,2)). remember(f(g(x))).');
  assert.deepEqual(r.player_memory.split(' ').sort(), ['memory(f(g(x))).', 'memory(seen(1,2)).']);
});

test('the history is only kept when a program uses it', () => {
  assert.equal(needs_history(WALK), false);
  assert.equal(needs_history({ ...WALK, goal_program: 'lose :- at_time(0,R,C,player), at(R,C,player), current_time(T), T > 1.' }), true);
  assert.equal(needs_history({ ...WALK, aux_program: 'steps(N) :- N = #count { T : state_time(T) }.' }), true);
  assert.equal(needs_history({ ...WALK, nature_program: '#include "x.lp".' }), true);   // cannot tell
  // The player's program never gets the game state
  assert.equal(needs_history({ ...WALK, player_move_program: 'x :- at_time(0,1,1,player).' }), false);
});

test('a program that uses the history still gets it', async () => {
  // Lose when the player is back where it started (needs the state at time 0)
  const game = {
    ...WALK,
    player_move_program: 'do(right) :- current_time(0).\ndo(left) :- current_time(1).',
    nature_program: WALK.nature_program + '\nnext(R,C-1,player) :- at(R,C,player), do(left).',
    goal_program: 'lose(back) :- at_time(0,R,C,player), at(R,C,player), current_time(T), T > 0.',
  };
  const result = await play_headless(solver, game);
  assert.equal(result.verdict, 'lose');
  assert.equal(result.steps, 3);
});

test('keeping only the latest time slice gives the same game', async () => {
  const strip = (log) => log.map((x) => x.replace(/- Time in clingo: .*\n/g, ''));
  for (const { name, game } of load_examples().filter((e) => /flag(5|8|11)-with-solutions(-a)?\.json/.test(e.name))) {
    const level = await generate_level(solver, normalize_game(game), seeded_rng(3));
    const full = await play_headless(solver, { ...game, ...level }, { rng: seeded_rng(4), keep_history: true });
    const latest = await play_headless(solver, { ...game, ...level }, { rng: seeded_rng(4) });
    assert.equal(latest.verdict, full.verdict, name);
    assert.deepEqual(strip(latest.log), strip(full.log), name);
  }
});

test('the time in clingo is reported, and slow programs get a note', async () => {
  const session = new GameSession(solver, WALK, { slow_ms: -1 });
  await session.start();
  const step = await session.step();
  assert.deepEqual(Object.keys(step.times).sort(), ['goal', 'nature', 'player', 'visibility']);
  assert.match(step.report, /- Time in clingo: winning conditions \d+ ms, player's program \d+ ms, nature's program \d+ ms, visibility program \d+ ms\n/);
  assert.match(step.report, /- Note: the player's program took 0\.\d seconds in this step/);
  const quiet = new GameSession(solver, WALK, { verbose: false });
  await quiet.start();
  assert.doesNotMatch((await quiet.step()).report, /Time in clingo|Note/);
});

test('testing a strategy on many levels is reproducible', async () => {
  const { game } = load_examples().find((e) => e.name === 'flag3-with-solutions.json');
  const weak = { ...game, player_move_program: 'do(move(down)) :- observe(at(R1,C,player)), observe(at(R2,C,flag)), R1 < R2.' };
  const seen = [];
  const first = await test_strategy(solver, weak, { levels: 5, first_seed: 10, on_level: (r) => seen.push(r.seed) });
  assert.deepEqual(seen, [10, 11, 12, 13, 14]);
  assert.deepEqual(await test_strategy(solver, weak, { levels: 5, first_seed: 10 }), first);
  // A level of the test, played again with replay_rng, ends the same way
  const lost = first.find((r) => r.verdict !== 'win');
  assert.ok(lost, JSON.stringify(first));
  const { rng, level } = await replay_rng(solver, weak, lost.seed);
  const again = await play_headless(solver, { ...weak, ...level }, { rng, verbose: false });
  assert.equal(again.verdict, lost.verdict);
  assert.equal(again.steps, lost.steps);
  // The solution wins everywhere; cancelling stops the test
  assert.ok((await test_strategy(solver, game, { levels: 3 })).every((r) => r.verdict === 'win'));
  let n = 0;
  assert.equal((await test_strategy(solver, game, { levels: 10, on_level: () => { n += 1; }, cancelled: () => n >= 2 })).length, 2);
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
  assert.equal(version, `clingo-wasm ${pkg.dependencies['clingo-wasm']}`,
    'run "npm run vendor" after changing the version of clingo-wasm');
  const dist = path.join(ROOT, 'node_modules', 'clingo-wasm', 'dist');
  for (const f of ['index.web.js', 'clingo.js', 'clingo.wasm']) {
    assert.ok(fs.readFileSync(path.join(dist, f)).equals(fs.readFileSync(path.join(ROOT, 'vendor', 'clingo-wasm', f))),
      `vendor/clingo-wasm/${f} differs from node_modules: run "npm run vendor"`);
  }
});

test('calls made while clingo is loading wait for it, without their time limit running', async () => {
  const s = create_solver(clingo, { timeout_ms: 300 });
  // (a download that takes longer than the time limit of a call)
  const download = new Promise((resolve) => setTimeout(() => resolve(undefined), 800));
  const loading = s.init(download);
  const result = await s.solve(['a.']);
  assert.deepEqual(result, { status: 'ok', atoms: ['a'] });
  await loading;
});
