// The game engine: how the programs of a game are run, and how their answer
// sets are passed on from one program to the next.
// (The Internals tab of the page describes this in words.)
// The game state only holds the latest time slice, unless a program uses the
// history (needs_history). test_strategy plays many levels from fixed seeds,
// so that every level can be played again exactly (replay_rng).
//
// This module does not use the DOM: all calls to clingo go through a solver
// (see solver.js), so that the tests can run games in Node.
import {
  preprocess_program, filter_answer_set, answer_set_to_facts, answer_set_to_fact_lines,
  facts_to_answer_set, split_atom, seeded_rng,
} from './asp.js';
import { relax_constraints, analyze_program } from './analysis.js';

// The programs that make up a game (the keys of a game object / game file).
export const GAME_FIELDS = [
  'aux_program', 'level_gen_program', 'visibility_program', 'player_move_program',
  'nature_program', 'goal_program', 'level_state', 'level_settings',
];

// Names for the parts of a program that errors can be in.
export const SOURCE_NAMES = {
  aux_program: 'Auxiliary program',
  level_gen_program: 'Level generation program',
  visibility_program: 'Visibility program',
  player_move_program: 'Player strategy',
  nature_program: "Nature's moves",
  goal_program: 'Winning conditions',
  level_state: 'Level state',
  level_settings: 'Level settings',
  engine: 'rules added by the engine',
  game_state: 'game state (generated)',
  player_input: 'player input (generated)',
  player_memory: 'player memory (generated)',
  player_moves: 'player moves (generated)',
  memory_updates: 'memory updates (generated)',
  nexts: 'next state (generated)',
};

// A game with all fields present (missing ones become empty programs, and so
// do fields that are not text: a game file can hold anything).
export function normalize_game(game) {
  const out = {};
  for (const field of GAME_FIELDS) out[field] = game && typeof game[field] === 'string' ? game[field] : '';
  return out;
}

// Rules that give the current time and the current state of the game
// (as atoms over 'at') from the game state.
const CURRENT_STATE_RULES =
  'current_time(T) :- T = #max { S : state_time(S) }.\n' +
  'at(R,C,O) :- at_time(T,R,C,O), current_time(T).';

// Parts of a program, for solver.solve().
const part = (source, text) => ({ source, text });
const engine = (text) => part('engine', text);

const VIOLATED = 'logic_game_violated';

// Solve, and when there is no answer set, try to explain why: find the
// integrity constraints (':- ...') in the programs of the game that are
// violated. To do so, the constraints are rewritten so that they derive
// an atom instead of failing, and clingo looks for an answer set that
// violates as few constraints as possible.
// An explained 'unsat' result gets violated: [{ source, line, col, text }].
async function solve(solver, parts) {
  const result = await solver.solve(parts);
  if (result.status !== 'unsat') return result;
  const table = [];
  const relaxed = parts.map((p, k) => {
    if (!GAME_FIELDS.includes(p.source)) return p;
    const r = relax_constraints(p.text, (i) => `${VIOLATED}(${k},${i})`);
    r.constraints.forEach((c, i) => table.push({ k, i, source: p.source, ...c }));
    return { ...p, text: r.text };
  });
  if (table.length === 0) return result;
  relaxed.push(engine(`#minimize { 1,K,I : ${VIOLATED}(K,I) }.`));
  const diagnosis = await solver.solve(relaxed, { optimize: true });
  if (diagnosis.status !== 'ok') return result;
  const violated = table.filter(({ k, i }) => diagnosis.atoms.includes(`${VIOLATED}(${k},${i})`))
    .map(({ source, line, col, text }) => ({ source, line, col, text }));
  return violated.length ? { ...result, violated } : result;
}

// ---- Describing problems ---------------------------------------------------

function describe_location(e) {
  if (!e.source) return null;
  const name = SOURCE_NAMES[e.source] || e.source;
  return e.line != null ? `${name}, line ${e.line}, column ${e.col}` : name;
}

