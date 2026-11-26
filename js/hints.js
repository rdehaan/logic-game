// Hints about the special predicates: each program of a game gets some
// predicates from the engine (its input) and passes some on (its output).
// Using the wrong ones is not an error for clingo, but the game will not
// work as intended. These hints point out such mistakes, for example:
// - the player strategy never derives do/1 (so the player never moves);
// - the player strategy uses at/3, which it does not get (it sees observe/1);
// - do(up) is derived, but the nature's moves program only reacts to do(move(D));
// - remeber/1 is derived but never used (did you mean remember/1?).
//
// This module does not use the DOM, so the tests can run it in Node.
import { analyze_program, sig, terms_match, term_to_string } from './analysis.js';
import { preprocess_program, facts_to_answer_set } from './asp.js';

// What each program gets and passes on (see the Internals tab, docs/internals.html).
// `inputs` and `outputs` are signatures; '*' as arity means any arity.
export const INTERFACES = {
  level_gen_program: {
    name: 'level generation program',
    inputs: [],
    outputs: ['at/3', 'setting/1', 'decorate/*', 'debug/*'],
    main: [['at/3', 'the level has no objects: level generation should derive at(R,C,O) atoms (object O in row R, column C)'],
      ['setting/1', 'the level has no settings, so the board cannot be drawn: level generation should derive setting(grid_width(W)) and setting(grid_height(H))']],
  },
  visibility_program: {
    name: 'visibility program',
    inputs: ['at/3', 'at_time/4', 'state_time/1', 'current_time/1', 'setting/1', 'decorate/*'],
    outputs: ['observe/1', 'decorate/*'],
    main: [['observe/1', 'the player never observes anything: the visibility program should derive observe(...) atoms, such as observe(at(R,C,O))']],
  },
  player_move_program: {
    name: 'player strategy',
    inputs: ['observe/1', 'setting/1', 'current_time/1', 'memory/1'],
    outputs: ['do/1', 'remember/1', 'forget/1'],
    main: [['do/1', 'the player never makes a move: the player strategy should derive do(...) atoms (such as do(move(up)), depending on the game)']],
  },
  nature_program: {
    name: "nature's moves",
    inputs: ['at/3', 'at_time/4', 'state_time/1', 'current_time/1', 'do/1', 'setting/1', 'decorate/*'],
    outputs: ['next/3', 'wipe_player_memory/0'],
    main: [['next/3', 'the board is empty after the first step: the next state consists of exactly the next(R,C,O) atoms that nature derives, so objects that stay in place need a rule too, e.g. next(R,C,O) :- at(R,C,O), ...']],
  },
  goal_program: {
    name: 'winning conditions',
    inputs: ['at/3', 'at_time/4', 'state_time/1', 'current_time/1', 'setting/1', 'decorate/*'],
    outputs: ['win/*', 'lose/*'],
    main: [],
  },
};

// Where the inputs of the programs come from, for comparing arguments:
// [program, input signature, the program(s) and signature that produce it].
const PRODUCERS = [
  ['player_move_program', 'observe/1', [['visibility_program', 'observe/1']]],
  ['player_move_program', 'memory/1', [['player_move_program', 'remember/1']]],
  ['player_move_program', 'setting/1', [['level_gen_program', 'setting/1'], ['level_settings', 'setting/1']]],
  ['visibility_program', 'setting/1', [['level_gen_program', 'setting/1'], ['level_settings', 'setting/1']]],
  ['nature_program', 'setting/1', [['level_gen_program', 'setting/1'], ['level_settings', 'setting/1']]],
  ['goal_program', 'setting/1', [['level_gen_program', 'setting/1'], ['level_settings', 'setting/1']]],
];

const NAMES = {
  aux_program: 'the auxiliary program',
  level_gen_program: 'level generation',
  visibility_program: 'the visibility program',
  player_move_program: 'the player strategy',
  nature_program: "the nature's moves program",
  goal_program: 'the winning conditions',
  level_settings: 'the level settings',
};

