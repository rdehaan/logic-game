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
  var verbose = document.getElementById("verbose").checked;

  var game_state = generate_initial_game_state(working_game);
  var player_input = generate_player_input(working_game, game_state);
  var player_memory = generate_player_plan(working_game, player_input);

  // Main loop
  var keep_going = true;
  var time_step = 0;
  var max_time = 50;

  function main_loop() {
    time_step += 1;

    // Check if game won/lost already
    game_condition = analyze_state(working_game, game_state);
    if (game_condition == "win") {
      keep_going = false;
      if (verbose) {
        addToGameOutput("## STEP " + (time_step+1) + " ##\n");
        addToGameOutput("- Player input:\n" + player_input + "\n");
        addToGameOutput("- Player memory:\n" + player_memory + "\n");
        show_grid(player_input + working_game["level_settings"]);
      }
      addToGameOutput("WIN!");
      return;
    } else if (game_condition == "lose") {
      keep_going = false;
      if (verbose) {
        addToGameOutput("## STEP " + (time_step+1) + " ##\n");
        addToGameOutput("- Player input:\n" + player_input + "\n");
        addToGameOutput("- Player memory:\n" + player_memory + "\n");
        show_grid(player_input + working_game["level_settings"]);
      }
      addToGameOutput("LOSE!");
      return;
    }

    if (verbose) {
      addToGameOutput("## STEP " + time_step + " ##\n")
      addToGameOutput("- Player input:\n" + player_input + "\n")
      addToGameOutput("- Player memory:\n" + player_memory + "\n")
      show_grid(player_input + working_game["level_settings"]);
    }

    // Check if player's program is stratified and simple
    var program_to_check = player_input + player_memory;
    program_to_check += working_game['level_settings'];
    program_to_check += working_game['player_move_program'];
    if (!check_if_stratified_and_simple(program_to_check)) {
      keep_going = false;
      addToGameOutput("LOSE! (program not simple)\n")
      return;
    }
    // Generate player moves and memory updates
    var {player_moves, memory_updates} = generate_player_move(working_game, player_input, player_memory);
    if (verbose) {
      addToGameOutput("- Player moves:\n" + player_moves + "\n")
      addToGameOutput("- Player memory updates:\n" + memory_updates + "\n")
    }
    // Update player memory
    player_memory = update_player_memory(player_memory, memory_updates);
    // Generate next state
    game_state = generate_next_state(working_game, game_state, player_moves);
    // Generate player input for next move
    player_input = generate_player_input(working_game, game_state);

    // Stop after a fixed amount of steps, to avoid (accidental) infinite loops. :)
    if (time_step > max_time) {
      keep_going = false;
      addToGameOutput("TIMEOUT!")
    }

    // Keep going as needed, with a delay
    if (keep_going) {
      setTimeout(main_loop, 500);
    }
  }
  // Start main loop
  main_loop();
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
    level_settings = filter_answer_set(answer_set, ["setting","decorate"]);
    level_settings = answer_set_to_facts(level_settings);
  } else {
    level_state = "";
    level_settings = "";
  }
}

// Generate initial game state from level state
function generate_initial_game_state(working_game) {
  program = "at_time(0,R,C,O) :- at(R,C,O).\n"
  program += working_game['level_state'];
  answer_set = get_answer_set(program);
  if (answer_set) {
    var output = filter_answer_set(answer_set, ["at_time"]);
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
  program += working_game['level_settings'];
  answer_set = get_answer_set(program);
  if (answer_set) {
    var output = filter_answer_set(answer_set, ["observe","setting"]);
    output = answer_set_to_facts(output);
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
    return output;
  } else {
    return "";
  }
}

// Generate player move
function generate_player_move(working_game, player_input, player_memory) {
  program = player_input;
  program += player_memory;
  program += working_game['player_move_program'];
  answer_set = get_answer_set(program);
  if (answer_set) {
    var player_moves = filter_answer_set(answer_set, ["do"]);
    player_moves = answer_set_to_facts(player_moves);
    var memory_updates = filter_answer_set(answer_set, ["remember","forget"]);
    memory_updates = answer_set_to_facts(memory_updates);
    return {
      player_moves: player_moves,
      memory_updates: memory_updates
    };
  } else {
    return {
      player_moves: "",
      memory_updates: ""
    };
  }
}

// Update player memory
function update_player_memory(player_memory, memory_updates) {
  if (!memory_updates) {
    return player_memory;
  }
  program = "new_memory(X) :- memory(X), not forget(X).\n"
  program += "new_memory(X) :- remember(X).\n"
  program += player_memory;
  program += memory_updates;
  answer_set = get_answer_set(program);
  if (answer_set) {
    var intermediate = filter_answer_set(answer_set, ["plan","new_memory"]);
    intermediate = answer_set_to_facts(intermediate);
  } else {
    return player_memory;
  }
  program = "memory(X) :- new_memory(X).\n";
  program += intermediate;
  answer_set = get_answer_set(program);
  if (answer_set) {
    var output = filter_answer_set(answer_set, ["plan","memory"]);
    output = answer_set_to_facts(output);
  } else {
    return player_memory;
  }
  return output;
}

// Generate next state
function generate_next_state(working_game, game_state, player_moves) {

  // Generate 'nexts'
  program = "current_time(T) :- T = #max { S : at_time(S,_,_,_) }.\n"
  program += "at(R,C,O) :- at_time(T,R,C,O), current_time(T).\n"
  program += game_state;
  program += player_moves;
  program += working_game['nature_program'];
  program += working_game['level_settings'];
  answer_set = get_answer_set(program);
  var nexts = null;
  if (answer_set) {
    nexts = filter_answer_set(answer_set, ["next","current_time"]);
    nexts = answer_set_to_facts(nexts);
  }

  // Generate trivial 'nexts' if needed
  if (!nexts) {
    program = "current_time(T) :- T = #max { S : at_time(S,_,_,_) }.\n"
    program += "at(R,C,O) :- at_time(T,R,C,O), current_time(T).\n"
    program += "next(R,C,O) :- at(R,C,O).\n"
    program += game_state;
    answer_set = get_answer_set(program);
    if (answer_set) {
      nexts = filter_answer_set(answer_set, ["next","current_time"]);
      nexts = answer_set_to_facts(nexts);
    }
  }

  // Generate next state based on 'nexts'
  program = "at_time(T+1,R,C,O) :- next(R,C,O), current_time(T).\n"
  program += game_state;
  program += nexts;
  answer_set = get_answer_set(program);
  if (answer_set) {
    var output = filter_answer_set(answer_set, ["at_time","win","lose"]);
    output = answer_set_to_facts(output);
  }

  return output;
}

// Analyze state for win/lose conditions
function analyze_state(working_game, game_state) {
  program = "current_time(T) :- T = #max { S : at_time(S,_,_,_) }.\n"
  program += "at(R,C,O) :- at_time(T,R,C,O), current_time(T).\n"
  program += game_state;
  program += working_game['level_settings'];
  program += working_game['goal_program'];
  answer_set = get_answer_set(program);
  if (answer_set) {
    var loses = filter_answer_set(answer_set, ["lose"]);
    if (loses.length > 0) {
      return "lose";
    }
    var wins = filter_answer_set(answer_set, ["win"]);
    if (wins.length > 0) {
      return "win";
    }
  }
  return "";
}

function reset_debugging() {
  clearOutput();
  clearGameOutput();
  if (level_state) {
    addToGameOutput("## LEVEL PRESENT ##\n");
  } else {
    addToGameOutput("## NO LEVEL YET ##\n");
  }
}
