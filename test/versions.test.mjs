// Tests of snapshots, differences and project files (no clingo or browser needed).
import test from 'node:test';
import assert from 'node:assert/strict';
import { diff_lines, diff_hunks, diff_games, VersionStore, MAX_AUTO, best_test, project_file, backup_file, read_file, file_stem, storage_used } from '../js/versions.js';
import { WorkStore } from '../js/storage.js';
import { load_examples } from './helpers.mjs';

// A stand-in for window.localStorage (with a limit, to test a full storage).
class MemoryStorage {
  constructor(limit = Infinity) { this.data = new Map(); this.limit = limit; }
  get length() { return this.data.size; }
  key(i) { return [...this.data.keys()][i] ?? null; }
  getItem(k) { return this.data.has(k) ? this.data.get(k) : null; }
  setItem(k, v) {
    const size = [...this.data].reduce((n, [key, val]) => n + (key === k ? 0 : key.length + val.length), 0);
    if (size + k.length + String(v).length > this.limit) {
      const e = new Error('The quota has been exceeded.');
      e.name = 'QuotaExceededError';
      throw e;
    }
    this.data.set(k, String(v));
  }
  removeItem(k) { this.data.delete(k); }
}

// A clock that moves on a minute at every call.
function clock() {
  let t = Date.UTC(2026, 0, 1);
  return () => new Date(t += 60000);
}

// The length of a longest common subsequence (to check that diffs are as short as can be).
function lcs(a, b) {
  const row = new Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    let prev = 0;
    for (let j = 1; j <= b.length; j++) {
      const tmp = row[j];
      row[j] = a[i - 1] === b[j - 1] ? prev + 1 : Math.max(row[j], row[j - 1]);
      prev = tmp;
    }
  }
  return row[b.length];
}

test('diffs: both texts can be read back, and the diff is as short as can be', () => {
  let seed = 7;
  const random = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const words = ['a.', 'b.', 'c.', 'do(wait).', '', '% x'];
  const text = () => Array.from({ length: Math.floor(random() * 12) }, () => words[Math.floor(random() * words.length)]).join('\n');
  for (let i = 0; i < 500; i++) {
    const a = text();
    const b = text();
    const lines = diff_lines(a, b);
    const a_lines = lines.filter((l) => l.op !== 'add');
    const b_lines = lines.filter((l) => l.op !== 'del');
    assert.equal(a_lines.map((l) => l.text).join('\n'), a, JSON.stringify([a, b]));
    assert.equal(b_lines.map((l) => l.text).join('\n'), b, JSON.stringify([a, b]));
    assert.deepEqual(a_lines.map((l) => l.a), a_lines.map((_, k) => k + 1));
    assert.deepEqual(b_lines.map((l) => l.b), b_lines.map((_, k) => k + 1));
    const same = lines.filter((l) => l.op === 'same').length;
    assert.equal(same, lcs(a ? a.split('\n') : [], b ? b.split('\n') : []), JSON.stringify([a, b]));
  }
});

test('diffs: a changed line, and the parts around changes', () => {
  const a = Array.from({ length: 20 }, (_, i) => `line(${i + 1}).`).join('\n');
  const b = a.replace('line(10).', 'line(ten).').replace('line(20).', 'line(20).\nnew.');
  const lines = diff_lines(a, b);
  assert.deepEqual(lines.filter((l) => l.op !== 'same').map((l) => [l.op, l.text, l.a, l.b]),
    [['del', 'line(10).', 10, null], ['add', 'line(ten).', null, 10], ['add', 'new.', null, 21]]);
  const { hunks, skipped_after } = diff_hunks(lines, 2);
  assert.equal(hunks.length, 2);
  assert.equal(hunks[0].skipped_before, 7);
  assert.deepEqual(hunks[0].lines.map((l) => l.text), ['line(8).', 'line(9).', 'line(10).', 'line(ten).', 'line(11).', 'line(12).']);
  assert.equal(hunks[1].skipped_before, 6);
  assert.equal(skipped_after, 0);
  // Windows line ends do not count as a change
  assert.equal(diff_lines('a.\r\nb.', 'a.\nb.').every((l) => l.op === 'same'), true);
  // Large programs are fine
  const big = Array.from({ length: 3000 }, (_, i) => `p(${i}).`);
  const t0 = Date.now();
  const changed = diff_lines(big.join('\n'), big.filter((_, i) => i % 7).join('\n'));
  assert.equal(changed.filter((l) => l.op === 'del').length, 429);
  assert.ok(Date.now() - t0 < 2000);
});

