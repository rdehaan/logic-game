// Handles for buttons
var lock_button = document.getElementById('lock-button');
var unlock_button = document.getElementById('unlock-button');
var generate_button = document.getElementById('generate-button');
var clear_button = document.getElementById('clear-button');
var play_button = document.getElementById('play-button');
var pause_button = document.getElementById('pause-button');
var stop_button = document.getElementById('stop-button');
var speed_selector = document.getElementById('speed-selector');

// Moving between different states of the game engine
var level_gen_locked = false;
var speed;
function select_speed() {
  speed = speed_selector.value;
}
select_speed();
function lock_level_generation() {
  level_gen_locked = true;
  lock_button.disabled = true;
  unlock_button.disabled = false;
  generate_button.disabled = false;
  level_gen_program.setReadOnly(true);
}
function unlock_level_generation() {
  level_gen_locked = false;
  lock_button.disabled = false;
  unlock_button.disabled = true;
  generate_button.disabled = true;
  clear_button.disabled = true;
  play_button.disabled = true;
  pause_button.disabled = true;
  stop_button.disabled = true;
  level_gen_program.setReadOnly(false);
  clear_level();
  reset_debugging();
}
function clear_level() {
  level_state = "";
  level_settings = "";
  update_interface();
  clear_grid();
}
function update_interface() {
  if (level_state) {
    clear_button.disabled = false;
    play_button.disabled = false;
  } else {
    clear_button.disabled = true;
    play_button.disabled = true;
  }
}
function do_generate2() {
  level_state = "at(1,1,player). at(5,7,flag).";
  level_settings = "setting(grid_width(8)). setting(grid_height(6)). setting(time_bound(15)). setting(col(1)). setting(col(2)). setting(col(3)). setting(col(4)). setting(col(5)). setting(col(6)). setting(col(7)). setting(col(8)). setting(row(1)). setting(row(2)). setting(row(3)). setting(row(4)). setting(row(5)). setting(row(6)). decorate(game_type,grid). decorate(label,flag,font_f024). decorate(label,player,font_f007).";
  update_interface();
  show_grid(level_state + level_settings);
}
function do_generate() {
  generate_level();
  update_interface();
  show_grid(level_state + level_settings);
}
function do_play() {
  unlock_button.disabled = true;
  clear_button.disabled = true;
  generate_button.disabled = true;
  play_button.disabled = true;
  pause_button.disabled = false;
  stop_button.disabled = false;
  clearGameOutput();
  play_game();
}
function end_playing() {
  unlock_button.disabled = false;
  clear_button.disabled = false;
  generate_button.disabled = false;
  play_button.disabled = false;
  pause_button.disabled = true;
  stop_button.disabled = true;
}
function do_pause() {
}
function do_stop() {
}
function reset_debugging() {
  clearOutput();
  clearGameOutput();
}


// Variables for generated level
var level_state = "";
var level_settings = "";

// Loading games from file
function load_game() {
  load_game_from_path(example_games.value);
  load_status.innerText = "Done loading..";
}

function load_game_from_path(path) {
  var request = new XMLHttpRequest();
  request.onreadystatechange = function() {
    if (request.readyState == 4 && request.status == 200) {
      game = JSON.parse(request.responseText.trim())
      level_gen_program.setValue(game['level_gen_program'], 1);
      visibility_program.setValue(game['visibility_program'], 1);
      player_plan_program.setValue(game['player_plan_program'], 1);
      player_move_program.setValue(game['player_move_program'], 1);
      nature_program.setValue(game['nature_program'], 1);
      goal_program.setValue(game['goal_program'], 1);
      level_state = game['level_state'];
      level_settings = game['level_settings'];
      reset_debugging();
    }
  }
  request.open("GET", path, true);
  request.send();
}

file_input = document.getElementById('file_input');
upload_status = document.getElementById('upload_status');
example_games = document.getElementById('example_games');

// Refreshing after changing tabs
function change_tabs() {
  level_gen_program.resize();
  visibility_program.resize();
  player_plan_program.resize();
  player_move_program.resize();
  nature_program.resize();
  goal_program.resize();
  upload_status.innerText = ""
  load_status.innerText = ""
}

// Loading games from upload
async function load_game_from_file(event) {
  const file = event.target.files.item(0)
  const text = await file.text();
  game = JSON.parse(text);
  level_gen_program.setValue(game['level_gen_program'], 1);
  visibility_program.setValue(game['visibility_program'], 1);
  player_plan_program.setValue(game['player_plan_program'], 1);
  player_move_program.setValue(game['player_move_program'], 1);
  nature_program.setValue(game['nature_program'], 1);
  goal_program.setValue(game['goal_program'], 1);
  level_state = game['level_state'];
  level_settings = game['level_settings'];
  upload_status.innerText = "Done loading.."
  reset_debugging();
}

// Downloading game currently in memory
function download_game() {
  var game = {}
  game['level_gen_program'] = level_gen_program.getValue();
  game['visibility_program'] = visibility_program.getValue();
  game['player_plan_program'] = player_plan_program.getValue();
  game['player_move_program'] = player_move_program.getValue();
  game['nature_program'] = nature_program.getValue();
  game['goal_program'] = goal_program.getValue();
  game['level_state'] = level_state;
  game['level_settings'] = level_settings;
  var text = JSON.stringify(game, null, 2);
  save('game.json', text)
}
function save(filename, data) {
    const blob = new Blob([data], {type: 'text/csv'});
    if(window.navigator.msSaveOrOpenBlob) {
        window.navigator.msSaveBlob(blob, filename);
    }
    else{
        const elem = window.document.createElement('a');
        elem.href = window.URL.createObjectURL(blob);
        elem.download = filename;
        document.body.appendChild(elem);
        elem.click();
        document.body.removeChild(elem);
    }
}