// Matches a signature against a list with wildcards ('decorate/*').
function in_list(s, list) {
  const [name] = s.split('/');
  return list.some((x) => x === s || x === name + '/*');
}

function names_of(list) {
  return list.map((s) => s.replace('/*', '')).join(', ');
}

// Edit distance (for "did you mean").
function distance(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  return d[a.length][b.length];
}

// A known signature with the same arity that `s` is probably a misspelling of.
// (With any_arity, the arity does not have to be the same.)
function similar(s, known, any_arity = false) {
  const [name, arity] = s.split('/');
  const limit = name.length <= 3 ? 1 : 2;
  let best = null;
  for (const k of known) {
    const [other, other_arity] = k.split('/');
    if (other === name || (!any_arity && other_arity !== arity && other_arity !== '*')) continue;
    const dist = distance(name, other);
    if (dist <= limit && (!best || dist < best.dist)) best = { sig: k, dist };
  }
  return best && best.sig;
}

function sigs_of(atoms, role) {
  const out = new Map();
  for (const a of atoms) {
    if (role && a.role !== role) continue;
    const s = sig(a);
    if (!out.has(s)) out.set(s, []);
    out.get(s).push(a);
  }
  return out;
}

const describe = (s) => s.replace('/*', '');

// A hint at an atom: { line, col, end_line, end_col, severity, message }.
function at(atom, severity, message) {
  return { line: atom.line, col: atom.col, end_line: atom.line, end_col: atom.end_col, severity, message };
}
function general(severity, message) {
  return { line: null, col: null, end_line: null, end_col: null, severity, message };
}

