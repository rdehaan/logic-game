// Tests of the folder format and zip files (no clingo or browser needed).
import test from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import {
  game_to_files, files_to_game, file_names, strip_common_dir, make_zip, read_zip, same_text, DEFAULT_FILES,
  zip_budget, ZipLimitError, ZIP_MAX_ENTRY_SIZE, ZIP_MAX_TOTAL_SIZE, ZIP_MAX_RATIO,
} from '../js/folder.js';
import { GAME_FIELDS } from '../js/engine.js';
import { load_examples } from './helpers.mjs';

test('folders: every example survives the round trip', () => {
  for (const { name, game } of load_examples()) {
    const files = game_to_files(game, { title: name });
    assert.ok(files['strategy.lp'] != null, name);
    for (const [p, text] of Object.entries(files)) if (text) assert.ok(text.endsWith('\n') && !text.endsWith('\n\n'), `${name}: ${p}`);
    const back = files_to_game(files);
    assert.equal(back.title, name);
    for (const field of GAME_FIELDS) assert.equal(back.game[field], (game[field] || '').replace(/\n+$/, ''), `${name}: ${field}`);
  }
});

test('folders: a game without a level has no level files', () => {
  const files = game_to_files({ player_move_program: 'do(wait).' });
  assert.deepEqual(Object.keys(files).sort(), ['auxiliary.lp', 'game.json', 'level-generation.lp', 'nature.lp', 'strategy.lp', 'visibility.lp', 'winning-conditions.lp']);
  assert.equal(files['strategy.lp'], 'do(wait).\n');
  assert.equal(files['nature.lp'], '');
});

test('folders: other file names in game.json, no game.json, and wrong folders', () => {
  const manifest = JSON.stringify({ format: 'logic-game-folder', format_version: 1, files: { player_move_program: 'src/my strategy.lp' } });
  const { game, files } = files_to_game({ 'game.json': manifest, 'src/my strategy.lp': 'do(move(up)).\r\n', 'nature.lp': 'n.' });
  assert.equal(game.player_move_program, 'do(move(up)).');
  assert.equal(game.nature_program, 'n.');
  assert.equal(files.player_move_program, 'src/my strategy.lp');
  assert.equal(files.goal_program, DEFAULT_FILES.goal_program);
  // Without game.json: the default names
  assert.equal(files_to_game({ 'strategy.lp': 'do(wait).\n' }).game.player_move_program, 'do(wait).');
  assert.throws(() => files_to_game({ 'notes.txt': 'hi' }), /none of the programs.*no game\.json/);
  assert.throws(() => file_names('{"files": {"aux_program": "../../etc/passwd"}}'), /not a path inside the folder/);
  assert.throws(() => file_names('{"files": {"aux_program": "/abs.lp"}}'), /not a path inside the folder/);
  assert.throws(() => file_names('not json'), /not valid JSON/);
  assert.throws(() => file_names('{"format": "something-else"}'), /unknown format/);
  assert.throws(() => file_names('{"format_version": 2}'), /newer version/);
  assert.deepEqual(strip_common_dir(['g/strategy.lp', 'g/level/state.lp']), { dir: 'g', paths: ['strategy.lp', 'level/state.lp'] });
  assert.deepEqual(strip_common_dir(['strategy.lp', 'g/x.lp']).dir, null);
  assert.equal(same_text('a.\n', 'a.'), true);
  assert.equal(same_text('a.\r\n\n', 'a.'), true);
  assert.equal(same_text('a.', 'b.'), false);
});

// A zip file as zip programs write it (compressed, with a folder entry).
// For zip files that lie: declared gives other unpacked sizes ({ name: size }),
// and same_data entries that use the data of another one ({ name: other name }).
function deflated_zip(files, { declared = {}, same_data = {} } = {}) {
  const parts = [];
  const central = [];
  const offsets = {};
  let offset = 0;
  const entries = Object.entries(files);
  for (const [name, text] of entries) {
    offsets[name] = offset;
    const n = Buffer.from(name);
    const raw = Buffer.from(text);
    const data = name.endsWith('/') ? Buffer.alloc(0) : zlib.deflateRawSync(raw);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(name.endsWith('/') ? 0 : 8, 8);
    local.writeUInt32LE(zlib.crc32 ? zlib.crc32(raw) : 0, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(n.length, 26);
    parts.push(local, n, data);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt16LE(name.endsWith('/') ? 0 : 8, 10);
    c.writeUInt32LE(data.length, 20);
    c.writeUInt32LE(declared[name] ?? raw.length, 24);
    c.writeUInt16LE(n.length, 28);
    c.writeUInt32LE(same_data[name] != null ? offsets[same_data[name]] : offset, 42);
    central.push(c, n);
    offset += 30 + n.length + data.length;
  }
  const size = central.reduce((k, b) => k + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(size, 12);
  end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...parts, ...central, end]));
}

