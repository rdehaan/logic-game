// Tests of the program analysis and the hints about special predicates (no clingo needed).
import test from 'node:test';
import assert from 'node:assert/strict';
import { analyze_program, parse_term, terms_match, relax_constraints, tokenize } from '../js/analysis.js';
import { game_hints, board_problems, special_help, completions, SPECIAL_DOCS, INTERFACES } from '../js/hints.js';
import { load_examples } from './helpers.mjs';

const sigs = (text, role) => [...new Set(analyze_program(text).atoms.filter((a) => a.role === role).map((a) => `${a.name}/${a.arity}`))].sort();

test('heads and bodies', () => {
  const p = 'a. b(X) :- c(X), not d(X,1).\n:- e.\nf(1..3;5).';
  assert.deepEqual(sigs(p, 'head'), ['a/0', 'b/1', 'f/1']);
  assert.deepEqual(sigs(p, 'body'), ['c/1', 'd/2', 'e/0']);
  assert.equal(analyze_program(p).complete, true);
});

test('terms in comparisons and arguments are not atoms', () => {
  const p = 'p(D) :- dir(D), D != left, X = f(1), X < g, h(a(b)).\nq :- T = #max { S : s(S) }, T > 3.';
  assert.deepEqual(sigs(p, 'body'), ['dir/1', 'h/1', 's/1']);
  assert.deepEqual(sigs(p, 'head'), ['p/1', 'q/0']);
});

test('choices, aggregates and conditions', () => {
  const p = '1 { do(move(D)) : direction(D) } 1 :- go.\n' +
    'n(N) :- N = #count { X,Y : at(X,Y,O), O != wall ; 1 : extra }.\n' +
    'all :- ok(X) : item(X).\n' +
    'a(X) : b(X) :- c.\n' +
    '#minimize { 1,X : cost(X) }.\n' +
    '#show x : shown.\n' +
    '#heuristic h(X) : hh(X). [1, true]\n' +
    ':~ w(X). [X@1]\n' +
    '#external ext(1).\n' +
    '#defined decl/2.';
  assert.deepEqual(sigs(p, 'head'), ['a/1', 'all/0', 'decl/2', 'do/1', 'ext/1', 'n/1']);
  assert.deepEqual(sigs(p, 'body'), ['at/3', 'b/1', 'c/0', 'cost/1', 'direction/1', 'extra/0', 'go/0', 'h/1', 'hh/1', 'item/1', 'ok/1', 'shown/0', 'w/1']);
  assert.equal(analyze_program(p).complete, true);
});

test('positions of atoms', () => {
  const [atom] = analyze_program('% comment\n  foo(X, bar) :- baz(X).').atoms;
  assert.deepEqual([atom.name, atom.arity, atom.line, atom.col, atom.end_col], ['foo', 2, 2, 3, 14]);
});

test('comments, strings and scripts are skipped', () => {
  const p = '%* block\n a :- b. *%\nx("a. b :- c.").\n#script (lua)\nfunction f() return 1 end\n#end.\ny :- x(_).';
  assert.deepEqual(sigs(p, 'head'), ['x/1', 'y/0']);
  assert.deepEqual(sigs(p, 'body'), ['x/1']);
  assert.equal(tokenize('a. $'), null);
});

test('programs that cannot be analyzed are marked as incomplete', () => {
  assert.equal(analyze_program('#include "x.lp".\na.').complete, false);
  assert.equal(analyze_program('&diff { x - y } <= 2.').complete, false);
  assert.equal(analyze_program('a :- b').complete, false);
});

test('terms and matching', () => {
  const term = (text) => {
    const tokens = tokenize(text);
    return parse_term(tokens, 0, tokens.length);
  };
  assert.deepEqual(term('move(up)'), { kind: 'fun', name: 'move', args: [{ kind: 'fun', name: 'up', args: [] }] });
  assert.equal(term('X+1').kind, 'any');
  assert.ok(terms_match(term('move(D)'), term('move(up)')));
  assert.ok(!terms_match(term('move(D)'), term('up')));
  assert.ok(!terms_match(term('at(R,C)'), term('at(R,C,O)')));
  assert.ok(terms_match(term('1..3'), term('2')));
  assert.ok(terms_match(term('-1'), term('-1')));
});

