// A light-weight analysis of answer set programs: which predicates a program
// derives (in rule heads) and which it uses (in rule bodies), and with which
// arguments. clingo itself checks the syntax; this module is only used on
// programs that clingo accepted, to give hints about mistakes that are not
// errors for clingo, such as a misspelled predicate, a predicate with the
// wrong number of arguments, or a program that never derives do/1.
//
// This module does not use the DOM, so the tests can run it in Node.

// ---- Tokens ------------------------------------------------------------------------

const TOKEN_RULES = [
  ['space', /\s+/y],
  ['comment', /%\*[\s\S]*?\*%/y],
  ['comment', /%[^\n]*/y],
  ['script', /#script\s*\([^)]*\)[\s\S]*?#end\s*\./y],
  ['string', /"(?:\\.|[^"\\])*"/y],
  ['keyword', /#[A-Za-z_]+\+?/y],
  ['function', /@_*[a-z][A-Za-z0-9_']*/y],
  ['number', /0x[0-9A-Fa-f]+|0o[0-7]+|0b[01]+|\d+/y],
  ['variable', /_*[A-Z][A-Za-z0-9_']*/y],
  ['ident', /_*[a-z][A-Za-z0-9_']*/y],
  ['anon', /_/y],
  ['op', /:-|:~|\.\.|\*\*|!=|<=|>=|==|<>|[.,;:(){}[\]=<>+\-*/\\|&^~?!@]/y],
];

// Split a program into tokens { type, value, line, col, offset }.
// Returns null if the text contains something unexpected.
export function tokenize(text) {
  const tokens = [];
  let pos = 0;
  let line = 1;
  let line_start = 0;
  while (pos < text.length) {
    let matched = false;
    for (const [type, re] of TOKEN_RULES) {
      re.lastIndex = pos;
      const m = re.exec(text);
      if (!m || m[0].length === 0) continue;
      if (type !== 'space' && type !== 'comment') {
        tokens.push({ type, value: m[0], line, col: pos - line_start + 1, offset: pos });
      }
      for (let i = pos; i < pos + m[0].length; i++) {
        if (text[i] === '\n') {
          line += 1;
          line_start = i + 1;
        }
      }
      pos += m[0].length;
      matched = true;
      break;
    }
    if (!matched) return null;
  }
  return tokens;
}

const OPEN = { '(': ')', '[': ']', '{': '}' };

// Index of the bracket that closes the one at index i (or -1).
function matching(tokens, i, end = tokens.length) {
  const open = tokens[i].value;
  const close = OPEN[open];
  let depth = 0;
  for (let j = i; j < end; j++) {
    const v = tokens[j].type === 'op' ? tokens[j].value : null;
    if (v === open) depth += 1;
    else if (v === close) {
      depth -= 1;
      if (depth === 0) return j;
    }
  }
  return -1;
}

// Split tokens[start..end) at the operators in `separators` that are not inside brackets.
function split_top(tokens, start, end, separators) {
  const parts = [];
  let depth = 0;
  let from = start;
  for (let i = start; i < end; i++) {
    const t = tokens[i];
    if (t.type !== 'op') continue;
    if (OPEN[t.value]) depth += 1;
    else if (t.value === ')' || t.value === ']' || t.value === '}') depth -= 1;
    else if (depth === 0 && separators.includes(t.value)) {
      parts.push([from, i, t.value]);
      from = i + 1;
    }
  }
  parts.push([from, end, null]);
  return parts;
}

// ---- Terms ----------------------------------------------------------------------------

// A simple picture of a term, for comparing the arguments of atoms:
//   { kind: 'var' } | { kind: 'num', value } | { kind: 'str', value }
//   { kind: 'fun', name, args: [...] } (constants are functions without arguments,
//   tuples are functions with name '') | { kind: 'any' } (anything more complicated)
const ANY = { kind: 'any' };

export function parse_term(tokens, start, end) {
  if (start >= end) return ANY;
  const t = tokens[start];
  if (end - start === 1) {
    if (t.type === 'variable' || t.type === 'anon') return { kind: 'var' };
    if (t.type === 'number') return { kind: 'num', value: Number(t.value) };
    if (t.type === 'string') return { kind: 'str', value: t.value };
    if (t.type === 'ident') return { kind: 'fun', name: t.value, args: [] };
    return ANY;
  }
  if (end - start === 2 && t.value === '-' && tokens[start + 1].type === 'number') {
    return { kind: 'num', value: -Number(tokens[start + 1].value) };
  }
  const is_call = t.type === 'ident' && tokens[start + 1].value === '(';
  const open = is_call ? start + 1 : start;
  if ((is_call || t.value === '(') && matching(tokens, open, end) === end - 1) {
    const parts = split_top(tokens, open + 1, end - 1, [',', ';']);
    if (parts.some((p) => p[2] === ';')) return ANY;      // pools
    if (!is_call && parts.length === 1) return parse_term(tokens, open + 1, end - 1);   // (X)
    const args = (open + 1 === end - 1) ? [] : parts.map(([s, e]) => parse_term(tokens, s, e));
    return { kind: 'fun', name: is_call ? t.value : '', args };
  }
  return ANY;
}

// Whether two terms can stand for the same value (variables match anything).
export function terms_match(a, b) {
  if (a.kind === 'any' || b.kind === 'any' || a.kind === 'var' || b.kind === 'var') return true;
  if (a.kind !== b.kind) return false;
  if (a.kind === 'fun') {
    return a.name === b.name && a.args.length === b.args.length && a.args.every((x, i) => terms_match(x, b.args[i]));
  }
  return a.value === b.value;
}

export function term_to_string(t) {
  switch (t.kind) {
    case 'var': return '_';
    case 'any': return '..';
    case 'num': return String(t.value);
    case 'str': return t.value;
    default: return t.args.length || t.name === '' ? `${t.name}(${t.args.map(term_to_string).join(',')})` : t.name;
  }
}

// ---- Atoms ------------------------------------------------------------------------------

const AGGREGATES = new Set(['#count', '#sum', '#sum+', '#min', '#max']);
// Operators that make an identifier next to them a term instead of an atom.
const TERM_OPERATORS = new Set(['=', '!=', '<', '<=', '>', '>=', '==', '<>', '+', '-', '*', '/', '\\', '**', '..', '^', '&', '?', '~']);

// One occurrence of an atom: { name, arity, args (terms), line, col, end_col, negated }.
function make_atom(tokens, i, args_end) {
  const t = tokens[i];
  let arity = 0;
  let args = [];
  if (args_end > i) {
    const parts = split_top(tokens, i + 2, args_end, [',', ';']);
    const first_pool = [];
    for (const p of parts) {
      first_pool.push(p);
      if (p[2] === ';') break;
    }
    if (args_end > i + 2) {
      arity = first_pool.length;
      args = parts.some((p) => p[2] === ';') ? first_pool.map(() => ANY) : first_pool.map(([s, e]) => parse_term(tokens, s, e));
    }
  }
  const last = tokens[args_end];
  const same_line = last.line === t.line;
  return {
    name: t.value,
    arity,
    args,
    line: t.line,
    col: t.col,
    end_col: same_line ? last.col + last.value.length : t.col + t.value.length,
  };
}

// Find the atoms in tokens[start..end). Atoms in `role` 'head' are derived
// (except in conditions after ':'), all others are used.
function scan(tokens, start, end, role, out) {
  let current = role;
  let i = start;
  while (i < end) {
    const t = tokens[i];
    if (t.type === 'op') {
      if (t.value === '{') {
        const j = matching(tokens, i, end);
        if (j < 0) throw new Error('unbalanced');
        const prev = tokens[i - 1];
        const aggregate = i > start && prev && AGGREGATES.has(prev.value);
        scan_elements(tokens, i + 1, j, aggregate, current, out);
        i = j + 1;
        continue;
      }
      if (t.value === '(' || t.value === '[') {
        const j = matching(tokens, i, end);
        if (j < 0) throw new Error('unbalanced');
        i = j + 1;
        continue;
      }
      if (t.value === ':' && role === 'head') current = 'body';
      else if ((t.value === ';' || t.value === '|') && role === 'head') current = 'head';
      else if (t.value === '&') throw new Error('theory atoms are not analyzed');
      i += 1;
      continue;
    }
    if (t.type === 'ident' && t.value !== 'not') {
      let args_end = i;
      if (i + 1 < end && tokens[i + 1].value === '(') {
        args_end = matching(tokens, i + 1, end);
        if (args_end < 0) throw new Error('unbalanced');
      }
      if (!is_operand(tokens, start, i, args_end, end)) {
        out.push({ ...make_atom(tokens, i, args_end), role: current });
      }
      i = args_end + 1;
      continue;
    }
    if (t.type === 'function' && i + 1 < end && tokens[i + 1].value === '(') {
      i = matching(tokens, i + 1, end) + 1;
      continue;
    }
    i += 1;
  }
}

// Whether the identifier at index i (with arguments up to args_end) is a term
// in a comparison or calculation, rather than an atom.
function is_operand(tokens, start, i, args_end, end) {
  const next = args_end + 1 < end ? tokens[args_end + 1] : null;
  if (next && next.type === 'op' && TERM_OPERATORS.has(next.value)) return true;
  if (i > start) {
    const prev = tokens[i - 1];
    if (prev.type === 'op' && TERM_OPERATORS.has(prev.value)) {
      // '-p(X)' (classical negation) is an atom, 'X - p' is a term
      if (prev.value !== '-') return true;
      const before = i - 1 > start ? tokens[i - 2] : null;
      if (before && !(before.type === 'op' && [',', ';', ':', ':-', '{', '|'].includes(before.value)) && before.value !== 'not') return true;
    }
  }
  return false;
}

// The elements of a choice ('{ a : b ; c }') or of an aggregate ('#count { X : p(X) }').
function scan_elements(tokens, start, end, aggregate, role, out) {
  for (const [s, e] of split_top(tokens, start, end, [';'])) {
    const [head_part, ...rest] = split_top(tokens, s, e, [':']);
    if (!aggregate) scan(tokens, head_part[0], head_part[1], role, out);
    if (rest.length) scan(tokens, rest[0][0], e, 'body', out);
  }
}

// ---- Programs ------------------------------------------------------------------------------

// Analyze a program. Returns { atoms, constraints, complete }:
// - atoms: every occurrence of an atom, with role 'head' (derived) or 'body' (used);
// - constraints: the integrity constraints (':- ...'), as { offset, line };
// - complete: false if the program has parts that are not analyzed (then
//   hints that need the whole program, such as "never derived", are not given).
export function analyze_program(text) {
  const tokens = tokenize(text || '');
  if (!tokens) return { atoms: [], constraints: [], complete: false };
  const atoms = [];
  const constraints = [];
  let complete = true;
  let start = 0;
  let depth = 0;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.type === 'script') {
      start = i + 1;
      continue;
    }
    // '[weight@level]' after a weak constraint or a #heuristic statement
    if (i === start && t.value === '[') {
      const j = matching(tokens, i);
      if (j < 0) return { atoms, constraints, complete: false };
      i = j;
      start = j + 1;
      continue;
    }
    if (t.type !== 'op') continue;
    if (OPEN[t.value]) depth += 1;
    else if (t.value === ')' || t.value === ']' || t.value === '}') depth -= 1;
    else if (t.value === '.' && depth === 0) {
      try {
        if (!statement(tokens, start, i, atoms, constraints)) complete = false;
      } catch {
        complete = false;
      }
      start = i + 1;
    }
  }
  if (start < tokens.length) complete = false;
  return { atoms, constraints, complete };
}

// Analyze one statement (tokens[start..end), without the final '.').
// Returns false if the statement is not analyzed.
function statement(tokens, start, end, atoms, constraints) {
  if (start >= end) return true;
  const first = tokens[start];
  if (first.type === 'keyword') {
    switch (first.value) {
      case '#const': case '#program': case '#script':
        return true;
      case '#show': {
        // '#show p/1.' or '#show t : body.'
        const parts = split_top(tokens, start + 1, end, [':']);
        if (parts.length > 1) scan(tokens, parts[1][0], end, 'body', atoms);
        return true;
      }
      case '#defined': {
        const [name, slash, arity] = tokens.slice(start + 1, end);
        if (name && slash && slash.value === '/' && arity) {
          atoms.push({ name: name.value, arity: Number(arity.value), args: [], line: name.line, col: name.col, end_col: arity.col + arity.value.length, role: 'head', declared: true });
        }
        return true;
      }
      case '#external': case '#heuristic': case '#project': {
        const parts = split_top(tokens, start + 1, end, [':']);
        scan(tokens, parts[0][0], parts[0][1], first.value === '#external' ? 'head' : 'body', atoms);
        if (parts.length > 1) scan(tokens, parts[1][0], end, 'body', atoms);
        return true;
      }
      case '#minimize': case '#maximize': case '#minimise': case '#maximise': {
        if (tokens[start + 1] && tokens[start + 1].value === '{') {
          scan_elements(tokens, start + 2, end - 1, true, 'body', atoms);
          return true;
        }
        return false;
      }
      default:
        return false;      // #include, #theory, #edge, ...
    }
  }
  if (first.value === ':~') {
    scan(tokens, start + 1, end, 'body', atoms);
    return true;
  }
  let arrow = -1;
  for (const [, e, sep] of split_top(tokens, start, end, [':-'])) {
    if (sep === ':-') {
      arrow = e;
      break;
    }
  }
  if (arrow === start) {
    constraints.push({ offset: first.offset, line: first.line, col: first.col });
  }
  if (arrow < 0) {
    scan(tokens, start, end, 'head', atoms);
  } else {
    scan(tokens, start, arrow, 'head', atoms);
    const body = [];
    scan(tokens, arrow + 1, end, 'body', body);
    // atoms in the body of a constraint (':- ...') only restrict, they do not derive anything
    for (const a of body) atoms.push(arrow === start ? { ...a, in_constraint: true } : a);
  }
  return true;
}

// Signature of an atom: 'name/arity'.
export const sig = (a) => `${a.name}/${a.arity}`;

// Rewrite the integrity constraints of a program, so that a violated
// constraint does not make the program fail, but derives the atom head(I)
// (I is the index of the constraint). The line numbers stay the same.
// Returns { text, constraints: [{ line, col, text }] } (text: the first line
// of the constraint).
export function relax_constraints(text, head) {
  const { constraints } = analyze_program(text);
  let out = '';
  let pos = 0;
  constraints.forEach((c, i) => {
    out += text.slice(pos, c.offset) + head(i) + ' ';
    pos = c.offset;
  });
  out += text.slice(pos);
  return {
    text: out,
    constraints: constraints.map(({ line, col, offset }) => ({ line, col, text: text.slice(offset).split('\n')[0].trim() })),
  };
}
