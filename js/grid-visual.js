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

// Compute a grid data structure from an answer set
function compute_grid_ds(answer_set) {

  var match;
  match = answer_set.match(/setting\(grid_height\((\d+)\)\)/);
  var height = Number(match[1]);
  match = answer_set.match(/setting\(grid_width\((\d+)\)\)/);
  var width = Number(match[1]);

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

  matches = answer_set.matchAll(/observe\(at\((\d+),(\d+),(\w+)\)\)/g);
  for (const match of matches) {
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
      if (bgcolor.match(/^[0-9a-fA-F]+$/) &&
          (bgcolor.length == 3 || bgcolor.length == 6)) {
        bgcolor = "#" + bgcolor;
      }
      div.style.setProperty("background-color", bgcolor);
    }

    var font_size = (20 / height);
    if (font_size < 2.5) {
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
          if (color.match(/^[0-9a-fA-F]+$/) &&
              (color.length == 3 || color.length == 6)) {
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