test('diffs of games: per program, with counts', () => {
  const d = diff_games({ aux_program: 'a.', player_move_program: 'do(wait).' }, { aux_program: 'a.', player_move_program: 'do(move(up)).\n% two' });
  const strategy = d.find((x) => x.field === 'player_move_program');
  assert.equal(d.find((x) => x.field === 'aux_program').same, true);
  assert.equal(d.find((x) => x.field === 'goal_program').same, true);
  assert.deepEqual([strategy.same, strategy.added, strategy.removed], [false, 2, 1]);
});

test('snapshots: keep, name, delete', () => {
  const store = new VersionStore(new MemoryStorage(), clock());
  const original = { aux_program: 'a.' };
  assert.deepEqual(store.list('example:x'), []);
  const s1 = store.add('example:x', { aux_program: 'a.', player_move_program: 'do(wait).' }, { name: 'first', note: 'waits' }, { title: 'X', original });
  assert.equal(s1.name, 'first');
  assert.equal(s1.auto, false);
  assert.equal(store.record('example:x').title, 'X');
  assert.equal(store.record('example:x').original.aux_program, 'a.');
  // An automatic snapshot of the same version is not made
  assert.equal(store.add('example:x', { aux_program: 'a.', player_move_program: 'do(wait).' }, { auto: true }).id, s1.id);
  const s2 = store.add('example:x', { aux_program: 'b.' }, { auto: true, reason: 'restoring' });
  assert.notEqual(s2.id, s1.id);
  assert.deepEqual(store.list('example:x').map((s) => s.id), [s1.id, s2.id]);
  assert.equal(store.get('example:x', s2.id).game.goal_program, '');
  // A name keeps an automatic snapshot
  assert.equal(store.update('example:x', s2.id, { name: 'keep me' }).auto, false);
  assert.equal(store.remove('example:x', s1.id), true);
  assert.deepEqual(store.list('example:x').map((s) => s.name), ['keep me']);
  assert.deepEqual(store.origins(), ['example:x']);
  store.forget_all();
  assert.deepEqual(store.origins(), []);
});

test('snapshots: only the newest automatic ones are kept', () => {
  const store = new VersionStore(new MemoryStorage(), clock());
  store.add('o', { aux_program: 'mine.' }, { name: 'mine' });
  for (let i = 0; i < MAX_AUTO + 5; i++) store.add('o', { aux_program: `v${i}.` }, { auto: true });
  const list = store.list('o');
  assert.equal(list.length, MAX_AUTO + 1);
  assert.equal(list[0].name, 'mine');
  assert.equal(list[1].game.aux_program, 'v5.');
});

test('snapshots: test results are kept with the version that was tested', () => {
  const store = new VersionStore(new MemoryStorage(), clock());
  const game = { aux_program: 'a.', player_move_program: 'do(wait).', level_state: 'at(1,1,player).' };
  const s = store.add('o', game, { name: 'v1' });
  // (another level: the same version)
  const t1 = store.add_test('o', { ...game, level_state: 'at(2,2,player).' }, { levels: 20, counts: { win: 15, lose: 5 } });
  assert.equal(t1.id, s.id);
  const t2 = store.add_test('o', { ...game, player_move_program: 'do(move(up)).' }, { levels: 10, counts: { win: 10 } });
  assert.notEqual(t2.id, s.id);
  assert.equal(t2.auto, true);
  assert.equal(t2.reason, 'tested');
  assert.deepEqual(store.get('o', s.id).tests.map((t) => t.counts), [{ win: 15, lose: 5 }]);
  assert.equal(best_test(store.get('o', t2.id)).rate, 1);
  assert.equal(best_test(store.get('o', s.id)).won, 15);
});

test('snapshots: a full or blocked storage is reported', () => {
  const store = new VersionStore(new MemoryStorage(2000), clock());
  assert.ok(store.add('o', { aux_program: 'a.' }, { name: 'small' }));
  assert.equal(store.add('o', { aux_program: 'x'.repeat(3000) }, { name: 'big' }), null);
  assert.equal(store.error, 'full');
  assert.deepEqual(store.list('o').map((s) => s.name), ['small']);
  const blocked = new VersionStore(null);
  assert.deepEqual(blocked.list('o'), []);
  assert.equal(blocked.add('o', { aux_program: 'a.' }), null);
  assert.equal(blocked.error, 'blocked');
  assert.deepEqual(blocked.origins(), []);
});

