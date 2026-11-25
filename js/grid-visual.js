// Drawing the board from the facts that the player observes (and the decorations).
//
// The board is built from DOM elements, never from HTML text: labels and
// colours come from the programs of a game, and a game can come from anyone
// (e.g. through a share link), so they must not be able to inject HTML or
// scripts into the page. Labels are shown as text, and colours are only
// accepted as hex_RGB / hex_RRGGBB (and with alpha) or as plain colour names.
//
// compute_grid_ds() does not use the DOM (the tests run it in Node).
import { facts_to_answer_set, split_atom } from './asp.js';

const number = (text) => (/^-?\d+$/.test(text) ? Number(text) : null);

// The board described by a program of facts, or null if it has no size:
// { height, width, cells: Map(index -> [object]), fog: Set(index),
//   bg: Map(index -> colour), hidden: Map(index -> [object]),
//   labels: Map(object -> label), colors: Map(object -> colour) }
// (cells are numbered from 1, row by row).
export function compute_grid_ds(facts) {
  const atoms = facts_to_answer_set(facts).map(split_atom);
  const setting = (key) => {
    for (const a of atoms) {
      if (a.name !== 'setting' || a.args.length !== 1) continue;
      const inner = split_atom(a.args[0]);
      if (inner.name === key && inner.args.length === 1 && number(inner.args[0]) != null) return number(inner.args[0]);
    }
    return null;
  };
  const height = setting('grid_height');
  const width = setting('grid_width');
  if (!(height > 0) || !(width > 0)) return null;

  const grid = {
    height, width,
    cells: new Map(), fog: new Set(), bg: new Map(), hidden: new Map(), labels: new Map(), colors: new Map(),
  };
  // The index of a cell, or null if (row, col) is not on the board
  const cell = (row, col) => {
    const r = number(row);
    const c = number(col);
    if (r == null || c == null || r < 1 || c < 1 || r > height || c > width) return null;
    return (r - 1) * width + c;
  };
  const add = (map, key, value) => {
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(value);
  };

  for (const a of atoms) {
    if (a.name === 'observe' && a.args.length === 1) {
      const inner = split_atom(a.args[0]);
      if (inner.name === 'at' && inner.args.length === 3) {
        const i = cell(inner.args[0], inner.args[1]);
        if (i != null) add(grid.cells, i, inner.args[2]);
      } else if (inner.name === 'fog' && inner.args.length === 2) {
        const i = cell(inner.args[0], inner.args[1]);
        if (i != null) grid.fog.add(i);
      }
    } else if (a.name === 'decorate') {
      const [kind, ...rest] = a.args;
      if (kind === 'bgcolor' && rest.length === 3) {
        const i = cell(rest[0], rest[1]);
        if (i != null) grid.bg.set(i, rest[2]);
      } else if (kind === 'item' && rest.length === 3) {
        const i = cell(rest[0], rest[1]);
        if (i != null) add(grid.hidden, i, rest[2]);
      } else if (kind === 'label' && rest.length === 2) {
        grid.labels.set(rest[0], rest[1]);
      } else if (kind === 'color' && rest.length === 2) {
        grid.colors.set(rest[0], rest[1]);
      }
    }
  }
  return grid;
}

// The text to show for a label: font_XXXX is the character with code XXXX
// (e.g. an icon of Font Awesome), 'empty' is nothing, a string is its
// contents, anything else is shown as it is.
export function label_text(label) {
  if (label == null) return '?';
  if (label === 'empty') return '';
  const font = /^font_([0-9a-fA-F]{1,6})$/.exec(label);
  if (font) {
    const code = parseInt(font[1], 16);
    return code <= 0x10FFFF ? String.fromCodePoint(code) : '?';
  }
  const string = /^"((?:\\.|[^"\\])*)"$/.exec(label);
  if (string) return string[1].replace(/\\(.)/g, '$1');
  return label;
}

