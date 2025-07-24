// Initialize a grid data structure
function init_grid_ds(height, width) {
  grid_ds = {};
  grid_ds["height"] = height;
  grid_ds["width"] = width;
  for (let row=1; row <= height; row++) {
    for (let col=1; col <= width; col++) {
      num = coord_to_num(height, width, row, col);
      grid_ds[num] = [];
    }
  }
  return grid_ds;
}

// Auxiliary function to parse an atom into its elements
function flatparse_atom(atom) {

  var bracket_count = 0;
  var cur_substr_init = 0;
  var elements = Array();
  for (let i = 0; i < atom.length; i++) {
    if (atom[i] == "(") {
      if (bracket_count == 0) {
        elements.push(atom.substring(cur_substr_init, i));
        cur_substr_init = i+1;
      }
      bracket_count += 1;
    } else if (atom[i] == ")") {
      if (bracket_count == 1) {
        elements.push(atom.substring(cur_substr_init, i));
        cur_substr_init = i+1;
      }
      if (bracket_count != 0) {
        bracket_count -= 1;
      }
    } else if (atom[i] == ",") {
      console.log(i)
      if (bracket_count == 1) {
        elements.push(atom.substring(cur_substr_init, i));
        cur_substr_init = i+1;
      }
    }
  }
  return elements;
}

// Auxiliary function to split an answer set (string) into its atoms
function split_answer_set(answer_set) {

  var bracket_count = 0;
  var cur_substr_init = 0;
  var elements = Array();
  for (let i = 0; i < answer_set.length; i++) {
    if (answer_set[i] == "(") {
      bracket_count += 1;
    } else if (answer_set[i] == ")") {
      if (bracket_count != 0) {
        bracket_count -= 1;
      }
    } else if (answer_set[i] == ".") {
      elements.push(answer_set.substring(cur_substr_init, i));
      cur_substr_init = i+1;
    } else if (answer_set[i] == " ") {
      if (i > cur_substr_init) {
        elements.push(answer_set.substring(cur_substr_init, i));
      }
      cur_substr_init = i+1;
    }
  }
  if (answer_set.length > cur_substr_init) {
    elements.push(answer_set.substring(cur_substr_init, answer_set.length));
  }
  return elements;
}

// Auxiliary function to filter atoms from answer set
function get_atoms_beginning_with(answer_set, prefix) {

  var selected_atoms = Array();
  var atoms = split_answer_set(answer_set)
  for (index in atoms) {
    if (atoms[index].startsWith(prefix)) {
      selected_atoms.push(atoms[index]);
    }
  }
  return selected_atoms;
}

// Compute a grid data structure from an answer set
function compute_grid_ds(answer_set) {

  var matches;
  var atoms;
  // match = answer_set.match(/setting\(grid_height\((\d+)\)\)/);
  // var height = Number(match[1]);
  // match = answer_set.match(/setting\(grid_width\((\d+)\)\)/);
  // var width = Number(match[1]);
  matches = get_atoms_beginning_with(answer_set, "setting(grid_height(");
  var height = Number(flatparse_atom(flatparse_atom(matches[0])[1])[1]);
  matches = get_atoms_beginning_with(answer_set, "setting(grid_width(");
  var width = Number(flatparse_atom(flatparse_atom(matches[0])[1])[1]);

  var grid_ds = {};
  var fog = {};
  grid_ds["height"] = height;
  grid_ds["width"] = width;
  for (let row=1; row <= height; row++) {
    for (let col=1; col <= width; col++) {
      num = coord_to_num(height, width, row, col);
      grid_ds[num] = [];
      fog[num] = false;
    }
  }

  // matches = answer_set.matchAll(/observe\(at\((\d+),(\d+),(\w+)\)\)/g);
  atoms = get_atoms_beginning_with(answer_set, "observe(at(");
  for (const atom of atoms) {
    match = flatparse_atom(flatparse_atom(atom)[1])
    row = Number(match[1]);
    col = Number(match[2]);
    num = coord_to_num(height, width, row, col);
    item = match[3];
    grid_ds[num].push(item);
  }

  matches = answer_set.matchAll(/observe\(fog\((\w+),(\w+)\)\)/g);
  for (const match of matches) {
    row = Number(match[1]);
    col = Number(match[2]);
    num = coord_to_num(height, width, row, col);
    fog[num] = true;
  }
  grid_ds["fog"] = fog;

  var bg = {};
  matches = answer_set.matchAll(/decorate\(bgcolor,(\w+),(\w+),(\w+)\)/g);
  for (const match of matches) {
    row = Number(match[1]);
    col = Number(match[2]);
    color = match[3];
    num = coord_to_num(height, width, row, col);
    bg[num] = color;
  }
  grid_ds["bg"] = bg;

  var labels = {};
  matches = answer_set.matchAll(/decorate\(label,(\w+),(\w+)\)/g);
  for (const match of matches) {
    item = match[1];
    label = match[2];
    labels[item] = label;
  }
  grid_ds["labels"] = labels;

  var colors = {};
  matches = answer_set.matchAll(/decorate\(color,(\w+),(\w+)\)/g);
  for (const match of matches) {
    item = match[1];
    color = match[2];
    colors[item] = color;
  }
  grid_ds["colors"] = colors;

  console.log(grid_ds);
  return grid_ds;
}