// A short description of why a call to the solver gave no answer set.
export function describe_failure(result, solver) {
  switch (result.status) {
    case 'unsat':
      if (!result.violated) return 'no answer set';
      return 'no answer set, because ' + (result.violated.length > 1 ? 'these constraints are' : 'this constraint is') + ' violated:\n' +
        result.violated.map((v) => `    ${SOURCE_NAMES[v.source]}, line ${v.line}: ${v.text}`).join('\n');
    case 'timeout': return `clingo took longer than ${Math.round(solver.timeout_ms / 1000)} seconds and was stopped`;
    case 'aborted': return 'stopped';
    case 'error': return 'error:\n' + result.errors.map((e) => {
      const where = describe_location(e);
      return '    ' + (where ? where + ': ' : '') + e.message.replace(/\n/g, '\n      ');
    }).join('\n');
    default: return String(result.status);
  }
}

// A problem: { program, result, text } (program: which program fell back).
function problem(program, result, solver) {
  if (result.status === 'ok') return null;
  return { program, result, text: describe_failure(result, solver) };
}

// Whether a problem means that the engine cannot go on (clingo hung or was stopped).
export function is_fatal(p) {
  return !!p && (p.result.status === 'timeout' || p.result.status === 'aborted');
}

// Line for the game output reporting that a program fell back
// (no answer set or an error), or '' if there was no problem.
export function problem_line(program_name, p, consequence) {
  if (!p) return '';
  return '- ' + program_name + ': ' + p.text + '\n  (' + consequence + ')\n';
}

// ---- The programs ------------------------------------------------------------

// Generate a level: returns { level_state, level_settings, problem }.
export async function generate_level(solver, game, rng = Math.random) {
  const result = await solve(solver, [
    part('level_gen_program', preprocess_program(game.level_gen_program, rng)),
    part('aux_program', game.aux_program),
  ]);
  if (result.status !== 'ok') {
    return { level_state: '', level_settings: '', problem: problem('Level generation', result, solver) };
  }
  return {
    level_state: answer_set_to_fact_lines(filter_answer_set(result.atoms, ['at', 'debug'])),
    level_settings: answer_set_to_fact_lines(filter_answer_set(result.atoms, ['setting', 'decorate'])),
    problem: null,
  };
}

// Generate the initial game state from the level state.
export async function generate_initial_game_state(solver, game) {
  const result = await solve(solver, [
    engine('at_time(0,R,C,O) :- at(R,C,O).\nstate_time(0).'),
    part('level_state', game.level_state),
  ]);
  if (result.status !== 'ok') {
    return { game_state: '', problem: problem('Level state', result, solver) };
  }
  return {
    game_state: answer_set_to_facts(filter_answer_set(result.atoms, ['at_time', 'state_time'])),
    problem: null,
  };
}

// Generate the player's input (and the decorations for the visualization)
// from the game state.
export async function generate_player_input(solver, game, game_state) {
  const result = await solve(solver, [
    engine(CURRENT_STATE_RULES),
    part('game_state', game_state),
    part('visibility_program', game.visibility_program),
    part('level_settings', game.level_settings),
    part('aux_program', game.aux_program),
  ]);
  if (result.status !== 'ok') {
    return { player_input: '', decorations: '', problem: problem('Visibility program', result, solver) };
  }
  return {
    // What the player gets to see (passed on to the player strategy)
    player_input: answer_set_to_facts(filter_answer_set(result.atoms, ['observe', 'setting', 'current_time'])),
    // What is only used for visualization (never passed on to the player)
    decorations: answer_set_to_facts(filter_answer_set(result.atoms, ['decorate'])),
    problem: null,
  };
}