// Hints for all programs of a game: { field: [hints] }.
// Programs in `skip` (e.g. those with syntax errors) get no hints.
export function game_hints(game, skip = new Set()) {
  const analysis = {};
  for (const field of ['aux_program', 'level_gen_program', 'visibility_program', 'player_move_program', 'nature_program', 'goal_program', 'level_settings', 'level_state']) {
    analysis[field] = skip.has(field) ? null : analyze_program(preprocess_program(game[field] || '', () => 0));
  }
  const hints = {};
  for (const field of Object.keys(analysis)) hints[field] = [];
  const aux = analysis.aux_program;
  const aux_defined = aux ? sigs_of(aux.atoms, 'head') : new Map();
  const aux_used = aux ? sigs_of(aux.atoms, 'body') : new Map();

  for (const [field, iface] of Object.entries(INTERFACES)) {
    const a = analysis[field];
    if (!a) continue;
    const defined = sigs_of(a.atoms, 'head');
    const used = sigs_of(a.atoms, 'body');
    const out = hints[field];
    const complete = a.complete && (!aux || aux.complete);
    const available = new Set([...iface.inputs, ...defined.keys(), ...aux_defined.keys()]);

    // The main output is never derived
    const empty = a.atoms.length === 0 && a.constraints.length === 0;
    if (complete && empty && iface.main.length) {
      out.push(general('info', `This program has no rules yet: ${iface.main.map(([, m]) => m.replace(/^[^:]*: /, '')).join('; ')}.`));
    } else if (complete) {
      for (const [s, message] of iface.main) {
        if (!defined.has(s) && !aux_defined.has(s) && ![...defined.keys()].some((d) => d.startsWith(s.split('/')[0] + '/'))) {
          out.push(general('warning', `This program never derives ${s}, so ${message}.`));
        }
      }
      if (field === 'goal_program' && !empty) {
        const names = new Set([...defined.keys(), ...aux_defined.keys()].map((s) => s.split('/')[0]));
        if (!names.has('win')) out.push(general('info', 'This program never derives win, so the game cannot be won.'));
        if (!names.has('lose') && !names.has('win')) out.push(general('warning', 'This program never derives win or lose, so the game only ends when the engine stops it after 500 steps.'));
      }
    }

    // Derived, but not used and not passed on
    for (const [s, atoms] of defined) {
      if (in_list(s, iface.outputs) || used.has(s) || aux_used.has(s)) continue;
      if (atoms.every((x) => x.declared)) continue;
      const first = atoms[0];
      const name = first.name;
      const same_name = iface.outputs.find((o) => o.split('/')[0] === name);
      const elsewhere = Object.entries(INTERFACES).find(([f, i]) => f !== field && in_list(s, i.outputs));
      const used_elsewhere = Object.entries(INTERFACES).find(([f, i]) => f !== field && in_list(s, i.inputs));
      const typo = similar(s, [...iface.outputs.filter((o) => !o.endsWith('/*')), ...used.keys(), ...aux_used.keys()]) ||
        similar(s, iface.outputs.filter((o) => !o.endsWith('/*')), true);
      if (same_name) {
        out.push(at(first, 'warning', `${s} is derived, but only ${describe(same_name)} is passed on (with ${same_name.split('/')[1]} argument${same_name.endsWith('/1') ? '' : 's'}): check the number of arguments.`));
      } else if (elsewhere) {
        out.push(at(first, 'warning', `${s} is not passed on from ${NAMES[field]}: only ${NAMES[elsewhere[0]]} passes on ${s}. This program passes on ${names_of(iface.outputs)}.`));
      } else if (typo) {
        out.push(at(first, 'warning', `${s} is derived but never used, and it is not passed on. Did you mean ${typo}?`));
      } else if (used_elsewhere && field !== 'player_move_program') {
        // e.g. a helper that the auxiliary program or another program might expect
        out.push(at(first, 'info', `${s} is derived but never used here, and it is not passed on (this program passes on ${names_of(iface.outputs)}).`));
      } else if (complete) {
        out.push(at(first, 'info', `${s} is derived but never used, and it is not passed on (this program passes on ${names_of(iface.outputs)}).`));
      }
    }

    // Used, but never available
    for (const [s, atoms] of used) {
      if (available.has(s) || in_list(s, iface.inputs)) continue;
      const first = atoms[0];
      const name = first.name;
      const same_name = [...iface.inputs, ...defined.keys(), ...aux_defined.keys()].find((o) => o.split('/')[0] === name);
      const gets_it = Object.entries(INTERFACES).filter(([f, i]) => f !== field && in_list(s, i.inputs)).map(([f]) => NAMES[f]);
      const derives_it = Object.entries(INTERFACES).find(([f, i]) => f !== field && in_list(s, i.outputs));
      if (same_name) {
        out.push(at(first, 'warning', `${s} never holds: there is only ${describe(same_name)}. Check the number of arguments.`));
      } else if (field === 'player_move_program' && s === 'at/3') {
        out.push(at(first, 'warning', 'at/3 never holds here: the player does not see the state of the game directly, only what the visibility program lets it observe, as observe(...) atoms (such as observe(at(R,C,O))).'));
      } else if (gets_it.length || derives_it) {
        const who = gets_it.length ? `only ${gets_it.join(' and ')} ${gets_it.length > 1 ? 'get' : 'gets'} it` : `it is derived by ${NAMES[derives_it[0]]}, and not passed on to this program`;
        out.push(at(first, 'warning', `${s} never holds here: ${NAMES[field]} does not get ${s} (${who}). It gets ${names_of(iface.inputs)}.`));
      } else if (complete) {
        const typo = similar(s, [...available]) || similar(s, iface.inputs.filter((o) => !o.endsWith('/*')), true);
        out.push(at(first, 'warning', `${s} never holds: it is not derived anywhere, and ${NAMES[field]} does not get it as input.` +
          (typo ? ` Did you mean ${typo}?` : ` This program gets ${names_of(iface.inputs)}.`)));
      }
    }

    // A player that uses memory/1 without ever remembering anything
    if (field === 'player_move_program' && used.has('memory/1') && !defined.has('remember/1') && !aux_defined.has('remember/1') && complete) {
      out.push(at(used.get('memory/1')[0], 'warning', 'memory/1 never holds: memory(X) holds only for what the player remembered earlier with remember(X), and this program never derives remember/1.'));
    }
  }

  // Arguments: compare how inputs are used with how they are produced
  for (const [field, s, producers] of PRODUCERS) {
    const a = analysis[field];
    if (!a) continue;
    const pattern_atoms = [];
    let known = true;
    for (const [pf, ps] of producers) {
      const pa = analysis[pf];
      if (!pa || !pa.complete) {
        known = false;
        break;
      }
      pattern_atoms.push(...pa.atoms.filter((x) => x.role === 'head' && sig(x) === ps));
    }
    if (aux) pattern_atoms.push(...aux.atoms.filter((x) => x.role === 'head' && sig(x) === s));
    if (!known || pattern_atoms.length === 0) continue;
    const producer_sig = producers[0][1];
    const reported = new Set();
    for (const use of a.atoms.filter((x) => x.role === 'body' && sig(x) === s)) {
      if (pattern_atoms.some((p) => p.args.every((t, i) => terms_match(t, use.args[i])))) continue;
      const text = `${use.name}(${use.args.map(term_to_string).join(',')})`;
      if (reported.has(text)) continue;
      reported.add(text);
      const examples = [...new Set(pattern_atoms.map((p) => `${producer_sig.split('/')[0]}(${p.args.map(term_to_string).join(',')})`))].slice(0, 4);
      const from = producers.map(([pf]) => NAMES[pf]).join(' or ');
      const message = s === 'memory/1'
        ? `${text} never holds: this program only remembers ${examples.join(', ')}.`
        : `${text} never holds: ${from} only derives ${examples.join(', ')}.`;
      hints[field].push(at(use, 'warning', message + (examples.some((x) => x.includes('_')) ? ' (_ stands for anything.)' : '')));
    }
  }

  // Moves that nature does not react to
  const player = analysis.player_move_program;
  const nature = analysis.nature_program;
  if (player && nature && nature.complete) {
    const reactions = nature.atoms.filter((x) => x.role === 'body' && !x.in_constraint && sig(x) === 'do/1');
    if (reactions.length) {
      const reported = new Set();
      for (const move of player.atoms.filter((x) => x.role === 'head' && sig(x) === 'do/1')) {
        if (reactions.some((r) => terms_match(r.args[0], move.args[0]))) continue;
        const text = `do(${term_to_string(move.args[0])})`;
        if (reported.has(text)) continue;
        reported.add(text);
        const examples = [...new Set(reactions.map((r) => `do(${term_to_string(r.args[0])})`))].slice(0, 4);
        hints.player_move_program.push(at(move, 'warning', `The nature's moves program does not react to moves like ${text}: it only looks at ${examples.join(', ')}.` +
          (examples.some((x) => x.includes('_')) ? ' (_ stands for anything.)' : '')));
      }
    }
  }

  // The level: atoms that are dropped, and the size of the board
  const state = analysis.level_state;
  if (state) {
    for (const x of state.atoms) {
      if (x.role === 'head' && x.name === 'at' && x.arity !== 3) {
        hints.level_state.push(at(x, 'warning', `${sig(x)}: the state only consists of at(R,C,O) atoms (with 3 arguments); this one is dropped.`));
      }
    }
  }
  return hints;
}

