// Help in the editors:
// - hovering over a special predicate (such as do/1 or observe/1) shows what it
//   means, and what it means for this program (gets it, passes it on, or does
//   not get it);
// - autocompletion offers the special predicates of the program, and the
//   predicates defined in it and in the auxiliary program (Ctrl-Space, or
//   while typing).
import { analyze_program, sig } from './analysis.js';
import { preprocess_program } from './asp.js';
import { special_help, completions } from './hints.js';

let tooltip = null;

function show_tooltip(x, y, title, text) {
  if (!tooltip) {
    tooltip = document.createElement('div');
    tooltip.className = 'predicate-help';
    tooltip.setAttribute('role', 'tooltip');
    document.body.append(tooltip);
  }
  const strong = document.createElement('strong');
  strong.textContent = title;
  tooltip.replaceChildren(strong, document.createElement('br'), document.createTextNode(text));
  tooltip.hidden = false;
  const width = Math.min(360, window.innerWidth - 16);
  tooltip.style.maxWidth = width + 'px';
  tooltip.style.left = Math.max(8, Math.min(x + 12, window.innerWidth - width - 8)) + 'px';
  // below the mouse, or above it if there is no room below
  const height = tooltip.offsetHeight;
  const top = y + 18 + height <= window.innerHeight ? y + 18 : Math.max(8, y - height - 8);
  tooltip.style.top = (top + window.scrollY) + 'px';
}

function hide_tooltip() {
  if (tooltip) tooltip.hidden = true;
}

// The atom at a position (row and column from 0) of a program, using the analysis.
function atom_at(atoms, row, column) {
  const line = row + 1;
  const col = column + 1;
  return atoms.find((a) => a.line === line && col >= a.col && col < a.col + a.name.length);
}

// Add the help to the editor of program `field`; game() gives the current game.
export function add_editor_help(editor, field, game) {
  let analysis = null;
  editor.session.on('change', () => { analysis = null; });
  let timer = null;

  editor.container.addEventListener('mousemove', (e) => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      const pos = editor.renderer.screenToTextCoordinates(e.clientX, e.clientY);
      if (!analysis) analysis = analyze_program(preprocess_program(editor.getValue(), () => 0));
      const atom = atom_at(analysis.atoms, pos.row, pos.column);
      const help = atom && special_help(field, sig(atom));
      if (help) show_tooltip(e.clientX, e.clientY, help.title, help.text);
      else hide_tooltip();
    }, 150);
  });
  editor.container.addEventListener('mouseleave', () => {
    clearTimeout(timer);
    hide_tooltip();
  });

  editor.completers = [{
    id: 'logic-game',
    getCompletions(ed, session, pos, prefix, callback) {
      // (no suggestions while typing a variable)
      if (/^[A-Z_]/.test(prefix)) {
        callback(null, []);
        return;
      }
      callback(null, completions(field, game()).map((c, i) => ({
        caption: c.caption, value: c.value, meta: c.meta, docText: c.doc, score: 1000 - i,
      })));
    },
  }];
  editor.setOptions({ enableBasicAutocompletion: true, enableLiveAutocompletion: true, enableSnippets: false });
}
