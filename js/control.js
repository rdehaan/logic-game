// Handles for buttons
var lock_button = document.getElementById('lock-button');
var unlock_button = document.getElementById('unlock-button');
var lock_button2 = document.getElementById('lock-button2');
var unlock_button2 = document.getElementById('unlock-button2');
var generate_button = document.getElementById('generate-button');
var clear_button = document.getElementById('clear-button');
var play_button = document.getElementById('play-button');
var pause_button = document.getElementById('pause-button');
var stop_button = document.getElementById('stop-button');
var speed_selector = document.getElementById('speed-selector');

// Moving between different states of the game engine
var speed;
function select_speed() {
  speed = speed_selector.value;
}
select_speed();
function lock_level_generation() {
  lock_button.disabled = true;
  unlock_button.disabled = false;
  lock_button2.disabled = true;
  unlock_button2.disabled = false;
  generate_button.disabled = false;
  level_gen_program.setReadOnly(true);
  visibility_program.setReadOnly(true);
}
function unlock_level_generation() {
  lock_button.disabled = false;
  unlock_button.disabled = true;
  lock_button2.disabled = false;
  unlock_button2.disabled = true;
  generate_button.disabled = true;
  clear_button.disabled = true;
  play_button.disabled = true;
  pause_button.disabled = true;
  stop_button.disabled = true;
  level_gen_program.setReadOnly(false);
  visibility_program.setReadOnly(false);
  clear_level();
  reset_debugging();
}
function clear_level() {
  level_state = "";
  level_settings = "";
  update_interface();
}
function update_interface() {
  if (level_state) {
    clear_button.disabled = false;
    play_button.disabled = false;
    var partial_game = {};
    partial_game['level_state'] = level_state;
    partial_game['level_settings'] = level_settings;
    partial_game['visibility_program'] = visibility_program.getValue();
    var game_state = generate_initial_game_state(partial_game);
    var player_input = generate_player_input(partial_game, game_state);
    show_grid(player_input + level_settings);
  } else {
    clear_button.disabled = true;
    play_button.disabled = true;
    clear_grid();
  }
}
function do_generate() {
  generate_level();
  update_interface();
}
function do_play() {
  unlock_button.disabled = true;
  unlock_button2.disabled = true;
  clear_button.disabled = true;
  generate_button.disabled = true;
  play_button.disabled = true;
  pause_button.disabled = false;
  stop_button.disabled = false;
  visibility_program.setReadOnly(true);
  nature_program.setReadOnly(true);
  goal_program.setReadOnly(true);
  player_plan_program.setReadOnly(true);
  player_move_program.setReadOnly(true);
  clearGameOutput();
  play_game();
}
function end_playing() {
  unlock_button.disabled = false;
  unlock_button2.disabled = false;
  clear_button.disabled = false;
  generate_button.disabled = false;
  play_button.disabled = false;
  pause_button.disabled = true;
  stop_button.disabled = true;
  visibility_program.setReadOnly(false);
  nature_program.setReadOnly(false);
  goal_program.setReadOnly(false);
  player_plan_program.setReadOnly(false);
  player_move_program.setReadOnly(false);
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
      update_interface();
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
  update_interface();
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
