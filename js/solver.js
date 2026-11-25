// A thin layer around the clingo-wasm package (https://github.com/domoritz/clingo-wasm).
//
// clingo-wasm runs clingo in a web worker (in Node: a worker thread), so the
// page stays responsive while clingo works. When a call takes too long, or the
// user stops the game, the worker is terminated with clingo.restart(); the next
// call starts a fresh worker.
//
// This module does not import clingo-wasm itself: the caller passes it in
// (the page imports vendor/clingo-wasm/, the tests import the npm package).
// It does not use the DOM.
import { compose, parse_clingo_errors, locate_errors } from './asp.js';

export const DEFAULT_OPTIONS = ['-Wnone', '--heuristic=Domain'];
export const DEFAULT_TIMEOUT_MS = 10000;

// The program part that a syntax check puts in front of a program: the rules
// after it belong to a program part that clingo parses (and checks for
// unsafe variables) but does not ground or solve.
const CHECK_HEADER = '#program syntax_check.';

export function create_solver(clingo, { timeout_ms = DEFAULT_TIMEOUT_MS, options = DEFAULT_OPTIONS } = {}) {
  let generation = 0;     // increased by abort(), to recognize calls that were aborted
  let queue = Promise.resolve();

  // Run clingo on a program, with a time limit.
  // Returns { status, result }, where status is 'done', 'timeout' or 'aborted'.
  // Calls run one at a time, and the time limit of a call starts when the call
  // starts (not while it waits for an earlier call).
  function run_with_limit(text, models, opts) {
    const my_generation = generation;
    const result = queue.then(() => run_now(text, models, opts, my_generation));
    queue = result.catch(() => {});
    return result;
  }

  async function run_now(text, models, opts, my_generation) {
    if (generation !== my_generation) return { status: 'aborted' };
    let timer = null;
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => resolve({ status: 'timeout' }), solver.timeout_ms);
    });
    const run = clingo.run(text, models, opts).then((result) => ({ status: 'done', result }));
    const outcome = await Promise.race([run, timeout]);
    clearTimeout(timer);
    if (generation !== my_generation) return { status: 'aborted' };
    if (outcome.status === 'timeout') {
      await clingo.restart(wasm_url);
    }
    return outcome;
  }

  let wasm_url;      // (see init)
  const solver = {
    timeout_ms,
    options,

    // Find one answer set of a program glued together from parts
    // (strings or { text, source }, see compose() in asp.js).
    // Returns one of
    //   { status: 'ok', atoms: [...] }
    //   { status: 'unsat' }
    //   { status: 'error', errors: [{ source, line, col, severity, message }] }
    //   { status: 'timeout' }   (clingo took longer than timeout_ms and was stopped)
    //   { status: 'aborted' }   (abort() was called while clingo was running)
    //
    // With { optimize: true }, clingo looks for an optimal answer set
    // (for programs with #minimize or #maximize).
    async solve(parts, { optimize = false } = {}) {
      const { text, segments } = compose(parts);
      const outcome = await run_with_limit(text, optimize ? 0 : 1, solver.options);
      if (outcome.status !== 'done') return { status: outcome.status };
      const result = outcome.result;
      if (result.Result === 'ERROR') {
        let errors = parse_clingo_errors(result.Error);
        if (errors.length === 0) errors = [{ line: null, col: null, end_line: null, end_col: null, severity: 'error', message: String(result.Error) }];
        return { status: 'error', errors: locate_errors(errors, segments) };
      }
      if (result.Result === 'UNSATISFIABLE') return { status: 'unsat' };
      const witnesses = (result.Call || []).flatMap((call) => call.Witnesses || []);
      if (witnesses.length === 0) return { status: 'unsat' };
      return { status: 'ok', atoms: witnesses.at(-1).Value };
    },

    // Check a single program for syntax errors and unsafe variables, without
    // grounding it. Returns a list of errors [{ line, col, severity, message }]
    // (empty if the program is fine), or null if the check was aborted or
    // timed out.
    async check(text) {
      const outcome = await run_with_limit(CHECK_HEADER + '\n' + (text || ''), 1, ['-Wnone']);
      if (outcome.status !== 'done') return null;
      const result = outcome.result;
      if (result.Result !== 'ERROR') return [];
      return parse_clingo_errors(result.Error).map((e) =>
        (e.line == null ? e : { ...e, line: Math.max(1, e.line - 1), end_line: Math.max(1, e.end_line - 1) }));
    },

    // Stop whatever clingo is doing (the pending call returns 'aborted').
    async abort() {
      generation += 1;
      await clingo.restart(wasm_url);
    },

    // Load clingo (the worker and the WebAssembly module) ahead of the first call;
    // optionally from a URL of the .wasm file, or a promise of one (e.g. a file
    // the page downloads itself, to show the progress), which is also used
    // after an abort. Calls made in the meantime wait (without their time
    // limit running), so that clingo is not loaded twice.
    init(url = undefined) {
      const loading = (async () => {
        const resolved = await url;
        await clingo.init(resolved);
        wasm_url = resolved;
      })();
      queue = queue.then(() => loading).catch(() => {});
      return loading;
    },
  };
  return solver;
}
