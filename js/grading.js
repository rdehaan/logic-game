// Grading games: the rubric and the grade, measurements of a game (how long its
// programs take, whether its strategy wins on new levels, whether it hides
// things from the player, has moving objects, random levels, uses the memory),
// how well its programs are documented, how similar it is to other games, and
// the scores that these measurements suggest for the items of the rubric.
//
// The grader always decides: suggestions only fill in items that the grader has
// not decided yet, and every suggestion comes with the evidence it is based on.
//
// This module does not use the DOM, so the tests can run it in Node.
import { GAME_FIELDS, normalize_game, generate_level, GameSession, is_fatal } from './engine.js';
import { facts_to_answer_set, split_atom, seeded_rng, preprocess_program } from './asp.js';
import { tokenize, analyze_program } from './analysis.js';
import { compute_grid_ds } from './grid-visual.js';

// ---- The rubric -----------------------------------------------------------------
//
// A rubric (a JSON file, "format": "logic-game-rubric"):
//   title         the course and assignment (on every feedback document)
//   required      { grade, items }: the grade when all of these items are met
//   extra         { max, all_grade, items }: items with points that raise the grade,
//                 up to `max`; all of them (in full) give `all_grade`
//   checks        thresholds for the suggestions (see DEFAULT_CHECKS)
//   snippets      standard comments, to insert with one click
// An item: { id, label, points (extra items), check (what suggests a score: see
// CHECKS), description }.

export const RUBRIC_FORMAT = 'logic-game-rubric';
export const GRADING_FORMAT = 'logic-game-grading';

// What can suggest a score for an item (the `check` of an item).
export const CHECKS = {
  timing: 'how long level generation and the programs take',
  novelty: 'how similar the game is to the example games and to the other submissions',
  comments: 'how many comments the programs have',
  visual: 'the labels and colors the game uses (the grader decides)',
  hidden: 'whether the player cannot see some objects',
  npc: 'whether objects other than the player move',
  random: 'whether level generation makes different levels',
  new_levels: 'how often the strategy wins on new levels',
  memory: 'whether the strategy uses the memory (remember/1)',
};

export const DEFAULT_CHECKS = {
  test_levels: 20,                // levels played for the measurements
  generation_seconds: 5,          // level generation may take this long ...
  step_seconds: 2,                // ... and a program in one step this long
  min_comment_ratio: 0.15,        // comment lines per line of code, for each program
  min_win_rate: 0.9,              // "works for new levels" from this rate on
  low_win_rate: 0.5,              // and certainly not below this rate
  similar: 0.8,                   // a game this similar to another one is a near-copy
  different: 0.5,                 // and below this it is clearly different
  player_objects: ['player'],     // the objects that are the player (the others are NPCs)
};

export const DEFAULT_SNIPPETS = [
  'Well done: the game works, and the strategy wins reliably.',
  'Some of the programs have (almost) no comments: explain what the rules do.',
  'The strategy does not win on all newly generated levels (see the test results).',
  'Level generation (or a step of the game) takes long; this impedes game play.',
  'The PDF does not motivate why the game satisfies the items you claim points for.',
  'Everything is visible to the player: no (important) elements are hidden.',
  'The game is very close to one of the example games.',
  'The memory feature is used, but the game can be solved without it.',
];

export const DEFAULT_RUBRIC = {
  format: RUBRIC_FORMAT,
  format_version: 1,
  title: 'Knowledge Representation and Reasoning 2026 — Homework 3, Exercise 1',
  required: {
    grade: 6,
    items: [
      { id: 'timing', label: 'Level generation and execution of the game (with the strategy) run in a matter of seconds', check: 'timing' },
      { id: 'novel', label: 'The game is novel (in some way)', check: 'novelty' },
      { id: 'documented', label: 'The answer set programs are properly documented with comments', check: 'comments' },
    ],
  },
  extra: {
    max: 9,
    all_grade: 10,
    items: [
      { id: 'visual', label: 'The game is visually pleasing', points: 0.5, check: 'visual' },
      { id: 'hidden', label: 'Some (important) elements in the game are not observable to the player', points: 1, check: 'hidden' },
      { id: 'npc', label: 'The game involves moving NPCs (non-playable characters)', points: 1, check: 'npc' },
      { id: 'random', label: 'Level generation involves randomness', points: 0.5, check: 'random' },
      { id: 'new_levels', label: 'The solution works for newly generated levels', points: 0.5, check: 'new_levels' },
      { id: 'memory', label: 'Solving the game involves the memory feature', points: 1, check: 'memory' },
    ],
  },
  checks: { ...DEFAULT_CHECKS },
  snippets: DEFAULT_SNIPPETS,
};