// Generate the player's moves and memory updates.
export async function generate_player_move(solver, game, player_input, player_memory, rng = Math.random) {
  const result = await solve(solver, [
    part('player_input', player_input),
    part('player_memory', player_memory),
    part('aux_program', game.aux_program),
    part('player_move_program', preprocess_program(game.player_move_program, rng)),
  ]);
  if (result.status !== 'ok') {
    return { player_moves: '', memory_updates: '', problem: problem('Player strategy', result, solver) };
  }
  return {
    player_moves: answer_set_to_facts(filter_answer_set(result.atoms, ['do'])),
    memory_updates: answer_set_to_facts(filter_answer_set(result.atoms, ['remember', 'forget'])),
    problem: null,
  };
}

// Update the player's memory: forget what is forgotten, then add what is
// remembered (memory(X) holds afterwards if remember(X), or if memory(X) held
// and not forget(X)). Returns { player_memory, problem }.
// (This needs no clingo: clingo prints every value in one way, so values can
// be compared as text.)
export function update_player_memory(player_memory, memory_updates) {
  if (!memory_updates) return { player_memory, problem: null };
  const updates = facts_to_answer_set(memory_updates).map(split_atom).filter((a) => a.args.length === 1);
  const forget = new Set(updates.filter((a) => a.name === 'forget').map((a) => a.args[0]));
  const memory = new Set();
  for (const atom of facts_to_answer_set(player_memory)) {
    const { name, args } = split_atom(atom);
    if (name === 'memory' && args.length === 1 && !forget.has(args[0])) memory.add(args[0]);
  }
  for (const a of updates) if (a.name === 'remember') memory.add(a.args[0]);
  return { player_memory: answer_set_to_facts([...memory].map((x) => `memory(${x})`)), problem: null };
}

// Generate the next state of the game.
export async function generate_next_state(solver, game, game_state, player_moves, rng = Math.random) {
  // Generate 'nexts'
  let result = await solve(solver, [
    engine(CURRENT_STATE_RULES),
    part('game_state', game_state),
    part('player_moves', player_moves),
    part('nature_program', preprocess_program(game.nature_program, rng)),
    part('level_settings', game.level_settings),
    part('aux_program', game.aux_program),
  ]);
  let nexts = null;
  let wipe_memory = false;
  let nature_problem = null;
  if (result.status === 'ok') {
    nexts = answer_set_to_facts(filter_answer_set(result.atoms, ['next', 'current_time']));
    // Check whether nature wipes the player's memory
    wipe_memory = filter_answer_set(result.atoms, ['wipe_player_memory']).length > 0;
  } else {
    nature_problem = problem("Nature's moves", result, solver);
    const moves = player_moves.split(' ').filter(Boolean);
    if (result.status === 'unsat' && moves.length > 1) {
      nature_problem.text += `\n    The player made ${moves.length} moves in this step (${moves.join(' ')});` +
        '\n    maybe nature allows only one move per step.';
    }
    if (is_fatal(nature_problem)) {
      return { next_state: game_state, nexts: '', wipe_memory: false, problem: nature_problem };
    }
  }

  // Generate trivial 'nexts' if needed (nothing changes)
  if (!nexts) {
    result = await solve(solver, [
      engine(CURRENT_STATE_RULES + '\nnext(R,C,O) :- at(R,C,O).'),
      part('game_state', game_state),
    ]);
    if (result.status === 'ok') {
      nexts = answer_set_to_facts(filter_answer_set(result.atoms, ['next', 'current_time']));
    }
  }

  // The next time slice of the game state, from the 'nexts'
  // (the time always advances, even if there are no 'nexts'):
  //   at_time(T+1,R,C,O) :- next(R,C,O), current_time(T).
  //   state_time(T+1) :- current_time(T).
  const atoms = facts_to_answer_set(nexts || '');
  const now = atoms.map(split_atom).find((a) => a.name === 'current_time' && a.args.length === 1);
  const next_atoms = atoms.filter((a) => a.startsWith('next(') && split_atom(a).args.length === 3);
  let slice = [];
  if (now && /^-?\d+$/.test(now.args[0])) {
    const t = Number(now.args[0]) + 1;
    slice = [`state_time(${t})`, ...next_atoms.map((a) => `at_time(${t},${split_atom(a).args.join(',')})`)];
  }
  return {
    next_state: [game_state, answer_set_to_facts(slice)].filter(Boolean).join(' '),
    next_slice: answer_set_to_facts(slice),
    nexts: answer_set_to_facts(next_atoms),
    wipe_memory,
    problem: nature_problem,
  };
}