test('zip files: the round trip, and zip files from zip programs', async () => {
  const [{ game }] = load_examples();
  const files = game_to_files(game, { title: 'Ünïcode title' });
  const zipped = make_zip(Object.fromEntries(Object.entries(files).map(([p, t]) => ['my-game/' + p, t])));
  const back = await read_zip(zipped);
  const { dir, paths } = strip_common_dir(Object.keys(back));
  assert.equal(dir, 'my-game');
  assert.deepEqual(paths.sort(), Object.keys(files).sort());
  assert.equal(back['my-game/strategy.lp'], files['strategy.lp']);
  assert.equal(JSON.parse(back['my-game/game.json']).title, 'Ünïcode title');
  // CRCs are right (checked by the zip tool of the system, if there is one)
  const deflated = await read_zip(deflated_zip({ 'g/': '', 'g/strategy.lp': 'do(wait).\n'.repeat(50), '__MACOSX/g/._strategy.lp': 'x' }));
  assert.deepEqual(Object.keys(deflated), ['g/strategy.lp']);
  assert.equal(deflated['g/strategy.lp'], 'do(wait).\n'.repeat(50));
  await assert.rejects(read_zip(new Uint8Array(100)), /not a zip file/);
});

test('zip files: the checksums are the standard ones', async () => {
  if (!zlib.crc32) return;      // (Node 20.15 and newer)
  const bytes = make_zip({ 'a.lp': 'hello.\n' });
  const view = new DataView(bytes.buffer);
  assert.equal(view.getUint32(14, true), zlib.crc32(Buffer.from('hello.\n')));
});

test("zip files: a file named '__proto__' is a file, not the prototype of the result", async () => {
  const back = await read_zip(make_zip({ ['__proto__']: new Uint8Array([1, 2]), 'a.lp': 'a.' }), { binary: true });
  assert.equal(Object.getPrototypeOf(back), Object.prototype);
  assert.deepEqual(Object.keys(back), ['__proto__', 'a.lp']);
  assert.deepEqual([...back['__proto__']], [1, 2]);
  // (and a folder whose game.json names such files has no programs in them)
  assert.throws(() => files_to_game({ 'game.json': '{"files": {"player_move_program": "toString"}}' }), /none of the programs/);
});

test('zip files: zip bombs are not unpacked', async () => {
  const skipped = [];
  const ok = 'do(wait).\n';
  // Entries that share their data (a small zip file with many large files)
  const shared = deflated_zip({ 'a.lp': 'x'.repeat(1000), 'b.lp': '', 'c.lp': '', 'ok.lp': ok }, { same_data: { 'b.lp': 'a.lp', 'c.lp': 'a.lp' } });
  let back = await read_zip(shared, { skipped });
  assert.deepEqual(Object.keys(back), ['ok.lp']);
  assert.deepEqual(skipped.map((x) => x.name), ['a.lp', 'b.lp', 'c.lp']);
  assert.match(skipped[0].reason, /overlaps with that of another file/);
  await assert.rejects(read_zip(shared), /a\.lp in the zip file is damaged \(its data overlaps/);
  // An unpacked size that is not the one the zip file says: unpacking stops at the size it says
  skipped.length = 0;
  const big = Buffer.alloc(20e6).toString();
  back = await read_zip(deflated_zip({ 'big.lp': big, 'small.lp': 'abc', 'ok.lp': ok }, { declared: { 'big.lp': 1000, 'small.lp': 10 } }), { skipped });
  assert.deepEqual(Object.keys(back), ['ok.lp']);
  assert.deepEqual(skipped.map((x) => x.name), ['big.lp', 'small.lp']);
  assert.match(skipped[0].reason, /its size when unpacked is not the one the zip file gives/);
  // (also without compression)
  const stored = make_zip({ 'a.lp': 'abc' });
  new DataView(stored.buffer).setUint32(stored.length - 22 - 46 - 4 + 24, 5, true);
  skipped.length = 0;
  assert.deepEqual(await read_zip(stored, { skipped }), {});
  assert.match(skipped[0].reason, /its size when unpacked/);
  // A file that is too large on its own is left out, without unpacking it
  skipped.length = 0;
  back = await read_zip(deflated_zip({ 'huge.lp': 'x', 'ok.lp': ok }, { declared: { 'huge.lp': ZIP_MAX_ENTRY_SIZE + 1 } }), { skipped });
  assert.deepEqual(Object.keys(back), ['ok.lp']);
  assert.match(skipped[0].reason, /is too large when unpacked \(100 MB; at most 100 MB can be read\)/);
  // Data beyond the end of the zip file
  const cut = make_zip({ 'a.lp': 'abc', 'b.lp': ok });
  new DataView(cut.buffer).setUint32(cut.length - 22 - 2 * 46 - 4 - 4 + 20, 1e6, true);
  skipped.length = 0;
  assert.deepEqual(Object.keys(await read_zip(cut, { skipped })), ['b.lp']);
  assert.match(skipped[0].reason, /its data is not all in the zip file/);
  // All files together: too large for what may be unpacked (the whole file fails)
  const budget = { limit: 1000, left: 1000 };
  await read_zip(make_zip({ 'a.lp': 'x'.repeat(600) }), { budget });
  assert.equal(budget.left, 400);
  await assert.rejects(read_zip(make_zip({ 'b.lp': 'x'.repeat(600) }), { budget, skipped: [] }), ZipLimitError);
  assert.equal(zip_budget(10).limit, ZIP_MAX_TOTAL_SIZE);
  assert.equal(zip_budget(1e9).limit, ZIP_MAX_RATIO * 1e9);
  // Too many files
  const many = make_zip({ 'a.lp': 'a.' });
  new DataView(many.buffer).setUint16(many.length - 22 + 10, 60000, true);
  await assert.rejects(read_zip(many), /too many files \(60000; at most 10000/);
});