// Read a rubric (an object, or the text of a JSON file); throws with a reason
// if it is not one. Missing parts get their defaults.
export function read_rubric(input) {
  let r = input;
  if (typeof input === 'string') {
    try {
      r = JSON.parse(input);
    } catch (e) {
      throw new Error('the rubric is not valid JSON: ' + e.message);
    }
  }
  if (!r || typeof r !== 'object') throw new Error('this is not a rubric');
  if (r.format && r.format !== RUBRIC_FORMAT) throw new Error(`this is not a rubric (its format is "${r.format}")`);
  const ids = new Set();
  const items = (list, extra) => {
    if (!Array.isArray(list)) throw new Error(`the rubric has no list of ${extra ? 'extra' : 'required'} items`);
    return list.map((item, i) => {
      if (!item || typeof item !== 'object' || typeof item.label !== 'string' || !item.label.trim()) {
        throw new Error(`item ${i + 1} of the ${extra ? 'extra' : 'required'} items has no label`);
      }
      const id = String(item.id || `${extra ? 'extra' : 'required'}_${i + 1}`);
      if (ids.has(id)) throw new Error(`two items of the rubric have the id "${id}"`);
      ids.add(id);
      if (item.check != null && !CHECKS[item.check]) throw new Error(`the item "${item.label}" has an unknown check "${item.check}" (known: ${Object.keys(CHECKS).join(', ')})`);
      const points = extra ? Number(item.points) : 0;
      if (extra && !(points > 0)) throw new Error(`the extra item "${item.label}" has no points`);
      return { id, label: item.label, check: item.check || null, description: item.description || '', ...(extra ? { points } : {}) };
    });
  };
  const required = r.required || {};
  const extra = r.extra || { items: [] };
  const rubric = {
    format: RUBRIC_FORMAT,
    format_version: 1,
    title: typeof r.title === 'string' ? r.title : '',
    required: { grade: Number(required.grade ?? 6), items: items(required.items || [], false) },
    extra: {
      max: Number(extra.max ?? 10),
      all_grade: extra.all_grade == null ? null : Number(extra.all_grade),
      items: items(extra.items || [], true),
    },
    checks: { ...DEFAULT_CHECKS, ...(r.checks || {}) },
    snippets: Array.isArray(r.snippets) ? r.snippets.filter((s) => typeof s === 'string') : [...DEFAULT_SNIPPETS],
  };
  if (!Number.isFinite(rubric.required.grade) || !Number.isFinite(rubric.extra.max)) throw new Error('the grades of the rubric are not numbers');
  return rubric;
}

export const rubric_items = (rubric) => [
  ...rubric.required.items.map((item) => ({ ...item, required: true })),
  ...rubric.extra.items.map((item) => ({ ...item, required: false })),
];

// The points an extra item gets from a score { value: 'yes' | 'no' | '', points }.
export function item_points(item, score) {
  if (!score || score.value !== 'yes') return 0;
  const p = Number(score.points);
  return score.points != null && score.points !== '' && Number.isFinite(p) ? Math.max(0, Math.min(item.points, p)) : item.points;
}

// The grade from the scores ({ item id: { value, points } }):
//   { grade, complete, below_pass, points, text }
// grade is null when it cannot be computed: when an item is not decided yet, or
// when a required item is not met (then the grader gives the grade). An
// override (a number) is the grade, whatever the scores are.
export function compute_grade(rubric, scores = {}, override = null) {
  const required = rubric.required.items;
  const extra = rubric.extra.items;
  const value = (item) => (scores[item.id] && scores[item.id].value) || '';
  const undecided = [...required, ...extra].filter((item) => !value(item));
  const below_pass = required.some((item) => value(item) === 'no');
  const points = extra.reduce((n, item) => n + item_points(item, scores[item.id]), 0);
  const all_extra = extra.length > 0 && extra.every((item) => value(item) === 'yes' && item_points(item, scores[item.id]) === item.points);
  let grade = null;
  if (!below_pass) {
    grade = Math.min(rubric.extra.max, rubric.required.grade + points);
    if (all_extra && rubric.extra.all_grade != null) grade = rubric.extra.all_grade;
  }
  const complete = undecided.length === 0;
  let text;
  const has_override = override != null && override !== '' && Number.isFinite(Number(override));
  if (has_override) text = `${format_number(Number(override))} (given by the grader)`;
  else if (below_pass) text = 'not all requirements are met: the grader gives the grade';
  else if (!complete) text = `${format_number(grade)} so far (${undecided.length} item${undecided.length > 1 ? 's' : ''} not decided)`;
  else text = format_number(grade);
  return {
    grade: has_override ? Number(override) : complete ? grade : null,
    computed: below_pass ? null : grade,
    complete: has_override || complete,
    below_pass, points, all_extra, undecided: undecided.map((item) => item.id), text,
  };
}

