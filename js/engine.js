// The game engine: how the programs of a game are run, and how their answer
// sets are passed on from one program to the next.
// (The Internals tab of the page describes this in words.)
//
// This module does not use the DOM: all calls to clingo go through a solver
// (see solver.js), so that the tests can run games in Node.
import {
  preprocess_program, filter_answer_set, answer_set_to_facts, answer_set_to_fact_lines,
} from './asp.js';
import { relax_constraints } from './analysis.js';

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

// A game with all fields present (missing ones become empty programs).
export function normalize_game(game) {
  const out = {};
  for (const field of GAME_FIELDS) out[field] = (game && game[field]) || '';
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
    // What the player gets to see (passed on to the player's program)
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
    return { player_moves: '', memory_updates: '', problem: problem('Player program', result, solver) };
  }
  return {
    player_moves: answer_set_to_facts(filter_answer_set(result.atoms, ['do'])),
    memory_updates: answer_set_to_facts(filter_answer_set(result.atoms, ['remember', 'forget'])),
    problem: null,
  };
}

// Update the player's memory. Returns { player_memory, problem }.
export async function update_player_memory(solver, player_memory, memory_updates) {
  if (!memory_updates) return { player_memory, problem: null };
  let result = await solve(solver, [
    engine('new_memory(X) :- memory(X), not forget(X).\nnew_memory(X) :- remember(X).'),
    part('player_memory', player_memory),
    part('memory_updates', memory_updates),
  ]);
  if (result.status !== 'ok') return { player_memory, problem: problem('Memory update', result, solver) };
  const intermediate = answer_set_to_facts(filter_answer_set(result.atoms, ['new_memory']));
  result = await solve(solver, [engine('memory(X) :- new_memory(X).'), engine(intermediate)]);
  if (result.status !== 'ok') return { player_memory, problem: problem('Memory update', result, solver) };
  return { player_memory: answer_set_to_facts(filter_answer_set(result.atoms, ['memory'])), problem: null };
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
    nature_problem = problem('Nature program', result, solver);
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

  // Generate the next state based on 'nexts'
  // (the time always advances, even if there are no 'nexts')
  result = await solve(solver, [
    engine('at_time(T+1,R,C,O) :- next(R,C,O), current_time(T).\nstate_time(T+1) :- current_time(T).'),
    part('game_state', game_state),
    part('nexts', nexts || ''),
  ]);
  let next_state = '';
  let next_atoms = '';
  if (result.status === 'ok') {
    next_state = answer_set_to_facts(filter_answer_set(result.atoms, ['at_time', 'state_time']));
    // The 'nexts' themselves (for the game output)
    next_atoms = answer_set_to_facts(filter_answer_set(result.atoms, ['next']));
  }
  return { next_state, nexts: next_atoms, wipe_memory, problem: nature_problem };
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
  constructor(solver, game, { rng = Math.random, max_time = 500, verbose = true } = {}) {
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
    const condition = await analyze_state(s, g, this.game_state);
    if (condition.problem) {
      problems.push(condition.problem);
      if (is_fatal(condition.problem)) return this.stop(report, condition.problem, problems);
    }
    report += problem_line('Winning conditions', condition.problem, 'game continues');
    if (condition.verdict === 'win' || condition.verdict === 'lose') {
      this.verdict = condition.verdict;
      return {
        report, verdict: this.verdict, problems,
        message: condition.verdict.toUpperCase() + '! (' + condition.atoms.join(', ') + ')\n',
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
    const move = await generate_player_move(s, g, this.player_input, this.player_memory, this.rng);
    if (move.problem) {
      problems.push(move.problem);
      if (is_fatal(move.problem)) return this.stop(report, move.problem, problems);
    }
    report_line('Player moves', move.player_moves);
    report_line('Memory updates', move.memory_updates);
    report += problem_line('Player program', move.problem, 'no moves, memory unchanged');

    // Update the player's memory
    const memory = await update_player_memory(s, this.player_memory, move.memory_updates);
    if (memory.problem) {
      problems.push(memory.problem);
      if (is_fatal(memory.problem)) return this.stop(report, memory.problem, problems);
    }
    this.player_memory = memory.player_memory;
    report += problem_line('Memory update', memory.problem, 'memory unchanged');

    // Generate the next state
    const nature = await generate_next_state(s, g, this.game_state, move.player_moves, this.rng);
    if (nature.problem) {
      problems.push(nature.problem);
      if (is_fatal(nature.problem)) return this.stop(report, nature.problem, problems);
    }
    this.game_state = nature.next_state;
    report_line('Next state (from nature)', nature.nexts);
    report += problem_line('Nature program', nature.problem, 'state unchanged');

    // Wipe the player's memory if nature says so
    if (nature.wipe_memory) {
      this.player_memory = '';
      report += '- Player memory wiped by nature\n';
    }

    // Generate the player's input for the next step
    await this.observe(problems);
    if (is_fatal(this.visibility_problem)) return this.stop(report, this.visibility_problem, problems);

    return { report, verdict: null, message: '', problems };
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