// A colour as CSS, or null if it is not a colour that is accepted:
// hex_RGB, hex_RGBA, hex_RRGGBB, hex_RRGGBBAA, or a plain colour name.
export function css_color(color) {
  if (color == null) return null;
  const hex = /^hex_([0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.exec(color);
  if (hex) return '#' + hex[1];
  if (/^[a-z]+$/.test(color)) return color;
  return null;
}

function item_element(grid, item, css_class) {
  const span = document.createElement('span');
  span.textContent = label_text(grid.labels.get(item));
  if (css_class) span.className = css_class;
  const color = css_color(grid.colors.get(item));
  if (color) span.style.color = color;
  return span;
}

// What a cell shows, as text (for comparing two boards).
function cell_contents(grid, i) {
  return JSON.stringify([(grid.cells.get(i) || []).toSorted(), (grid.hidden.get(i) || []).toSorted(), grid.fog.has(i)]);
}

// The cells that show something else on two boards (of the same size).
export function changed_cells(grid, previous) {
  const out = new Set();
  if (!grid || !previous || grid.width !== previous.width || grid.height !== previous.height) return out;
  for (let i = 1; i <= grid.height * grid.width; i++) {
    if (cell_contents(grid, i) !== cell_contents(previous, i)) out.add(i);
  }
  return out;
}

// The size of the board: square cells, as large as fits in the width of the
// page and in about 70% of the height of the screen (at least MIN_CELL pixels:
// a board that is larger than that can be scrolled).
const MIN_CELL = 6;
const MAX_CELL = 96;

function cell_size(width, height) {
  const container = document.getElementById('visual-container');
  const available_width = Math.max(100, (container ? container.clientWidth : window.innerWidth) - 4);
  const available_height = Math.max(160, Math.min(window.innerHeight * 0.7, 640));
  const size = Math.floor(Math.min(available_width / width, available_height / height, MAX_CELL));
  return Math.max(MIN_CELL, size);
}

// Size the board, and the items in its cells (to fit in a cell, also when
// there are several items in it).
function layout_grid() {
  const visual = document.getElementById('visual');
  const width = Number(visual.dataset.cols);
  const height = Number(visual.dataset.rows);
  if (!width || !height) return;
  const size = cell_size(width, height);
  visual.style.setProperty('--cell-size', size + 'px');
  visual.style.gridTemplateColumns = `repeat(${width}, ${size}px)`;
  visual.style.gridTemplateRows = `repeat(${height}, ${size}px)`;
  visual.classList.toggle('small-cells', size < 16);
  for (const cell of visual.children) {
    const n = Number(cell.dataset.items) || 1;
    // (items side by side, in as many rows as needed)
    const per_row = Math.ceil(Math.sqrt(n));
    cell.style.fontSize = Math.max(2, Math.floor(size * 0.62 / per_row)) + 'px';
  }
}

let resize_observer = null;
function watch_size() {
  if (resize_observer || typeof ResizeObserver === 'undefined') return;
  const container = document.getElementById('visual-container');
  let last = null;
  resize_observer = new ResizeObserver(() => {
    const w = container.clientWidth;
    if (w !== last) {
      last = w;
      layout_grid();
    }
  });
  resize_observer.observe(container);
  window.addEventListener('resize', layout_grid);
}

function visualize_grid(grid, changed = new Set()) {
  const visual = document.getElementById('visual');
  visual.replaceChildren();
  visual.className = 'grid-visual';
  visual.dataset.cols = grid.width;
  visual.dataset.rows = grid.height;
  visual.style.removeProperty('width');
  visual.style.setProperty('border', '1px solid #000');
  for (let i = 1; i <= grid.height * grid.width; i++) {
    const div = document.createElement('div');
    div.className = changed.has(i) ? 'grid-visual-cell changed' : 'grid-visual-cell';
    if (grid.fog.has(i)) div.style.backgroundColor = '#ddd';
    const bg = css_color(grid.bg.get(i));
    if (bg) div.style.backgroundColor = bg;
    const items = [
      ...(grid.cells.get(i) || []).toSorted().map((item) => item_element(grid, item, '')),
      ...(grid.hidden.get(i) || []).toSorted().map((item) => item_element(grid, item, 'grid-visual-hidden')),
    ];
    div.dataset.items = items.length;
    div.append(...items);
    visual.append(div);
  }
  layout_grid();
  watch_size();
}

// Visual effects for when a game is won or lost
export function display_win() {
  document.getElementById('visual').style.setProperty('border', '3px solid #AADB1E');
}
export function display_lose() {
  document.getElementById('visual').style.setProperty('border', '3px solid #E10600');
}

// Draw the board; with the facts of the previous step, the cells that
// changed since then are highlighted.
export function show_grid(facts, previous_facts = null) {
  const grid = compute_grid_ds(facts);
  if (!grid) {
    clear_grid();
    return;
  }
  const changed = previous_facts != null ? changed_cells(grid, compute_grid_ds(previous_facts)) : new Set();
  visualize_grid(grid, changed);
}

export function clear_grid() {
  const visual = document.getElementById('visual');
  visual.replaceChildren();
  visual.className = '';
  delete visual.dataset.cols;
  delete visual.dataset.rows;
  visual.style.setProperty('border', '0px solid #000');
}