// Analyze the state for win/lose conditions.
// Returns { verdict: 'win' | 'lose' | '', atoms, problem }.
export async function analyze_state(solver, game, game_state) {
  const result = await solve(solver, [
    engine(CURRENT_STATE_RULES),
    part('game_state', game_state),
    part('level_settings', game.level_settings),
    part('aux_program', game.aux_program),
    part('goal_program', game.goal_program),
  ]);
  if (result.status !== 'ok') {
    return { verdict: '', atoms: [], problem: problem('Winning conditions', result, solver) };
  }
  const loses = filter_answer_set(result.atoms, ['lose']);
  if (loses.length > 0) return { verdict: 'lose', atoms: loses, problem: null };
  const wins = filter_answer_set(result.atoms, ['win']);
  if (wins.length > 0) return { verdict: 'win', atoms: wins, problem: null };
  return { verdict: '', atoms: [], problem: null };
}

// Whether any program that gets the game state uses its history (at_time/4
// or state_time/1, rather than at/3 and current_time/1). If not, the engine
// only keeps the latest time slice of the game state, which gives the same
// results but keeps the programs small: otherwise every program grounds the
// whole history again in every step.
export function needs_history(game) {
  for (const field of ['visibility_program', 'nature_program', 'goal_program', 'aux_program', 'level_settings']) {
    const a = analyze_program(preprocess_program(game[field] || '', () => 0));
    if (!a.complete) return true;
    if (a.atoms.some((x) => x.name === 'at_time' || x.name === 'state_time')) return true;
  }
  return false;
}

// Programs that take longer than this (in a step) are mentioned in the game output.
export const SLOW_MS = 2000;

const TIMED_PROGRAMS = [
  ['goal', 'winning conditions'], ['player', 'player strategy'], ['nature', "nature's moves"], ['visibility', 'visibility program'],
];

// ---- Playing a game ----------------------------------------------------------

// One game being played, one step at a time:
//
//   const session = new GameSession(solver, game);
//   await session.start();
//   while (!session.verdict) {
//     show(session.view());        // what the player sees (for the visualization)
//     const step = await session.step();
//     print(step.report);
//   }
//
// Every step reports the problems it ran into (step.problems), so that the
// page can mark the errors in the editors.
export class GameSession {
  // Options: rng (random numbers for RANDINT), max_time (steps), verbose (report everything),
  // keep_history (true: always keep the whole history; by default only when needed),
  // slow_ms (programs that take longer in a step get a note in the report).
  constructor(solver, game, { rng = Math.random, max_time = 500, verbose = true, keep_history = null, slow_ms = SLOW_MS } = {}) {
    this.solver = solver;
    this.game = normalize_game(game);
    this.rng = rng;
    this.max_time = max_time;
    this.verbose = verbose;
    this.time_step = 0;
    this.verdict = null;          // 'win', 'lose', 'timeout' or 'stopped' when the game is over
    this.game_state = '';
    this.player_input = '';
    this.player_decorations = '';
    this.player_memory = '';
    this.pending_report = '';     // problems found before the first step, reported with it
    this.visibility_problem = null;
    this.keep_history = keep_history ?? needs_history(this.game);
    this.slow_ms = slow_ms;
    // Time spent in clingo per program in the current step (in ms)
    this.times = {};
    this.timing = null;
    const timed = Object.create(solver);
    timed.solve = async (parts, opts) => {
      const t0 = performance.now();
      try {
        return await solver.solve(parts, opts);
      } finally {
        if (this.timing) this.times[this.timing] = (this.times[this.timing] || 0) + performance.now() - t0;
      }
    };
    this.solver = timed;
  }