// Problems with the facts that the board is drawn from (the player's view):
// returns a list of messages (empty if the board can be drawn).
export function board_problems(view, level_state = '') {
  const problems = [];
  const number = (re) => {
    const m = re.exec(view);
    return m ? Number(m[1]) : null;
  };
  const width = number(/setting\(grid_width\((\d+)\)\)/);
  const height = number(/setting\(grid_height\((\d+)\)\)/);
  if (width == null || height == null) {
    const missing = [width == null ? 'setting(grid_width(W))' : null, height == null ? 'setting(grid_height(H))' : null].filter(Boolean);
    problems.push(`The board cannot be drawn: the level settings have no ${missing.join(' and no ')}.`);
    return problems;
  }
  const outside = [];
  for (const m of level_state.matchAll(/(?:^|[^a-z_])at\((-?\d+),(-?\d+),([^()]*(?:\([^()]*\))?)\)/g)) {
    const r = Number(m[1]);
    const c = Number(m[2]);
    if (r < 1 || c < 1 || r > height || c > width) outside.push(`at(${m[1]},${m[2]},${m[3]})`);
  }
  if (outside.length) {
    problems.push(`${outside.slice(0, 3).join(', ')}${outside.length > 3 ? ', ...' : ''} ${outside.length > 1 ? 'are' : 'is'} outside of the board (rows 1-${height}, columns 1-${width}).`);
  }
  return problems;
}

