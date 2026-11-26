// The feedback for a student, from the grading of their game: the grade, the
// items of the rubric, the grader's comment, notes on lines of the programs,
// pictures of the board, and (if the grader chooses so) the test results.
// As Markdown (to paste, e.g. into a comment in Canvas), as a web page (one
// file, with the pictures in it), and as a PDF file.
//
// This module does not use the DOM: the pictures of the board are made by the
// page (board-image.js) and passed in.
import { rubric_items, compute_grade, item_points, format_number, win_counts, STEP_PROGRAM_NAMES } from './grading.js';
import { SOURCE_NAMES } from './engine.js';
import { PdfDocument } from './pdf.js';

const VERDICTS = { win: 'won', lose: 'lost', timeout: 'timed out', stopped: 'stopped (clingo took too long)', 'no level': 'no level generated', cancelled: 'canceled' };

// Everything the feedback says, in one object (the documents are made from it).
export function feedback_model(rubric, st) {
  const grade = compute_grade(rubric, st.scores, st.grade_override);
  const items = rubric_items(rubric).map((item) => {
    const sc = st.scores[item.id] || {};
    const value = sc.value || '';
    return {
      label: item.label,
      required: item.required,
      points: item.points ?? null,
      value,
      result: item.required ? ({ yes: 'met', no: 'not met' }[value] || 'not decided')
        : value === 'yes' ? `+${format_number(item_points(item, sc))}` : value === 'no' ? '0' : 'not decided',
      note: sc.note || '',
    };
  });
  const game = st.game || {};
  const line_notes = (st.line_notes || []).map((n) => ({
    program: SOURCE_NAMES[n.field] || n.field,
    line: n.line,
    quote: n.quote != null ? n.quote : ((game[n.field] || '').split('\n')[n.line - 1] ?? ''),
    text: n.text,
  }));
  let tests = null;
  const m = st.measurements;
  if (st.include_tests && m && m.levels && m.levels.length) {
    const counts = win_counts(m);
    const lines = [
      `Played ${m.levels.length} new levels (levels 1 to ${m.levels.length} of "Test your strategy"): ` +
        Object.entries(counts).map(([v, n]) => `${n} ${VERDICTS[v] || v}`).join(', ') + '.',
      `Level generation took at most ${(Math.max(0, ...m.generation_ms) / 1000).toFixed(1)} seconds.`,
    ];
    const programs = Object.entries(m.program_ms).sort((a, b) => b[1].max - a[1].max);
    if (programs.length) {
      lines.push('Longest time of a program in one step: ' +
        programs.map(([p, x]) => `${STEP_PROGRAM_NAMES[p] || p} ${(x.max / 1000).toFixed(2)} s`).join(', ') + '.');
    }
    tests = {
      lines,
      failed: m.levels.filter((l) => l.verdict !== 'win').map((l) => `Level ${l.seed}: ${l.message || VERDICTS[l.verdict] || l.verdict}` + (l.steps ? ` (after ${l.steps} steps)` : '')),
    };
  }
  return {
    title: rubric.title || 'Feedback',
    student: st.name,
    canvas_id: st.canvas_id,
    grade: grade.grade == null ? null : format_number(grade.grade),
    grade_text: grade.text,
    required_grade: rubric.required.grade,
    max: rubric.extra.max,
    all_grade: rubric.extra.all_grade,
    items,
    comment: st.comment || '',
    line_notes,
    images: (st.images || []).map((img) => ({ caption: img.caption || '' })),
    tests,
  };
}

// ---- Markdown ---------------------------------------------------------------------------