test('project files: the round trip, and merging snapshots', () => {
  const storage = new MemoryStorage();
  const store = new VersionStore(storage, clock());
  const [example] = load_examples();
  const s1 = store.add('example:flag1', { ...example.game, player_move_program: 'do(wait).' }, { name: 'one', note: 'a note' });
  store.add_test('example:flag1', { ...example.game, player_move_program: 'do(wait).' }, { levels: 5, counts: { lose: 5 } });
  const file = project_file({
    origin: 'example:flag1', title: 'Find the flag 1', original: example.game,
    game: { ...example.game, player_move_program: 'do(move(up)).' }, snapshots: store.list('example:flag1'),
  });
  const text = JSON.stringify(file);
  const back = read_file(text, 'p.json');
  assert.equal(back.kind, 'project');
  assert.equal(back.project.origin, 'example:flag1');
  assert.equal(back.project.title, 'Find the flag 1');
  assert.equal(back.project.game.player_move_program, 'do(move(up)).');
  assert.equal(back.project.original.aux_program, example.game.aux_program);
  assert.deepEqual(back.project.snapshots.map((s) => [s.id, s.name, s.note, s.tests.length]), [[s1.id, 'one', 'a note', 1]]);
  // Into another browser, which already has a snapshot of its own; loading the same file twice adds nothing
  const other = new VersionStore(new MemoryStorage(), clock());
  other.add('example:flag1', { aux_program: 'mine.' }, { name: 'mine' });
  assert.equal(other.merge('example:flag1', back.project.snapshots), 1);
  assert.equal(other.merge('example:flag1', back.project.snapshots), 0);
  assert.deepEqual(other.list('example:flag1').map((s) => s.name).sort(), ['mine', 'one']);
  assert.ok(storage_used(storage) > 2 * JSON.stringify(s1.game).length);
});

test('project files: backups, plain games, and files that are neither', () => {
  const backup = read_file(JSON.stringify(backup_file([
    { origin: 'example:a', title: 'A', game: { aux_program: 'a.' } },
    { origin: 'nonsense', title: '', game: { aux_program: 'b.' } },
  ])), 'all.json');
  assert.equal(backup.kind, 'backup');
  assert.deepEqual(backup.projects.map((p) => [p.origin, p.title]), [['example:a', 'A'], ['file:all.json', 'all.json']]);
  for (const { game } of load_examples()) assert.equal(read_file(JSON.stringify(game)).kind, 'game');
  assert.throws(() => read_file('not json'), /not JSON/);
  assert.throws(() => read_file('{"hello": 1}'), /none of the programs/);
  assert.throws(() => read_file(JSON.stringify({ format: 'logic-game-project', format_version: 99, game: {} })), /newer version/);
  assert.throws(() => read_file(JSON.stringify({ format: 'logic-game-project', format_version: 1 })), /no game/);
  assert.equal(file_stem('Find the flag 3 (with solutions)'), 'find-the-flag-3-with-solutions');
  assert.equal(file_stem(''), 'game');
});

test('saved work keeps the original game and its title', () => {
  const store = new WorkStore(new MemoryStorage());
  store.save('file:x.json', { aux_program: 'b.' }, { aux_program: 'a.' }, 'x.json');
  const saved = store.load('file:x.json');
  assert.equal(saved.original.aux_program, 'a.');
  assert.equal(saved.title, 'x.json');
});

test('downloads of the game file and of the project file are remembered separately', () => {
  const store = new VersionStore(new MemoryStorage(), clock());
  const game = { player_move_program: 'do(move(up)).' };
  assert.equal(store.record('example:a').game_downloaded_at, null);
  assert.equal(store.mark_game_downloaded('example:a', game, { title: 'A' }), true);
  let record = store.record('example:a');
  assert.equal(record.game_downloaded_at, '2026-01-01T00:01:00.000Z');
  assert.equal(record.game_downloaded.player_move_program, 'do(move(up)).');
  assert.equal(record.title, 'A');
  assert.equal(record.downloaded_at, null);
  // (a record with only a download is kept)
  assert.deepEqual(store.origins(), ['example:a']);
  store.mark_downloaded('example:a', { player_move_program: 'do(move(down)).' });
  record = store.record('example:a');
  assert.equal(record.game_downloaded.player_move_program, 'do(move(up)).');
  assert.equal(record.downloaded_game.player_move_program, 'do(move(down)).');
});