  // Compute the initial state and what the player sees of it.
  // Returns { report, problems }.
  async start() {
    const problems = [];
    const initial = await generate_initial_game_state(this.solver, this.game);
    this.game_state = initial.game_state;
    let report = '';
    if (initial.problem) {
      problems.push(initial.problem);
      report += '- Level state: ' + initial.problem.text + '\n';
      if (is_fatal(initial.problem)) return this.stop(report, initial.problem, problems);
    }
    await this.observe(problems);
    if (is_fatal(this.visibility_problem)) return this.stop(report, this.visibility_problem, problems);
    this.pending_report = report;
    return { report, problems };
  }

  // The facts for the visualization: what the player sees, and the decorations.
  view() {
    return this.player_input + this.player_decorations + this.game.level_settings;
  }

  // Run the visibility program on the current state.
  async observe(problems) {
    this.timing = 'visibility';
    const out = await generate_player_input(this.solver, this.game, this.game_state);
    this.player_input = out.player_input;
    this.player_decorations = out.decorations;
    this.visibility_problem = out.problem;
    if (out.problem) problems.push(out.problem);
  }

  stop(report, p, problems) {
    this.verdict = 'stopped';
    const why = p.result.status === 'timeout' ? p.program + ': ' + p.text : 'the game was stopped';
    return { report, verdict: 'stopped', message: 'STOPPED! (' + why + ')\n', problems };
  }

  // Play one time step. Returns { report, verdict, message, problems }:
  // the report of the step, and (when the game is over) the verdict and a message.
  async step() {
    const s = this.solver;
    const g = this.game;
    const problems = [];
    this.time_step += 1;
    this.times = {};

    // The report for this step: the regular lines are only shown when
    // verbose, problems (fallbacks and errors) are always shown
    let report = this.pending_report;
    this.pending_report = '';
    const report_line = (label, facts) => {
      if (this.verbose) report += '- ' + label + ':\n' + facts + '\n';
    };
    if (this.verbose) report += '## STEP ' + this.time_step + ' ##\n';
    report_line('Player input', this.player_input);
    report_line('Player memory', this.player_memory);
    report += problem_line('Visibility program', this.visibility_problem, 'player observes nothing');

    // Check if the game is won/lost already
    this.timing = 'goal';
    const condition = await analyze_state(s, g, this.game_state);
    if (condition.problem) {
      problems.push(condition.problem);
      if (is_fatal(condition.problem)) return this.stop(report, condition.problem, problems);
    }
    report += problem_line('Winning conditions', condition.problem, 'game continues');
    if (condition.verdict === 'win' || condition.verdict === 'lose') {
      this.verdict = condition.verdict;
      // (with the reason, unless it says no more than the verdict: "WIN!", not "WIN! (win)")
      const reason = condition.atoms.filter((atom) => atom !== condition.verdict);
      return {
        report, verdict: this.verdict, problems,
        message: condition.verdict.toUpperCase() + '!' + (reason.length ? ' (' + condition.atoms.join(', ') + ')' : '') + '\n',
      };
    }

    // Stop after a fixed number of steps, to avoid (accidental) infinite loops
    if (this.time_step > this.max_time) {
      this.verdict = 'timeout';
      return {
        report, verdict: 'timeout', problems,
        message: 'TIMEOUT! (the engine stops games after ' + this.max_time + ' steps)\n',
      };
    }

    // Generate the player's moves and memory updates
    this.timing = 'player';
    const move = await generate_player_move(s, g, this.player_input, this.player_memory, this.rng);
    if (move.problem) {
      problems.push(move.problem);
      if (is_fatal(move.problem)) return this.stop(report, move.problem, problems);
    }
    report_line('Player moves', move.player_moves);
    report_line('Memory updates', move.memory_updates);
    report += problem_line('Player strategy', move.problem, 'no moves, memory unchanged');

    // Update the player's memory
    this.player_memory = update_player_memory(this.player_memory, move.memory_updates).player_memory;

    // Generate the next state
    this.timing = 'nature';
    const nature = await generate_next_state(s, g, this.game_state, move.player_moves, this.rng);
    if (nature.problem) {
      problems.push(nature.problem);
      if (is_fatal(nature.problem)) return this.stop(report, nature.problem, problems);
    }
    this.game_state = this.keep_history ? nature.next_state : nature.next_slice;
    report_line('Next state (from nature)', nature.nexts);
    report += problem_line("Nature's moves", nature.problem, 'state unchanged');

    // Wipe the player's memory if nature says so
    if (nature.wipe_memory) {
      this.player_memory = '';
      report += '- Player memory wiped by nature\n';
    }

    // Generate the player's input for the next step
    await this.observe(problems);
    if (is_fatal(this.visibility_problem)) return this.stop(report, this.visibility_problem, problems);

    report += this.time_report();
    return { report, verdict: null, message: '', problems, times: this.times, moves: move.player_moves };
  }

