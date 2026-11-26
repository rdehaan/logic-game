// Tests of the feedback documents (Markdown, web page, PDF) and of the PDF writer.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_RUBRIC, read_rubric, new_student } from '../js/grading.js';
import { feedback_model, feedback_markdown, feedback_html, feedback_pdf, feedback_name } from '../js/feedback.js';
import { PdfDocument, wrap, text_width, pdf_text } from '../js/pdf.js';
import { load_examples } from './helpers.mjs';

const rubric = read_rubric(DEFAULT_RUBRIC);
const game = load_examples().find((x) => x.name === 'flag9-with-solutions.json').game;

function graded() {
  const st = new_student({ key: 'canvas:1', name: 'doejane', canvas_id: '101', game });
  st.scores = {
    timing: { value: 'yes' }, novel: { value: 'yes', note: 'A <new> idea' }, documented: { value: 'yes' },
    visual: { value: 'no' }, hidden: { value: 'yes', points: 0.5 }, npc: { value: 'yes' }, random: { value: 'yes' },
    new_levels: { value: 'yes' }, memory: { value: '' },
  };
  st.comment = 'Well done.\nThe strategy is clever — nice!';
  st.line_notes = [{ field: 'player_move_program', line: 2, text: 'Why 2*W?', quote: null }];
  st.images = [{ caption: 'The start', facts: '' }];
  return st;
}

test('the feedback: grade, items, comment, notes on lines, pictures', () => {
  const model = feedback_model(rubric, graded());
  assert.equal(model.student, 'doejane');
  assert.match(model.grade_text, /^8.5 so far \(1 item not decided\)/);      // 6 + 0.5 + 1 + 0.5 + 0.5, memory not decided
  assert.deepEqual(model.items.map((i) => i.result), ['met', 'met', 'met', '0', '+0.5', '+1', '+0.5', '+0.5', 'not decided']);
  assert.equal(model.line_notes[0].program, 'Player strategy');
  assert.equal(model.line_notes[0].quote, game.player_move_program.split('\n')[1]);
  assert.equal(model.tests, null);      // (only when the grader chooses so)

  const md = feedback_markdown(model);
  assert.match(md, /^# Knowledge Representation and Reasoning 2026/);
  assert.match(md, /\*\*Student:\*\* doejane \(101\)/);
  assert.match(md, /The game is novel \(in some way\): \*\*met\*\* — A \\<new\\> idea/);
  assert.match(md, /## Notes on the programs\n\n\*\*Player strategy, line 2:\*\* Why 2\\\*W\?/);
  assert.match(md, /Picture 1: The start/);

  const html = feedback_html(model, [{ data_url: 'data:image/png;base64,AAAA' }]);
  assert.match(html, /^<!DOCTYPE html>/);
  assert.ok(html.includes('A &lt;new&gt; idea'));
  assert.ok(!html.includes('<new>'));
  assert.ok(html.includes('<img src="data:image/png;base64,AAAA"'));
  // (only images, nothing else, as the source of a picture)
  assert.ok(!feedback_html(model, [{ data_url: 'javascript:alert(1)' }]).includes('javascript:'));
  assert.equal(feedback_name({ name: 'De Haan, Jé', canvas_id: '7' }), 'feedback-De-Haan-Je-7');
});

test('the feedback with test results', () => {
  const st = graded();
  st.include_tests = true;
  st.measurements = {
    levels: [{ seed: 1, verdict: 'win', steps: 10, message: 'WIN!' }, { seed: 2, verdict: 'lose', steps: 7, message: 'LOSE! (lose(caught))' }],
    generation_ms: [120, 300], program_ms: { player: { max: 250, total: 400, steps: 17 } },
  };
  const model = feedback_model(rubric, st);
  assert.match(model.tests.lines[0], /Played 2 new levels .*: 1 won, 1 lost\./);
  assert.match(model.tests.lines[1], /at most 0\.3 seconds/);
  assert.match(model.tests.lines[2], /strategy 0\.25 s/);
  assert.deepEqual(model.tests.failed, ['Level 2: LOSE! (lose(caught)) (after 7 steps)']);
  assert.match(feedback_markdown(model), /## Test results/);
});

// The text of a PDF file that pdf.js wrote (its streams are not compressed).
const pdf_strings = (bytes) => [...Buffer.from(bytes).toString('latin1').matchAll(/\((.*?)\) Tj/g)].map((m) => m[1]);

function check_pdf_structure(bytes) {
  const text = Buffer.from(bytes).toString('latin1');
  assert.ok(text.startsWith('%PDF-1.4'));
  assert.ok(text.trimEnd().endsWith('%%EOF'));
  // The cross-reference table points to the objects
  const xref = Number(/startxref\n(\d+)/.exec(text)[1]);
  assert.ok(text.slice(xref).startsWith('xref'));
  const offsets = [...text.slice(xref).matchAll(/^(\d{10}) 00000 n $/gm)].map((m) => Number(m[1]));
  offsets.forEach((off, i) => assert.ok(text.slice(off).startsWith(`${i + 1} 0 obj`), `object ${i + 1}`));
  // Every stream has the length it says
  for (const m of text.matchAll(/\/Length (\d+)[^>]*>>\nstream\n/g)) {
    const start = m.index + m[0].length;
    assert.equal(text.slice(start + Number(m[1]), start + Number(m[1]) + 10), '\nendstream');
  }
  return text;
}

test('the feedback as a PDF file', () => {
  const jpeg = { bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), width: 40, height: 20 };
  const bytes = feedback_pdf(feedback_model(rubric, graded()), [jpeg]);
  const text = check_pdf_structure(bytes);
  const strings = pdf_strings(bytes);
  assert.ok(strings.includes('Student: doejane \\(101\\)'), strings.slice(0, 5).join(' | '));
  assert.ok(strings.some((s) => s.includes('The strategy is clever \x97 nice!')));      // (a dash in WinAnsi)
  assert.match(text, /\/Subtype \/Image \/Width 40 \/Height 20 .*\/Filter \/DCTDecode/);
  assert.match(text, /\/BaseFont \/Courier/);
});

test('the PDF writer: wrapping, page breaks, characters it does not have', () => {
  assert.equal(text_width('iiii', 'regular', 10), 8.88);
  assert.equal(text_width('abc', 'mono', 10), 18);
  const lines = wrap('the quick brown fox jumps over the lazy dog '.repeat(5), 200, 'regular', 11);
  assert.ok(lines.length > 3);
  assert.ok(lines.every((l) => text_width(l, 'regular', 11) <= 200));
  assert.deepEqual(wrap('a\n\nb', 100), ['a', '', 'b']);
  assert.ok(wrap('x'.repeat(200), 100).every((l) => text_width(l) <= 100));
  assert.equal(pdf_text('café → —'), 'café ? \x97');
  const doc = new PdfDocument({ title: 'Long' });
  for (let i = 0; i < 120; i++) doc.text(`Line ${i} (with brackets) and a \\ backslash`);
  const bytes = doc.output();
  const text = check_pdf_structure(bytes);
  assert.match(text, /\/Count [3-9]/);
  assert.ok(pdf_strings(bytes).includes('Line 7 \\(with brackets\\) and a \\\\ backslash'));
});