const md_escape = (s) => String(s).replace(/([\\`*_[\]|<>])/g, '\\$1');

export function feedback_markdown(model) {
  const out = [];
  out.push(`# ${md_escape(model.title)}`, '');
  out.push(`**Student:** ${md_escape(model.student)}${model.canvas_id ? ` (${model.canvas_id})` : ''}  `);
  out.push(`**Grade:** ${model.grade != null ? model.grade : md_escape(model.grade_text)}`, '');
  out.push('## Grading', '');
  out.push(`To pass (grade ${model.required_grade}), all of these are needed:`, '');
  for (const item of model.items.filter((x) => x.required)) out.push(`- ${md_escape(item.label)}: **${item.result}**${item.note ? ` — ${md_escape(item.note)}` : ''}`);
  const extra = model.items.filter((x) => !x.required);
  if (extra.length) {
    out.push('', `Extra points (up to a ${model.max}${model.all_grade != null ? `; all of them give a ${model.all_grade}` : ''}):`, '');
    for (const item of extra) out.push(`- ${md_escape(item.label)} (${format_number(item.points)}): **${item.result}**${item.note ? ` — ${md_escape(item.note)}` : ''}`);
  }
  if (model.comment.trim()) out.push('', '## Comments', '', model.comment.trim());
  if (model.line_notes.length) {
    out.push('', '## Notes on the programs', '');
    for (const n of model.line_notes) {
      out.push(`**${md_escape(n.program)}, line ${n.line}:** ${md_escape(n.text)}`, '', '```', n.quote.replace(/```/g, "'''"), '```', '');
    }
  }
  if (model.images.length) {
    out.push('', '## The board', '');
    model.images.forEach((img, i) => out.push(`- Picture ${i + 1}${img.caption ? ': ' + md_escape(img.caption) : ''} (in the PDF and web page versions of this feedback)`));
  }
  if (model.tests) {
    out.push('', '## Test results', '', ...model.tests.lines);
    if (model.tests.failed.length) out.push('', 'Levels that were not won:', '', ...model.tests.failed.map((f) => '- ' + md_escape(f)));
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n') + '\n';
}

// ---- A web page -------------------------------------------------------------------------

const html_escape = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// images: [{ data_url }] (PNG or JPEG), in the order of model.images.
export function feedback_html(model, images = []) {
  const e = html_escape;
  const rows = (list) => list.map((item) => `<tr><td>${e(item.label)}${item.points != null ? ` <span class="pts">(${e(format_number(item.points))})</span>` : ''}` +
    `${item.note ? `<div class="note">${e(item.note)}</div>` : ''}</td><td class="result ${e(item.value || 'none')}">${e(item.result)}</td></tr>`).join('\n');
  const extra = model.items.filter((x) => !x.required);
  const parts = [];
  parts.push(`<h1>${e(model.title)}</h1>`);
  parts.push(`<p class="who"><b>Student:</b> ${e(model.student)}${model.canvas_id ? ` (${e(model.canvas_id)})` : ''}<br><b>Grade:</b> <span class="grade">${e(model.grade != null ? model.grade : model.grade_text)}</span></p>`);
  parts.push('<h2>Grading</h2>');
  parts.push(`<p>To pass (grade ${e(model.required_grade)}), all of these are needed:</p>`);
  parts.push(`<table>${rows(model.items.filter((x) => x.required))}</table>`);
  if (extra.length) {
    parts.push(`<p>Extra points (up to a ${e(model.max)}${model.all_grade != null ? `; all of them give a ${e(model.all_grade)}` : ''}):</p>`);
    parts.push(`<table>${rows(extra)}</table>`);
  }
  if (model.comment.trim()) parts.push('<h2>Comments</h2>', `<div class="comment">${e(model.comment.trim())}</div>`);
  if (model.line_notes.length) {
    parts.push('<h2>Notes on the programs</h2>');
    for (const n of model.line_notes) parts.push(`<p><b>${e(n.program)}, line ${e(n.line)}:</b> ${e(n.text)}</p><pre>${e(n.quote)}</pre>`);
  }
  if (model.images.length) {
    parts.push('<h2>The board</h2>');
    model.images.forEach((img, i) => {
      const src = images[i] && images[i].data_url;
      parts.push(`<figure>${src && /^data:image\/(png|jpeg);base64,/.test(src) ? `<img src="${src}" alt="${e(img.caption || 'The board')}">` : ''}<figcaption>${e(img.caption || `Picture ${i + 1}`)}</figcaption></figure>`);
    });
  }
  if (model.tests) {
    parts.push('<h2>Test results</h2>', ...model.tests.lines.map((l) => `<p>${e(l)}</p>`));
    if (model.tests.failed.length) parts.push('<p>Levels that were not won:</p>', `<ul>${model.tests.failed.map((f) => `<li>${e(f)}</li>`).join('')}</ul>`);
  }
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${e(model.title)} — ${e(model.student)}</title>
<style>
  body { font-family: system-ui, -apple-system, "Segoe UI", Helvetica, Arial, sans-serif; max-width: 760px; margin: 2em auto; padding: 0 16px; color: #222; line-height: 1.45; background: #fff; }
  h1 { font-size: 1.5em; } h2 { font-size: 1.2em; margin-top: 1.6em; border-bottom: 1px solid #ddd; }
  .grade { font-size: 1.3em; font-weight: 700; }
  table { border-collapse: collapse; width: 100%; margin: 0.5em 0 1em; }
  td { border-bottom: 1px solid #e3e3e3; padding: 6px 8px; vertical-align: top; }
  td.result { white-space: nowrap; text-align: right; font-weight: 600; width: 8em; }
  td.result.yes { color: #2e7d32; } td.result.no { color: #c62828; } td.result.none { color: #888; font-weight: normal; }
  .pts { color: #777; } .note { color: #555; font-size: 0.92em; margin-top: 2px; }
  .comment { white-space: pre-wrap; }
  pre { background: #f4f4f4; padding: 6px 10px; overflow-x: auto; white-space: pre-wrap; }
  figure { margin: 1em 0; } figure img { max-width: 100%; border: 1px solid #ccc; } figcaption { color: #666; font-size: 0.9em; }
  @media print { body { margin: 0; } }
</style>
</head>
<body>
${parts.join('\n')}
</body>
</html>
`;
}

// ---- A PDF file ---------------------------------------------------------------------------

// images: [{ bytes (JPEG), width, height }], in the order of model.images.
export function feedback_pdf(model, images = []) {
  const doc = new PdfDocument({ title: `${model.title} — ${model.student}` });
  doc.heading(model.title, 1);
  doc.text(`Student: ${model.student}${model.canvas_id ? ` (${model.canvas_id})` : ''}`, { size: 11, gap: 2 });
  doc.text(`Grade: ${model.grade != null ? model.grade : model.grade_text}`, { font: 'bold', size: 13 });
  doc.rule();
  doc.heading('Grading', 2);
  doc.text(`To pass (grade ${model.required_grade}), all of these are needed:`);
  const table = (list) => doc.table([['Item', 'Result'], ...list.map((item) => [
    item.label + (item.points != null ? ` (${format_number(item.points)})` : '') + (item.note ? `\n${item.note}` : ''), item.result])], [5, 1.2]);
  table(model.items.filter((x) => x.required));
  const extra = model.items.filter((x) => !x.required);
  if (extra.length) {
    doc.text(`Extra points (up to a ${model.max}${model.all_grade != null ? `; all of them give a ${model.all_grade}` : ''}):`);
    table(extra);
  }
  if (model.comment.trim()) {
    doc.heading('Comments', 2);
    doc.text(model.comment.trim());
  }
  if (model.line_notes.length) {
    doc.heading('Notes on the programs', 2);
    for (const n of model.line_notes) {
      doc.text(`${n.program}, line ${n.line}: ${n.text}`, { gap: 2 });
      doc.code(n.quote || ' ');
    }
  }
  if (model.images.length) {
    const first = images.find(Boolean);
    doc.heading('The board', 2, first ? Math.min(260, first.height * (260 / first.width)) + 20 : 0);
    model.images.forEach((img, i) => {
      if (images[i] && images[i].bytes) doc.image(images[i], { caption: img.caption || `Picture ${i + 1}` });
      else doc.text(img.caption || `Picture ${i + 1}`);
    });
  }
  if (model.tests) {
    doc.heading('Test results', 2);
    for (const l of model.tests.lines) doc.text(l);
    if (model.tests.failed.length) {
      doc.text('Levels that were not won:', { gap: 2 });
      for (const f of model.tests.failed) doc.text('• ' + f, { indent: 10, gap: 1 });
    }
  }
  return doc.output();
}

// A file name for the feedback of a student (without the extension).
export function feedback_name(st) {
  // (only letters, digits and dashes: the name and the Canvas id come from a file that can be changed by hand)
  const clean = (text) => String(text || '').normalize('NFKD').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const id = clean(st.canvas_id);
  return `feedback-${clean(st.name) || 'student'}${id ? '-' + id : ''}`;
}