// ---- Help about the special predicates (for the editors) --------------------------------

// What each special predicate means.
export const SPECIAL_DOCS = {
  'at/3': 'at(R,C,O): object O is in row R, column C (the current state of the game).',
  'at_time/4': 'at_time(T,R,C,O): object O was in row R, column C at time T (the history of the game).',
  'state_time/1': 'state_time(T): time T is part of the history of the game.',
  'current_time/1': 'current_time(T): the current time (0 at the start, one more after every step).',
  'setting/1': 'setting(S): a setting of the level, such as setting(grid_width(W)) or setting(grid_height(H)).',
  'decorate/*': 'decorate(...): instructions for drawing the board, such as decorate(label,O,font_f024); never passed to the player.',
  'debug/*': 'debug(...): kept in the level state for debugging, but not used by the game.',
  'observe/1': 'observe(X): what the player observes, such as observe(at(R,C,O)) or observe(fog(R,C)).',
  'memory/1': 'memory(X): what the player remembered (with remember(X)) in an earlier step.',
  'do/1': 'do(X): a move of the player, such as do(move(up)).',
  'remember/1': 'remember(X): store X in the memory of the player; memory(X) holds from the next step on.',
  'forget/1': 'forget(X): remove X from the memory of the player (remember wins over forget).',
  'next/3': 'next(R,C,O): object O is in row R, column C in the next state. Objects without a next atom disappear.',
  'wipe_player_memory/0': 'wipe_player_memory: empty the memory of the player after this step.',
  'win/*': 'win: the game is won (checked at the start of every step).',
  'lose/*': 'lose: the game is lost (checked at the start of every step, before win).',
};

const doc_key = (s) => (SPECIAL_DOCS[s] ? s : SPECIAL_DOCS[s.replace(/\/\d+$/, '/*')] ? s.replace(/\/\d+$/, '/*') : null);

// Help about predicate `s` ('name/arity') in the program `field`, or null if it
// is not a special predicate: { title, text }.
export function special_help(field, s) {
  const key = doc_key(s);
  if (!key) return null;
  const iface = INTERFACES[field];
  let role = '';
  if (iface && in_list(s, iface.inputs)) {
    role = `This program gets it from the game.`;
  } else if (iface && in_list(s, iface.outputs)) {
    const to = {
      'do/1': "the nature's moves program", 'remember/1': "the player's memory", 'forget/1': "the player's memory",
      'observe/1': 'the player strategy', 'next/3': 'the next state of the game', 'wipe_player_memory/0': "the player's memory",
      'at/3': 'the level state', 'setting/1': 'the level settings', 'decorate/*': 'the drawing of the board', 'debug/*': 'the level state',
    }[key];
    role = to ? `This program passes it on to ${to}.` : 'This program passes it on to the game.';
  } else if (iface) {
    const users = Object.entries(INTERFACES).filter(([f, i]) => f !== field && (in_list(s, i.inputs) || in_list(s, i.outputs))).map(([f]) => NAMES[f]);
    const list = users.length > 1 ? users.slice(0, -1).join(', ') + ' and ' + users.at(-1) : users[0];
    role = `${NAMES[field][0].toUpperCase() + NAMES[field].slice(1)} does not get it${list ? ` (it is used by ${list})` : ''}.`;
  } else if (field === 'aux_program') {
    role = 'The auxiliary program is added to all programs, so this depends on the program it is added to.';
  }
  return { title: key.replace('/*', ''), text: SPECIAL_DOCS[key] + (role ? ' ' + role : '') };
}

