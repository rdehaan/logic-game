// The board as text (for the command-line version), from the same facts as
// the board on the page (see grid-visual.js).
//
// Each object gets a letter (the first free letter of its name: player P,
// flag F, ...), or its label when that is a short string. Items that the
// player does not observe (decorate(item,...)) are in lower case; cells the
// player cannot see (fog) are shown as ~. Optionally, cells that changed since
// the board before are highlighted (with ANSI colors).
//
// This module does not use the DOM.
import { compute_grid_ds, changed_cells } from './grid-visual.js';

// A symbol for every object: { object: symbol }.
function symbols(grid) {
  const objects = new Set();
  for (const list of [...grid.cells.values(), ...grid.hidden.values()]) for (const o of list) objects.add(o);
  const taken = new Set();
  const out = {};
  for (const o of [...objects].sort()) {
    const label = grid.labels.get(o);
    const string = label && /^"([^"\\]{1,2})"$/.exec(label);
    let s = string ? string[1] : null;
    if (!s || taken.has(s)) {
      const letters = (o.replace(/[^A-Za-z]/g, '') + 'XYZWVQ').toUpperCase();
      s = [...letters].find((c) => !taken.has(c)) || '?';
    }
    taken.add(s);
    out[o] = s;
  }
  return out;
}

const color = {
  changed: (t) => `\x1b[43m\x1b[30m${t}\x1b[0m`,
  dim: (t) => `\x1b[2m${t}\x1b[0m`,
};

// The board described by the facts, as lines of text (or null if it has no size).
// Options: previous (the facts of the board before, to mark the changed cells),
// ansi (use colors), legend (add a line that says which symbol is which object).
export function text_board(facts, { previous = null, ansi = false, legend = true } = {}) {
  const grid = compute_grid_ds(facts);
  if (!grid) return null;
  const prev = previous != null ? compute_grid_ds(previous) : null;
  const changed = prev ? changed_cells(grid, prev) : new Set();
  const sym = symbols(grid);
  const cell_text = (i) => {
    const seen = (grid.cells.get(i) || []).map((o) => sym[o]);
    const hidden = (grid.hidden.get(i) || []).map((o) => sym[o].toLowerCase());
    const text = [...seen, ...hidden].join('');
    if (text) return text;
    return grid.fog.has(i) ? '~' : '.';
  };
  let width = 1;
  for (let i = 1; i <= grid.width * grid.height; i++) width = Math.max(width, cell_text(i).length);
  const col_width = Math.max(width, String(grid.width).length);
  const row_width = String(grid.height).length;
  const lines = [' '.repeat(row_width) + ' ' + Array.from({ length: grid.width }, (_, c) => String(c + 1).padStart(col_width)).join(' ')];
  for (let r = 1; r <= grid.height; r++) {
    const cells = [];
    for (let c = 1; c <= grid.width; c++) {
      const i = (r - 1) * grid.width + c;
      let t = cell_text(i).padStart(col_width);
      if (ansi && changed.has(i)) t = color.changed(t);
      else if (ansi && (t.trim() === '.' || t.trim() === '~')) t = color.dim(t);
      cells.push(t);
    }
    lines.push(String(r).padStart(row_width) + ' ' + cells.join(' '));
  }
  if (legend && Object.keys(sym).length) {
    lines.push(Object.entries(sym).map(([o, s]) => `${s} = ${o}`).join(', ') +
      (grid.hidden.size ? ' (lower case: not observed by the player)' : '') +
      (grid.fog.size ? '; ~ = cannot be seen' : ''));
  }
  return lines;
}