// Auxiliary functions
function coord_to_num(height, width, row, col) {
  return (row-1)*width + col;
}
function num_to_row(height, width, num) {
  return Math.floor((num-1)/width)+1;
}
function num_to_col(height, width, num) {
  return (num-1) % width + 1;
}

// Visualize the grid
function visualize_grid(grid_ds) {
  var visual_elem = document.getElementById("visual");
  visual_elem.innerHTML = '';
  visual_elem.className = 'grid-visual';

  let height = grid_ds["height"];
  let width = grid_ds["width"];
  let num_cells = height * width;

  visual_elem.style.setProperty("--num-cols", width);
  visual_elem.style.setProperty("--num-rows", height);
  visual_elem.style.setProperty("border", "1px solid #000");
  visual_elem.style.setProperty("width", "80%");

  ratio = width/height;
  visual_elem.style.setProperty("aspect-ratio", ratio);

  for (let num = 1; num <= num_cells ; num++) {
    var div = document.createElement("div");
    div.className = 'grid-visual-cell';
    visual_elem.appendChild(div);

    if (grid_ds["fog"][num]) {
      div.style.setProperty("background-color", "#ddd");
    }
    var bgcolor = grid_ds["bg"][num];
    if (bgcolor) {
      if (bgcolor.match(/^hex_[0-9a-fA-F]+$/)) {
        bgcolor = bgcolor.replace(/hex_(\w+)/, "$1");
        bgcolor = "#" + bgcolor;
      }
      div.style.setProperty("background-color", bgcolor);
    }

    var font_size = (20 / height);
    if (font_size > 2.5) {
      font_size = 2.5;
    }
    div.style.setProperty("--font-size", font_size + "vw");
    var items = grid_ds[num].toSorted();
    var html = "<div>";
    for (const item of items) {
      label = grid_ds["labels"][item];
      color = grid_ds["colors"][item];
      var label_html = "?"
      if (label) {
        if (label.match(/font_(\w+)/)) {
          label = label.replace(/font_(\w+)/, "$1");
          label = String.fromCharCode(parseInt(label,16))
        }
        label_html = label;
        if (label == "empty") {
          label_html = "";
        }
      }
      if (!color) {
        html += "<span>" + label_html + "</span>";
      } else {
        html += "<span style='";
        if (color) {
          if (color.match(/^hex_[0-9a-fA-F]+$/)) {
            color = color.replace(/hex_(\w+)/, "$1");
            color = "#" + color;
          }
          html += "color: " + color + "; ";
        }
        html += "'>" + label_html + "</span>";
      }
    }
    html += '</div>';
    div.innerHTML = html;
  }
}

// Visual effects for when a game is won
function display_win() {
  var visual_elem = document.getElementById("visual");
  visual_elem.style.setProperty("border", "3px solid #AADB1E");
}
// Visual effects for when a game is lost
function display_lose() {
  var visual_elem = document.getElementById("visual");
  visual_elem.style.setProperty("border", "3px solid #E10600");
}

// Wrapper
function show_grid(answer_set) {
  visualize_grid(compute_grid_ds(answer_set));
}
function clear_grid() {
  var visual_elem = document.getElementById("visual");
  visual_elem.innerHTML = '';
  visual_elem.className = '';
  visual_elem.style.setProperty("width", "0");
  visual_elem.style.setProperty("border", "0px solid #000");
}
