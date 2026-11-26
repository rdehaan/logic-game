// The tutorial: a guided first game, for new players.
//
// A card (in a corner of the screen) explains one thing at a time, and the
// part of the page it is about is highlighted. Most steps wait until the player
// did something (played a game, opened a tab, wrote a rule); "Do it for me"
// does it for them. The tutorial plays its own copy of "Find the flag 1", so
// the player's other work is not changed.
//
// The page (main.js) passes in what the tutorial needs from it (`app`):
//   open_game()          -> opens a fresh copy of the tutorial game
//   close()              -> (optional) called when the tutorial is closed
//   load_example(name)   -> loads an example game (e.g. 'flag2')
//   results()            -> { games, verdict }: the number of games played so far, and the last verdict
//   select_tab(n), program(), set_program(text), snapshots()
//
// The same card is used for other tutorials (the grading tutorial, see
// grading-tutorial.js): they pass their own steps, their own key to remember
// that they were seen, and the id of their own invitation.

const STATE_KEY = 'logic-game:tutorial';
const POLL_MS = 250;

const $ = (id) => document.getElementById(id);
const tab_label = (n) => document.querySelector(`label[for=tab${n}]`);
const tab_open = (n) => $('tab' + n).checked;
// (a program without spaces and comments, to recognize what the player typed)
const squeeze = (text) => text.replace(/%.*$/gm, '').replace(/\s+/g, '');

// The first example games, from easy to harder (also offered in the Control tab).
export const FIRST_GAMES = [
  ['flag1', 'Find the flag 1', 'the game of this tutorial: the flag is always in the same place'],
  ['flag2', 'Find the flag 2', 'the flag is somewhere in the bottom half'],
  ['flag3', 'Find the flag 3', 'the player starts somewhere in the top half, too'],
  ['flag4', 'Find the flag 4', 'the player only sees the cells around it'],
  ['flag5', 'Find the flag 5', 'the same, and the player and the flag can be anywhere'],
  ['flag6', 'Find the flag 6', 'trees are in the way'],
];

// Buttons to load these games (handled by the element they are put in, see Tutorial.make_card).
export function first_games_html() {
  return '<ul class="tutorial-games">' + FIRST_GAMES.map(([file, title, about]) =>
    `<li><button type="button" class="control-button" data-example="${file}">${title}</button> <span>${about}</span></li>`).join('') + '</ul>';
}

const FIRST_RULE = 'do(move(right)).';
const STRATEGY = `% Move down while the player is above the flag
do(move(down)) :- observe(at(R1,C1,player)), observe(at(R2,C2,flag)), R1 < R2.
% Move right when the player is in the row of the flag, left of it
do(move(right)) :- observe(at(R,C1,player)), observe(at(R,C2,flag)), C1 < C2.
`;

function code(text) {
  const pre = document.createElement('pre');
  pre.className = 'tutorial-code';
  pre.textContent = text;
  return pre.outerHTML;
}

