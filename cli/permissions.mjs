// Running the command-line version under Node's permission model (Node only).
//
// The programs of a game run in clingo, and the games that are graded come
// from students. Programs with scripts are refused (see js/solver.js); as a
// second layer, the command runs under Node's permission model: it can read
// files and start worker threads (clingo runs in one), but it can only write
// what the command writes (e.g. the folder of new, the grading file of grade),
// and it cannot start other programs.
//
// Node only takes these as options of node itself, and the first line of
// bin/logic-game.mjs (#!) cannot pass several options on every system, so the
// command starts itself again with them, in the same terminal and with the
// same arguments (see run_with_permissions).
import { spawn } from 'node:child_process';
import path from 'node:path';

// The options of node for the permission model, for a command that writes
// the files and folders in `written` (a folder: also all in it). Returns null
// when this version of Node does not have the permission model (before 20).
export function permission_flags(written) {
  const known = process.allowedNodeEnvironmentFlags;
  const flag = ['--permission', '--experimental-permission'].find((f) => known.has(f));
  if (!flag) return null;
  const flags = [flag, '--allow-fs-read=*', '--allow-worker'];
  for (const p of written) flags.push(`--allow-fs-write=${path.resolve(p)}`, `--allow-fs-write=${path.join(path.resolve(p), '*')}`);
  // (Node warns that worker threads could get around the permission model:
  // they get the same permissions, so they cannot; and in some versions, that
  // the model is experimental)
  if (known.has('--disable-warning')) flags.push('--disable-warning=SecurityWarning', '--disable-warning=ExperimentalWarning');
  return flags;
}

// Run a script again under the permission model (in the same terminal: same
// input and output); returns its exit code, or null when this version of Node
// does not have the permission model. A signal to this process (e.g. Ctrl+C)
// is passed on, and when the script is stopped by one, so is this process.
export async function run_with_permissions(script, args, written) {
  const flags = permission_flags(written);
  if (!flags) return null;
  const child = spawn(process.execPath, [...process.execArgv, ...flags, script, ...args], { stdio: 'inherit' });
  const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'];
  const pass_on = (signal) => child.kill(signal);
  for (const signal of signals) process.on(signal, pass_on);
  const { code, signal, error } = await new Promise((resolve) => {
    child.on('error', (e) => resolve({ error: e }));
    child.on('exit', (code, signal) => resolve({ code, signal }));
  });
  for (const signal of signals) process.off(signal, pass_on);
  if (error) throw new Error(`the command could not be started under Node's permission model (${error.message})`);
  if (signal) process.kill(process.pid, signal);
  return code ?? 1;
}
