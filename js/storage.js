// Keeping work, and sharing games as links.
//
// - Saved work: the page saves the game being edited in the browser
//   (localStorage), under the name of the game it was loaded from (an example,
//   an uploaded file, or a shared link). When that game is loaded again, the
//   saved version is loaded instead, with a way back to the original.
// - Share links: the whole game, compressed, in the part of the URL after '#'
//   (#game=...). That part never reaches the web server, so a link works
//   without any server, and nothing is uploaded anywhere.
//
// This module does not use the DOM (only localStorage, which is passed in),
// so the tests can run it in Node.
import { GAME_FIELDS, normalize_game } from './engine.js';

const PREFIX = 'logic-game:work:';

// ---- Share links --------------------------------------------------------------------

function to_base64url(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function from_base64url(text) {
  const binary = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

async function transform(bytes, stream) {
  const blob = new Blob([bytes]);
  return new Uint8Array(await new Response(blob.stream().pipeThrough(stream)).arrayBuffer());
}

// The game as text for a link: compressed JSON in base64url.
export async function encode_game(game) {
  const json = JSON.stringify(compact(game));
  const compressed = await transform(new TextEncoder().encode(json), new CompressionStream('deflate-raw'));
  return to_base64url(compressed);
}

// The game from the text of a link (throws if it is not a game).
export async function decode_game(text) {
  const bytes = await transform(from_base64url(text), new DecompressionStream('deflate-raw'));
  const game = JSON.parse(new TextDecoder().decode(bytes));
  if (!game || typeof game !== 'object' || !GAME_FIELDS.some((f) => typeof game[f] === 'string')) {
    throw new Error('this link does not contain a game');
  }
  return normalize_game(game);
}

// A game without its empty fields (shorter links).
export function compact(game) {
  const out = {};
  for (const field of GAME_FIELDS) if (game[field]) out[field] = game[field];
  return out;
}

// A short name for a shared game (to save work on it under).
export async function game_id(game) {
  const data = new TextEncoder().encode(JSON.stringify(compact(game)));
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', data));
  return to_base64url(hash).slice(0, 12);
}

// ---- Saved work ---------------------------------------------------------------------

export function same_game(a, b, fields = GAME_FIELDS) {
  return fields.every((f) => (a[f] || '') === (b[f] || ''));
}

// Saved work, in a storage such as window.localStorage. All calls return
// quietly when the storage cannot be used (e.g. in a private window).
export class WorkStore {
  constructor(storage) {
    this.storage = storage;
  }

  // The saved version of a game (or null): { game, saved_at, original, title }
  // (the original game and its title are null for work saved by older versions).
  load(origin) {
    try {
      const entry = JSON.parse(this.storage.getItem(PREFIX + origin));
      if (!entry || !entry.game) return null;
      return {
        game: normalize_game(entry.game),
        saved_at: entry.saved_at,
        original: entry.original ? normalize_game(entry.original) : null,
        title: typeof entry.title === 'string' ? entry.title : null,
      };
    } catch {
      return null;
    }
  }

  // Save the current version of a game; a version that is the same as the
  // original is not kept. The original and its title are kept with it, so that
  // the game can be opened again from the list of saved work.
  save(origin, game, original, title) {
    try {
      if (original && same_game(game, original)) {
        this.storage.removeItem(PREFIX + origin);
      } else {
        const entry = { game: compact(game), saved_at: new Date().toISOString() };
        if (original) entry.original = compact(original);
        if (title) entry.title = title;
        this.storage.setItem(PREFIX + origin, JSON.stringify(entry));
      }
      return true;
    } catch {
      return false;
    }
  }

  forget(origin) {
    try {
      this.storage.removeItem(PREFIX + origin);
    } catch {
      // nothing to do
    }
  }

  // The names of all games with saved work.
  origins() {
    try {
      const out = [];
      for (let i = 0; i < this.storage.length; i++) {
        const key = this.storage.key(i);
        if (key && key.startsWith(PREFIX)) out.push(key.slice(PREFIX.length));
      }
      return out.sort();
    } catch {
      return [];
    }
  }

  forget_all() {
    for (const origin of this.origins()) this.forget(origin);
  }
}