// The steps. `target` is the element to highlight (a function: it can depend
// on what is on the screen); `done` says when the step is done; then `after`
// is shown, and the tutorial goes on by itself if `auto_next` is set.
// (The texts are the page's own, so they can contain HTML.)
function make_steps(app) {
  const games_at_start = { value: 0 };
  const played = () => app.results().games > games_at_start.value;
  const start_counting = () => { games_at_start.value = app.results().games; };
  return [
    {
      title: 'Welcome!',
      text: `<p>In this game you do not steer the player with the arrow keys: you write a small
        <b>logic program</b> (answer set programming, as in clingo) that decides what the player does.</p>
        <p>This tutorial takes about five minutes. It opens a simple game, <i>Find the flag 1</i>,
        in a copy of its own: your other work is not changed.</p>`,
      next: 'Start',
    },
    {
      title: 'The board',
      target: () => $('visual-container'),
      text: `<p>You are the <b>player</b> (the person in the top left corner).
        The <b>flag</b> is further down and to the right.</p>
        <p>You win when the player reaches the flag within 15 steps.</p>`,
    },
    {
      title: 'Play',
      target: () => $('play-button'),
      enter: start_counting,
      text: `<p>Click <b>Play</b> to see what happens.</p>
        <p>(Your strategy is still empty. What do you think the player will do?)</p>`,
      done: played,
      after: () => `<p>The player did not do anything, so the time ran out: <b>LOSE!</b>
        To move, the player needs a strategy.</p>`,
    },
    {
      title: 'Your strategy',
      target: () => tab_label(4),
      text: '<p>Your strategy is a program, in the <b>Strategy</b> tab. Click on it.</p>',
      done: () => tab_open(4),
      auto_next: true,
    },
    {
      title: 'A first rule',
      target: () => $('player_move_program'),
      text: `<p>At every step, the game runs your program, and the player makes the move that it derives with
        <tt>do/1</tt>: <tt>do(move(up))</tt>, <tt>do(move(down))</tt>, <tt>do(move(left))</tt> or <tt>do(move(right))</tt>.</p>
        <p>Type this line into the editor (with the period at the end):</p>${code(FIRST_RULE)}`,
      enter: () => app.select_tab(4),
      done: () => squeeze(app.program()).includes(squeeze(FIRST_RULE)),
      do_it: () => app.set_program(FIRST_RULE + '\n'),
      after: () => '<p>Well done: every program line (a <i>rule</i>, or here a <i>fact</i>) ends with a period.</p>',
    },
    {
      title: 'Play again',
      target: () => $('play-button'),
      enter: start_counting,
      text: '<p>Click <b>Play</b> again, and watch the player.</p>',
      done: played,
      after: () => `<p>The player walks to the right, and then stays at the edge of the board, because the flag is lower.
        Walking in one direction is not enough: the strategy has to <b>look</b> where the player and the flag are.</p>`,
    },
    {
      title: 'Looking at the board',
      target: () => $('player_move_program'),
      text: `<p>Your program sees the board through <tt>observe/1</tt>:
        <tt>observe(at(R,C,player))</tt> holds when the player is in row <tt>R</tt> and column <tt>C</tt>,
        and <tt>observe(at(R,C,flag))</tt> when the flag is there.
        Words that start with a capital letter are <i>variables</i>.</p>
        <p>Replace your program with these two rules (<tt>%</tt> starts a comment):</p>${code(STRATEGY)}
        <p>The rule <tt>A :- B, C.</tt> means: <tt>A</tt> holds if <tt>B</tt> and <tt>C</tt> hold.</p>`,
      enter: () => app.select_tab(4),
      done: () => {
        const p = squeeze(app.program());
        return p.includes('do(move(down)):-') && p.includes('do(move(right)):-') && p.includes('observe(') && !p.includes(squeeze(FIRST_RULE));
      },
      do_it: () => app.set_program(STRATEGY),
    },
    {
      title: 'Find the flag',
      target: () => $('play-button'),
      enter: start_counting,
      text: '<p>Click <b>Play</b>, and see whether the player now finds the flag.</p>',
      done: () => played() && app.results().verdict === 'win',
      progress: () => (played() ? `<p class="tutorial-warn">Not won yet. Compare your program with the rules in the step before
        (with <b>Back</b>), or let the tutorial type them for you there.</p>` : ''),
      after: () => '<p><b>WIN!</b> Your first strategy works.</p>',
    },
    {
      title: 'What did the player see?',
      target: () => tab_label(5),
      text: `<p>The <b>Debug</b> tab shows, for every step, what went into your program
        (what the player observed) and which move came out.
        Move through the game with the slider there (or the one under the board); the <b>Step</b> button plays one step at a time.</p>
        <p>Mistakes are marked in the editors while you type (try leaving out a period),
        with an explanation under the editor. Hover over a word like <tt>observe</tt> for help.</p>`,
    },
    {
      title: 'The rules of the game',
      target: () => tab_label(3),
      text: `<p>The rules of the game are programs too, in the <b>Game rules</b> tab: how levels are made,
        what the player can see, what moves do, and when the game is won or lost.
        Reading them tells you exactly what your strategy can use.</p>
        <p>In later games, levels are random. Then <b>Test your strategy</b> (in the Strategy tab)
        plays many levels, and lists the ones your strategy does not win.</p>`,
    },
    {
      title: 'Keep your work',
      target: () => {
        if (!tab_open(7)) return tab_label(7);
        $('snapshot-button').closest('details').open = true;      // (the section of the snapshots)
        return $('snapshot-button');
      },
      text: `<p>Your work is saved in this browser automatically. In the <b>Versions</b> tab you can
        download the game file (to hand in), keep <i>snapshots</i> of versions that work, compare
        versions, and download your project as a file, to work on it on another computer.</p>
        <p>Open the <b>Versions</b> tab, and keep a snapshot of your winning strategy.</p>`,
      done: () => app.snapshots() > 0,
      optional: true,
      after: () => '<p>Kept! You can go back to this version whenever you want.</p>',
    },
    {
      title: 'Done!',
      text: `<p>Now you know the basics. Go on with the next games, each a bit harder than the one before:</p>
        ${first_games_html()}
        <p>The <b>Instructions</b> tab explains everything else, such as the player's memory.
        These games, and this tutorial, are also in the <b>Control</b> tab.</p>`,
      next: 'Close',
    },
  ];
}

