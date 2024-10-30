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

// Generate the level
function generate_level() {
  program = level_gen_program.getValue();
  preprocessed = program.replace(/RANDINT(\d+,\d+)/g, "asdf");
  console.log(preprocessed);
  // TODO: preprocess_program
  answer_set = get_answer_set(program);
  if (answer_set) {
    level_state = filter_answer_set(answer_set, ["at"]);
    level_settings = filter_answer_set(answer_set, ["setting", "decorate"]);
  } else {
    level_state = "";
    level_settings = "";
  }
}
