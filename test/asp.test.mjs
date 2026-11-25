// Unit tests for the text helpers (no clingo needed).
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  compose, preprocess_program, filter_answer_set, answer_set_to_facts,
  answer_set_to_fact_lines, parse_clingo_errors, locate_errors, facts_to_answer_set, split_atom,
} from '../js/asp.js';
import { compute_grid_ds, split_answer_set, flatparse_atom } from '../js/grid-visual.js';
import { seeded_rng } from './helpers.mjs';

test('compose keeps track of the lines of each part', () => {
  const { text, segments } = compose([
    { source: 'a', text: 'x.\ny.' },
    'z.',
    { source: 'b', text: 'w :- z.\n% comment\nv.' },
  ]);
  assert.equal(text, 'x.\ny.\nz.\nw :- z.\n% comment\nv.');
  assert.deepEqual(segments, [
    { source: 'a', first_line: 1, line_count: 2 },
    { source: null, first_line: 3, line_count: 1 },
    { source: 'b', first_line: 4, line_count: 3 },
  ]);
});

test('a comment at the end of a part does not swallow the next part', () => {
  const { text } = compose(['a. % comment', 'b.']);
  assert.equal(text.split('\n')[1], 'b.');
});

test('locate_errors maps lines back to parts', () => {
  const { segments } = compose([{ source: 'a', text: 'x.\ny.' }, { source: 'b', text: 'p.\nq(.' }]);
  const errors = [{ line: 4, col: 3, end_line: 4, end_col: 4, severity: 'error', message: 'oops' }];
  assert.deepEqual(locate_errors(errors, segments), [
    { line: 2, col: 3, end_line: 2, end_col: 4, severity: 'error', message: 'oops', source: 'b' },
  ]);
  assert.equal(locate_errors([{ line: null, col: null, message: 'x' }], segments)[0].source, null);
});

test('RANDINT is replaced by a number in range, keeping columns and lines', () => {
  const rng = seeded_rng(1);
  for (let i = 0; i < 200; i++) {
    const program = 'at(RANDINT(1,3),RANDINT( -2 , 2 ),player). x(RANDINT(5,\n5)).';
    const out = preprocess_program(program, rng);
    assert.equal(out.length, program.length);
    assert.equal(out.split('\n').length, 2);
    const m = /^at\((\d+) *,(-?\d+) *,player\)\. x\((\d+) *\n *\)\.$/.exec(out);
    assert.ok(m, out);
    assert.ok(Number(m[1]) >= 1 && Number(m[1]) <= 3);
    assert.ok(Number(m[2]) >= -2 && Number(m[2]) <= 2);
    assert.equal(Number(m[3]), 5);
  }
});

test('filtering and writing answer sets', () => {
  const atoms = ['do(move(up))', 'done', 'remember(x)', 'forget(y)', 'dog(1)'];
  assert.deepEqual(filter_answer_set(atoms, ['do']), ['do(move(up))']);
  assert.deepEqual(filter_answer_set(atoms, ['done', 'forget']), ['done', 'forget(y)']);
  assert.equal(answer_set_to_facts(['a', 'b(1)']), 'a. b(1).');
  assert.equal(answer_set_to_facts([]), '');
  assert.equal(answer_set_to_fact_lines(['a', 'b(1)']), 'a.\nb(1).');
});

test('parse_clingo_errors reads locations, ranges and notes', () => {
  const errors = parse_clingo_errors([
    '-:1:9-10: error: syntax error, unexpected ., expecting ) or ;',
    '',
    '-:2:1-3:5: error: unsafe variables in:',
    '  a(X):-[#inc_base];not b(X).',
    "-:2:3-4: note: 'X' is unsafe",
    '',
    '*** ERROR: (clingo): grounding stopped because of errors',
  ].join('\n'));
  assert.deepEqual(errors, [
    { line: 1, col: 9, end_line: 1, end_col: 10, severity: 'error', message: 'syntax error, unexpected ., expecting ) or ;' },
    { line: 2, col: 1, end_line: 3, end_col: 5, severity: 'error', message: "unsafe variables in: a(X):-not b(X).; 'X' is unsafe" },
  ]);
});

test('parse_clingo_errors falls back to the summary', () => {
  assert.deepEqual(parse_clingo_errors('*** ERROR: (clingo): something went wrong'), [
    { line: null, col: null, end_line: null, end_col: null, severity: 'error', message: 'something went wrong' },
  ]);
  assert.deepEqual(parse_clingo_errors(''), []);
});

test('the board is computed from the observed facts', () => {
  const facts = 'setting(grid_height(2)). setting(grid_width(3)). observe(at(1,2,player)). ' +
    'observe(fog(2,3)). decorate(label,player,font_f007). decorate(item,2,1,flag).';
  assert.deepEqual(split_answer_set('a(1,2). b.'), ['a(1,2)', 'b']);
  assert.deepEqual(flatparse_atom('at(1,f(2,3),x)'), ['at', '1', 'f(2,3)', 'x']);
  const grid = compute_grid_ds(facts);
  assert.equal(grid.height, 2);
  assert.equal(grid.width, 3);
  assert.deepEqual(grid[2], ['player']);
  assert.equal(grid.fog[6], true);
  assert.deepEqual(grid.hidden[4], ['flag']);
  assert.equal(grid.labels.player, 'font_f007');
  // No grid size: nothing to draw (instead of an exception)
  assert.equal(compute_grid_ds('observe(at(1,1,player)).'), null);
  // Items outside of the grid are ignored
  assert.deepEqual(compute_grid_ds('setting(grid_height(1)). setting(grid_width(1)). observe(at(5,5,x)).')[1], []);
});

test('reading facts and atoms back', () => {
  const atoms = ['a', 'b(1,-2)', 'c("x. y",f(g(1),"(,)"))', 'd("a\\"b. c")', 'e((1,2))'];
  assert.deepEqual(facts_to_answer_set(answer_set_to_facts(atoms)), atoms);
  assert.deepEqual(facts_to_answer_set(''), []);
  assert.deepEqual(split_atom('at(1,f(2,3),"a,b")'), { name: 'at', args: ['1', 'f(2,3)', '"a,b"'] });
  assert.deepEqual(split_atom('win'), { name: 'win', args: [] });
  assert.deepEqual(split_atom('e((1,2))'), { name: 'e', args: ['(1,2)'] });
});