export class Tutorial {
  constructor({ storage, app, steps = make_steps, key = STATE_KEY, invite = 'tutorial-invite' }) {
    this.storage = storage;
    this.app = app;
    this.key = key;
    this.invite_id = invite;
    this.steps = steps(app);
    this.index = -1;
    this.timer = null;
    this.target = null;
    this.card = null;
  }

  // ---- Remembering that the tutorial was seen ----------------------------------------

  get seen() {
    try {
      return Boolean(this.storage && this.storage.getItem(this.key));
    } catch {
      return false;
    }
  }

  remember(state) {
    try {
      this.storage.setItem(this.key, JSON.stringify({ state, at: new Date().toISOString() }));
    } catch {
      // (then the invitation comes back next time)
    }
  }

  // The invitation for new players (not shown when the tutorial was seen or dismissed).
  invite() {
    const box = $(this.invite_id);
    if (!box || this.seen) return;
    box.hidden = false;
  }

  dismiss_invite() {
    $(this.invite_id).hidden = true;
    this.remember('dismissed');
  }

  // ---- Running ------------------------------------------------------------------------

  get running() {
    return this.index >= 0;
  }

  async start() {
    $(this.invite_id).hidden = true;
    this.remember('started');
    this.make_card();
    await this.app.open_game();
    this.go(0);
  }

  stop(finished = false) {
    const was_running = Boolean(this.card);      // (also when starting failed halfway)
    clearInterval(this.timer);
    this.timer = null;
    this.highlight(null);
    if (this.card) this.card.remove();
    this.card = null;
    this.index = -1;
    this.remember(finished ? 'finished' : 'closed');
    // (returns what close() returns: a promise, when closing takes a while)
    return was_running && this.app.close ? this.app.close() : undefined;
  }

  go(index) {
    clearInterval(this.timer);
    this.index = index;
    const step = this.steps[index];
    step.completed = false;
    if (step.enter) step.enter();
    this.render();
    this.timer = setInterval(() => this.poll(), POLL_MS);
    this.card.querySelector('.tutorial-body').focus({ preventScroll: true });
  }

  poll() {
    const step = this.steps[this.index];
    if (!step) return;
    // (the target can change, e.g. when a tab is opened)
    if (step.target && step.target() !== this.target) this.highlight(step.target(), true);
    if (!step.done || step.completed) {
      if (step.progress) this.set_progress(step.progress());
      return;
    }
    if (step.done()) {
      step.completed = true;
      if (step.auto_next) {
        this.go(this.index + 1);
        return;
      }
      this.render();
    } else if (step.progress) {
      this.set_progress(step.progress());
    }
  }

