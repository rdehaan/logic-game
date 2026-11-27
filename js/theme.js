// The colors of the page: light or dark. The player chooses Auto (as the
// browser or the system is set: the default), Light or Dark, with the theme
// button at the top of the page (and in Settings): each click goes on to the
// next of the three. The choice is kept in this browser.
//
// This is a plain script (not a module), loaded in <head>: it sets
// data-theme="light" or "dark" on <html> before the page is shown, so that a
// dark page does not first flash light. css/main.css and css/visual.css take
// their colors from data-theme, and the editors their theme (js/editors.js).
// A 'themechange' event on document says that the theme or the choice changed.
// Buttons marked data-theme-toggle show the choice, and change it when clicked.
(function () {
  const KEY = 'logic-game:theme';       // (forgotten with "Reset everything", as all logic-game: keys)
  const CHOICES = ['auto', 'light', 'dark'];
  const LABELS = { auto: '◐ Auto', light: '☀ Light', dark: '☾ Dark' };
  const DESCRIBED = { auto: 'Auto (as your browser or system is set)', light: 'Light', dark: 'Dark (the board stays white)' };
  const system_dark = window.matchMedia('(prefers-color-scheme: dark)');

  function stored_choice() {
    try {
      const value = window.localStorage.getItem(KEY);
      return CHOICES.includes(value) ? value : 'auto';
    } catch {
      return 'auto';      // (no storage, e.g. in a private window of some browsers)
    }
  }

  let choice = stored_choice();

  // The buttons show the choice (also those that are added later, e.g. in a dialog)
  function show_choice() {
    for (const button of document.querySelectorAll('[data-theme-toggle]')) {
      button.textContent = LABELS[choice];
      button.title = `Color theme: ${DESCRIBED[choice]}. Click for ${LABELS[next()].slice(2)}.`;
      button.setAttribute('aria-label', `Color theme: ${DESCRIBED[choice]}`);
    }
  }

  function next() {
    return CHOICES[(CHOICES.indexOf(choice) + 1) % CHOICES.length];
  }

  function apply() {
    const theme = choice === 'auto' ? (system_dark.matches ? 'dark' : 'light') : choice;
    const root = document.documentElement;
    show_choice();
    if (root.dataset.theme === theme && root.dataset.themeChoice === choice) return;
    root.dataset.theme = theme;
    root.dataset.themeChoice = choice;
    document.dispatchEvent(new CustomEvent('themechange', { detail: { theme, choice } }));
  }

  function set(value) {
    choice = CHOICES.includes(value) ? value : 'auto';
    try {
      if (choice === 'auto') window.localStorage.removeItem(KEY);
      else window.localStorage.setItem(KEY, choice);
    } catch {
      // (no storage: the choice holds until the page is closed)
    }
    apply();
  }

  // With Auto, the page follows a change of the setting right away
  system_dark.addEventListener('change', apply);
  // A choice made in another tab of the site counts here too
  window.addEventListener('storage', (event) => {
    if (event.key !== KEY && event.key !== null) return;
    choice = stored_choice();
    apply();
  });
  document.addEventListener('click', (event) => {
    const button = event.target.closest && event.target.closest('[data-theme-toggle]');
    if (!button) return;
    event.preventDefault();
    set(next());
  });
  document.addEventListener('DOMContentLoaded', show_choice);

  window.logic_game_theme = {
    CHOICES,
    get choice() { return choice; },
    get theme() { return document.documentElement.dataset.theme; },
    set,
    cycle() { set(next()); },
  };

  apply();
})();
