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

  var labels = {};
  matches = answer_set.matchAll(/decorate\(label,(\w+),(\w+)\)/g);
  for (const match of matches) {
    item = match[1];
    label = match[2];
    labels[item] = label;
  }
  grid_ds["labels"] = labels;

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

    div.style.setProperty("--font-size", "2vw");
    var items = grid_ds[num].toSorted();
    var html = '<span>';
    for (const item of items) {
      label = grid_ds["labels"][item]
      if (label) {
        if (label.match(/font_(\w+)/)) {
          label = label.replace(/font_(\w+)/, "$1");
          label = String.fromCharCode(parseInt(label,16))
        }
        html += label;
      } else {
        html += "?";
      }
    }
    html += '</span>';
    div.innerHTML = html;
  }
}

// Wrapper
function show_grid(answer_set) {
  visualize_grid(compute_grid_ds(answer_set));
}

// Test it..
answer_set = `
observe(at(5,7,flag)) observe(at(1,1,player)) observe(at(1,1,woo)) observe(fog(2,3))  setting(grid_width(8)) setting(grid_height(6)) setting(time_bound(15)) setting(col(1)) setting(col(2)) setting(col(3)) setting(col(4)) setting(col(5)) setting(col(6)) setting(col(7)) setting(col(8)) setting(row(1)) setting(row(2)) setting(row(3)) setting(row(4)) setting(row(5)) setting(row(6)) decorate(game_type,grid) decorate(label,flag,font_f024) decorate(label,woo,font_f085) decorate(label,player,font_f007)
`
grid_ds = compute_grid_ds(answer_set);
visualize_grid(grid_ds);
