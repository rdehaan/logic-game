var aux_program = ace.edit("aux_program");
aux_program.setTheme("ace/theme/textmate");
aux_program.$blockScrolling = Infinity;
aux_program.setOptions({
  useSoftTabs: true,
  tabSize: 2,
  maxLines: Infinity,
  mode: "ace/mode/gringo",
  autoScrollEditorIntoView: true
});

var level_gen_program = ace.edit("level_gen_program");
level_gen_program.setTheme("ace/theme/textmate");
level_gen_program.$blockScrolling = Infinity;
level_gen_program.setOptions({
  useSoftTabs: true,
  tabSize: 2,
  maxLines: Infinity,
  mode: "ace/mode/gringo",
  autoScrollEditorIntoView: true
});

var visibility_program = ace.edit("visibility_program");
visibility_program.setTheme("ace/theme/textmate");
visibility_program.$blockScrolling = Infinity;
visibility_program.setOptions({
  useSoftTabs: true,
  tabSize: 2,
  maxLines: Infinity,
  mode: "ace/mode/gringo",
  autoScrollEditorIntoView: true
});

var nature_program = ace.edit("nature_program");
nature_program.setTheme("ace/theme/textmate");
nature_program.$blockScrolling = Infinity;
nature_program.setOptions({
  useSoftTabs: true,
  tabSize: 2,
  maxLines: Infinity,
  mode: "ace/mode/gringo",
  autoScrollEditorIntoView: true
});

var goal_program = ace.edit("goal_program");
goal_program.setTheme("ace/theme/textmate");
goal_program.$blockScrolling = Infinity;
goal_program.setOptions({
  useSoftTabs: true,
  tabSize: 2,
  maxLines: Infinity,
  mode: "ace/mode/gringo",
  autoScrollEditorIntoView: true
});

var player_move_program = ace.edit("player_move_program");
player_move_program.setTheme("ace/theme/textmate");
player_move_program.$blockScrolling = Infinity;
player_move_program.setOptions({
  useSoftTabs: true,
  tabSize: 2,
  maxLines: Infinity,
  mode: "ace/mode/gringo",
  autoScrollEditorIntoView: true
});

var level_settings = ace.edit("level_settings");
level_settings.setTheme("ace/theme/textmate");
level_settings.$blockScrolling = Infinity;
level_settings.setOptions({
  useSoftTabs: true,
  tabSize: 2,
  maxLines: Infinity,
  mode: "ace/mode/gringo",
  autoScrollEditorIntoView: true
});

var level_state = ace.edit("level_state");
level_state.setTheme("ace/theme/textmate");
level_state.$blockScrolling = Infinity;
level_state.setOptions({
  useSoftTabs: true,
  tabSize: 2,
  maxLines: Infinity,
  mode: "ace/mode/gringo",
  autoScrollEditorIntoView: true
});

var example_code_elems = document.querySelectorAll(".example-code");
var example_code_num = 0;
var example_editor;
example_code_elems.forEach((elem) => {
  var id = "example" + example_code_num;
  elem.id = id;
  example_code_num += 1;
  example_editor = ace.edit(id);
  example_editor.setTheme("ace/theme/textmate");
  example_editor.$blockScrolling = Infinity;
  example_editor.setOptions({
    useSoftTabs: true,
    tabSize: 2,
    maxLines: Infinity,
    mode: "ace/mode/gringo",
    autoScrollEditorIntoView: true
  });
  example_editor.setReadOnly(true);
  example_editor.resize();
})
