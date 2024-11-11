function initalize_after_clingo_loaded() {
  load_game_from_path('examples/flag1.json');
  lock_level_generation();
};

function getQueryVariable(variable) {
  var query = window.location.search.substring(1);
  var vars = query.split("&");
  for (var i=0;i<vars.length;i++) {
    var pair = vars[i].split("=");
    if (pair[0] == variable) {
      return pair[1];
    }
  }
  return null;
}

// Only show (explicit) level editor if specified in the URL
if (getQueryVariable("editor") != "true") {
  document.getElementById('level-editor').style.display = "none";
}

// Only show solutions if called for in URL
if (getQueryVariable("solutions") != "true") {
  document.querySelector('#example-games optgroup[label="Solutions"]').remove();
}
//
// Select a particular tab if specified in the URL
if (getQueryVariable("tab") == "1") {
  document.getElementById('tab1').checked = true;
  reset_tab_color();
}
if (getQueryVariable("tab") == "2") {
  document.getElementById('tab2').checked = true;
  reset_tab_color();
}
if (getQueryVariable("tab") == "3") {
  document.getElementById('tab3').checked = true;
  reset_tab_color();
}
if (getQueryVariable("tab") == "4") {
  document.getElementById('tab4').checked = true;
  reset_tab_color();
}
if (getQueryVariable("tab") == "5") {
  document.getElementById('tab5').checked = true;
  reset_tab_color();
}