// Completions for program `field`: its special predicates first, then the
// predicates the other programs of the game define (e.g. in the auxiliary program).
// Returns [{ caption, value, meta, doc }].
export function completions(field, game) {
  const out = [];
  const seen = new Set();
  const add = (s, meta) => {
    const [name, arity] = s.split('/');
    if (seen.has(name + '/' + arity)) return;
    seen.add(name + '/' + arity);
    const help = special_help(field, s);
    out.push({ caption: arity === '*' ? name : `${name}/${arity}`, value: arity === '0' || arity === '*' ? name : name + '(', meta, doc: help ? help.text : '' });
  };
  const iface = INTERFACES[field];
  if (iface) {
    for (const s of iface.inputs) add(s, 'gets');
    for (const s of iface.outputs) add(s, 'passes on');
  }
  for (const f of ['aux_program', field]) {
    if (!game || !game[f]) continue;
    for (const a of analyze_program(preprocess_program(game[f], () => 0)).atoms) {
      if (a.role === 'head') add(sig(a), f === 'aux_program' && field !== f ? 'auxiliary' : 'defined here');
    }
  }
  return out;
}

// ---- Why the player made no move (or several) ----------------------------------------------

// A hint for a step in which the player made no move, or several moves at once:
// { text, lines } (lines: the lines of the player strategy to look at, from 1),
// or null when the player made exactly one move. `program` is the player
// strategy the step was played with, `moves` the moves it derived ('do(..). do(..).'),
// and `problem` the problem of the player strategy in that step (or null).
export function move_hint(program, moves, problem) {
  const made = facts_to_answer_set(moves || '');
  if (made.length === 1) return null;
  if (problem) {
    const status = problem.result.status;
    if (status === 'error') {
      const e = (problem.result.errors || []).find((x) => x.source === 'player_move_program');
      return {
        text: 'Your strategy has an error, so the player made no move' + (e ? `: ${e.message}` : '.'),
        lines: e && e.line ? [e.line] : [],
      };
    }
    if (status === 'unsat') {
      const violated = (problem.result.violated || []).filter((v) => v.source === 'player_move_program');
      return {
        text: violated.length
          ? `Your strategy had no answer set in this step, because ${violated.length > 1 ? 'constraints were' : 'a constraint was'} violated, so the player made no move.`
          : 'Your strategy had no answer set in this step, so the player made no move.',
        lines: [...new Set(violated.map((v) => v.line))],
      };
    }
    return { text: `Your strategy did not finish in this step (${problem.text.split('\n')[0]}), so the player made no move.`, lines: [] };
  }
  const rules = analyze_program(program).atoms.filter((a) => a.role === 'head' && !a.declared && sig(a) === 'do/1');
  const lines = [...new Set(rules.map((a) => a.line))];
  if (made.length === 0) {
    if (!rules.length) {
      return { text: 'Your strategy never derives do(...), so the player never moves. Add a rule such as do(move(up)) :- ... .', lines: [] };
    }
    return {
      text: `None of your rules for do(...) applied in this step: their conditions did not hold for what the player saw (see the player input in the Debug tab).`,
      lines,
    };
  }
  return {
    text: `The player made ${made.length} moves at once (${made.join(', ')}). A strategy usually makes one move per step: ` +
      'check that the conditions of your rules for do(...) exclude each other.',
    lines,
  };
}
