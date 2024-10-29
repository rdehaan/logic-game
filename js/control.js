// Variables for generated level
var level_state = "";
var level_settings = "";

// Loading games from file
function load_game() {
  load_game_from_path(example_games.value);
  load_status.innerText = "Loading successful.."
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
  upload_status.innerText = "Loading successful.."
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

// load_game_from_path('examples/flag1.json');