export function format_number(x) {
  if (x == null || !Number.isFinite(x)) return '';
  return Number.isInteger(x) ? String(x) : String(Math.round(x * 100) / 100);
}

// ---- Comments ------------------------------------------------------------------------

// How well a program is documented: { lines, code_lines, comment_lines, ratio }
// (lines with code, lines with a comment, and comment lines per code line).
export function comment_stats(text) {
  const lines = (text || '').split('\n');
  const code = new Set();
  const comment = new Set();
  let i = 0;
  let line = 0;
  const s = text || '';
  while (i < s.length) {
    const ch = s[i];
    if (ch === '\n') {
      line++;
      i++;
    } else if (ch === '%' && s[i + 1] === '*') {
      const end = s.indexOf('*%', i + 2);
      const stop = end < 0 ? s.length : end + 2;
      for (; i < stop; i++) {
        if (s[i] === '\n') line++;
        else if (!/\s/.test(s[i])) comment.add(line);
      }
    } else if (ch === '%') {
      const end = s.indexOf('\n', i);
      const stop = end < 0 ? s.length : end;
      if (s.slice(i + 1, stop).replace(/%/g, '').trim()) comment.add(line);
      i = stop;
    } else if (ch === '"') {
      code.add(line);
      i++;
      while (i < s.length && s[i] !== '"' && s[i] !== '\n') i += s[i] === '\\' ? 2 : 1;
      i++;
    } else {
      if (!/\s/.test(ch)) code.add(line);
      i++;
    }
  }
  const code_lines = code.size;
  const comment_lines = comment.size;
  return { lines: lines.length, code_lines, comment_lines, ratio: code_lines ? comment_lines / code_lines : (comment_lines ? 1 : 0) };
}

// The programs that are written by the students (not the level).
export const PROGRAMS = ['aux_program', 'level_gen_program', 'visibility_program', 'nature_program', 'goal_program', 'player_move_program'];

export function game_comment_stats(game) {
  game = normalize_game(game);
  return Object.fromEntries(PROGRAMS.map((field) => [field, comment_stats(game[field])]));
}

// ---- Similarity -------------------------------------------------------------------------
//
// Programs are compared as sequences of tokens, without comments and spaces,
// with every variable written as V (so renaming variables does not make a copy
// look different). Similarity is the Jaccard index of the sets of runs of
// SHINGLE tokens: 1 for the same program, 0 for programs without a run in common.
// This is a hint for the grader, not proof of copying.

const SHINGLE = 5;

export function program_tokens(text) {
  const tokens = tokenize(text || '');
  if (!tokens) return (text || '').replace(/%[^\n]*/g, '').split(/\s+/).filter(Boolean);
  return tokens.map((t) => (t.type === 'variable' || t.type === 'anon' ? 'V' : t.value));
}

export function shingles(tokens) {
  const out = new Set();
  if (tokens.length && tokens.length < SHINGLE) out.add(tokens.join(' '));
  for (let i = 0; i + SHINGLE <= tokens.length; i++) out.add(tokens.slice(i, i + SHINGLE).join(' '));
  return out;
}

export function jaccard(a, b) {
  if (!a.size && !b.size) return null;      // (two empty programs: nothing to compare)
  let common = 0;
  for (const x of a) if (b.has(x)) common++;
  return common / (a.size + b.size - common);
}

// The fingerprint of a game, for comparing: the shingles of each program, and of all of them.
export function fingerprint(game) {
  game = normalize_game(game);
  const per = Object.fromEntries(PROGRAMS.map((field) => [field, shingles(program_tokens(game[field]))]));
  const all = new Set();
  for (const field of PROGRAMS) for (const s of per[field]) all.add(field + ':' + s);
  return { per, all };
}

