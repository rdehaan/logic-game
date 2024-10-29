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
// load_named_program("heuristics", "stored/heuristics.lp")

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
      game_output += "\n" + text;
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
function get_answer_set(program, options) {
  answer_set = null;
  ClingoModule.ccall('run', 'number', ['string', 'string'], [program, options])
  return answer_set.split(" ");
}

// Clingo solving
function solve() {

  clearOutput();
  clearGameOutput();

  options = "-n1 -Wnone";
  program = "a :- not b.\nb :- not a.\n"
  solution = get_answer_set(program, options);
  if (solution) {
    var text = solution.join(". ") + "."
    addToGameOutput(text);
  } else {
    addToGameOutput("(none)");
  }

  updateOutput();
  updateGameOutput();
  // document.getElementById("run").disabled = false;
}

var next_line_will_be_answer_set = false;
var answer_set = null;
function handleOutputLine(text) {
  if (next_line_will_be_answer_set) {
    answer_set = text;
  }
  if (text.startsWith("Answer:")) {
    next_line_will_be_answer_set = true;
  } else {
    next_line_will_be_answer_set = false;
  }
  addToOutput(text);
  updateOutput();
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
    });

});
