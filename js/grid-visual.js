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

function visualize_grid(grid) {
  const visual = document.getElementById('visual');
  visual.replaceChildren();
  visual.className = 'grid-visual';
  visual.style.setProperty('--num-cols', grid.width);
  visual.style.setProperty('--num-rows', grid.height);
  visual.style.setProperty('border', '1px solid #000');
  visual.style.setProperty('width', '80%');
  visual.style.setProperty('aspect-ratio', grid.width / grid.height);
  const font_size = Math.min(20 / grid.height, 2.5);

  for (let i = 1; i <= grid.height * grid.width; i++) {
    const div = document.createElement('div');
    div.className = 'grid-visual-cell';
    div.style.setProperty('--font-size', font_size + 'vw');
    if (grid.fog.has(i)) div.style.backgroundColor = '#ddd';
    const bg = css_color(grid.bg.get(i));
    if (bg) div.style.backgroundColor = bg;
    const inner = document.createElement('div');
    for (const item of (grid.cells.get(i) || []).toSorted()) inner.append(item_element(grid, item, ''));
    for (const item of (grid.hidden.get(i) || []).toSorted()) inner.append(item_element(grid, item, 'grid-visual-hidden'));
    div.append(inner);
    visual.append(div);
  }
}

// Visual effects for when a game is won or lost
export function display_win() {
  document.getElementById('visual').style.setProperty('border', '3px solid #AADB1E');
}
export function display_lose() {
  document.getElementById('visual').style.setProperty('border', '3px solid #E10600');
}

export function show_grid(facts) {
  const grid = compute_grid_ds(facts);
  if (grid) visualize_grid(grid);
  else clear_grid();
}

export function clear_grid() {
  const visual = document.getElementById('visual');
  visual.replaceChildren();
  visual.className = '';
  visual.style.setProperty('width', '0');
  visual.style.setProperty('border', '0px solid #000');
}