// How similar two games are: { overall, programs: { field: similarity or null } }.
export function similarity(a, b) {
  const fa = a.per ? a : fingerprint(a);
  const fb = b.per ? b : fingerprint(b);
  const programs = {};
  for (const field of PROGRAMS) programs[field] = jaccard(fa.per[field], fb.per[field]);
  return { overall: jaccard(fa.all, fb.all) ?? 0, programs };
}

// The games most similar to `game` among `others` ([{ name, game }]), most similar first:
// [{ name, overall, programs }].
export function most_similar(game, others, n = 3) {
  const f = fingerprint(game);
  return others.map(({ name, game: g, fingerprint: fp }) => ({ name, ...similarity(f, fp || fingerprint(g)) }))
    .sort((x, y) => y.overall - x.overall).slice(0, n);
}

// ---- What a game shows -------------------------------------------------------------------

// The objects on the board of the current time of a game state:
// [{ row, col, object }] (as text, e.g. '2', '8', 'player').
export function state_objects(game_state) {
  const atoms = facts_to_answer_set(game_state).map(split_atom);
  const times = atoms.filter((a) => a.name === 'at_time' && a.args.length === 4).map((a) => Number(a.args[0]));
  const now = times.length ? Math.max(...times) : null;
  return atoms.filter((a) => a.name === 'at_time' && a.args.length === 4 && Number(a.args[0]) === now)
    .map((a) => ({ row: a.args[1], col: a.args[2], object: a.args[3] }));
}

// The objects that the player observes: [{ row, col, object }].
export function observed_objects(player_input) {
  const out = [];
  for (const a of facts_to_answer_set(player_input).map(split_atom)) {
    if (a.name !== 'observe' || a.args.length !== 1) continue;
    const inner = split_atom(a.args[0]);
    if (inner.name === 'at' && inner.args.length === 3) out.push({ row: inner.args[0], col: inner.args[1], object: inner.args[2] });
  }
  return out;
}

const key_of = (o) => `${o.row},${o.col},${o.object}`;

// The facts for the board with everything on it: what the player sees (`view`,
// as GameSession.view() gives it), and the objects of the game state that the
// player does not see, as decorate(item,R,C,O) (drawn faded on the board).
// An object is not added to a cell that already shows it, or that shows
// something that looks the same (the same label): e.g. a game that draws
// hidden objects faded itself (decorate(item,R,C,O)), or lets the player see
// an object under another name with the same icon.
export function full_view(view, game_state) {
  const grid = compute_grid_ds(view);
  const seen = new Set(observed_objects(view).map(key_of));
  const label = (o) => (grid ? grid.labels.get(o) : undefined);
  const shown = (o) => {
    if (seen.has(key_of(o))) return true;
    if (!grid) return false;
    const r = Number(o.row);
    const c = Number(o.col);
    if (!(r >= 1 && c >= 1 && r <= grid.height && c <= grid.width)) return false;
    const there = [...(grid.cells.get((r - 1) * grid.width + c) || []), ...(grid.hidden.get((r - 1) * grid.width + c) || [])];
    return there.includes(o.object) || (label(o.object) != null && there.some((x) => label(x) === label(o.object)));
  };
  const added = new Set();
  const hidden = state_objects(game_state).filter((o) => {
    if (shown(o) || added.has(key_of(o))) return false;
    added.add(key_of(o));
    return true;
  });
  // (an object without a label, e.g. one that a game only keeps for itself, is shown by its name)
  const unlabelled = [...new Set(hidden.map((o) => o.object).filter((x) => label(x) == null))];
  return view + hidden.map((o) => ` decorate(item,${o.row},${o.col},${o.object}).`).join('') +
    unlabelled.map((x) => ` decorate(label,${x},"${x.replace(/[\\"]/g, (c) => '\\' + c)}").`).join('');
}

// The facts for the board of a level, as the level is (everything visible).
export function level_view(level_state, level_settings) {
  const objects = facts_to_answer_set(level_state).map(split_atom).filter((a) => a.name === 'at' && a.args.length === 3);
  return objects.map((a) => `observe(at(${a.args.join(',')})).`).join(' ') + ' ' + (level_settings || '');
}

// The labels and colors that a game uses (in its level settings and decorations).
export function decoration_stats(level_settings, decorations = '') {
  const atoms = facts_to_answer_set((level_settings || '') + ' ' + (decorations || '')).map(split_atom).filter((a) => a.name === 'decorate');
  const count = (kind) => new Set(atoms.filter((a) => a.args[0] === kind).map((a) => a.args.slice(1).join(','))).size;
  const icons = new Set(atoms.filter((a) => a.args[0] === 'label' && /^font_/.test(a.args[2] || '')).map((a) => a.args[1])).size;
  return { labels: count('label'), colors: count('color'), backgrounds: count('bgcolor'), icons };
}