  // Lines for the game output about the time spent in clingo in this step:
  // always for programs that were slow, otherwise only when verbose.
  time_report() {
    const parts = TIMED_PROGRAMS.filter(([key]) => this.times[key] != null)
      .map(([key, name]) => `${name} ${Math.round(this.times[key])} ms`);
    let out = this.verbose && parts.length ? '- Time in clingo: ' + parts.join(', ') + '\n' : '';
    for (const [key, name] of TIMED_PROGRAMS) {
      if (this.times[key] > this.slow_ms) {
        out += `- Note: ${name} took ${(this.times[key] / 1000).toFixed(1)} seconds in this step` +
          ' (large groundings make programs slow; the engine stops a program after ' +
          `${Math.round(this.solver.timeout_ms / 1000)} seconds)\n`;
      }
    }
    return out;
  }
}

// Play a whole game without a user interface (used by the tests).
// Returns { verdict, steps, log }, where log is the game output (oldest first).
export async function play_headless(solver, game, options = {}) {
  const session = new GameSession(solver, game, options);
  const log = [];
  const start = await session.start();
  if (session.verdict) return { verdict: session.verdict, steps: 0, log: [start.report, start.message] };
  while (!session.verdict) {
    const step = await session.step();
    log.push(step.report);
    if (step.message) log.push(step.message);
  }
  return { verdict: session.verdict, steps: session.time_step, log };
}

// Test a game (typically: a player's strategy) on many random levels.
// Level n is generated and played with seeded_rng(n), so that it can be
// played again exactly (see replay_rng). Calls on_level(result) after each
// level, and stops early when cancelled() returns true.
// Returns [{ seed, verdict, steps, message }] (verdict 'no level' if no
// level could be generated).
export async function test_strategy(solver, game, {
  levels = 20, first_seed = 1, max_time = 500, on_level = () => {}, cancelled = () => false,
} = {}) {
  const results = [];
  for (let seed = first_seed; seed < first_seed + levels && !cancelled(); seed++) {
    const rng = seeded_rng(seed);
    const level = await generate_level(solver, normalize_game(game), rng);
    let result;
    if (level.problem) {
      result = { seed, verdict: is_fatal(level.problem) ? 'stopped' : 'no level', steps: 0, message: 'Level generation: ' + level.problem.text };
    } else {
      const played = await play_headless(solver, { ...game, ...level }, { rng, max_time, verbose: false });
      result = { seed, verdict: played.verdict, steps: played.steps, message: (played.log.at(-1) || '').trim() };
    }
    if (cancelled()) break;
    results.push(result);
    on_level(result);
  }
  return results;
}

// The random numbers for playing level `seed` (as in test_strategy): the
// level is generated again, to bring the random numbers to the same point.
// Returns { rng, level } (level: as generate_level returns it).
export async function replay_rng(solver, game, seed) {
  const rng = seeded_rng(seed);
  const level = await generate_level(solver, normalize_game(game), rng);
  return { rng, level };
}
