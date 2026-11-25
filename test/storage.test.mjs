// Tests of saved work and share links (no clingo or browser needed).
import test from 'node:test';
import assert from 'node:assert/strict';
import { encode_game, decode_game, game_id, WorkStore } from '../js/storage.js';
import { GAME_FIELDS } from '../js/engine.js';
import { load_examples } from './helpers.mjs';

// A stand-in for window.localStorage.
class MemoryStorage {
  constructor() { this.data = new Map(); }
  get length() { return this.data.size; }
  key(i) { return [...this.data.keys()][i] ?? null; }
  getItem(k) { return this.data.has(k) ? this.data.get(k) : null; }
  setItem(k, v) { this.data.set(k, String(v)); }
  removeItem(k) { this.data.delete(k); }
}

test('share links: every example survives the round trip, and links are short', async () => {
  for (const { name, game } of load_examples()) {
    const code = await encode_game(game);
    assert.match(code, /^[A-Za-z0-9_-]+$/, name);
    const back = await decode_game(code);
    for (const field of GAME_FIELDS) assert.equal(back[field], game[field] || '', `${name}: ${field}`);
    assert.ok(code.length < 0.6 * JSON.stringify(game).length, `${name}: ${code.length} characters`);
  }
});

test('share links: text that is not a game is refused', async () => {
  await assert.rejects(decode_game('not-a-game'));
  const { Readable } = await import('node:stream');
  const bytes = new TextEncoder().encode(JSON.stringify({ hello: 'world' }));
  const compressed = new Uint8Array(await new Response(Readable.toWeb(Readable.from([bytes])).pipeThrough(new CompressionStream('deflate-raw'))).arrayBuffer());
  const code = Buffer.from(compressed).toString('base64url');
  await assert.rejects(decode_game(code), /does not contain a game/);
});

test('game ids depend only on the contents', async () => {
  const a = await game_id({ aux_program: 'a.' });
  assert.equal(a, await game_id({ aux_program: 'a.', goal_program: '' }));
  assert.notEqual(a, await game_id({ aux_program: 'b.' }));
  assert.equal(a.length, 12);
});

test('saved work: save, load, forget', () => {
  const store = new WorkStore(new MemoryStorage());
  const original = { aux_program: 'a.', player_move_program: '' };
  assert.equal(store.load('example:x'), null);
  store.save('example:x', { ...original, player_move_program: 'do(move(up)).' }, original);
  const saved = store.load('example:x');
  assert.equal(saved.game.player_move_program, 'do(move(up)).');
  assert.equal(saved.game.goal_program, '');
  assert.ok(saved.saved_at);
  assert.deepEqual(store.origins(), ['example:x']);
  // Back to the same as the original: nothing to keep
  store.save('example:x', original, original);
  assert.equal(store.load('example:x'), null);
  store.save('example:x', { aux_program: 'b.' }, original);
  store.save('file:y.json', { aux_program: 'c.' }, original);
  assert.deepEqual(store.origins(), ['example:x', 'file:y.json']);
  store.forget_all();
  assert.deepEqual(store.origins(), []);
});

test('saved work: a storage that does not work is ignored', () => {
  const broken = {
    get length() { throw new Error('denied'); },
    getItem() { throw new Error('denied'); },
    setItem() { throw new Error('quota'); },
    removeItem() { throw new Error('denied'); },
  };
  for (const store of [new WorkStore(broken), new WorkStore(null)]) {
    assert.equal(store.load('x'), null);
    assert.equal(store.save('x', { aux_program: 'a.' }), false);
    assert.deepEqual(store.origins(), []);
    store.forget_all();
  }
});