// What the static analysis of a game says (no clingo needed).
export function static_facts(game) {
  game = normalize_game(game);
  const strategy = analyze_program(preprocess_program(game.player_move_program, () => 0));
  const heads = new Set(strategy.atoms.filter((a) => a.role === 'head').map((a) => a.name));
  const bodies = new Set(strategy.atoms.filter((a) => a.role === 'body').map((a) => a.name));
  const nature = analyze_program(preprocess_program(game.nature_program, () => 0));
  return {
    randint: /RANDINT\s*\(/.test(game.level_gen_program),
    remembers: heads.has('remember'),
    forgets: heads.has('forget'),
    reads_memory: bodies.has('memory'),
    wipes_memory: nature.atoms.some((a) => a.role === 'head' && a.name === 'wipe_player_memory'),
    comments: game_comment_stats(game),
  };
}

// ---- Measuring a game ---------------------------------------------------------------------
//
// Plays the game on levels 1, 2, ..., n (as Test your strategy does: level k is
// generated and played with the random numbers of seed k, so each of them can
// be played again exactly), and keeps:
// - how long level generation took, and each program in each step;
// - how each game ended;
// - which objects the player did not see, and which objects moved;
// - whether the player's memory was used;
// - how many different levels were generated (and the first few of them).

export const LEVELS_KEPT = 6;

export async function measure_game(solver, game, {
  levels = DEFAULT_CHECKS.test_levels, max_time = 500, on_progress = () => {}, cancelled = () => false,
} = {}) {
  game = normalize_game(game);
  const t_start = Date.now();
  const out = {
    levels: [],
    generation_ms: [],
    program_ms: {},           // program -> { max, total, steps }
    distinct_levels: 0,
    sample_levels: [],        // [{ seed, level_state, level_settings }]
    hidden: {},               // object -> number of steps in which some of it was not seen
    fog: false,
    moved: {},                // object -> number of steps in which it moved
    memory_steps: 0,
    steps: 0,
    statics: static_facts(game),
    cancelled: false,
    timeout_s: solver.timeout_ms / 1000,
  };
  const seen_levels = new Set();
  for (let seed = 1; seed <= levels; seed++) {
    if (cancelled()) {
      out.cancelled = true;
      break;
    }
    on_progress({ level: seed, levels });
    const rng = seeded_rng(seed);
    const t0 = Date.now();
    const level = await generate_level(solver, game, rng);
    out.generation_ms.push(Date.now() - t0);
    if (level.problem) {
      out.levels.push({ seed, verdict: is_fatal(level.problem) ? 'stopped' : 'no level', steps: 0, message: 'Level generation: ' + level.problem.text });
      continue;
    }
    if (!seen_levels.has(level.level_state)) {
      seen_levels.add(level.level_state);
      if (out.sample_levels.length < LEVELS_KEPT) out.sample_levels.push({ seed, level_state: level.level_state, level_settings: level.level_settings });
    }
    out.levels.push(await measure_play(solver, { ...game, ...level }, rng, max_time, out, cancelled, seed));
  }
  out.distinct_levels = seen_levels.size;
  out.seconds = (Date.now() - t_start) / 1000;
  return out;
}

async function measure_play(solver, game, rng, max_time, out, cancelled, seed) {
  const session = new GameSession(solver, game, { rng, max_time, verbose: false });
  const t0 = Date.now();
  const start = await session.start();
  const decorations = decoration_stats(game.level_settings, session.player_decorations);
  if (session.verdict) return { seed, verdict: session.verdict, steps: 0, message: (start.message || '').trim(), ms: Date.now() - t0, decorations };
  const look = (before) => {
    const objects = state_objects(session.game_state);
    const seen = new Set(observed_objects(session.player_input).map(key_of));
    const hidden = new Set(objects.filter((o) => !seen.has(key_of(o))).map((o) => o.object));
    for (const o of hidden) out.hidden[o] = (out.hidden[o] || 0) + 1;
    if (/observe\(fog\(/.test(session.player_input)) out.fog = true;
    if (session.player_memory) out.memory_steps++;
    const now = new Map();
    for (const o of objects) {
      if (!now.has(o.object)) now.set(o.object, new Set());
      now.get(o.object).add(o.row + ',' + o.col);
    }
    if (before) {
      for (const [object, cells] of now) {
        const was = before.get(object);
        if (was && was.size && [...cells].some((c) => !was.has(c))) out.moved[object] = (out.moved[object] || 0) + 1;
      }
    }
    return now;
  };
  let before = look(null);
  let message = '';
  while (!session.verdict) {
    if (cancelled()) {
      message = 'canceled';
      break;
    }
    const step = await session.step();
    for (const [program, ms] of Object.entries(session.times)) {
      const p = out.program_ms[program] || (out.program_ms[program] = { max: 0, total: 0, steps: 0 });
      p.max = Math.max(p.max, ms);
      p.total += ms;
      p.steps++;
    }
    if (step.verdict) {
      message = (step.message || '').trim();
      break;
    }
    out.steps++;
    before = look(before);
  }
  return { seed, verdict: session.verdict || 'cancelled', steps: session.time_step, message, ms: Date.now() - t0, decorations };
}

// ---- Suggestions --------------------------------------------------------------------------

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const seconds = (ms) => `${(ms / 1000).toFixed(1)} s`;

export function win_counts(m) {
  const counts = {};
  for (const l of m.levels) counts[l.verdict] = (counts[l.verdict] || 0) + 1;
  return counts;
}

// The objects that moved and are not the player.
export function npcs(m, checks = DEFAULT_CHECKS) {
  const players = new Set(checks.player_objects || []);
  const moving = Object.keys(m.moved);
  const has_player = moving.some((o) => players.has(o));
  // (no object is called as the player: one of the moving objects is the player)
  return has_player ? moving.filter((o) => !players.has(o)) : moving.length > 1 ? moving : [];
}

// What the measurements (and the similarity to other games) suggest for an item:
// { value: 'yes' | 'no' | '' (no suggestion), evidence: text }.
export function suggest(item, m, checks = DEFAULT_CHECKS, similar = null) {
  const s = (value, evidence) => ({ value, evidence });
  const st = m ? m.statics : null;
  switch (item.check) {
    case 'timing': {
      if (!m || !m.levels.length) return s('', 'not measured yet');
      const gen = Math.max(0, ...m.generation_ms);
      const slowest = Object.entries(m.program_ms).sort((a, b) => b[1].max - a[1].max)[0];
      const step = slowest ? slowest[1].max : 0;
      const stopped = m.levels.filter((l) => l.verdict === 'stopped').length;
      const evidence = `level generation at most ${seconds(gen)}; slowest program in a step: ${slowest ? `${STEP_PROGRAM_NAMES[slowest[0]] || slowest[0]} ${seconds(step)}` : 'none'}` +
        (stopped ? `; clingo was stopped (after ${m.timeout_s} s) in ${plural(stopped, 'level')}` : '');
      if (stopped) return s('no', evidence);
      if (gen <= checks.generation_seconds * 1000 && step <= checks.step_seconds * 1000) return s('yes', evidence);
      return s('', evidence + ` (more than ${checks.generation_seconds} s for generation or ${checks.step_seconds} s for a step: judge whether it impedes game play)`);
    }
    case 'comments': {
      const stats = st ? st.comments : null;
      if (!stats) return s('', 'not measured yet');
      const parts = PROGRAMS.filter((f) => stats[f].code_lines > 0);
      const few = parts.filter((f) => stats[f].ratio < checks.min_comment_ratio);
      const none = parts.filter((f) => stats[f].comment_lines === 0 && stats[f].code_lines >= 3);
      const evidence = parts.map((f) => `${PROGRAM_NAMES[f]}: ${stats[f].comment_lines}/${stats[f].code_lines}`).join(', ') + ' (comment lines / code lines)';
      if (none.length) return s('no', `no comments in the ${none.map((f) => PROGRAM_NAMES[f]).join(', ')}; ` + evidence);
      if (!few.length) return s('yes', evidence);
      return s('', `few comments in the ${few.map((f) => PROGRAM_NAMES[f]).join(', ')}; ` + evidence);
    }
    case 'novelty': {
      if (!similar || !similar.length) return s('', 'not compared yet');
      const top = similar[0];
      const evidence = 'most similar: ' + similar.map((x) => `${x.name} (${Math.round(x.overall * 100)}%)`).join(', ');
      if (top.overall >= checks.similar) return s('no', evidence);
      if (top.overall < checks.different) return s('yes', evidence);
      return s('', evidence);
    }
    case 'visual': {
      if (!m || !m.levels.length || !m.levels[0].decorations) return s('', 'the grader decides');
      const d = m.levels.find((l) => l.decorations).decorations;
      return s('', `the grader decides (the game uses ${plural(d.labels, 'label')}, ${d.icons} of them icons, ${plural(d.colors, 'color')}, ${plural(d.backgrounds, 'background color')})`);
    }
    case 'hidden': {
      if (!m || !m.steps) return s('', 'not measured yet');
      const hidden = Object.entries(m.hidden).sort((a, b) => b[1] - a[1]);
      if (!hidden.length) return s('no', `the player saw every object in all ${m.steps} steps` + (m.fog ? ' (some cells are fog)' : ''));
      return s('yes', 'not seen by the player: ' + hidden.map(([o, n]) => `${o} (in ${plural(n, 'step')})`).join(', '));
    }
    case 'npc': {
      if (!m || !m.steps) return s('', 'not measured yet');
      const moving = Object.entries(m.moved).sort((a, b) => b[1] - a[1]);
      const evidence = moving.length ? 'objects that moved: ' + moving.map(([o, n]) => `${o} (in ${plural(n, 'step')})`).join(', ') : 'no object moved';
      return npcs(m, checks).length ? s('yes', evidence) : s('no', evidence);
    }
    case 'random': {
      if (!m || !m.levels.length) return s('', 'not measured yet');
      const evidence = `${m.distinct_levels} different level${m.distinct_levels === 1 ? '' : 's'} in ${plural(m.levels.length, 'level')} generated` +
        (st && st.randint ? ' (level generation uses RANDINT)' : ' (level generation does not use RANDINT)');
      if (m.distinct_levels > 1) return s('yes', evidence);
      return s(m.levels.length > 1 ? 'no' : '', evidence);
    }
    case 'new_levels': {
      if (!m || !m.levels.length) return s('', 'not measured yet');
      const counts = win_counts(m);
      const rate = (counts.win || 0) / m.levels.length;
      const evidence = `won ${counts.win || 0} of ${plural(m.levels.length, 'new level')} (${Math.round(rate * 100)}%)`;
      if (rate >= checks.min_win_rate) return s('yes', evidence);
      if (rate < checks.low_win_rate) return s('no', evidence);
      return s('', evidence);
    }
    case 'memory': {
      if (!st) return s('', 'not measured yet');
      if (!st.remembers) return s('no', 'the strategy never derives remember/1');
      const used = m && m.steps ? `; the memory was not empty in ${m.memory_steps} of ${plural(m.steps, 'step')}` : '';
      if (!st.reads_memory) return s('', 'the strategy derives remember/1, but does not use memory/1' + used);
      if (m && m.steps && !m.memory_steps) return s('no', 'the strategy derives remember/1, but nothing was remembered while playing' + used);
      return s('yes', 'the strategy remembers (remember/1) and uses its memory (memory/1)' + used + '; judge whether solving the game involves it');
    }
    default:
      return s('', '');
  }
}

// The programs that are timed in each step (the keys of GameSession.times).
export const STEP_PROGRAM_NAMES = { visibility: 'visibility', player: 'strategy', nature: "nature's moves", goal: 'winning conditions' };

export const PROGRAM_NAMES = {
  aux_program: 'auxiliary program',
  level_gen_program: 'level generation',
  visibility_program: 'visibility',
  nature_program: "nature's moves",
  goal_program: 'winning conditions',
  player_move_program: 'strategy',
};

// Suggestions for all items: { item id: { value, evidence } }.
export function suggest_all(rubric, m, similar = null) {
  return Object.fromEntries(rubric_items(rubric).map((item) => [item.id, suggest(item, m, rubric.checks, similar)]));
}

// Fill in the suggestions for the items that the grader did not decide yet.
// Returns the new scores (the old ones are not changed).
export function apply_suggestions(rubric, scores, suggestions) {
  const out = { ...scores };
  for (const item of rubric_items(rubric)) {
    const sug = suggestions[item.id];
    const cur = out[item.id] || { value: '', points: null, note: '' };
    if (!cur.value && sug && sug.value) out[item.id] = { ...cur, value: sug.value, suggested: true };
  }
  return out;
}

// ---- A grading session ------------------------------------------------------------------
//
// All students of a batch: { format, format_version, rubric, snippets, students },
// a student: { key, name, canvas_id, late, files, warnings, game, game_file, pdfs,
// status, scores, comment, line_notes, images, include_tests, grade_override,
// measurements, similar, updated_at }. (The PDF files themselves are kept elsewhere:
// they are not part of an exported session.)

export function new_student({ key, name, canvas_id = null, late = false, files = [], warnings = [], game = null, game_file = null, pdfs = [] }) {
  return {
    key, name, canvas_id, late, files, warnings, game: game ? normalize_game(game) : null, game_file, pdfs,
    status: 'new', scores: {}, comment: '', line_notes: [], images: [], include_tests: false, grade_override: null,
    measurements: null, measured_game: null, similar: null, updated_at: new Date().toISOString(),
  };
}

// Whether a student's record has any grading work in it.
export function has_work(st) {
  return Boolean(st && (st.comment || st.line_notes.length || st.images.length || Object.values(st.scores).some((x) => x && (x.value || x.note)) ||
    (st.grade_override != null && st.grade_override !== '') || st.status !== 'new'));
}

export function session_file(session) {
  return {
    format: GRADING_FORMAT,
    format_version: 1,
    saved_at: new Date().toISOString(),
    rubric: session.rubric,
    students: session.students,
  };
}

// Read an exported grading session (text). Returns { rubric, students }.
export function read_session(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('this is not a grading file (it is not JSON)');
  }
  if (!data || data.format !== GRADING_FORMAT) throw new Error('this is not a grading file');
  if (Number(data.format_version) > 1) throw new Error('this grading file was made by a newer version of the page: reload the page');
  if (!Array.isArray(data.students)) throw new Error('the grading file has no students');
  const students = data.students.filter((st) => st && typeof st.key === 'string').map((st) => ({ ...new_student(st), ...st }));
  return { rubric: data.rubric ? read_rubric(data.rubric) : null, students };
}

// Merge the students of another session into ours: a student that is only in
// theirs is added; for a student in both, the record that was changed last is
// kept (but our submitted game and files stay, if theirs has none). Measurements
// that we do not have yet are taken over in any case (e.g. from the command
// line: logic-game grade).
// Returns { students, added, updated, kept, measured }.
export function merge_students(ours, theirs) {
  const by_key = new Map(ours.map((st) => [st.key, st]));
  let added = 0;
  let updated = 0;
  let kept = 0;
  let measured = 0;
  for (const st of theirs) {
    const mine = by_key.get(st.key);
    if (!mine) {
      by_key.set(st.key, st);
      added++;
    } else if ((st.updated_at || '') > (mine.updated_at || '') && has_work(st)) {
      by_key.set(st.key, {
        ...st, game: st.game || mine.game, pdfs: st.pdfs && st.pdfs.length ? st.pdfs : mine.pdfs, files: st.files && st.files.length ? st.files : mine.files,
        ...(!st.measurements && mine.measurements ? measurement_fields(mine) : {}),
      });
      updated++;
    } else if (st.measurements && !mine.measurements) {
      by_key.set(st.key, { ...mine, ...measurement_fields(st) });
      measured++;
    } else {
      kept++;
    }
  }
  return { students: [...by_key.values()], added, updated, kept, measured };
}

const measurement_fields = (st) => ({ measurements: st.measurements, measured_game: st.measured_game || null, similar: st.similar || null, suggestions: st.suggestions || null });

// The grades of all students as CSV, for a spreadsheet. (This is not the format of Canvas'
// gradebook import: the grades are entered in Canvas by hand.)
export function grades_csv(rubric, students) {
  const items = rubric_items(rubric);
  const header = ['student', 'canvas_id', 'late', 'status', 'grade', ...items.map((item) => item.id), 'comment'];
  const rows = students.map((st) => {
    const g = compute_grade(rubric, st.scores, st.grade_override);
    return [st.name, st.canvas_id || '', st.late ? 'yes' : '', st.status, g.grade == null ? '' : format_number(g.grade),
      ...items.map((item) => {
        const sc = st.scores[item.id];
        if (!sc || !sc.value) return '';
        return item.required ? sc.value : sc.value === 'yes' ? format_number(item_points(item, sc)) : '0';
      }), st.comment || ''];
  });
  const cell = (x) => (/[",\n\r;]/.test(String(x)) ? '"' + String(x).replace(/"/g, '""') + '"' : String(x));
  return [header, ...rows].map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n';
}

export { GAME_FIELDS };
