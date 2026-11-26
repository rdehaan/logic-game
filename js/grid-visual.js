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
const SIDE_BY_SIDE_MIN = 1100;      // (as in css/main.css)

// The width of the container of the board, as last measured (by the ResizeObserver
// of watch_size): reading it from the page at every step would make the browser
// lay out the page again.
let container_width = null;

function cell_size(width, height) {
  const container = document.getElementById('visual-container');
  if (container_width == null && container) container_width = container.clientWidth;
  const available_width = Math.max(100, (container ? container_width : window.innerWidth) - 4);
  // (next to the tabs, the board shares the height of the screen with the buttons)
  const share = document.body.classList.contains('side-by-side') && window.innerWidth >= SIDE_BY_SIDE_MIN ? 0.55 : 0.7;
  const available_height = Math.max(160, Math.min(window.innerHeight * share, 640));
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
    container_width = w;
    if (w !== last) {
      last = w;
      layout_grid();
    }
  });
  resize_observer.observe(container);
  window.addEventListener('resize', layout_grid);
}

// The cell with the keyboard focus (an index), kept when the board is drawn again.
let focused_cell = 1;

// What a cell holds, in words (for screen readers, and as a tooltip).
function cell_description(grid, i, changed) {
  const row = Math.floor((i - 1) / grid.width) + 1;
  const col = ((i - 1) % grid.width) + 1;
  const items = [...(grid.cells.get(i) || []), ...(grid.hidden.get(i) || [])].toSorted();
  let what = items.length ? items.join(', ') : grid.fog.has(i) ? 'not visible' : 'empty';
  if (items.length && grid.fog.has(i)) what += ' (not visible)';
  return `Row ${row}, column ${col}: ${what}` + (changed.has(i) ? ' (changed)' : '');
}

function visualize_grid(grid, changed = new Set()) {
  const visual = document.getElementById('visual');
  const had_focus = visual.contains(document.activeElement);
  if (focused_cell > grid.width * grid.height) focused_cell = 1;
  visual.replaceChildren();
  visual.setAttribute('role', 'group');
  visual.setAttribute('aria-label', `The board: ${grid.height} rows, ${grid.width} columns (arrow keys: from cell to cell)`);
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
    for (const item of items) item.setAttribute('aria-hidden', 'true');
    div.setAttribute('role', 'img');
    div.setAttribute('aria-label', cell_description(grid, i, changed));
    div.tabIndex = i === focused_cell ? 0 : -1;
    visual.append(div);
  }
  if (had_focus) visual.children[focused_cell - 1].focus({ preventScroll: true });
  watch_keys();
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

// ---- Facts and cells ---------------------------------------------------------------------
//
// The cell a fact is about: the first two whole numbers that follow each other
// in its arguments (at any depth) and are a row and column of the board, as in
// observe(at(2,8,player)), next(2,8,player), observe(fog(1,4)) or
// memory(step(2,5,3)). Returns the index of the cell (as on the board), or null.
export function cell_of_atom(atom, width, height) {
  const visit = (term) => {
    const { args } = split_atom(term.trim());
    for (let k = 0; k + 1 < args.length; k++) {
      const r = number(args[k]);
      const c = number(args[k + 1]);
      if (r != null && c != null && r >= 1 && c >= 1 && r <= height && c <= width) return (r - 1) * width + c;
    }
    for (const a of args) {
      const i = visit(a);
      if (i != null) return i;
    }
    return null;
  };
  return visit(atom);
}

// The size of the board that is shown ({ width, height }), or null.
export function board_size() {
  const visual = document.getElementById('visual');
  const width = Number(visual.dataset.cols);
  const height = Number(visual.dataset.rows);
  return width && height ? { width, height } : null;
}

// Highlight cells of the board (indices as in cell_of_atom); none: no highlights.
export function highlight_cells(indices = []) {
  const visual = document.getElementById('visual');
  const set = new Set(indices);
  [...visual.children].forEach((cell, k) => cell.classList.toggle('linked', set.has(k + 1)));
}

// Call `fn` with the index of the cell under the mouse, or with the keyboard
// focus (null when both leave the board).
export function on_cell_hover(fn) {
  const visual = document.getElementById('visual');
  const index = (e) => {
    const cell = e.target.closest && e.target.closest('.grid-visual-cell');
    return cell ? [...visual.children].indexOf(cell) + 1 : null;
  };
  visual.addEventListener('mouseover', (e) => { if (index(e)) fn(index(e)); });
  visual.addEventListener('mouseleave', () => fn(visual.contains(document.activeElement) ? focused_cell : null));
  visual.addEventListener('focusin', (e) => { if (index(e)) fn(index(e)); });
  visual.addEventListener('focusout', (e) => { if (!visual.contains(e.relatedTarget)) fn(null); });
}

// The arrow keys (and Home and End) move the focus from cell to cell.
let keys_watched = false;
function watch_keys() {
  if (keys_watched) return;
  keys_watched = true;
  const visual = document.getElementById('visual');
  visual.addEventListener('keydown', (e) => {
    const width = Number(visual.dataset.cols);
    const n = visual.children.length;
    if (!width || !n || e.ctrlKey || e.metaKey || e.altKey) return;
    const i = focused_cell;
    const col = (i - 1) % width;
    const to = {
      ArrowLeft: col > 0 ? i - 1 : i, ArrowRight: col < width - 1 ? i + 1 : i,
      ArrowUp: i - width >= 1 ? i - width : i, ArrowDown: i + width <= n ? i + width : i,
      Home: i - col, End: i - col + width - 1,
    }[e.key];
    if (to == null) return;
    e.preventDefault();
    move_focus(to);
  });
  visual.addEventListener('focusin', (e) => {
    const cell = e.target.closest('.grid-visual-cell');
    if (cell) focused_cell = [...visual.children].indexOf(cell) + 1;
  });
}

function move_focus(to) {
  const visual = document.getElementById('visual');
  const from = visual.children[focused_cell - 1];
  if (from) from.tabIndex = -1;
  focused_cell = to;
  const cell = visual.children[to - 1];
  cell.tabIndex = 0;
  cell.focus();
}
