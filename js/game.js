// Control variables for main playing loop
var working_game = {}
var keep_going = true;
var time_step = 0;
var max_time = 500;
var game_state = null;
var player_input = "";
var player_decorations = "";
var player_memory = "";
var verbose = true;
var player_problems = "";

// Rules that give the current time and the current state of the game
// (as atoms over 'at') from the game state
var CURRENT_STATE_RULES =
  "current_time(T) :- T = #max { S : state_time(S) }.\n" +
  "at(R,C,O) :- at_time(T,R,C,O), current_time(T).\n";

// Glue programs together, separated by newlines (so that a comment on the
// last line of one program does not swallow the start of the next one)
function join_programs(...parts) {
  return parts.join("\n");
}

// Run the game
function play_game() {

  if (!game_paused) {
    // Store the current level/game
    working_game['aux_program'] = aux_program.getValue();
    working_game['level_gen_program'] = level_gen_program.getValue();
    working_game['visibility_program'] = visibility_program.getValue();
    working_game['player_move_program'] = player_move_program.getValue();
    working_game['nature_program'] = nature_program.getValue();
    working_game['goal_program'] = goal_program.getValue();
    working_game['level_state'] = level_state.getValue();
    working_game['level_settings'] = level_settings.getValue();
    var verbose_checkbox = document.getElementById("verbose");
    verbose = true;
    if(typeof verbose_checkbox !== 'undefined' && verbose_checkbox !== null) {
      verbose = verbose_checkbox.checked;
    }

    var initial = generate_initial_game_state(working_game);
    game_state = initial.game_state;
    if (initial.problem) {
      addToGameOutput("- Level state: " + initial.problem + "\n");
    }
    var visibility_output = generate_player_input(working_game, game_state);
    player_input = visibility_output.player_input;
    player_decorations = visibility_output.decorations;
    player_problems = problem_line("Visibility program", visibility_output.problem,
      "player observes nothing");
    player_memory = "";

    // Initialize variables for main loop
    keep_going = true;
    time_step = 0;
  } else {
    game_paused = false;
  }

  function main_loop() {
    time_step += 1;

    // The report for this step: the regular lines are only shown when
    // verbose, problems (fallbacks and errors) are always shown
    var report = "";
    function report_line(label, facts) {
      if (verbose) {
        report += "- " + label + ":\n" + facts + "\n";
      }
    }
    if (verbose) {
      report += "## STEP " + time_step + " ##\n";
    }
    report_line("Player input", player_input);
    report_line("Player memory", player_memory);
    report += player_problems;

    show_grid(player_input + player_decorations + working_game["level_settings"]);

    // Check if game won/lost already
    var condition = analyze_state(working_game, game_state);
    report += problem_line("Winning conditions", condition.problem, "game continues");
    if (condition.verdict == "win" || condition.verdict == "lose") {
      keep_going = false;
      addToGameOutput(report);
      addToGameOutput(condition.verdict.toUpperCase() + "! (" + condition.atoms.join(", ") + ")\n");
      if (condition.verdict == "win") {
        display_win();
      } else {
        display_lose();
      }
      end_playing();
      return;
    }

    // Stop after a fixed amount of steps, to avoid (accidental) infinite loops. :)
    if (time_step > max_time) {
      keep_going = false;
      addToGameOutput(report);
      addToGameOutput("TIMEOUT! (the engine stops games after " + max_time + " steps)\n");
      display_lose();
      end_playing();
      return;
    }

    // // Check if player's program is stratified and simple
    // var program_to_check = player_input + player_memory;
    // program_to_check += working_game['level_settings'];
    // program_to_check += working_game['player_move_program'];
    // if (!check_if_stratified_and_simple(program_to_check)) {
    //   keep_going = false;
    //   addToGameOutput(report);
    //   addToGameOutput("LOSE! (program not simple)\n")
    //   display_lose();
    //   end_playing();
    //   return;
    // }

    // Generate player moves and memory updates
    var move = generate_player_move(working_game, player_input, player_memory);
    report_line("Player moves", move.player_moves);
    report_line("Memory updates", move.memory_updates);
    report += problem_line("Player program", move.problem,
      "no moves, memory unchanged");
    // Update player memory
    player_memory = update_player_memory(player_memory, move.memory_updates);
    // Generate next state
    var nature = generate_next_state(working_game, game_state, move.player_moves);
    game_state = nature.next_state;
    report_line("Next state (from nature)", nature.nexts);
    report += problem_line("Nature program", nature.problem, "state unchanged");
    // Wipe the player's memory if nature says so
    if (nature.wipe_memory) {
      player_memory = "";
      report += "- Player memory wiped by nature\n";
    }
    // Generate player input for next move
    var visibility_output = generate_player_input(working_game, game_state);
    player_input = visibility_output.player_input;
    player_decorations = visibility_output.decorations;
    player_problems = problem_line("Visibility program", visibility_output.problem,
      "player observes nothing");

    if (report) {
      addToGameOutput(report);
    }

    // Keep going as needed, with a delay
    if (stop_playing) {
      end_playing();
      reset_debugging();
      return;
    }
    if (game_paused) {
      play_button.disabled = false;
    }
    if (keep_going && !game_paused) {
      setTimeout(main_loop, speed);
    }
  }
  // Start main loop
  main_loop();
}