test('relaxing constraints keeps lines and columns', () => {
  const r = relax_constraints('a.\n:- a, b.\n  :- c.', (i) => `v(${i})`);
  assert.equal(r.text, 'a.\nv(0) :- a, b.\n  v(1) :- c.');
  assert.deepEqual(r.constraints, [{ line: 2, col: 1, text: ':- a, b.' }, { line: 3, col: 3, text: ':- c.' }]);
});

// ---- Hints ---------------------------------------------------------------------------

const GAME = {
  aux_program: 'cell(R,C) :- setting(row(R)), setting(col(C)).',
  level_gen_program: 'setting(grid_width(3)). setting(grid_height(1)).\nsetting(row(1)). setting(col(1..3)).\nat(1,1,player). at(1,3,flag).',
  visibility_program: 'observe(at(R,C,O)) :- at(R,C,O).',
  player_move_program: 'do(move(right)) :- observe(at(R,C,player)).',
  nature_program: ':- do(X), do(Y), X != Y.\nnext(R,C+1,player) :- at(R,C,player), do(move(right)).\nnext(R,C,O) :- at(R,C,O), O != player.',
  goal_program: 'win :- at(R,C,player), at(R,C,flag).\nlose(timeout) :- current_time(T), T >= 10.',
  level_state: 'at(1,1,player).\nat(1,3,flag).',
  level_settings: 'setting(grid_width(3)).\nsetting(grid_height(1)).',
};

function hints_for(changes, field) {
  return game_hints({ ...GAME, ...changes })[field].map((h) => `${h.line}:${h.severity}: ${h.message}`);
}

test('a correct game gets no hints', () => {
  for (const [field, list] of Object.entries(game_hints(GAME))) assert.deepEqual(list, [], field);
});

test('the example games get no warnings', () => {
  for (const { name, game } of load_examples()) {
    for (const [field, list] of Object.entries(game_hints(game))) {
      const warnings = list.filter((h) => h.severity !== 'info');
      // The examples without solutions have no player's program yet
      assert.deepEqual(warnings, [], `${name}: ${field}`);
    }
  }
});

test('a player program without moves', () => {
  assert.match(hints_for({ player_move_program: 'remember(x).' }, 'player_move_program')[0], /^null:warning: This program never derives do\/1, so the player never makes a move/);
  assert.match(hints_for({ player_move_program: '% my strategy' }, 'player_move_program')[0], /^null:info: This program has no rules yet/);
});

test('the player uses at/3 instead of observe/1', () => {
  assert.deepEqual(hints_for({ player_move_program: 'do(move(right)) :- at(R,C,player).' }, 'player_move_program'),
    ['1:warning: at/3 never holds here: the player does not see the state of the game directly, only what the visibility program lets it observe, as observe(...) atoms (such as observe(at(R,C,O))).']);
});

test('wrong number of arguments, and misspelled predicates', () => {
  const hints = hints_for({ player_move_program: 'do(move,right).\nremeber(x).\nrember(1,2).\nfoo :- obsrve(at(R,C,O)).\ndo(move(right)) :- observe(at(R,C)).' }, 'player_move_program');
  assert.ok(hints.includes('1:warning: do/2 is derived, but only do/1 is passed on (with 1 argument): check the number of arguments.'), hints.join('\n'));
  assert.ok(hints.includes('2:warning: remeber/1 is derived but never used, and it is not passed on. Did you mean remember/1?'), hints.join('\n'));
  assert.ok(hints.includes('3:warning: rember/2 is derived but never used, and it is not passed on. Did you mean remember/1?'), hints.join('\n'));
  assert.ok(hints.some((h) => /^4:warning: obsrve\/1 never holds: .* Did you mean observe\/1\?$/.test(h)), hints.join('\n'));
  assert.ok(hints.includes('5:warning: observe(at(_,_)) never holds: the visibility program only derives observe(at(_,_,_)). (_ stands for anything.)'), hints.join('\n'));
});

test('predicates of other programs', () => {
  assert.deepEqual(hints_for({ player_move_program: 'do(move(right)).\nnext(1,1,player).' }, 'player_move_program'),
    ["2:warning: next/3 is not passed on from the player's program: only nature's program passes on next/3. This program passes on do/1, remember/1, forget/1."]);
  assert.deepEqual(hints_for({ nature_program: GAME.nature_program + '\nnext(R,C,O) :- observe(at(R,C,O)).' }, 'nature_program'),
    ["4:warning: observe/1 never holds here: nature's program does not get observe/1 (only the player's program gets it). It gets at/3, at_time/4, state_time/1, current_time/1, do/1, setting/1, decorate."]);
});