  set_progress(html) {
    const elem = this.card && this.card.querySelector('.tutorial-progress-text');
    if (elem && elem.innerHTML !== html) elem.innerHTML = html;
  }

  highlight(elem, scroll = false) {
    if (this.target) this.target.classList.remove('tutorial-target');
    this.target = elem || null;
    if (!this.target) return;
    this.target.classList.add('tutorial-target');
    if (scroll) this.scroll_to(this.target);
  }

  // Scroll the target into view, above the card (which covers the bottom of the screen on phones).
  scroll_to(elem) {
    const rect = elem.getBoundingClientRect();
    const card = this.card.getBoundingClientRect();
    // (on phones the card is as wide as the screen: then only the part above it is free)
    const bottom = card.left < 100 ? card.top : window.innerHeight;
    if (rect.top < 10 || rect.bottom > bottom - 10) {
      const y = window.scrollY + rect.top - Math.max(10, (bottom - Math.min(rect.height, bottom * 0.6)) / 3);
      window.scrollTo({ top: Math.max(0, y), behavior: 'smooth' });
    }
  }

  make_card() {
    if (this.card) return;
    const card = document.createElement('div');
    card.id = 'tutorial-card';
    card.className = 'tutorial-card';
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-labelledby', 'tutorial-title');
    card.innerHTML = `
      <div class="tutorial-head">
        <span id="tutorial-title" class="tutorial-title"></span>
        <span class="tutorial-count"></span>
        <button type="button" class="tutorial-close" title="Close the tutorial" aria-label="Close the tutorial">✕</button>
      </div>
      <div class="tutorial-body" tabindex="-1" aria-live="polite"></div>
      <div class="tutorial-progress-text"></div>
      <div class="tutorial-buttons">
        <button type="button" class="control-button tutorial-back">Back</button>
        <button type="button" class="control-button tutorial-do-it">Do it for me</button>
        <button type="button" class="control-button tutorial-next">Next</button>
      </div>`;
    card.querySelector('.tutorial-close').addEventListener('click', () => this.stop(this.index === this.steps.length - 1));
    card.querySelector('.tutorial-back').addEventListener('click', () => this.go(Math.max(0, this.index - 1)));
    card.querySelector('.tutorial-next').addEventListener('click', () => {
      if (this.index === this.steps.length - 1) this.stop(true);
      else this.go(this.index + 1);
    });
    card.querySelector('.tutorial-do-it').addEventListener('click', async () => {
      const step = this.steps[this.index];
      if (step.do_it) await step.do_it();
      this.poll();
    });
    card.querySelector('.tutorial-body').addEventListener('click', async (e) => {
      const game = e.target.closest('button[data-example]');
      if (!game) return;
      this.stop(this.index === this.steps.length - 1);
      await this.app.load_example(game.dataset.example);
    });
    document.body.append(card);
    this.card = card;
  }

  render() {
    const step = this.steps[this.index];
    const card = this.card;
    const waiting = step.done && !step.completed && !step.optional;
    card.querySelector('.tutorial-title').textContent = step.title;
    card.querySelector('.tutorial-count').textContent = `${this.index + 1} of ${this.steps.length}`;
    card.querySelector('.tutorial-body').innerHTML = step.text + (step.completed && step.after ? `<div class="tutorial-after">${step.after()}</div>` : '');
    card.querySelector('.tutorial-progress-text').innerHTML = '';
    card.querySelector('.tutorial-back').hidden = this.index === 0;
    card.querySelector('.tutorial-do-it').hidden = !(step.do_it && step.done && !step.completed);
    const next = card.querySelector('.tutorial-next');
    next.textContent = step.next || (step.optional && !step.completed ? 'Skip' : 'Next');
    next.disabled = waiting;
    next.title = waiting ? 'Do what the tutorial asks first' : '';
    card.classList.toggle('waiting', waiting);
    this.highlight(step.target ? step.target() : null, true);
  }
}