// Line for the game output reporting that a program fell back
// (no answer set or an error), or "" if there was no problem
function problem_line(program_name, problem, consequence) {
  if (!problem) {
    return "";
  }
  return "- " + program_name + ": " + problem + "\n  (" + consequence + ")\n";
}

// Generate random integer in given range
function randint(min, max) {
  return Math.floor(Math.random() * (max - min) ) + min;
}

// Preprocess programs
function preprocess_program(program) {
  // Evaluate 'RANDINT(l,u)' commands in program
  return program.replace(/RANDINT\(\s*(-?\d+)\s*,\s*(-?\d+)\s*\)/g,
    (match, l, u) => randint(Number(l), Number(u) + 1).toString());
}

// Generate the level
function generate_level() {
  // Take level generation program
  program = level_gen_program.getValue();

  // Preprocess it
  program = preprocess_program(program);

  program = join_programs(program, aux_program.getValue());

  // Find answer set, and split into two sets of facts
  answer_set = get_answer_set(program);
  if (answer_set) {
    var generated_state = filter_answer_set(answer_set, ["at", "debug"]);
    generated_state = answer_set_to_facts(generated_state);
    generated_state = generated_state.replace(/\. /g, ".\n");
    level_state.setValue(generated_state, 1);
    var generated_settings = filter_answer_set(answer_set, ["setting","decorate"]);
    generated_settings = answer_set_to_facts(generated_settings);
    generated_settings = generated_settings.replace(/\. /g, ".\n");
    level_settings.setValue(generated_settings, 1);
  } else {
    var problem = describe_failure();
    level_state.setValue("", 1);
    level_settings.setValue("", 1);
  }

  reset_debugging();
  if (!answer_set) {
    addToGameOutput("Level generation: " + problem + "\n  (no level generated)\n");
  }
}

// Generate initial game state from level state
function generate_initial_game_state(working_game) {
  program = join_programs(
    "at_time(0,R,C,O) :- at(R,C,O).",
    "state_time(0).",
    working_game['level_state']
  );
  answer_set = get_answer_set(program);
  if (answer_set) {
    var output = filter_answer_set(answer_set, ["at_time","state_time"]);
    return {
      game_state: answer_set_to_facts(output),
      problem: null
    };
  } else {
    return {
      game_state: "",
      problem: describe_failure()
    };
  }
}

// Generate player input from game state
function generate_player_input(working_game, game_state) {
  program = join_programs(
    CURRENT_STATE_RULES,
    game_state,
    working_game['visibility_program'],
    working_game['level_settings'],
    working_game['aux_program']
  );
  answer_set = get_answer_set(program);
  if (answer_set) {
    // What the player gets to see (passed on to the player's program)
    var output = filter_answer_set(answer_set, ["observe","setting","current_time"]);
    output = answer_set_to_facts(output);
    // What is only used for visualization (never passed on to the player)
    var decorations = filter_answer_set(answer_set, ["decorate"]);
    decorations = answer_set_to_facts(decorations);
    return {
      player_input: output,
      decorations: decorations,
      problem: null
    };
  } else {
    return {
      player_input: "",
      decorations: "",
      problem: describe_failure()
    };
  }
}

