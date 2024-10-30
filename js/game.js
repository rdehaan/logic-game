// Run the game
function play_game() {
  // Store the current level/game
  working_game = {}
  working_game['level_gen_program'] = level_gen_program.getValue();
  working_game['visibility_program'] = visibility_program.getValue();
  working_game['player_plan_program'] = player_plan_program.getValue();
  working_game['player_move_program'] = player_move_program.getValue();
  working_game['nature_program'] = nature_program.getValue();
  working_game['goal_program'] = goal_program.getValue();
  working_game['level_state'] = level_state;
  working_game['level_settings'] = level_settings;

  console.log(working_game);
}

function randint(min, max) {
  return Math.floor(Math.random() * (max - min) ) + min;
}

// Generate the level
function generate_level() {
  program = level_gen_program.getValue();
  preprocessed = program.replace(/RANDINT\((\d+),(\d+)\)/g, "RANDOMa$1,b$2RANDOM");
  parts = preprocessed.split("RANDOM");
  for (let i = 0; i < parts.length; i++) {
    if (i % 2 == 0) {
      nums = parts[i].split(",");
      random_int = randint(nums[0],nums[1]);
      parts[i] = random_int.toString();
    }
  }
  program = parts.join('')
  console.log(program);

  answer_set = get_answer_set(preprocessed);
  if (answer_set) {
    level_state = filter_answer_set(answer_set, ["at"]);
    level_settings = filter_answer_set(answer_set, ["setting", "decorate"]);
  } else {
    level_state = "";
    level_settings = "";
  }
}
