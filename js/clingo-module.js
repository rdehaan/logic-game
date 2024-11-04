var ClingoModule = {};

// Load some pre-stored programs
var stored_programs = {}
function save_stored_program(name, program) {
    stored_programs[name] = program;
}
function load_named_program(name, path) {
    var request = new XMLHttpRequest();
    request.onreadystatechange = function() {
      if (request.readyState == 4 && request.status == 200) {
        program = request.responseText.trim()
        save_stored_program(name, program);
      }
    }
    request.open("GET", path, true);
    request.send();
}
load_named_program("stratified", "stored/stratified.lp")

// Infrastructure for clingo output
var output_elem = document.getElementById('clingo-output');
var output = "";
function clearOutput() {
  output = "";
  updateOutput();
}
function addToOutput(text) {
  if (output == "") {
      output += text;
  } else {
      output += "\n" + text;
  }
  updateOutput();
}
function updateOutput() {
  if (output_elem) {
    output_elem.textContent = output;
    // outputElement.scrollTop = outputElement.scrollHeight; // focus on bottom
  }
}

// Infrastructure for game output
var game_output_elem = document.getElementById('game-output');
var game_output = "";
function clearGameOutput() {
  game_output = "";
  updateGameOutput();
}
function addToGameOutput(text) {
  if (game_output == "") {
      game_output += text;
  } else {
      game_output = text + "\n" + game_output;
  }
  updateGameOutput();
}
function updateGameOutput() {
  if (game_output_elem) {
    game_output_elem.textContent = game_output;
    // outputElement.scrollTop = outputElement.scrollHeight; // focus on bottom
  }
}

// Clingo solving (1)
function get_answer_set(program) {
  clearOutput();
  options = "-n1 -Wnone --heuristic=Domain";
  constructed_answer_set = null;
  ClingoModule.ccall('run', 'number', ['string', 'string'], [program, options])
  if (constructed_answer_set || constructed_answer_set === "") {
    return constructed_answer_set.split(" ");
  } else {
    return null
  }
}

// Clingo reifying
function get_reified_program(program) {
  clearOutput();
  options = "--output=reify --reify-sccs -Wnone";
  start_reifying();
  ClingoModule.ccall('run', 'number', ['string', 'string'], [program, options])
  end_reifying();
  return reified_program;
}

// Keep only some predicate names in an answer set
function filter_answer_set(answer_set, pred_names) {
  function keep(atom) {
    for (let i = 0; i < pred_names.length; i++) {
      if (atom == pred_names[i] || atom.startsWith(pred_names[i]+"(")) {
        return true
      }
    }
    return false
  }
  return answer_set.filter(keep);
}

// Write answer set as program of facts
function answer_set_to_facts(answer_set) {
  if (answer_set.length > 0) {
    return answer_set.join(". ") + "."
  }
  return ""
}

// Clingo solving
// function solve() {
//
//   // clearOutput();
//   // clearGameOutput();
//   //
//   // program = "num(1..3).\n{ foo(X) : num(X) }.\n:- not foo(1).\n"
//   // answer_set = get_answer_set(program);
//   // if (answer_set) {
//   //   answer_set = filter_answer_set(answer_set, ["foo", "bar"]);
//   //   var text = answer_set_to_facts(answer_set);
//   //   addToGameOutput(text);
//   // } else {
//   //   addToGameOutput("(none)");
//   // }
//   //
//   // addToOutput("");
//   // addToGameOutput("");
//   //
//   // program = "num(1..3).\n{ foo(X) : num(X) }.\n:- num(1).\n"
//   // answer_set = get_answer_set(program);
//   // if (answer_set) {
//   //   answer_set = filter_answer_set(answer_set, ["foo", "bar"]);
//   //   var text = answer_set_to_facts(answer_set);
//   //   addToGameOutput(text);
//   // } else {
//   //   addToGameOutput("(none)");
//   // }
//   //
//   // addToOutput("");
//   // addToGameOutput("");
//   //
//   // new_program = get_reified_program(program);
//   // if (new_program) {
//   //   addToGameOutput(new_program);
//   // } else {
//   //   addToGameOutput("(none)");
//   // }
//   //
//   // updateOutput();
//   // updateGameOutput();
//
//   // document.getElementById("run").disabled = false;
//
//   clearOutput();
//   clearGameOutput();
//   generate_level();
//   play_game();
//
// }

var next_line_will_be_answer_set = false;
var constructed_answer_set = null;
var currently_reifying = false;
var reified_program = "";
function start_reifying() {
  currently_reifying = true;
  reified_program = "";
}
function end_reifying() {
  currently_reifying = false;
}
function handleOutputLine(text) {
  if (currently_reifying) {
    reified_program += text + "\n";
  } else {
    if (next_line_will_be_answer_set) {
      constructed_answer_set = text;
    }
    if (text.startsWith("Answer:")) {
      next_line_will_be_answer_set = true;
    } else {
      next_line_will_be_answer_set = false;
    }
  }
  addToOutput(text);
  updateOutput();
}

// // Check if program is stratified and 'simple'
// function check_if_stratified_and_simple(program) {
//   reified_program = get_reified_program(program);
//   check_program = stored_programs["stratified"];
//   answer_set = get_answer_set(reified_program + check_program);
//   if (answer_set) {
//     answer_set = filter_answer_set(answer_set, ["has_choice","has_proper_disjunction","has_negative_cycle"]);
//     return answer_set.length == 0;
//   }
// }

// Check if program is stratified and 'simple'
function check_if_stratified_and_simple(program) {
  reified_program = get_reified_program(program);
  check_program = stored_programs["stratified"];
  answer_set = get_answer_set(reified_program + check_program);
  if (answer_set) {
    return true;
  } else {
    return false;
  }
}

// Load clingo
const version = '0.3.0';
d3.require(`wasm-clingo@${version}`).then(Clingo => {
    const Module = {
        locateFile: (file) => `https://cdn.jsdelivr.net/npm/wasm-clingo@${version}/${file}`,
        print: function(text) {
            handleOutputLine(text);
        },
        printErr: function(err) {
            Module.setStatus('Error')
            console.error(err)
        },
        setStatus: function(text) {
            addToOutput(text);
        },
        totalDependencies: 0,
        monitorRunDependencies: function(left) {
            this.totalDependencies = Math.max(this.totalDependencies, left);
            Module.setStatus(left ? 'Preparing... (' + (this.totalDependencies-left) + '/' + this.totalDependencies + ')' : 'All downloads complete.');
        }
    }

    window.onerror = function(event) {
        Module.setStatus('Exception thrown, see JavaScript console');
        Module.setStatus = function(text) {
            if (text) Module.printErr('[post-exception status] ' + text);
        };
    };
    Module.setStatus('Downloading...');

    Clingo(Module).then(clingo => {
        ClingoModule = clingo;
        initalize_after_clingo_loaded();
    });

});