// Generate player move
function generate_player_move(working_game, player_input, player_memory) {
  program = join_programs(
    player_input,
    player_memory,
    working_game['aux_program'],
    preprocess_program(working_game['player_move_program'])
  );
  answer_set = get_answer_set(program);
  if (answer_set) {
    var player_moves = filter_answer_set(answer_set, ["do"]);
    player_moves = answer_set_to_facts(player_moves);
    var memory_updates = filter_answer_set(answer_set, ["remember","forget"]);
    memory_updates = answer_set_to_facts(memory_updates);
    return {
      player_moves: player_moves,
      memory_updates: memory_updates,
      problem: null
    };
  } else {
    return {
      player_moves: "",
      memory_updates: "",
      problem: describe_failure()
    };
  }
}

// Update player memory
function update_player_memory(player_memory, memory_updates) {
  if (!memory_updates) {
    return player_memory;
  }
  program = join_programs(
    "new_memory(X) :- memory(X), not forget(X).",
    "new_memory(X) :- remember(X).",
    player_memory,
    memory_updates
  );
  answer_set = get_answer_set(program);
  if (answer_set) {
    var intermediate = filter_answer_set(answer_set, ["new_memory"]);
    intermediate = answer_set_to_facts(intermediate);
  } else {
    return player_memory;
  }
  program = join_programs("memory(X) :- new_memory(X).", intermediate);
  answer_set = get_answer_set(program);
  if (answer_set) {
    var output = filter_answer_set(answer_set, ["memory"]);
    output = answer_set_to_facts(output);
  } else {
    return player_memory;
  }
  return output;
}

// Generate next state
function generate_next_state(working_game, game_state, player_moves) {

  // Generate 'nexts'
  program = join_programs(
    CURRENT_STATE_RULES,
    game_state,
    player_moves,
    preprocess_program(working_game['nature_program']),
    working_game['level_settings'],
    working_game['aux_program']
  );
  answer_set = get_answer_set(program);
  var nexts = null;
  var wipe_memory = false;
  var problem = null;
  if (answer_set) {
    nexts = filter_answer_set(answer_set, ["next","current_time"]);
    nexts = answer_set_to_facts(nexts);
    // Check whether nature wipes the player's memory
    wipe_memory = filter_answer_set(answer_set, ["wipe_player_memory"]).length > 0;
  } else {
    problem = describe_failure();
  }

  // Generate trivial 'nexts' if needed
  if (!nexts) {
    program = join_programs(
      CURRENT_STATE_RULES,
      "next(R,C,O) :- at(R,C,O).",
      game_state
    );
    answer_set = get_answer_set(program);
    if (answer_set) {
      nexts = filter_answer_set(answer_set, ["next","current_time"]);
      nexts = answer_set_to_facts(nexts);
    }
  }

  // Generate next state based on 'nexts'
  // (the time always advances, even if there are no 'nexts')
  program = join_programs(
    "at_time(T+1,R,C,O) :- next(R,C,O), current_time(T).",
    "state_time(T+1) :- current_time(T).",
    game_state,
    nexts
  );
  answer_set = get_answer_set(program);
  var output = "";
  var next_atoms = "";
  if (answer_set) {
    output = filter_answer_set(answer_set, ["at_time","state_time"]);
    output = answer_set_to_facts(output);
    // The 'nexts' themselves (for the game output)
    next_atoms = answer_set_to_facts(filter_answer_set(answer_set, ["next"]));
  }

  return {
    next_state: output,
    nexts: next_atoms,
    wipe_memory: wipe_memory,
    problem: problem
  };
}

// Analyze state for win/lose conditions
function analyze_state(working_game, game_state) {
  program = join_programs(
    CURRENT_STATE_RULES,
    game_state,
    working_game['level_settings'],
    working_game['aux_program'],
    working_game['goal_program']
  );
  answer_set = get_answer_set(program);
  if (answer_set) {
    var loses = filter_answer_set(answer_set, ["lose"]);
    if (loses.length > 0) {
      return { verdict: "lose", atoms: loses, problem: null };
    }
    var wins = filter_answer_set(answer_set, ["win"]);
    if (wins.length > 0) {
      return { verdict: "win", atoms: wins, problem: null };
    }
    return { verdict: "", atoms: [], problem: null };
  }
  return { verdict: "", atoms: [], problem: describe_failure() };
}