test('moves that nature does not react to', () => {
  assert.deepEqual(hints_for({ player_move_program: 'do(right).' }, 'player_move_program'),
    ["1:warning: Nature's program does not react to moves like do(right): it only looks at do(move(right))."]);
});

test('memory without remember, and remembering the wrong thing', () => {
  assert.deepEqual(hints_for({ player_move_program: 'do(move(right)) :- not memory(seen).' }, 'player_move_program'),
    ['1:warning: memory/1 never holds: memory(X) holds only for what the player remembered earlier with remember(X), and this program never derives remember/1.']);
  assert.deepEqual(hints_for({ player_move_program: 'do(move(right)) :- not memory(seen(flag)).\nremember(seen).' }, 'player_move_program'),
    ['1:warning: memory(seen(flag)) never holds: this program only remembers remember(seen).']);
});

test('settings that level generation does not derive', () => {
  assert.deepEqual(hints_for({ player_move_program: 'do(move(right)) :- setting(width(W)).' }, 'player_move_program'),
    ['1:warning: setting(width(_)) never holds: level generation or the level settings only derives setting(grid_width(3)), setting(grid_height(1)), setting(row(1)), setting(col(..)). (_ stands for anything.)']);
});

test('nature without next/3, and goals without win or lose', () => {
  assert.match(hints_for({ nature_program: 'moved :- do(X).' }, 'nature_program').join('\n'), /never derives next\/3, so the board is empty after the first step/);
  assert.deepEqual(hints_for({ goal_program: 'done :- at(1,3,player).' }, 'goal_program'), [
    'null:info: This program never derives win, so the game cannot be won.',
    'null:warning: This program never derives win or lose, so the game only ends when the engine stops it after 500 steps.',
    '1:info: done/0 is derived but never used, and it is not passed on (this program passes on win, lose).',
  ]);
});

test('programs with syntax errors are skipped', () => {
  const hints = game_hints({ ...GAME, player_move_program: 'do(right).' }, new Set(['player_move_program']));
  assert.deepEqual(hints.player_move_program, []);
});

test('problems with the board', () => {
  assert.deepEqual(board_problems('setting(grid_width(3)).', ''), ['The board cannot be drawn: the level settings have no setting(grid_height(H)).']);
  assert.deepEqual(board_problems('setting(grid_width(3)). setting(grid_height(1)).', 'at(1,1,player).\nat(2,4,flag).'),
    ['at(2,4,flag) is outside of the board (rows 1-1, columns 1-3).']);
  assert.deepEqual(board_problems('setting(grid_width(3)). setting(grid_height(1)).', 'at(1,1,player).'), []);
});

test('help about special predicates, per program', () => {
  assert.match(special_help('player_move_program', 'do/1').text, /This program passes it on to nature's program\.$/);
  assert.match(special_help('nature_program', 'do/1').text, /This program gets it from the game\.$/);
  assert.match(special_help('player_move_program', 'at/3').text, /The player's program does not get it/);
  assert.equal(special_help('goal_program', 'win/0').title, 'win');
  assert.equal(special_help('player_move_program', 'foo/1'), null);
  // every special predicate of every program has help
  for (const iface of Object.values(INTERFACES)) {
    for (const s of [...iface.inputs, ...iface.outputs]) assert.ok(SPECIAL_DOCS[s] || SPECIAL_DOCS[s.replace(/\/\d+$/, '/*')], s);
  }
});

test('completions: the special predicates, then what the programs define', () => {
  const list = completions('player_move_program', { aux_program: 'cell(R,C) :- setting(row(R)), setting(col(C)).', player_move_program: 'go(X) :- observe(X).\ndone.' });
  assert.deepEqual(list.map((c) => `${c.caption}:${c.meta}:${c.value}`), [
    'observe/1:gets:observe(', 'setting/1:gets:setting(', 'current_time/1:gets:current_time(', 'memory/1:gets:memory(',
    'do/1:passes on:do(', 'remember/1:passes on:remember(', 'forget/1:passes on:forget(',
    'cell/2:auxiliary:cell(', 'go/1:defined here:go(', 'done/0:defined here:done',
  ]);
  assert.match(list[0].doc, /^observe\(X\): what the player observes/);
});
