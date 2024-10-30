// Run the game
function play_game() {
  // Store the current level/game
  var working_game = {}
  working_game['level_gen_program'] = level_gen_program.getValue();
  working_game['visibility_program'] = visibility_program.getValue();
  working_game['player_plan_program'] = player_plan_program.getValue();
  working_game['player_move_program'] = player_move_program.getValue();
  working_game['nature_program'] = nature_program.getValue();
  working_game['goal_program'] = goal_program.getValue();
  working_game['level_state'] = level_state;
  working_game['level_settings'] = level_settings;

  var game_state = generate_initial_game_state(working_game);
  var player_input = generate_player_input(working_game, game_state);
  var player_memory = generate_player_plan(working_game, player_input);

  // Main loop
  var keep_going = true;
  var time_step = 0;
  var max_time = 20;
  while (keep_going) {
    time_step += 1;
    // Generate player's input for next move
    if (time_step > 1) {
      player_input = generate_player_input(working_game, game_state);
    }
    // Check if player's program is stratified and simple
    var program_to_check = player_input + player_memory;
    program_to_check += working_game['level_settings'];
    program_to_check += working_game['player_move_program'];
    if (!check_if_stratified_and_simple(program_to_check)) {
      keep_going = false;
      addToGameOutput("PROGRAM TOO COMPLICATED..\n")
      break;
    }
    // Generate player moves and memory updates
    var {moves, memory_updates} = generate_player_move(working_game, player_input);
  }
}

// Generate random integer in given range
function randint(min, max) {
  return Math.floor(Math.random() * (max - min) ) + min;
}

// Generate the level
function generate_level() {
  // Take level generation program
  program = level_gen_program.getValue();

  // Evaluate 'RANDINT(x,y)' commands in program
  preprocessed = program.replace(/RANDINT\((\d+),(\d+)\)/g, "RANDOM$1,$2RANDOM");
  parts = preprocessed.split("RANDOM");
  for (let i = 0; i < parts.length; i++) {
    if (i % 2 == 1) {
      nums = parts[i].split(",");
      random_int = randint(Number(nums[0]),Number(nums[1]));
      parts[i] = random_int.toString();
    }
  }
  program = parts.join('')

  // Find answer set, and split into two sets of facts
  answer_set = get_answer_set(program);
  if (answer_set) {
    level_state = filter_answer_set(answer_set, ["at"]);
    level_state = answer_set_to_facts(level_state);
    level_settings = filter_answer_set(answer_set, ["setting", "decorate"]);
    level_settings = answer_set_to_facts(level_settings);
  } else {
    level_state = "";
    level_settings = "";
  }

  addToGameOutput("Level state:\n" + level_state + "\n")
  addToGameOutput("Level settings:\n" + level_settings + "\n")
}

// Generate initial game state from level state
function generate_initial_game_state(working_game) {
  program = "at_time(0,R,C,O) :- at(R,C,O).\n"
  program += working_game['level_state'];
  answer_set = get_answer_set(program);
  if (answer_set) {
    var output = filter_answer_set(answer_set, ["at_time"]);
    addToGameOutput("Initial state:\n" + answer_set_to_facts(output) + "\n")
    return answer_set_to_facts(output);
  } else {
    return "";
  }
}

// Generate player input from game state
function generate_player_input(working_game, game_state) {
  program = "current_time(T) :- T = #max { S : at_time(S,_,_,_) }.\n"
  program += "at(R,C,O) :- at_time(T,R,C,O), current_time(T).\n"
  program += "observe(at(R,C,O)) :- at(R,C,O), observe(at(R,C,O)).\n"
  program += game_state;
  program += working_game['visibility_program'];
  answer_set = get_answer_set(program);
  if (answer_set) {
    var output = filter_answer_set(answer_set, ["observe"]);
    output = answer_set_to_facts(output);
    addToGameOutput("Player input:\n" + output + "\n")
    return output;
  } else {
    return "";
  }
}

// Generate player plan from (initial) observable state
function generate_player_plan(working_game, player_input) {
  program = player_input;
  program += working_game['level_settings'];
  program += working_game['player_plan_program'];
  answer_set = get_answer_set(program);
  if (answer_set) {
    var output = filter_answer_set(answer_set, ["plan"]);
    output = answer_set_to_facts(output);
    addToGameOutput("Player plan:\n" + output + "\n")
    return output;
  } else {
    return "";
  }
}

// Generate player move
function generate_player_move(working_game, player_input) {
  program = player_input;
  program += working_game['player_move_program'];
  answer_set = get_answer_set(program);
  if (answer_set) {
    var moves = filter_answer_set(answer_set, ["do"]);
    moves = answer_set_to_facts(moves);
    addToGameOutput("Player moves:\n" + moves + "\n")
    var memory_updates = filter_answer_set(answer_set, ["remember","forget"]);
    memory_updates = answer_set_to_facts(memory_updates);
    addToGameOutput("Player memory updates:\n" + memory_updates + "\n")
    return {
      moves: moves,
      memory_updates: memory_updates
    };
  } else {
    return {
      moves: "",
      memory_updates: ""
    };
  }
}
