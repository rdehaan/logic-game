// Helpers for answer set programs as text: composing programs from parts,
// preprocessing, reading answer sets, and reading clingo's error messages.
//
// This module does not use the DOM, so the tests can run it in Node.

// ---- Composing programs ----------------------------------------------------

// A program is glued together from parts, separated by newlines (so that a
// comment on the last line of one part does not swallow the start of the next
// one). Each part may say where it came from (`source`), so that an error that
// clingo reports for a line of the whole program can be traced back to the
// line of the part (e.g. the editor) that it is on.
//
// parts: strings or { text, source } objects.
// Returns { text, segments }, where segments are
// [{ source, first_line, line_count }] (first_line is 1-based).
export function compose(parts) {
  const segments = [];
  const texts = [];
  let line = 1;
  for (const part of parts) {
    const { text, source } = typeof part === 'string' ? { text: part, source: null } : part;
    const t = text || '';
    const line_count = t.split('\n').length;
    segments.push({ source: source || null, first_line: line, line_count });
    texts.push(t);
    line += line_count;
  }
  return { text: texts.join('\n'), segments };
}

// Glue programs together (without keeping track of where the parts came from).
export function join_programs(...parts) {
  return parts.join('\n');
}

// ---- Preprocessing ---------------------------------------------------------

// Random integer in [min, max), using rng() in [0, 1) (Math.random by default).
export function randint(min, max, rng = Math.random) {
  return Math.floor(rng() * (max - min)) + min;
}

// Evaluate 'RANDINT(l,u)' (a random integer between l and u, inclusive).
// The number is padded with spaces to the length of the RANDINT(...) text
// (newlines are kept), so that line and column numbers in clingo's error
// messages still match the text in the editor.
export function preprocess_program(program, rng = Math.random) {
  return (program || '').replace(/RANDINT\(\s*(-?\d+)\s*,\s*(-?\d+)\s*\)/g, (match, l, u) => {
    const n = String(randint(Number(l), Number(u) + 1, rng));
    return n + match.slice(n.length).replace(/[^\n]/g, ' ');
  });
}

// ---- Answer sets -----------------------------------------------------------

// Keep only some predicate names in an answer set (an array of atoms).
export function filter_answer_set(answer_set, pred_names) {
  return answer_set.filter((atom) =>
    pred_names.some((name) => atom === name || atom.startsWith(name + '(')));
}

// Write an answer set as a program of facts.
export function answer_set_to_facts(answer_set) {
  return answer_set.length > 0 ? answer_set.join('. ') + '.' : '';
}

// Same, one fact per line.
export function answer_set_to_fact_lines(answer_set) {
  return answer_set.map((atom) => atom + '.').join('\n');
}

// ---- clingo's error messages -------------------------------------------------

// Parse clingo's error output. Messages look like
//   -:3:9-10: error: syntax error, unexpected ., expecting ) or ;
//   -:1:1-18: error: unsafe variables in:
//     a(X):-[#inc_base];not b(X).
//   -:1:3-4: note: 'X' is unsafe
// (the end of the range may also be 'L2:C2'). Notes and indented lines belong
// to the message before them. Lines starting with '***' are clingo's summary
// ("parsing failed"); they are only used when there is nothing else.
//
// Returns [{ line, col, end_line, end_col, severity, message }] (1-based;
// line and col are null for messages without a location; end_col is the
// column just after the range).
export function parse_clingo_errors(text) {
  const out = [];
  const summary = [];
  const loc = /^(?:-|<string>|<stdin>):(\d+):(\d+)(?:-(?:(\d+):)?(\d+))?: (error|warning|info|note): (.*)$/;
  for (const raw of String(text || '').split('\n')) {
    const l = raw.trimEnd();
    if (!l.trim()) continue;
    const m = loc.exec(l);
    if (m && m[5] !== 'note') {
      const line = Number(m[1]);
      const col = Number(m[2]);
      out.push({
        line, col,
        end_line: m[3] ? Number(m[3]) : line,
        end_col: m[4] ? Number(m[4]) : col + 1,
        severity: m[5] === 'error' ? 'error' : 'warning',
        message: m[6],
      });
    } else if (m && out.length) {
      out.at(-1).message += '\n' + m[6];
    } else if (/^\*\*\*/.test(l)) {
      summary.push(l.replace(/^\*+\s*(ERROR:\s*)?(\(clingo\):\s*)?/, ''));
    } else if (out.length && /^\s/.test(l)) {
      out.at(-1).message += '\n' + l.trim();
    } else {
      out.push({ line: null, col: null, end_line: null, end_col: null, severity: 'error', message: l.trim() });
    }
  }
  for (const e of out) e.message = clean_message(e.message);
  if (out.length === 0 && summary.length > 0) {
    out.push({ line: null, col: null, end_line: null, end_col: null, severity: 'error', message: summary.join('; ') });
  }
  return out;
}

// Make a message from clingo a bit easier to read: drop clingo-internal
// markers such as '[#inc_base];' and put the lines of a message on one line.
function clean_message(message) {
  const lines = message.split('\n').map((l) => l.trim()).filter(Boolean)
    .map((l) => l.replace(/\[#inc_[A-Za-z0-9_]*\];?/g, ''));
  if (lines.length > 1 && lines[0].endsWith(':')) return lines[0] + ' ' + lines.slice(1).join('; ');
  return lines.join('; ');
}

// Find out which part of a composed program each error is in.
// Returns the errors with { source, line, col, end_line, end_col } relative to
// that part (source is null if the error has no location, or is in a part
// without a source).
export function locate_errors(errors, segments) {
  return errors.map((e) => {
    if (e.line == null) return { ...e, source: null };
    for (const s of segments) {
      if (e.line >= s.first_line && e.line < s.first_line + s.line_count) {
        const shift = s.first_line - 1;
        return { ...e, source: s.source, line: e.line - shift, end_line: e.end_line - shift };
      }
    }
    return { ...e, source: null };
  });
}
