// Tests of the page in a real browser (Chromium, via Playwright).
//
// Needs Playwright's Chromium: run "npx playwright install chromium" once.
// To use another Chromium, set CHROMIUM_PATH to its executable.
// The tests are skipped when no browser can be started.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createServer } from '../tools/serve.mjs';
import { ROOT } from './helpers.mjs';
import { make_zip } from '../js/folder.js';

let chromium = null;
let devices = {};
try {
  ({ chromium, devices } = await import('playwright'));
} catch {
  // playwright is not installed
}

let browser = null;
let server = null;
let base = '';
let skip = false;

test.before(async () => {
  if (!chromium) {
    skip = 'playwright is not installed (npm install)';
    return;
  }
  try {
    browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
  } catch (e) {
    skip = 'no browser: ' + e.message.split('\n')[0];
    return;
  }
  server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}/`;
});

test.after(async () => {
  if (browser) await browser.close();
  if (server) server.close();
});

// Open the page, and collect the errors that happen in it.
async function open(t, query = '') {
  if (skip) {
    t.skip(skip);
    return null;
  }
  // (service workers are blocked: they would bypass page.route; see the offline test)
  const page = await browser.newPage({ serviceWorkers: 'block' });
  page.errors = [];
  page.external = [];
  page.on('pageerror', (e) => page.errors.push(e.message));
  // The page does not need anything from other sites
  // (the browser's own files, e.g. of its PDF viewer, are not from other sites)
  await page.route((url) => !url.href.startsWith(base) && !/^(blob|chrome|chrome-extension):/.test(url.href), (route) => {
    page.external.push(route.request().url());
    route.abort();
  });
  await page.goto(base + query);
  await page.waitForSelector('body[data-ready=true]', { timeout: 30000 });
  t.after(() => page.close());
  return page;
}

// The whole game output as text, newest first.
const game_output = (page) => page.evaluate(() => window.logic_game.game_output());

async function wait_for_verdict(page, pattern = /WIN!|LOSE!|STOPPED!|TIMEOUT!/, timeout = 60000) {
  await page.waitForFunction((source) => new RegExp(source).test(window.logic_game.game_output()),
    pattern.source, { timeout });
}

// Open the closed sections of the Versions tab (as a player would: by clicking them).
async function open_sections(page) {
  const closed = page.locator('#section-versions details:not([open]) > summary');
  while (await closed.count()) await closed.first().click();
}

async function set_program(page, key, text) {
  await page.evaluate(([k, v]) => window.logic_game.editors.set_value(k, v), [key, text]);
}

test('the page loads a level, and the example solution wins', async (t) => {
  const page = await open(t);
  if (!page) return;
  assert.equal(await page.locator('#visual .grid-visual-cell').count(), 48);
  await page.selectOption('#speed-selector', '100');
  await page.click('#play-button');
  await wait_for_verdict(page);
  assert.match(await game_output(page), /^WIN!/);
  assert.equal(await page.isDisabled('#stop-button'), true);
  assert.equal(await page.isEnabled('#reset-button'), true);
  assert.deepEqual(page.errors, []);
  assert.deepEqual(page.external, []);
});

test('the fonts are loaded from the site itself', async (t) => {
  const page = await open(t);
  if (!page) return;
  await page.evaluate(() => document.fonts.ready);
  const loaded = await page.evaluate(async () => {
    await document.fonts.load('16px FontAwesome', '\uf024');
    await document.fonts.load('600 14px "Open Sans"', 'A');
    return [document.fonts.check('16px FontAwesome', '\uf024'), document.fonts.check('600 14px "Open Sans"', 'A'),
      [...document.fonts].filter((f) => f.status === 'loaded').map((f) => f.family.replace(/"/g, ''))];
  });
  assert.equal(loaded[0], true);
  assert.equal(loaded[1], true);
  assert.ok(loaded[2].includes('FontAwesome') && loaded[2].includes('Open Sans'), loaded[2].join(', '));
  assert.deepEqual(page.external, []);
});

test('generating a level', async (t) => {
  const page = await open(t, '?editor=true&tab=5');
  if (!page) return;
  const before = await page.evaluate(() => window.logic_game.editors.value('level_state'));
  for (let i = 0; i < 5; i++) {
    await page.click('#generate-button');
    await page.waitForFunction(() => !document.getElementById('generate-button').disabled);
  }
  const after = await page.evaluate(() => window.logic_game.editors.value('level_state'));
  assert.match(after, /at\(\d+,\d+,player\)\./);
  assert.match(after, /at\(\d+,\d+,flag\)\./);
  assert.ok(before);
  assert.deepEqual(page.errors, []);
});

test('syntax errors are shown in the editor while typing', async (t) => {
  const page = await open(t, '?tab=4');
  if (!page) return;
  await set_program(page, 'player_move_program', 'do(move(down)).\ndo(move(up)) :- observe(at(R,C,player).');
  await page.waitForSelector('#player_move_program-problems li');
  assert.deepEqual(await page.locator('#player_move_program-problems li').allTextContents(),
    ['Error (line 2): syntax error, unexpected ., expecting ) or ;']);
  assert.equal(await page.locator('#player_move_program .ace_gutter-cell.ace_error').count(), 1);
  assert.match(await page.getAttribute('label[for=tab4]', 'class'), /has-errors/);
  // Fixing the error removes the marks
  await set_program(page, 'player_move_program', 'do(move(down)).');
  await page.waitForSelector('#player_move_program-problems li', { state: 'detached' });
  assert.doesNotMatch(await page.getAttribute('label[for=tab4]', 'class') || '', /has-errors/);
});

test('unsafe variables are shown in the editor', async (t) => {
  const page = await open(t, '?tab=3');
  if (!page) return;
  await set_program(page, 'goal_program', 'win :- at(R,C,player), at(R,C,flag).\n\nlose(X) :- current_time(T), T > 10.');
  await page.waitForSelector('#goal_program-problems li');
  const [text] = await page.locator('#goal_program-problems li').allTextContents();
  assert.match(text, /^Error \(line 3\): unsafe variables in: .*'X' is unsafe/);
});

test('errors during a game are reported with the program and line', async (t) => {
  const page = await open(t, '?tab=5');
  if (!page) return;
  await set_program(page, 'player_move_program', '% oops\ndo(move(down)) :- observe(at(R,C,player).');
  await page.selectOption('#speed-selector', '100');
  await page.click('#play-button');
  await wait_for_verdict(page);
  assert.match(await game_output(page), /Player program: error:\n {4}Player strategy, line 2, column 41: syntax error/);
});

test('a program that does not terminate is stopped, and the page stays responsive', async (t) => {
  const page = await open(t, '?timeout=2');
  if (!page) return;
  await set_program(page, 'nature_program', 'n(0). n(X+1) :- n(X).');
  await page.click('#play-button');
  // The page responds while clingo is busy
  const t0 = Date.now();
  await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 100)));
  assert.ok(Date.now() - t0 < 1000);
  await wait_for_verdict(page, /STOPPED!/, 20000);
  assert.match(await game_output(page), /^STOPPED! \(Nature program: clingo took longer than 2 seconds and was stopped\)/);
  assert.equal(await page.isEnabled('#play-button'), true);
});

test('the Stop button stops clingo, and the next game works', async (t) => {
  const page = await open(t, '?timeout=60');
  if (!page) return;
  await set_program(page, 'nature_program', 'n(0). n(X+1) :- n(X).');
  await page.click('#play-button');
  await page.waitForTimeout(1000);
  await page.click('#stop-button');
  await page.waitForFunction(() => document.getElementById('stop-button').disabled, null, { timeout: 5000 });
  assert.equal(await page.isEnabled('#play-button'), true);
  // Back to the nature program of the example (the changed one was saved)
  page.on('dialog', (dialog) => dialog.accept());
  await page.waitForSelector('#work-notice:not([hidden])');
  await page.click('button[data-action=revert_to_original]');
  await page.waitForFunction(() => !/n\(0\)/.test(window.logic_game.editors.value('nature_program')));
  await page.selectOption('#speed-selector', '100');
  await page.click('#play-button');
  await wait_for_verdict(page);
  assert.match(await game_output(page), /^WIN!/);
  assert.deepEqual(page.errors, []);
});

test('pause and resume', async (t) => {
  const page = await open(t);
  if (!page) return;
  await page.selectOption('#speed-selector', '1000');
  await page.click('#play-button');
  await page.waitForFunction(() => /STEP 1 /.test(window.logic_game.game_output()));
  await page.click('#pause-button');
  await page.waitForFunction(() => !document.getElementById('play-button').disabled, null, { timeout: 5000 });
  const paused_at = (await game_output(page)).length;
  await page.waitForTimeout(1500);
  assert.equal((await game_output(page)).length, paused_at);
  await page.selectOption('#speed-selector', '100');
  await page.click('#play-button');
  await wait_for_verdict(page);
  assert.match(await game_output(page), /^WIN!/);
});

test('the URL options select a tab and a file', async (t) => {
  const page = await open(t, '?file=flag3-with-solutions&tab=3&internals=true&solutions=true');
  if (!page) return;
  assert.equal(await page.isChecked('#tab3'), true);
  assert.equal(await page.isVisible('label[for=tab6]'), true);
  assert.equal(await page.locator('#example-games optgroup[label=Solutions]').count(), 1);
  assert.match(await page.evaluate(() => window.logic_game.editors.value('level_gen_program')), /8x6 grid/);
});

test('uploading a game file', async (t) => {
  const page = await open(t);
  if (!page) return;
  const game = {
    aux_program: '% uploaded',
    level_gen_program: 'setting(grid_width(2)). setting(grid_height(1)). at(1,1,player).',
    level_state: 'at(1,1,player).',
    level_settings: 'setting(grid_width(2)).\nsetting(grid_height(1)).',
    visibility_program: 'observe(at(R,C,O)) :- at(R,C,O).',
  };
  await page.setInputFiles('#file-input', { name: 'game.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(game)) });
  await page.waitForFunction(() => /Done loading/.test(document.getElementById('upload-status').textContent));
  assert.equal(await page.evaluate(() => window.logic_game.editors.value('aux_program')), '% uploaded');
  assert.equal(await page.evaluate(() => window.logic_game.editors.value('goal_program')), '');
  await page.waitForFunction(() => document.querySelectorAll('#visual .grid-visual-cell').length === 2);
});

test('hints about special predicates are shown in the editor and in the Debug tab', async (t) => {
  const page = await open(t, '?tab=4');
  if (!page) return;
  await set_program(page, 'player_move_program', 'do(move(down)) :- at(R,C,player).\nremeber(x).');
  await page.waitForSelector('#player_move_program-problems li.severity-warning');
  const items = await page.locator('#player_move_program-problems li').allTextContents();
  assert.match(items[0], /^Warning \(line 1\): at\/3 never holds here: the player does not see the state/);
  assert.match(items[1], /^Warning \(line 2\): remeber\/1 is derived but never used.*Did you mean remember\/1\?/);
  assert.match(await page.getAttribute('label[for=tab4]', 'class'), /has-warnings/);
  assert.equal(await page.textContent('#problems-notice'), '\u26A0 2 warnings in the programs');
  assert.match(await page.textContent('#player_move_program-problems + *, p.editor-interface') || '', /Gets: /);
  // The notice opens the Debug tab with the list; clicking an item goes to the program
  await page.click('#problems-notice');
  assert.equal(await page.isChecked('#tab5'), true);
  assert.equal(await page.locator('#problems-summary li').count(), 2);
  await page.locator('#problems-summary li').first().click();
  assert.equal(await page.isChecked('#tab4'), true);
  // Fixing the program removes the hints
  await set_program(page, 'player_move_program', 'do(move(down)) :- observe(at(R,C,player)).');
  await page.waitForSelector('#player_move_program-problems li', { state: 'detached' });
  assert.equal(await page.isHidden('#problems-notice'), true);
});

test('a violated constraint is marked in the editor, and a lost game points to the warnings', async (t) => {
  const page = await open(t, '?tab=3');
  if (!page) return;
  await set_program(page, 'goal_program', 'win :- at(R,C,player), at(R,C,flag).\nlose(timeout) :- current_time(T), T >= 3.\n:- current_time(2).');
  await page.selectOption('#speed-selector', '100');
  await page.click('#play-button');
  await wait_for_verdict(page);
  const output = await game_output(page);
  assert.match(output, /- Winning conditions: no answer set, because this constraint is violated:\n {4}Winning conditions, line 3: :- current_time\(2\)\./);
  assert.match(output, /^LOSE! \(lose\(timeout\)\)\n\(There is 1 error or warning in the programs that may explain this/);
  const items = await page.locator('#goal_program-problems li').allTextContents();
  assert.deepEqual(items, ['Warning (line 3): This constraint was violated during the game, so the winning conditions had no answer set (see the game output).']);
});

test('problems with the board are shown under it', async (t) => {
  const page = await open(t, '?editor=true&tab=5');
  if (!page) return;
  await set_program(page, 'level_settings', 'setting(grid_width(8)).');
  await page.click('button[data-action=update_interface]');
  await page.waitForSelector('#board-message:not([hidden])');
  assert.equal(await page.textContent('#board-message'), 'The board cannot be drawn: the level settings have no setting(grid_height(H)).');
});

test('changes are saved in the browser, and come back after a reload', async (t) => {
  const page = await open(t, '?file=flag3&tab=4');
  if (!page) return;
  page.on('dialog', (dialog) => dialog.accept());
  assert.equal(await page.isHidden('#work-notice'), true);
  await set_program(page, 'player_move_program', 'do(move(down)).');
  await page.waitForFunction(() => window.logic_game.work.origins().length === 1);
  // As soon as there are changes, there is a way back
  await page.waitForSelector('#work-notice:not([hidden])');
  await page.reload();
  await page.waitForSelector('body[data-ready=true]');
  assert.equal(await page.evaluate(() => window.logic_game.editors.value('player_move_program')), 'do(move(down)).');
  assert.match(await page.textContent('#work-notice'), /^\s*Your own version, saved in this browser at \d+:\d+.*\.\s*Back to the original\s*$/);
  assert.equal(await page.textContent('#game-title'), 'Find the flag 3');
  // Other games are not affected
  await page.click('label[for=tab1]');
  await page.selectOption('#example-games', 'examples/flag2.json');
  await page.click('button[data-action=load_game]');
  await page.waitForFunction(() => /Done loading/.test(document.getElementById('load-status').textContent));
  assert.notEqual(await page.evaluate(() => window.logic_game.editors.value('player_move_program')), 'do(move(down)).');
  assert.equal(await page.isHidden('#work-notice'), true);
  // Back to flag 3: the changes are loaded, until going back to the original
  await page.selectOption('#example-games', 'examples/flag3.json');
  await page.click('button[data-action=load_game]');
  await page.waitForSelector('#work-notice:not([hidden])');
  assert.match(await page.textContent('#work-notice'), /Your own version, saved in this browser at /);
  await page.click('button[data-action=revert_to_original]');
  await page.waitForSelector('#work-notice', { state: 'hidden' });
  assert.equal(await page.evaluate(() => window.logic_game.editors.value('player_move_program')), '');
  assert.deepEqual(await page.evaluate(() => window.logic_game.work.origins()), []);
});

test('share links', async (t) => {
  const page = await open(t, '?tab=4');
  if (!page) return;
  await set_program(page, 'player_move_program', '% shared strategy\ndo(move(down)).');
  await page.click('label[for=tab7]');
  await open_sections(page);
  await page.click('button[data-action=share_game]');
  await page.waitForSelector('#share-box:not([hidden])');
  const link = await page.inputValue('#share-link');
  assert.match(link, /\?tab=4#game=[A-Za-z0-9_-]+$/);
  assert.ok(link.length < 2500, `${link.length} characters`);
  // Someone else opens the link
  const other = await browser.newPage();
  t.after(() => other.close());
  await other.goto(link);
  await other.waitForSelector('body[data-ready=true]');
  assert.equal(await other.evaluate(() => window.logic_game.editors.value('player_move_program')), '% shared strategy\ndo(move(down)).');
  assert.equal(await other.evaluate(() => window.logic_game.editors.value('level_state')),
    await page.evaluate(() => window.logic_game.editors.value('level_state')));
  // and plays it
  await other.selectOption('#speed-selector', '100');
  await other.click('#play-button');
  await wait_for_verdict(other);
  // A link that is broken
  const broken = await browser.newPage();
  t.after(() => broken.close());
  await broken.goto(base + '#game=AAAA');
  await broken.waitForSelector('body[data-ready=true]');
  assert.match(await broken.textContent('#engine-status'), /The link could not be read/);
  assert.match(await broken.evaluate(() => window.logic_game.editors.value('level_gen_program')), /grid/);
});

test('forgetting all saved work', async (t) => {
  const page = await open(t, '?tab=4');
  if (!page) return;
  page.on('dialog', (dialog) => dialog.accept());
  await set_program(page, 'player_move_program', 'do(move(up)).');
  await page.waitForFunction(() => window.logic_game.work.origins().length === 1);
  await page.click('label[for=tab7]');
  await open_sections(page);
  assert.equal(await page.textContent('#saved-work-status'), 'There is saved work for 1 game.');
  await page.click('#forget-button');
  assert.equal(await page.textContent('#saved-work-status'), 'There is no saved work.');
  await page.reload();
  await page.waitForSelector('body[data-ready=true]');
  assert.notEqual(await page.evaluate(() => window.logic_game.editors.value('player_move_program')), 'do(move(up)).');
});

test('the speeds As fast as possible and Instant', async (t) => {
  const page = await open(t);
  if (!page) return;
  for (const speed of ['0', '-1']) {
    await page.selectOption('#speed-selector', speed);
    await page.click('#play-button');
    await wait_for_verdict(page);
    assert.match(await game_output(page), /^WIN!/);
    // The board shows the end of the game
    assert.equal(await page.locator('#visual .grid-visual-cell').count(), 48);
    await page.waitForFunction(() => !document.getElementById('play-button').disabled);
  }
  assert.match(await game_output(page), /- Time in clingo: winning conditions \d+ ms/);
});

test('a game cannot inject HTML or scripts into the page through the board', async (t) => {
  const page = await open(t, '?editor=true&tab=5');
  if (!page) return;
  await page.evaluate(() => { window.injected = false; });
  await set_program(page, 'level_settings', 'setting(grid_width(2)).\nsetting(grid_height(1)).\n' +
    'decorate(label,player,"<img src=x onerror=window.injected=true>").\n' +
    'decorate(color,player,"red\\" onmouseover=\\"window.injected=true").\n' +
    'decorate(bgcolor,1,2,"red; background-image: url(https://example.com/x.png)").');
  await set_program(page, 'level_state', 'at(1,1,player).');
  await page.click('button[data-action=update_interface]');
  await page.waitForFunction(() => document.querySelectorAll('#visual .grid-visual-cell').length === 2);
  await page.waitForTimeout(300);
  assert.equal(await page.locator('#visual img').count(), 0);
  assert.equal(await page.textContent('#visual .grid-visual-cell span'), '<img src=x onerror=window.injected=true>');
  await page.hover('#visual .grid-visual-cell span');
  assert.equal(await page.evaluate(() => window.injected), false);
  assert.deepEqual(page.external, []);
});

test('playing step by step, and looking back', async (t) => {
  const page = await open(t);
  if (!page) return;
  assert.equal(await page.isHidden('#timeline-box'), true);
  // Step starts a game and plays one step
  for (let i = 1; i <= 3; i++) {
    await page.click('#step-button');
    await page.waitForFunction(() => !document.getElementById('step-button').disabled);
    assert.equal(await page.textContent('#timeline-label'), `Time ${i} of ${i}`);
    assert.match(await page.textContent('#board-status'), new RegExp(`^Paused at time ${i}\\.`));
  }
  assert.equal(await page.isDisabled('#pause-button'), true);
  assert.equal(await page.isEnabled('#stop-button'), true);
  assert.ok(await page.locator('.grid-visual-cell.changed').count() > 0);
  // The cells that changed are not marked, unless that is turned on
  assert.equal(await page.isChecked('#mark-changes'), false);
  assert.equal(await page.locator('.grid-visual-cell.changed').first().evaluate((e) => getComputedStyle(e).boxShadow), 'none');
  await page.check('#mark-changes');
  assert.equal(await page.locator('.grid-visual-cell.changed').first().evaluate((e) => getComputedStyle(e).boxShadow !== 'none'), true);
  await page.uncheck('#mark-changes');
  // Back one time: the move the player made there
  await page.click('#timeline-prev');
  assert.match(await page.textContent('#timeline-label'), /^Time 2 of 3: the player moved do\(move\(\w+\)\)$/);
  // Play to the end, then look back with the slider and from the game output
  await page.selectOption('#speed-selector', '0');
  await page.click('#play-button');
  await wait_for_verdict(page);
  const end = await page.textContent('#timeline-label');
  assert.match(end, /^Time (\d+) of \1: WIN/);
  await page.fill('#timeline', '1');
  await page.dispatchEvent('#timeline', 'input');
  assert.match(await page.textContent('#timeline-label'), /^Time 0 of \d+: the player moved /);
  assert.equal(await page.locator('.grid-visual-cell.changed').count(), 0);
  // The Debug tab shows the step of the board, with a slider of its own
  await page.click('label[for=tab5]');
  assert.match(await page.textContent('#debug-step-label'), /^Step 1: the player saw the board of time 0/);
  assert.match(await page.textContent('#debug-step'), /Player input/);
  // with the facts of each program in a locked editor, one fact per line
  const output_editors = page.locator('#debug-step .ace_editor.output-editor');
  assert.ok(await output_editors.count() >= 3);
  assert.equal(await output_editors.first().evaluate((e) => ace.edit(e).getReadOnly()), true);
  assert.match(await output_editors.first().evaluate((e) => ace.edit(e).getValue()), /^current_time\(0\)\.\n/);
  assert.ok(await page.locator('#debug-step .ace_editor .ace_keyword, #debug-step .ace_editor .ace_constant, #debug-step .ace_editor .ace_paren').count() > 0);
  assert.match(await page.textContent('#debug-messages'), /^WIN!/);
  // (next to the board, the slider under the board is used; otherwise the Debug tab has its own)
  assert.equal(await page.isHidden('.debug-timeline'), true);
  await page.click('#timeline-next');
  assert.match(await page.textContent('#timeline-label'), /^Time 1 of /);
  assert.match(await page.textContent('#debug-step-label'), /^Step 2:/);
  await page.evaluate(() => { document.getElementById('option-side-by-side').checked = false; document.getElementById('option-side-by-side').dispatchEvent(new Event('change')); });
  assert.equal(await page.isVisible('.debug-timeline'), true);
  await page.click('#debug-next');
  assert.match(await page.textContent('#timeline-label'), /^Time 2 of /);
  assert.match(await page.textContent('#debug-step-label'), /^Step 3:/);
  // Changing a program after the game: the board says so
  await set_program(page, 'player_move_program', (await value(page, 'player_move_program')) + '\n% changed');
  assert.match(await page.textContent('#board-status'), /^The board shows the last game \(WIN at time \d+\)\. Since then, you changed: Player strategy\./);
  // A new game starts a new timeline
  await page.click('#reset-button');
  assert.equal(await page.isHidden('#timeline-box'), true);
  assert.match(await page.textContent('#debug-step'), /Play a game/);
  // and clearing the level after a game removes it too
  await page.click('#play-button');
  await wait_for_verdict(page);
  assert.equal(await page.isVisible('#timeline-box'), true);
  await page.click('#clear-button');
  assert.equal(await page.isHidden('#timeline-box'), true);
  assert.equal(await page.textContent('#board-status'), 'There is no level: generate one.');
  assert.equal(await page.isDisabled('#play-button'), true);
});

test('the game rules are locked together; unlocking keeps the level until the level programs change', async (t) => {
  const page = await open(t, '?tab=3');
  if (!page) return;
  const read_only = () => page.evaluate(() => ['aux_program', 'level_gen_program', 'visibility_program', 'nature_program', 'goal_program', 'player_move_program']
    .map((k) => window.logic_game.editors.get(k).getReadOnly()));
  assert.deepEqual(await read_only(), [true, true, true, true, true, false]);
  const level = await value(page, 'level_state');
  await page.click('#unlock-button');
  assert.deepEqual(await read_only(), [false, false, false, false, false, false]);
  assert.equal(await page.textContent('#play-button'), '\u23F5\u00A0Lock rules and play');
  assert.equal(await page.textContent('#generate-button'), '\u239A\u00A0Lock rules and generate level');
  assert.match(await page.textContent('#board-status'), /The game rules are unlocked/);
  // Changing the winning conditions keeps the level
  await set_program(page, 'goal_program', (await value(page, 'goal_program')) + '\n% changed');
  await page.click('#lock-button');
  assert.equal(await value(page, 'level_state'), level);
  assert.equal(await page.textContent('#play-button'), '\u23F5\u00A0Play');
  // Changing the level generation removes the level when locking
  await page.click('#unlock-button');
  await set_program(page, 'level_gen_program', (await value(page, 'level_gen_program')) + '\n% changed');
  await page.click('#lock-button');
  assert.equal(await value(page, 'level_state'), '');
  assert.match(await page.textContent('#board-status'), /^The level was removed: it was made with another version/);
  assert.deepEqual(await read_only(), [true, true, true, true, true, false]);
  // Lock rules and generate level
  await page.click('#unlock-button');
  await page.click('#generate-button');
  await page.waitForFunction(() => window.logic_game.editors.value('level_state') !== '');
  assert.match(await page.textContent('#board-status'), /^The board shows the start of the level \(generated at /);
  // During a game, the strategy cannot be changed either
  await page.selectOption('#speed-selector', '1000');
  await page.click('#play-button');
  await page.waitForFunction(() => window.logic_game.editors.get('player_move_program').getReadOnly());
  assert.equal(await page.isDisabled('#unlock-button'), true);
  await page.click('#stop-button');
  await page.waitForFunction(() => !window.logic_game.editors.get('player_move_program').getReadOnly());
});

test('a level made with another level generation program is out of date: generate a new one, or keep it on purpose', async (t) => {
  const page = await open(t, '?tab=3');
  if (!page) return;
  const level = await value(page, 'level_state');
  const status = () => page.textContent('#board-status');
  const outdated = () => page.evaluate(() => document.getElementById('visual-container').classList.contains('outdated'));
  await page.click('#unlock-button');
  // Other rules: the level is still fine
  await set_program(page, 'goal_program', (await value(page, 'goal_program')) + '\n% changed');
  assert.equal(await outdated(), false);
  assert.equal(await page.isEnabled('#play-button'), true);
  // The level generation program: the level is out of date, and Play and Step wait for a new level
  await set_program(page, 'level_gen_program', (await value(page, 'level_gen_program')) + '\n% changed');
  assert.equal(await outdated(), true);
  assert.match(await status(), /^This level is out of date: you changed the level generation program since it was made/);
  assert.equal(await page.isDisabled('#play-button'), true);
  assert.equal(await page.isDisabled('#step-button'), true);
  assert.match(await page.getAttribute('#play-button', 'title'), /^The level is out of date/);
  assert.match(await page.getAttribute('#generate-button', 'class'), /primary-button/);
  assert.match(await page.textContent('#rules-lock-text'), /locking removes it/);
  // Keeping it is a choice of its own
  await page.click('#board-status .keep-level-button');
  assert.equal(await outdated(), false);
  assert.equal(await page.isEnabled('#play-button'), true);
  assert.doesNotMatch(await page.getAttribute('#generate-button', 'class'), /primary-button/);
  assert.match(await status(), /^You kept the level/);
  await page.click('#lock-button');
  assert.equal(await value(page, 'level_state'), level);
  // A level removed by locking can be brought back, too
  await page.click('#unlock-button');
  await set_program(page, 'level_gen_program', (await value(page, 'level_gen_program')) + '\n% changed again');
  await page.click('#lock-button');
  assert.equal(await value(page, 'level_state'), '');
  assert.equal(await page.textContent('#board-status .keep-level-button'), 'Keep the old level anyway');
  assert.match(await page.getAttribute('#generate-button', 'class'), /primary-button/);
  await page.click('#board-status .keep-level-button');
  await page.waitForFunction(() => document.querySelectorAll('#visual .grid-visual-cell').length > 0);
  assert.equal(await value(page, 'level_state'), level);
  assert.equal(await page.isEnabled('#play-button'), true);
  await page.selectOption('#speed-selector', '0');
  await page.click('#play-button');
  await wait_for_verdict(page);
  // Generating a new level is the usual way
  await page.click('#unlock-button');
  await set_program(page, 'level_gen_program', (await value(page, 'level_gen_program')) + '\n% and again');
  assert.equal(await outdated(), true);
  await page.click('#generate-button');
  await page.waitForFunction(() => /^The board shows the start of the level \(generated at /.test(document.getElementById('board-status').textContent));
  assert.equal(await outdated(), false);
  assert.equal(await page.isEnabled('#play-button'), true);
  assert.equal(await page.locator('#board-status .keep-level-button').count(), 0);
  assert.deepEqual(page.errors, []);
});

test('options in the Control tab are kept, and can be set in the URL', async (t) => {
  const page = await open(t);
  if (!page) return;
  assert.equal(await page.isHidden('label[for=tab6]'), true);
  assert.equal(await page.locator('#example-games optgroup[label=Solutions]').count(), 0);
  await page.check('#option-internals');
  await page.check('#option-solutions');
  await page.check('#option-editor');
  await page.fill('#option-timeout', '25');
  await page.dispatchEvent('#option-timeout', 'change');
  assert.equal(await page.isChecked('#option-mark-changes'), false);
  await page.check('#option-mark-changes');
  assert.equal(await page.isVisible('label[for=tab6]'), true);
  assert.equal(await page.locator('#example-games optgroup[label=Solutions]').count(), 1);
  assert.equal(await page.evaluate(() => window.logic_game.solver.timeout_ms), 25000);
  await page.reload();
  await page.waitForSelector('body[data-ready=true]');
  assert.equal(await page.isVisible('label[for=tab6]'), true);
  assert.equal(await page.isChecked('#option-editor'), true);
  assert.equal(await page.isChecked('#mark-changes'), true);
  assert.equal(await page.evaluate(() => window.logic_game.solver.timeout_ms), 25000);
  // A link can turn them off (only for that visit)
  await page.goto(base + '?internals=false&mark_changes=false&solutions=false&editor=false&timeout=5');
  await page.waitForSelector('body[data-ready=true]');
  assert.equal(await page.isHidden('label[for=tab6]'), true);
  assert.equal(await page.isChecked('#option-mark-changes'), false);
  assert.equal(await page.isChecked('#mark-changes'), false);
  assert.equal(await page.isChecked('#option-solutions'), false);
  assert.equal(await page.locator('#example-games optgroup[label=Solutions]').count(), 0);
  assert.equal(await page.isChecked('#option-editor'), false);
  assert.equal(await page.evaluate(() => window.logic_game.solver.timeout_ms), 5000);
  await page.goto(base);
  await page.waitForSelector('body[data-ready=true]');
  assert.equal(await page.isVisible('label[for=tab6]'), true);
  assert.equal(await page.isChecked('#option-mark-changes'), true);
  // Turning off the Internals tab while it is open goes to the Control tab
  await page.click('label[for=tab6]');
  await page.click('label[for=tab1]');
  await page.uncheck('#option-internals');
  assert.equal(await page.isHidden('label[for=tab6]'), true);
});

test('testing a strategy on many levels, and playing a level of the test again', async (t) => {
  const page = await open(t, '?file=flag3&tab=4');
  if (!page) return;
  // This strategy only wins when the flag is below the player in the same column
  await set_program(page, 'player_move_program', 'do(move(down)) :- observe(at(R1,C,player)), observe(at(R2,C,flag)), R1 < R2.');
  await page.fill('#test-levels', '6');
  await page.click('#test-button');
  await page.waitForFunction(() => /^Done/.test(document.getElementById('test-progress').textContent), null, { timeout: 120000 });
  const summary = await page.textContent('#test-summary');
  assert.match(summary, /^6 levels: (\d+ won, )?\d+ lost\. \(Kept with this version in the Versions tab\.\)$/);
  const items = page.locator('#test-results li');
  assert.ok(await items.count() > 0);
  const first = await items.first().textContent();
  const [, seed, steps] = /^Level (\d+): LOSE! \(lose\(timeout\)\) \(after (\d+) steps\)/.exec(first);
  // Load the level and play it: the same result
  await items.first().locator('button', { hasText: 'Load this level' }).click();
  await page.waitForSelector('#board-message:not([hidden])');
  assert.equal(await page.textContent('#board-message'), `This is level ${seed} of the test. Play plays it exactly as in the test.`);
  await page.selectOption('#speed-selector', '0');
  await page.click('#play-button');
  await wait_for_verdict(page);
  assert.match(await game_output(page), /^LOSE! \(lose\(timeout\)\)/);
  assert.equal((await game_output(page)).match(/^## STEP \d+ ##$/gm).length, Number(steps));
  // A link to the level gives the same level
  const level_state = await page.evaluate(() => window.logic_game.editors.value('level_state'));
  await page.click('label[for=tab7]');
  await open_sections(page);
  await page.click('button[data-action=share_game]');
  await page.waitForFunction(() => document.getElementById('share-link').value !== '');
  const link = await page.inputValue('#share-link');
  assert.match(link, new RegExp(`&seed=${seed}$`));
  const other = await browser.newPage();
  t.after(() => other.close());
  await other.goto(link);
  await other.waitForSelector('body[data-ready=true]');
  await other.waitForSelector('#board-message:not([hidden])');
  assert.equal(await other.evaluate(() => window.logic_game.editors.value('level_state')), level_state);
  // Any level of the test can be loaded by its number, also one that was won
  await page.click('label[for=tab4]');
  assert.equal(await page.isVisible('#test-level'), true);
  const lost = await items.evaluateAll((lis) => lis.map((li) => Number(/^Level (\d+)/.exec(li.textContent)[1])));
  const won = [1, 2, 3, 4, 5, 6].find((n) => !lost.includes(n));
  const chosen = won ?? lost[0];
  await page.fill('#test-level-number', String(chosen));
  await page.click('#test-level-load');
  await page.waitForFunction((n) => document.getElementById('board-message').textContent === `This is level ${n} of the test. Play plays it exactly as in the test.`, chosen);
  await page.click('#play-button');
  await wait_for_verdict(page);
  assert.match(await game_output(page), won != null ? /^WIN!/ : /^LOSE!/);
  // (a number outside the test)
  await page.fill('#test-level-number', '7');
  await page.click('#test-level-load');
  assert.equal(await page.textContent('#test-level-status'), 'The test played levels 1 to 6.');
});

test('the page works offline after the first visit', async (t) => {
  if (skip) {
    t.skip(skip);
    return;
  }
  const context = await browser.newContext();
  t.after(() => context.close());
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(base);
  await page.waitForSelector('body[data-ready=true]');
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null || location.reload());
  await page.waitForSelector('body[data-ready=true]');
  // Offline: the page, clingo, the fonts and the examples still load
  await context.setOffline(true);
  await page.goto(base + '?file=flag2-with-solutions&tab=4');
  await page.waitForSelector('body[data-ready=true]');
  assert.match(await page.evaluate(() => window.logic_game.editors.value('player_move_program')), /do\(move/);
  await page.selectOption('#speed-selector', '0');
  await page.click('#play-button');
  await wait_for_verdict(page);
  assert.match(await game_output(page), /^WIN!/);
  assert.equal(await page.evaluate(() => document.fonts.check('16px FontAwesome', '\uf024')), true);
  assert.deepEqual(errors, []);
});

test('the offline copy holds every file that the page loads', async (t) => {
  const page = await open(t, '?editor=true&internals=true&solutions=true');
  if (!page) return;
  const loaded = new Set();
  const record = (url) => {
    if (url.startsWith(base)) loaded.add(url.slice(base.length).replace(/\?.*$/, '') || './');
  };
  page.on('request', (r) => record(r.url()));
  page.on('worker', (w) => record(w.url()));
  await page.reload();
  await page.waitForSelector('body[data-ready=true]');
  await page.evaluate(() => document.fonts.ready);
  await page.selectOption('#speed-selector', '0');
  await page.click('#play-button');
  await wait_for_verdict(page);
  for (const tab of [2, 3, 4, 5, 6, 7]) await page.click(`label[for=tab${tab}]`);
  await page.waitForTimeout(300);
  const source = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');
  const precache = new Set(eval(/const PRECACHE = (\[[\s\S]*?\n\]);/.exec(source)[1]));
  const missing = [...loaded].filter((f) => f !== 'sw.js' && f !== 'favicon.ico' && !precache.has(f));
  assert.deepEqual(missing, [], 'add these files to PRECACHE in sw.js');
  // and every file in the list exists
  for (const f of precache) if (f !== './') assert.ok(fs.existsSync(path.join(ROOT, f)), f);
});

test('the page fits on a phone', async (t) => {
  if (skip) {
    t.skip(skip);
    return;
  }
  const context = await browser.newContext({ ...devices['iPhone 13'], serviceWorkers: 'block' });
  t.after(() => context.close());
  const page = await context.newPage();
  await page.goto(base);
  await page.waitForSelector('body[data-ready=true]');
  for (const tab of [1, 2, 3, 4, 5, 7]) {
    await page.click(`label[for=tab${tab}]`);
    const [scroll, width] = await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
    assert.ok(scroll <= width, `tab ${tab}: the page is ${scroll} pixels wide on a ${width} pixel screen`);
  }
  // All tabs on one row
  const tops = await page.evaluate(() => [...document.querySelectorAll('label[name=tabs]')]
    .filter((l) => l.offsetParent).map((l) => Math.round(l.getBoundingClientRect().top)));
  assert.ok(Math.max(...tops) - Math.min(...tops) <= 4, JSON.stringify(tops));
  // Long lines in the editors are wrapped
  assert.equal(await page.evaluate(() => window.logic_game.editors.get('player_move_program').session.getUseWrapMode()), true);
  // and the board fits
  const board = await page.locator('#visual').boundingBox();
  assert.ok(board.x >= 0 && board.x + board.width <= 390, JSON.stringify(board));
});

test('the texts of the tabs and the info pop-ups are loaded', async (t) => {
  const page = await open(t, '?internals=true');
  if (!page) return;
  await page.click('label[for=tab2]');
  assert.match(await page.textContent('#section-instructions'), /observe/);
  // example code in the texts is shown in (read-only) editors
  assert.ok(await page.locator('#section-instructions .ace_editor').count() > 0);
  await page.click('label[for=tab6]');
  assert.match(await page.textContent('#section-internals'), /current-state rules/);
  // an (i) link opens its pop-up, Escape closes it
  await page.click('label[for=tab3]');
  await page.locator('#section-game-rules a.modal-link').first().click();
  await page.waitForSelector('.modal.is-visible');
  await page.keyboard.press('Escape');
  await page.waitForSelector('.modal.is-visible', { state: 'detached' });
  await page.locator('#section-game-rules a.modal-link').first().click();
  await page.click('.modal.is-visible [data-close]');
  assert.equal(await page.locator('.modal.is-visible').count(), 0);
  assert.deepEqual(page.errors, []);
});

// Hover (with a mouse event) over row/column of an editor; returns the help shown, or null.
async function hover_help(page, key, row, column) {
  return page.evaluate(async ([key, row, column]) => {
    const editor = window.logic_game.editors.get(key);
    editor.container.scrollIntoView({ block: 'center' });
    const c = editor.renderer.textToScreenCoordinates(row, column);
    const y = c.pageY + editor.renderer.lineHeight / 2;
    editor.container.dispatchEvent(new MouseEvent('mousemove', { clientX: c.pageX + 2, clientY: y, bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 300));
    const tip = document.querySelector('.predicate-help');
    return tip && !tip.hidden ? tip.textContent : null;
  }, [key, row, column]);
}

test('below the board: why the player made no move, with a link to the rule', async (t) => {
  const page = await open(t, '?file=flag3');
  if (!page) return;
  // (the flag is not below the player: the rule never applies)
  await set_program(page, 'player_move_program', '% go down to the flag\ndo(move(down)) :- observe(at(R1,C,player)), observe(at(R2,C,flag)), R1 < R2.');
  await page.selectOption('#speed-selector', '0');
  await page.click('#play-button');
  await wait_for_verdict(page);
  await page.fill('#timeline', '1');
  await page.dispatchEvent('#timeline', 'input');
  assert.match(await page.textContent('#timeline-label'), /the player made no move$/);
  assert.match(await page.textContent('#move-note'), /^None of your rules for do\(\.\.\.\) applied in this step.* See line 2 of your strategy\.$/);
  // (below the buttons)
  const buttons = await page.locator('.game-controls').boundingBox();
  assert.ok((await page.locator('#move-note').boundingBox()).y > buttons.y + buttons.height - 1);
  // The line number goes to the rule
  await page.locator('#move-note button', { hasText: '2' }).click();
  assert.equal(await page.isChecked('#tab4'), true);
  assert.equal(await page.evaluate(() => window.logic_game.editors.get('player_move_program').getCursorPosition().row), 1);
  // After a change, the note says that it is about the game that was played
  await set_program(page, 'player_move_program', 'do(move(left)).');
  await page.click('#timeline-next');
  await page.click('#timeline-prev');
  assert.match(await page.textContent('#move-note'), /You changed your strategy since this game/);
  // No note for a step with one move
  await page.click('#play-button');
  await wait_for_verdict(page);
  await page.fill('#timeline', '1');
  await page.dispatchEvent('#timeline', 'input');
  assert.equal(await page.isHidden('#move-note'), true);
});

test('the Debug tab marks what changed since the step before, or shows only that', async (t) => {
  const page = await open(t, '?file=flag3-with-solutions&tab=5');
  if (!page) return;
  await page.selectOption('#speed-selector', '0');
  await page.click('#play-button');
  await wait_for_verdict(page);
  await page.fill('#timeline', '2');
  await page.dispatchEvent('#timeline', 'input');
  // (step 2: the player moved, so its place and the time are new)
  const value = (i) => page.locator('#debug-step .output-editor').nth(i).evaluate((e) => ace.edit(e).getValue());
  assert.match(await page.textContent('.debug-legend'), /^Compared with the step before/);
  assert.match(await value(0), /^current_time\(1\)\.\n.*setting\(grid_width/s);
  assert.ok(await page.locator('#debug-step .output-editor').first().locator('.fact-new').count() >= 2);
  assert.match(await page.locator('.debug-gone').first().textContent(), /^Gone since the step before: current_time\(0\)\. .*observe\(at\(\d+,\d+,player\)\)\.$/);
  // Only what changed
  await page.check('#option-only-changes');
  assert.match(await value(0), /^current_time\(1\)\.\nobserve\(at\(\d+,\d+,player\)\)\.$/);
  assert.match(await page.locator('.debug-unchanged').first().textContent(), /^⋯ \d+ unchanged facts not shown$/);
  assert.match(await page.locator('.debug-gone').first().textContent(), /^Gone since the step before: current_time\(0\)\. observe\(at\(\d+,\d+,player\)\)\.$/);
  // The first step has nothing to compare with
  await page.fill('#timeline', '1');
  await page.dispatchEvent('#timeline', 'input');
  assert.equal(await page.locator('.debug-legend').count(), 0);
  assert.match(await value(0), /setting\(grid_width/);
  // (an option, also in a link)
  await page.goto(base + '?only_changes=false&tab=5');
  await page.waitForSelector('body[data-ready=true]');
  assert.equal(await page.isChecked('#option-only-changes'), false);
});

test('the Debug tab shows the same after going through the steps as when going to a step at once', async (t) => {
  // (its editors are used again from step to step: nothing of an earlier step may stay behind)
  const debug_view = (page) => page.evaluate(() => [...document.querySelectorAll('#debug-step .output-editor')].map((elem) => {
    const editor = ace.edit(elem);
    const markers = Object.values(editor.session.getMarkers()).filter((m) => m.clazz === 'fact-new').map((m) => m.range.start.row).sort((a, b) => a - b);
    return { text: editor.getValue(), markers, height: elem.offsetHeight, undo: editor.session.getUndoManager().hasUndo() };
  }));
  const play = async (page) => {
    await page.selectOption('#speed-selector', '-1');
    await page.click('#play-button');
    await wait_for_verdict(page);
    await page.evaluate(() => document.activeElement.blur());
  };
  const settled = (page) => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const stepping = await open(t, '?file=flag3-with-solutions&tab=5');
  if (!stepping) return;
  await play(stepping);
  await stepping.keyboard.press('Home');
  for (let i = 0; i < 5; i++) await stepping.keyboard.press('ArrowRight');
  await stepping.keyboard.press('ArrowLeft');
  await stepping.keyboard.press('ArrowRight');
  await settled(stepping);
  const at_once = await open(t, '?file=flag3-with-solutions&tab=5');
  await play(at_once);
  await at_once.fill('#timeline', '6');
  await at_once.dispatchEvent('#timeline', 'input');
  await settled(at_once);
  const [a, b] = [await debug_view(stepping), await debug_view(at_once)];
  assert.ok(a.length > 0);
  assert.ok(a.some((e) => e.markers.length > 0));
  assert.deepEqual(a, b);
  assert.ok(a.every((e) => e.height > 0 && !e.undo));
});

test('facts and the board: hovering over a fact shows its cell, and over a cell its facts', async (t) => {
  const page = await open(t, '?file=flag3-with-solutions&tab=5');
  if (!page) return;
  await page.selectOption('#speed-selector', '0');
  await page.click('#play-button');
  await wait_for_verdict(page);
  await page.fill('#timeline', '1');
  await page.dispatchEvent('#timeline', 'input');
  // Over the fact of the player in the player input: its cell on the board
  const point = await page.evaluate(() => {
    const editor = ace.edit(document.querySelector('#debug-step .output-editor'));
    editor.container.scrollIntoView({ block: 'center' });
    const lines = editor.getValue().split('\n');
    const row = lines.findIndex((l) => /^observe\(at\(\d+,\d+,player\)\)\.$/.test(l));
    const c = editor.renderer.textToScreenCoordinates(row, 3);
    const [, r, col] = /at\((\d+),(\d+)/.exec(lines[row]);
    return { x: c.pageX + 2, y: c.pageY + editor.renderer.lineHeight / 2, index: (Number(r) - 1) * 8 + Number(col) };
  });
  await page.mouse.move(point.x, point.y);
  await page.waitForFunction(() => document.querySelectorAll('.grid-visual-cell.linked').length === 1);
  assert.equal(await page.evaluate(() => [...document.getElementById('visual').children].findIndex((c) => c.classList.contains('linked')) + 1), point.index);
  // (and the facts about that cell)
  assert.ok(await page.locator('#debug-step .fact-linked').count() >= 1);
  // Away from the editors: no highlights
  await page.mouse.move(1, 1);
  await page.waitForFunction(() => !document.querySelector('.grid-visual-cell.linked'));
  // Over a cell: the facts about it
  await page.locator('.grid-visual-cell').nth(point.index - 1).hover();
  await page.waitForFunction(() => document.querySelectorAll('#debug-step .fact-linked').length >= 1);
  await page.mouse.move(1, 1);
  await page.waitForFunction(() => document.querySelectorAll('#debug-step .fact-linked').length === 0);
  // In the other tabs, a cell is not highlighted when hovering over it
  await page.click('label[for=tab4]');
  await page.locator('.grid-visual-cell').nth(point.index - 1).hover();
  await page.waitForTimeout(200);
  assert.equal(await page.locator('.grid-visual-cell.linked').count(), 0);
  // (and leaving the Debug tab while hovering takes the highlight away)
  await page.click('label[for=tab5]');
  await page.locator('.grid-visual-cell').nth(point.index - 1).hover();
  await page.waitForFunction(() => document.querySelectorAll('.grid-visual-cell.linked').length === 1);
  await page.evaluate(() => { document.getElementById('tab4').checked = true; document.getElementById('tab4').dispatchEvent(new Event('change')); });
  assert.equal(await page.locator('.grid-visual-cell.linked').count(), 0);
});

test('moving through the steps keeps the page where it was scrolled to', async (t) => {
  const page = await open(t, '?file=flag11-with-solutions-a&tab=5');
  if (!page) return;
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.selectOption('#speed-selector', '-1');
  await page.click('#play-button');
  await wait_for_verdict(page);
  await page.evaluate(() => document.activeElement.blur());
  await page.keyboard.press('Home');
  for (let i = 0; i < 5; i++) {
    await page.evaluate(() => window.scrollTo(0, 500));
    await page.keyboard.press('ArrowRight');
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const y = await page.evaluate(() => window.scrollY);
    assert.ok(Math.abs(y - 500) < 30, `scrolled to ${y} after step ${i + 2}`);
  }
});

test('after a change, Play again plays the level again and comes back to the same time', async (t) => {
  const page = await open(t, '?file=flag3-with-solutions');
  if (!page) return;
  await page.selectOption('#speed-selector', '0');
  await page.click('#play-button');
  await wait_for_verdict(page);
  assert.equal(await page.locator('.replay-button').count(), 0);
  await page.fill('#timeline', '3');
  await page.dispatchEvent('#timeline', 'input');
  assert.match(await page.textContent('#timeline-label'), /^Time 2 of /);
  await set_program(page, 'player_move_program', (await value(page, 'player_move_program')) + '\n% changed');
  assert.match(await page.textContent('#board-status'), /Since then, you changed: Player strategy\./);
  await page.click('.replay-button');
  await page.waitForFunction(() => /WIN!|LOSE!/.test(window.logic_game.game_output()) && !document.getElementById('play-button').disabled);
  assert.match(await page.textContent('#timeline-label'), /^Time 2 of /);
  assert.equal(await page.locator('.replay-button').count(), 0);
});

test('keyboard shortcuts: play, step, pause, and moving through the timeline', async (t) => {
  const page = await open(t, '?file=flag3-with-solutions');
  if (!page) return;
  await page.selectOption('#speed-selector', '0');
  await page.locator('h1').click();      // (the focus on the page, not in a field)
  // Space: one step at a time
  await page.keyboard.press('Space');
  await page.waitForFunction(() => document.getElementById('timeline-label').textContent === 'Time 1 of 1');
  await page.keyboard.press('Space');
  await page.waitForFunction(() => document.getElementById('timeline-label').textContent === 'Time 2 of 2');
  // Ctrl+Enter: play on
  await page.keyboard.press('Control+Enter');
  await wait_for_verdict(page);
  await page.waitForFunction(() => !document.getElementById('play-button').disabled);
  // The timeline: Home, End and the arrow keys
  await page.keyboard.press('Home');
  assert.match(await page.textContent('#timeline-label'), /^Time 0 of (\d+)/);
  await page.keyboard.press('ArrowRight');
  assert.match(await page.textContent('#timeline-label'), /^Time 1 of /);
  await page.keyboard.press('ArrowLeft');
  assert.match(await page.textContent('#timeline-label'), /^Time 0 of /);
  await page.keyboard.press('End');
  const end = await page.textContent('#timeline-label');
  assert.match(end, /^Time (\d+) of \1/);
  // While typing in an editor, Space and the arrows are the editor's; Ctrl+Enter plays
  await page.click('label[for=tab4]');
  const before = await value(page, 'player_move_program');
  await page.evaluate(() => { const e = window.logic_game.editors.get('player_move_program'); e.focus(); e.navigateFileEnd(); });
  await page.keyboard.press('ArrowLeft');
  assert.equal(await page.textContent('#timeline-label'), end);
  await page.keyboard.press('Control+Enter');
  await page.waitForFunction(() => /STEP 1 /.test(window.logic_game.game_output()));
  assert.equal(await value(page, 'player_move_program'), before);
});

test('accessibility: the tabs and the cells of the board can be used with the keyboard', async (t) => {
  const page = await open(t, '?file=flag3-with-solutions');
  if (!page) return;
  // The tabs: reachable, and the arrow keys go from tab to tab
  assert.equal(await page.getAttribute('label[for=tab4]', 'title'), 'Strategy');
  await page.focus('#tab1');
  await page.keyboard.press('ArrowRight');
  assert.equal(await page.isChecked('#tab2'), true);
  assert.equal(await page.isVisible('#section-instructions'), true);
  // The board: every cell says what it holds
  const label = (i) => page.locator('#visual .grid-visual-cell').nth(i).getAttribute('aria-label');
  assert.equal(await label(0), 'Row 1, column 1: empty');
  const player = await page.evaluate(() => [...document.querySelectorAll('#visual .grid-visual-cell')].findIndex((c) => /: player$/.test(c.getAttribute('aria-label'))));
  assert.ok(player >= 0);
  // One cell can be reached with Tab; the arrow keys move from cell to cell
  assert.equal(await page.locator('#visual [tabindex="0"]').count(), 1);
  await page.focus('#visual [tabindex="0"]');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowDown');
  assert.equal(await page.evaluate(() => document.activeElement.getAttribute('aria-label')), 'Row 2, column 2: empty');
  await page.keyboard.press('End');
  assert.match(await page.evaluate(() => document.activeElement.getAttribute('aria-label')), /^Row 2, column 8: /);
  // The focused cell has an outline; its facts are only highlighted in the Debug tab (as when hovering)
  assert.equal(await page.evaluate(() => document.activeElement.matches(':focus-visible')), true);
  assert.equal(await page.locator('.grid-visual-cell.linked').count(), 0);
  await page.click('label[for=tab5]');
  await page.focus('#visual [tabindex="0"]');
  assert.equal(await page.locator('.grid-visual-cell.linked').count(), 1);
  // After a game, the focus stays on its cell while going through time
  await page.selectOption('#speed-selector', '0');
  await page.click('#play-button');
  await wait_for_verdict(page);
  await page.focus('#visual [tabindex="0"]');
  const where = await page.evaluate(() => document.activeElement.getAttribute('aria-label').split(':')[0]);
  await page.click('#timeline-prev');
  await page.focus('#visual [tabindex="0"]');
  assert.equal(await page.evaluate(() => document.activeElement.getAttribute('aria-label').split(':')[0]), where);
});

test('a slow download of clingo shows its progress, and clingo is downloaded once', async (t) => {
  if (skip) {
    t.skip(skip);
    return;
  }
  const page = await browser.newPage({ serviceWorkers: 'block' });
  t.after(() => page.close());
  let downloads = 0;
  await page.route('**/clingo.wasm', async (route) => {
    downloads++;
    await new Promise((resolve) => setTimeout(resolve, 1500));
    await route.continue();
  });
  await page.goto(base + '?file=flag3');
  await page.waitForSelector('#loading:not([hidden])');
  assert.match(await page.textContent('#loading-text'), /^Loading clingo, the solver that runs the programs/);
  await page.waitForSelector('body[data-ready=true]', { timeout: 30000 });
  assert.equal(await page.isHidden('#loading'), true);
  assert.ok(await page.locator('#visual .grid-visual-cell').count() > 0);
  assert.equal(downloads, 1);
});

test('help about special predicates in the editors', async (t) => {
  const page = await open(t, '?tab=4');
  if (!page) return;
  await set_program(page, 'player_move_program', 'do(move(down)) :- observe(at(R1,C,player)), at(R2,C,flag).\nfoo :- bar.');
  assert.equal(await hover_help(page, 'player_move_program', 0, 1),
    "do/1do(X): a move of the player, such as do(move(up)). This program passes it on to nature's program.");
  assert.match(await hover_help(page, 'player_move_program', 0, 20), /^observe\/1observe\(X\): what the player observes.*This program gets it from the game\.$/);
  assert.match(await hover_help(page, 'player_move_program', 0, 45), /^at\/3at\(R,C,O\).*The player's program does not get it \(it is used by level generation/);
  assert.equal(await hover_help(page, 'player_move_program', 1, 1), null);       // not special
  // Autocompletion while typing
  await page.evaluate(() => {
    const editor = window.logic_game.editors.get('player_move_program');
    editor.focus();
    editor.navigateFileEnd();
  });
  await page.keyboard.type('\nreme');
  await page.waitForSelector('.ace_autocomplete', { state: 'visible', timeout: 5000 });
  assert.match(await page.textContent('.ace_autocomplete'), /remember\/1/);
  await page.waitForTimeout(300);      // (until the list is updated for all typed letters)
  await page.keyboard.press('Enter');
  assert.equal(await page.evaluate(() => window.logic_game.editors.value('player_move_program').split('\n').pop()), 'remember(');
  // No suggestions while typing a variable
  await page.keyboard.type('X');
  await page.waitForTimeout(400);
  assert.equal(await page.locator('.ace_autocomplete').isVisible(), false);
});

// ---- The Versions tab ----------------------------------------------------------------

const value = (page, key) => page.evaluate((k) => window.logic_game.editors.value(k), key);
const snapshot_names = (page) => page.locator('#snapshot-list li[data-id] .snapshot-name').allTextContents();

async function wait_saved(page, text) {
  await page.waitForFunction((t) => {
    const w = window.logic_game.work.origins().map((o) => window.logic_game.work.load(o));
    return w.some((x) => x.game.player_move_program === t);
  }, text);
}

test('the Versions tab: the game file to hand in first, the rest in sections that stay open', async (t) => {
  const page = await open(t, '?file=flag3&tab=7');
  if (!page) return;
  // At first, only the main things are shown
  assert.equal(await page.isVisible('button[data-action=download_game]'), true);
  assert.equal(await page.isVisible('#file-input + label, label[for=file-input]'), true);
  assert.equal(await page.locator('#section-versions details[open]').count(), 0);
  assert.equal(await page.isVisible('#snapshot-button'), false);
  assert.equal(await page.textContent('#game-reminder'), '');
  // A change: not downloaded yet
  // (the Versions tab is updated when the work is saved, shortly after a change)
  const reminder = (pattern) => page.waitForFunction((source) => new RegExp(source).test(document.getElementById('game-reminder').textContent), pattern.source);
  await set_program(page, 'player_move_program', 'do(move(down)).');
  await reminder(/^You have not downloaded the game file of Find the flag 3 yet\.$/);
  // Downloaded: the game file is the current version
  const [download] = await Promise.all([page.waitForEvent('download'), page.click('button[data-action=download_game]')]);
  assert.equal(download.suggestedFilename(), 'find-the-flag-3.json');
  assert.match(await page.textContent('#game-reminder'), /^You downloaded the game file on .*: that is your current version\.$/);
  // Changed after the download: download it again
  await set_program(page, 'player_move_program', 'do(move(up)).');
  await reminder(/^You changed Find the flag 3 since you downloaded the game file on .*: download it again/);
  assert.equal(await page.locator('#game-reminder.attention').count(), 1);
  // The snapshots: their number in the heading; an opened section stays open
  await page.click('summary:has-text("Snapshots of")');
  await page.fill('#snapshot-name', 'up');
  await page.click('#snapshot-button');
  assert.equal(await page.textContent('#snapshot-count'), '(1)');
  await page.reload();
  await page.waitForSelector('body[data-ready=true]');
  assert.equal(await page.isVisible('#snapshot-button'), true);
  assert.equal(await page.isVisible('button[data-action=share_game]'), false);
  // Comparing opens the section of the comparison
  await page.click('summary:has-text("Snapshots of")');
  assert.equal(await page.isVisible('#snapshot-button'), false);
  await page.evaluate(() => window.logic_game.versions_tab.compare('original'));
  assert.equal(await page.isVisible('#diff-output'), true);
});

test('snapshots: keep, compare, take one program, restore', async (t) => {
  const page = await open(t, '?file=flag3&tab=7');
  if (!page) return;
  await open_sections(page);
  page.on('dialog', (dialog) => dialog.accept());
  await set_program(page, 'player_move_program', 'do(move(down)).');
  await set_program(page, 'goal_program', 'win :- at(R,C,player), at(R,C,flag).');
  await wait_saved(page, 'do(move(down)).');
  await page.fill('#snapshot-name', 'goes down');
  await page.fill('#snapshot-note', 'only down');
  await page.click('#snapshot-button');
  assert.deepEqual(await snapshot_names(page), ['goes down']);
  assert.equal(await page.textContent('#snapshot-list li[data-id] .snapshot-note'), 'only down');
  // A name is not HTML
  await set_program(page, 'player_move_program', 'do(move(up)).\n% now up');
  await set_program(page, 'goal_program', 'win :- at(R,C,player).');
  await wait_saved(page, 'do(move(up)).\n% now up');
  await page.fill('#snapshot-name', '<img src=x onerror=alert(1)>');
  await page.click('#snapshot-button');
  assert.deepEqual(await snapshot_names(page), ['<img src=x onerror=alert(1)>', 'goes down']);
  // Change it again, and compare with "goes down"
  await set_program(page, 'player_move_program', 'do(move(left)).');
  await wait_saved(page, 'do(move(left)).');
  await page.locator('#snapshot-list li[data-id]').nth(1).getByText('Compare with current').click();
  const strategy = page.locator('.diff-program[data-field=player_move_program]');
  assert.deepEqual(await strategy.locator('.diff-del').allTextContents(), ['1− do(move(down)).']);
  assert.deepEqual(await strategy.locator('.diff-add').allTextContents(), ['1+ do(move(left)).']);
  assert.match(await page.textContent('.diff-unchanged'), /No changes: Auxiliary program, .*Nature's moves\./);
  // Take only the winning conditions of "goes down"
  await page.locator('.diff-program[data-field=goal_program]').getByText('Use the Winning conditions of "goes down"').click();
  assert.equal(await value(page, 'goal_program'), 'win :- at(R,C,player), at(R,C,flag).');
  assert.equal(await value(page, 'player_move_program'), 'do(move(left)).');
  // (the version before was kept)
  assert.match((await snapshot_names(page))[0], /^Automatic snapshot before taking a program/);
  // Restore all of "goes down"
  await page.locator('#snapshot-list li[data-id]', { hasText: 'only down' }).getByText('Restore').click();
  await page.waitForFunction(() => window.logic_game.editors.value('player_move_program') === 'do(move(down)).');
  await page.waitForSelector('#snapshot-list li.current:has-text("The same as the snapshot \\"goes down\\"")');
  // Automatic snapshots can be hidden, and named to keep them
  await page.uncheck('#show-auto');
  assert.deepEqual(await snapshot_names(page), ['<img src=x onerror=alert(1)>', 'goes down']);
  await page.check('#show-auto');
  const auto = page.locator('#snapshot-list li.auto').first();
  await auto.getByText('Name and keep').click();
  await auto.locator('input[type=text]').fill('left');
  await auto.getByText('Save').click();
  assert.equal(await page.locator('#snapshot-list li.auto').count(), 1);
  // After a reload, everything is still there
  await page.reload();
  await page.waitForSelector('body[data-ready=true]');
  assert.equal((await snapshot_names(page)).length, 4);
  assert.deepEqual(page.errors, []);
});

test('test results are kept with the version, and going back to the original keeps a snapshot', async (t) => {
  const page = await open(t, '?file=flag1-with-solutions&tab=4');
  if (!page) return;
  page.on('dialog', (dialog) => dialog.accept());
  await page.fill('#test-levels', '3');
  await page.click('#test-button');
  await page.waitForFunction(() => /Done/.test(document.getElementById('test-progress').textContent), null, { timeout: 60000 });
  assert.match(await page.textContent('#test-summary'), /3 levels: 3 won\. \(Kept with this version in the Versions tab\.\)/);
  await page.click('#test-summary a.tab-link');
  assert.equal(await page.isChecked('#tab7'), true);
  assert.equal(await page.textContent('#snapshot-list .snapshot-badge.tested'), 'Test: 3 of 3 won');
  // Back to the original: the changed version is kept
  await set_program(page, 'player_move_program', 'do(wait).');
  await wait_saved(page, 'do(wait).');
  await page.click('button[data-action=revert_to_original]');
  await page.waitForSelector('#work-notice', { state: 'hidden' });
  const list = await page.evaluate(() => window.logic_game.versions.list('example:flag1-with-solutions'));
  assert.deepEqual(list.map((s) => [s.reason, s.game.player_move_program === 'do(wait).']), [['tested', false], ['revert', true]]);
});

test('project files: download, and continue in another browser', async (t) => {
  const page = await open(t, '?file=flag2&tab=7');
  if (!page) return;
  await open_sections(page);
  await set_program(page, 'player_move_program', '% my work\ndo(move(down)).');
  await wait_saved(page, '% my work\ndo(move(down)).');
  await page.fill('#snapshot-name', 'first');
  await page.click('#snapshot-button');
  await set_program(page, 'player_move_program', '% my work\ndo(move(up)).');
  await wait_saved(page, '% my work\ndo(move(up)).');
  assert.match(await page.textContent('#download-reminder'), /not downloaded the project file of Find the flag 2 yet/);
  const [download] = await Promise.all([page.waitForEvent('download'), page.click('button[data-action=download_project]')]);
  assert.match(download.suggestedFilename(), /^find-the-flag-2-project-\d{4}-\d\d-\d\d\.json$/);
  const file = fs.readFileSync(await download.path());
  assert.match(await page.textContent('#download-reminder'), /nothing has changed since then/);
  // Another browser, with work of its own on the same game
  const context = await browser.newContext({ serviceWorkers: 'block' });
  t.after(() => context.close());
  const other = await context.newPage();
  other.on('dialog', (dialog) => dialog.accept());
  await other.goto(base + '?file=flag2&tab=7');
  await other.waitForSelector('body[data-ready=true]');
  await open_sections(other);
  await set_program(other, 'player_move_program', 'other work.');
  await wait_saved(other, 'other work.');
  await other.setInputFiles('#file-input', { name: 'p.json', mimeType: 'application/json', buffer: file });
  await other.waitForFunction(() => /Done loading the project Find the flag 2 \(1 snapshot\)/.test(document.getElementById('upload-status').textContent));
  assert.equal(await value(other, 'player_move_program'), '% my work\ndo(move(up)).');
  assert.deepEqual((await snapshot_names(other)).sort(), ['Automatic snapshot before loading a file', 'first']);
  assert.match(await other.textContent('#work-notice'), /Your own version, saved in this browser/);
  assert.equal(await other.textContent('#game-title'), 'Find the flag 2');
  // A plain game file still loads as before; a file that is not a game is refused
  await other.setInputFiles('#file-input', { name: 'x.json', mimeType: 'application/json', buffer: Buffer.from('{"a": 1}') });
  await other.waitForFunction(() => /Loading failed: this is not a game or project file/.test(document.getElementById('upload-status').textContent));
});

test('everything in this browser: the list, a backup, and opening a game from the list', async (t) => {
  const page = await open(t, '?file=flag1&tab=7');
  if (!page) return;
  await open_sections(page);
  page.on('dialog', (dialog) => dialog.accept());
  await set_program(page, 'player_move_program', 'one.');
  await wait_saved(page, 'one.');
  const game = { aux_program: '% uploaded', level_gen_program: 'setting(grid_width(2)). setting(grid_height(1)). at(1,1,player).' };
  await page.setInputFiles('#file-input', { name: 'mine.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(game)) });
  await page.waitForFunction(() => /Done loading/.test(document.getElementById('upload-status').textContent));
  await set_program(page, 'player_move_program', 'two.');
  await wait_saved(page, 'two.');
  const rows = page.locator('#saved-games tbody tr');
  assert.equal(await rows.count(), 2);
  assert.match(await rows.nth(1).textContent(), /mine\.json \(open now\)/);
  // Open the other game from the list
  await rows.nth(0).getByText('Open').click();
  await page.waitForFunction(() => window.logic_game.editors.value('player_move_program') === 'one.');
  // A backup, loaded into another browser
  const [download] = await Promise.all([page.waitForEvent('download'), page.click('#backup-button')]);
  const context = await browser.newContext({ serviceWorkers: 'block' });
  t.after(() => context.close());
  const other = await context.newPage();
  other.on('dialog', (dialog) => dialog.accept());
  await other.goto(base + '?tab=7');
  await other.waitForSelector('body[data-ready=true]');
  await open_sections(other);
  await other.setInputFiles('#file-input', { name: 'backup.json', mimeType: 'application/json', buffer: fs.readFileSync(await download.path()) });
  await other.waitForFunction(() => /Done loading: 2 games/.test(document.getElementById('upload-status').textContent));
  await other.locator('#saved-games tbody tr', { hasText: 'mine.json' }).getByText('Open').click();
  await other.waitForFunction(() => window.logic_game.editors.value('player_move_program') === 'two.');
  assert.equal(await value(other, 'aux_program'), '% uploaded');
  // Forget one game
  await other.locator('#saved-games tbody tr', { hasText: 'Find the flag 1' }).getByText('Forget').click();
  assert.equal(await other.locator('#saved-games tbody tr').count(), 1);
});

// ---- The tutorial ---------------------------------------------------------------------

test('reset everything: a fresh start, as on a first visit', async (t) => {
  const page = await open(t, '?tab=4&mark_changes=true');
  if (!page) return;
  page.on('dialog', (dialog) => dialog.accept());
  await page.click('#tutorial-invite button[data-action=dismiss_tutorial]');
  await page.click('label[for=tab1]');
  await page.check('#option-solutions');
  await set_program(page, 'player_move_program', 'do(move(up)).');
  await page.waitForFunction(() => window.logic_game.work.origins().length === 1);
  await page.click('label[for=tab7]');
  await open_sections(page);
  await page.fill('#snapshot-name', 'kept');
  await page.click('#snapshot-button');
  await page.evaluate(() => localStorage.setItem('someone-else', 'stays'));
  await Promise.all([page.waitForNavigation(), page.click('#reset-everything-button')]);
  await page.waitForSelector('body[data-ready=true]');
  assert.equal(new URL(page.url()).search, '');
  assert.deepEqual(await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('logic-game:'))), []);
  assert.equal(await page.evaluate(() => localStorage.getItem('someone-else')), 'stays');
  assert.notEqual(await page.evaluate(() => window.logic_game.editors.value('player_move_program')), 'do(move(up)).');
  assert.equal(await page.isChecked('#tab1'), true);
  assert.equal(await page.isChecked('#option-solutions'), false);
  assert.equal(await page.isVisible('#tutorial-invite'), true);
  assert.deepEqual(page.errors, []);
});

test('new players are invited to the tutorial, once', async (t) => {
  const page = await open(t);
  if (!page) return;
  assert.equal(await page.isVisible('#tutorial-invite'), true);
  await page.click('#tutorial-invite button[data-action=dismiss_tutorial]');
  assert.equal(await page.isHidden('#tutorial-invite'), true);
  await page.reload();
  await page.waitForSelector('body[data-ready=true]');
  assert.equal(await page.isHidden('#tutorial-invite'), true);
  // Someone who opens a shared game is not invited
  const other = await browser.newPage({ serviceWorkers: 'block' });
  t.after(() => other.close());
  await other.goto(base + '#game=' + await page.evaluate(async () => {
    const { encode_game } = await import('./js/storage.js');
    return encode_game(window.logic_game.editors.game());
  }));
  await other.waitForSelector('body[data-ready=true]');
  assert.equal(await other.isHidden('#tutorial-invite'), true);
});

test('the tutorial: from the first move to a winning strategy', async (t) => {
  const page = await open(t, '?file=flag3&tab=4');
  if (!page) return;
  // Work on another game is not touched
  await set_program(page, 'player_move_program', 'my own work.');
  await wait_saved(page, 'my own work.');
  await page.selectOption('#speed-selector', '0');
  await page.click('label[for=tab1]');
  await page.click('#section-control button[data-action=start_tutorial]');
  const count = () => page.textContent('.tutorial-count');
  const next = () => page.click('.tutorial-next');
  await page.waitForFunction(() => document.querySelector('.tutorial-count')?.textContent === '1 of 12');
  assert.equal(await value(page, 'player_move_program'), '');
  await next();
  assert.match(await page.getAttribute('#visual-container', 'class'), /tutorial-target/);
  await next();
  // (the highlight of the Play button is not cut off by the pane of the board, which can scroll)
  const room = await page.evaluate(() => {
    const pane = document.getElementById('board-pane').getBoundingClientRect();
    const play = document.getElementById('play-button').getBoundingClientRect();
    return Math.min(play.left - pane.left, pane.right - play.right, play.top - pane.top);
  });
  assert.ok(room >= 6, `only ${room}px around the Play button`);
  // Steps that wait for the player
  assert.equal(await page.isDisabled('.tutorial-next'), true);
  await page.click('#play-button');
  await page.waitForSelector('.tutorial-after', { timeout: 60000 });
  await next();
  await page.click('label[for=tab4]');
  await page.waitForFunction(() => document.querySelector('.tutorial-count').textContent === '5 of 12');
  await page.click('.tutorial-do-it');
  await page.waitForSelector('.tutorial-after');
  await next();
  await page.click('#play-button');
  await page.waitForSelector('.tutorial-after', { timeout: 60000 });
  await next();
  await page.click('.tutorial-do-it');
  await page.waitForFunction(() => !document.querySelector('.tutorial-next').disabled);
  await next();
  await page.click('#play-button');
  await page.waitForSelector('.tutorial-after', { timeout: 60000 });
  assert.match(await game_output(page), /^WIN!/);
  await next();
  await next();
  await next();
  // (a step that can be skipped)
  assert.equal(await count(), '11 of 12');
  assert.equal(await page.textContent('.tutorial-next'), 'Skip');
  await page.click('label[for=tab7]');
  await page.click('#snapshot-button');
  await page.waitForSelector('.tutorial-after');
  await next();
  // The end: on to the next game
  assert.equal(await page.locator('.tutorial-body button[data-example]').count(), 6);
  await page.click('.tutorial-body button[data-example=flag2]');
  await page.waitForSelector('#tutorial-card', { state: 'detached' });
  await page.waitForFunction(() => /flag is randomly placed/.test(window.logic_game.editors.value('level_gen_program')));
  assert.equal(await page.isChecked('#tab4'), true);
  assert.equal(await page.locator('.tutorial-target').count(), 0);
  assert.equal(await page.evaluate(() => window.logic_game.work.load('example:flag3').game.player_move_program), 'my own work.');
  assert.deepEqual(page.errors, []);
});

test('the first games can be loaded from the Control tab, and the tutorial started from a link', async (t) => {
  const page = await open(t, '?tutorial=true');
  if (!page) return;
  await page.waitForSelector('#tutorial-card');
  await page.click('.tutorial-close');
  await page.waitForSelector('#tutorial-card', { state: 'detached' });
  await page.click('label[for=tab1]');
  await page.click('#first-games button[data-example=flag6]');
  await page.waitForFunction(() => /trees/.test(window.logic_game.editors.value('level_gen_program')));
});

// ---- Game folders ---------------------------------------------------------------------

test('game folders: download as a .zip, and load a folder or a .zip', async (t) => {
  const page = await open(t, '?file=flag2&tab=7');
  if (!page) return;
  await open_sections(page);
  await set_program(page, 'player_move_program', '% from a folder\ndo(move(down)).');
  await wait_saved(page, '% from a folder\ndo(move(down)).');
  const [download] = await Promise.all([page.waitForEvent('download'), page.click('button[data-action=download_folder]')]);
  assert.equal(download.suggestedFilename(), 'find-the-flag-2.zip');
  const { read_zip } = await import('../js/folder.js');
  const zipped = fs.readFileSync(await download.path());
  const files = await read_zip(new Uint8Array(zipped));
  assert.equal(files['find-the-flag-2/strategy.lp'], '% from a folder\ndo(move(down)).\n');
  assert.equal(JSON.parse(files['find-the-flag-2/game.json']).title, 'Find the flag 2');
  // Another browser loads the .zip
  const context = await browser.newContext({ serviceWorkers: 'block' });
  t.after(() => context.close());
  const other = await context.newPage();
  await other.goto(base + '?tab=7');
  await other.waitForSelector('body[data-ready=true]');
  await open_sections(other);
  await other.setInputFiles('#file-input', { name: 'find-the-flag-2.zip', mimeType: 'application/zip', buffer: zipped });
  await other.waitForFunction(() => /Done loading: find-the-flag-2\.zip \(Find the flag 2\)/.test(document.getElementById('upload-status').textContent));
  assert.equal(await value(other, 'player_move_program'), '% from a folder\ndo(move(down)).');
  assert.equal(await other.textContent('#game-title'), 'Find the flag 2');
  // and a folder (as the command-line version makes it)
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'logic-game-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const folder = path.join(dir, 'my-game');
  fs.mkdirSync(path.join(folder, 'level'), { recursive: true });
  for (const [p, text] of Object.entries(files)) fs.writeFileSync(path.join(folder, p.replace(/^find-the-flag-2\//, '')), text);
  fs.writeFileSync(path.join(folder, 'strategy.lp'), 'do(move(right)).\n');
  fs.mkdirSync(path.join(folder, '.git'));
  fs.writeFileSync(path.join(folder, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  await other.setInputFiles('#folder-input', folder);
  await other.waitForFunction(() => /Done loading: the folder my-game/.test(document.getElementById('upload-status').textContent));
  assert.equal(await value(other, 'player_move_program'), 'do(move(right)).');
  // (game.json can name files with other extensions)
  const manifest = JSON.parse(fs.readFileSync(path.join(folder, 'game.json'), 'utf8'));
  manifest.files.player_move_program = 'src/player.asp';
  fs.writeFileSync(path.join(folder, 'game.json'), JSON.stringify(manifest));
  fs.mkdirSync(path.join(folder, 'src'));
  fs.writeFileSync(path.join(folder, 'src', 'player.asp'), 'do(move(up)).\n');
  await other.setInputFiles('#folder-input', folder);
  await other.waitForFunction(() => window.logic_game.editors.value('player_move_program') === 'do(move(up)).');
});

// A folder in the browser's own file system stands in for a folder that the player picks.
async function with_test_folder(page) {
  await page.addInitScript(() => {
    window.showDirectoryPicker = async () => (await navigator.storage.getDirectory()).getDirectoryHandle('linked', { create: true });
  });
}

async function folder_file(page, p) {
  return page.evaluate(async (name) => {
    let dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('linked');
    const parts = name.split('/');
    for (const part of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(part);
    try {
      return await (await (await dir.getFileHandle(parts.at(-1))).getFile()).text();
    } catch {
      return null;
    }
  }, p);
}

async function wait_folder_file(page, p, text) {
  for (let i = 0; i < 100 && await folder_file(page, p) !== text; i++) await page.waitForTimeout(100);
  assert.equal(await folder_file(page, p), text);
}

async function write_folder_file(page, p, text) {
  await page.evaluate(async ([name, contents]) => {
    const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('linked');
    const w = await (await dir.getFileHandle(name, { create: true })).createWritable();
    await w.write(contents);
    await w.close();
  }, [p, text]);
}

test('game folders: a linked folder gets every change, and changes to its files are loaded', async (t) => {
  if (skip) {
    t.skip(skip);
    return;
  }
  const context = await browser.newContext({ serviceWorkers: 'block' });
  t.after(() => context.close());
  const page = await context.newPage();
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push(e.message));
  page.on('dialog', (dialog) => dialog.accept());
  await with_test_folder(page);
  await page.goto(base + '?file=flag3&tab=7');
  await page.waitForSelector('body[data-ready=true]');
  await open_sections(page);
  assert.equal(await page.isVisible('#folder-supported'), true);
  await set_program(page, 'player_move_program', 'do(move(down)).');
  await wait_saved(page, 'do(move(down)).');
  // An empty folder gets the current game
  await page.click('#open-folder-button');
  await page.waitForFunction(() => /Linked to the folder linked/.test(document.getElementById('folder-status').textContent));
  assert.equal(await folder_file(page, 'strategy.lp'), 'do(move(down)).\n');
  assert.match(await folder_file(page, 'level-generation.lp'), /RANDINT/);
  assert.ok(await folder_file(page, 'level/state.lp'));
  assert.equal(JSON.parse(await folder_file(page, 'game.json')).title, 'linked');
  assert.match(await page.textContent('#work-notice'), /^\s*Linked to the folder linked: changes are saved into its files/);
  assert.equal(await page.textContent('#game-title'), 'linked');
  // Changes in the page go into the files
  await set_program(page, 'player_move_program', 'do(move(up)).');
  await wait_folder_file(page, 'strategy.lp', 'do(move(up)).\n');
  // and changes to the files (e.g. by git) come into the page, after a snapshot of the page's version
  await write_folder_file(page, 'strategy.lp', '% changed outside\ndo(move(left)).\n');
  await page.waitForFunction(() => window.logic_game.editors.value('player_move_program') === '% changed outside\ndo(move(left)).', null, { timeout: 10000 });
  assert.match(await page.textContent('#folder-status'), /Loaded the changes to Player strategy from the folder linked/);
  const snapshots = await page.evaluate(() => window.logic_game.versions.list('folder:linked'));
  assert.equal(snapshots.at(-1).reason, 'folder');
  assert.equal(snapshots.at(-1).game.player_move_program, 'do(move(up)).');
  // A change to a file (e.g. git checkout) at the same time as a change in the page:
  // the file is not overwritten, and the page's version is kept as a snapshot
  await write_folder_file(page, 'strategy.lp', '% checked out\ndo(move(left)).\n');
  await set_program(page, 'player_move_program', 'typed at the same time.');
  await page.waitForFunction(() => window.logic_game.editors.value('player_move_program') === '% checked out\ndo(move(left)).', null, { timeout: 10000 });
  assert.equal(await folder_file(page, 'strategy.lp'), '% checked out\ndo(move(left)).\n');
  assert.equal((await page.evaluate(() => window.logic_game.versions.list('folder:linked'))).at(-1).game.player_move_program, 'typed at the same time.');
  await write_folder_file(page, 'strategy.lp', '% changed outside\ndo(move(left)).\n');
  await page.waitForFunction(() => window.logic_game.editors.value('player_move_program') === '% changed outside\ndo(move(left)).', null, { timeout: 10000 });
  // Clearing the level removes the level files (and generating one writes them again)
  await page.click('#clear-button');
  await wait_folder_file(page, 'level/state.lp', null);
  await page.click('#generate-button');
  await page.waitForFunction(() => window.logic_game.editors.value('level_state') !== '');
  await page.waitForFunction(() => /generated at/.test(document.getElementById('board-status').textContent));
  for (let i = 0; i < 50 && !(await folder_file(page, 'level/state.lp')); i++) await page.waitForTimeout(100);
  assert.ok(await folder_file(page, 'level/state.lp'));
  // After a reload, the page offers to link the folder again
  await page.reload();
  await page.waitForSelector('body[data-ready=true]');
  await page.waitForSelector('#folder-notice:not([hidden])');
  assert.match(await page.textContent('#folder-notice'), /linked to your game folder linked/);
  await page.click('#folder-notice button[data-action=relink_folder]');
  await page.waitForFunction(() => /Linked to the folder linked/.test(document.getElementById('folder-status').textContent));
  assert.equal(await value(page, 'player_move_program'), '% changed outside\ndo(move(left)).');
  // Unlinking: the files are not changed any more
  await page.click('#unlink-folder-button');
  await set_program(page, 'player_move_program', 'do(wait).');
  await wait_saved(page, 'do(wait).');
  await page.waitForTimeout(500);
  assert.equal(await folder_file(page, 'strategy.lp'), '% changed outside\ndo(move(left)).\n');
  assert.deepEqual(page.errors, []);
});

// ---- The board at all sizes -----------------------------------------------------------

test('boards of all sizes fit, with square cells, on a large screen and on a phone', async (t) => {
  if (skip) {
    t.skip(skip);
    return;
  }
  // (1280: the board next to the tabs; 1920 also, and smaller after resizing; 390: a phone)
  for (const viewport of [{ width: 1280, height: 800 }, { width: 1920, height: 1080, resize: true }, { width: 390, height: 844, resize: true }]) {
    const page = await browser.newPage({ serviceWorkers: 'block', viewport });
    t.after(() => page.close());
    await page.goto(base);
    await page.waitForSelector('body[data-ready=true]');
    for (const [w, h] of [[1, 1], [3, 2], [8, 6], [4, 20], [30, 4], [40, 30]]) {
      const r = await page.evaluate(async ([w, h]) => {
        const { show_grid } = await import('./js/grid-visual.js');
        show_grid(`setting(grid_width(${w})). setting(grid_height(${h})). observe(at(1,1,player)). observe(at(1,1,flag)). observe(at(${h},${w},flag)).`);
        const v = document.getElementById('visual');
        const board = v.getBoundingClientRect();
        const cell = v.children[0].getBoundingClientRect();
        return {
          board_right: board.right, board_height: board.height, cell_w: cell.width, cell_h: cell.height,
          page_width: document.documentElement.scrollWidth, overflow: [...v.children].some((c) => c.scrollWidth > c.clientWidth + 1),
        };
      }, [w, h]);
      const what = `${w}x${h} on ${viewport.width}x${viewport.height}`;
      assert.ok(Math.abs(r.cell_w - r.cell_h) < 0.5, `${what}: cells are not square (${r.cell_w} x ${r.cell_h})`);
      assert.ok(r.board_right <= viewport.width, `${what}: the board is wider than the screen`);
      assert.ok(r.board_height <= viewport.height * (viewport.width >= 1100 ? 0.55 : 0.7) + 4, `${what}: the board is too high for the screen`);
      assert.ok(r.page_width <= viewport.width, `${what}: the page is wider than the screen`);
      assert.equal(r.overflow, false, `${what}: items do not fit in a cell`);
      assert.ok(r.cell_w >= 6, what);
    }
    // The board follows the size of the window
    if (!viewport.resize) continue;
    await page.evaluate(async () => (await import('./js/grid-visual.js')).show_grid('setting(grid_width(8)). setting(grid_height(6)).'));
    const before = await page.locator('#visual').boundingBox();
    await page.setViewportSize({ width: Math.round(viewport.width * 0.7), height: viewport.height });
    await page.waitForFunction((w) => document.getElementById('visual').getBoundingClientRect().width < w, before.width);
  }
});

test('the board next to the tabs on wide screens (an option), and above them otherwise', async (t) => {
  if (skip) {
    t.skip(skip);
    return;
  }
  const page = await browser.newPage({ serviceWorkers: 'block', viewport: { width: 1440, height: 900 } });
  t.after(() => page.close());
  await page.goto(base + '?tab=3&internals=true');
  await page.waitForSelector('body[data-ready=true]');
  const layout = () => page.evaluate(() => {
    const board = document.getElementById('board-pane').getBoundingClientRect();
    const tabs = document.getElementById('tabs-pane').getBoundingClientRect();
    const labels = [...document.querySelectorAll('label[name=tabs]')].filter((l) => l.offsetParent);
    return {
      side_by_side: board.right <= tabs.left && board.top < tabs.bottom,
      // (the selected tab is a pixel higher)
      one_row: Math.max(...labels.map((l) => l.getBoundingClientRect().top)) - Math.min(...labels.map((l) => l.getBoundingClientRect().top)) < 10,
      board_top: board.top, page_width: document.documentElement.scrollWidth,
    };
  });
  let r = await layout();
  assert.equal(r.side_by_side, true);
  assert.equal(r.one_row, true);
  // The board stays in view while the tabs scroll
  await page.evaluate(() => window.scrollTo(0, 400));
  await page.waitForFunction(() => window.scrollY > 300);
  r = await layout();
  assert.ok(r.board_top >= -1 && r.board_top < 50, `the board is not in view (${r.board_top})`);
  // The tabs stay on one row in a narrower window, also when a tab is marked
  await set_program(page, 'player_move_program', 'foo :- bar(X).');
  for (const width of [1100, 1180, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    await page.waitForTimeout(500);
    r = await layout();
    assert.equal(r.side_by_side, true, `${width}`);
    assert.equal(r.one_row, true, `${width}: the tabs are on more than one row`);
    assert.ok(r.page_width <= width, `${width}: the page is wider than the screen`);
  }
  // Below 1100 pixels (and when the option is off), the board is above the tabs
  await page.setViewportSize({ width: 1000, height: 900 });
  assert.equal((await layout()).side_by_side, false);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.click('label[for=tab1]');
  await page.uncheck('#option-side-by-side');
  assert.equal((await layout()).side_by_side, false);
  await page.goto(base + '?side_by_side=true');
  await page.waitForSelector('body[data-ready=true]');
  assert.equal((await layout()).side_by_side, true);
});

test('a test result stays with the game that was tested; loading another game stops the test', async (t) => {
  const page = await open(t, '?file=flag3-with-solutions&tab=4');
  if (!page) return;
  await page.fill('#test-levels', '200');
  await page.click('#test-button');
  await page.waitForFunction(() => /Level \d+ of 200/.test(document.getElementById('test-progress').textContent));
  await page.click('label[for=tab1]');
  await page.click('#first-games button[data-example=flag5]');
  await page.waitForFunction(() => /^Cancelled after/.test(document.getElementById('test-progress').textContent));
  assert.deepEqual(await page.evaluate(() => window.logic_game.versions.list('example:flag5')), []);
  assert.deepEqual(await page.evaluate(() => window.logic_game.versions.list('example:flag3-with-solutions')), []);
  // A test that finishes is kept with its own game
  await page.fill('#test-levels', '2');
  await page.click('#test-button');
  await page.waitForFunction(() => /^Done/.test(document.getElementById('test-progress').textContent), null, { timeout: 60000 });
  const kept = await page.evaluate(() => window.logic_game.versions.list('example:flag5'));
  assert.equal(kept.length, 1);
  assert.equal(kept[0].tests[0].levels, 2);
});

test('taking a level program from another version removes a level that does not fit any more', async (t) => {
  const page = await open(t, '?file=flag2&tab=7');
  if (!page) return;
  await open_sections(page);
  page.on('dialog', (dialog) => dialog.accept());
  await page.click('#snapshot-button');
  // A new level generation program (with a new level)
  await page.click('label[for=tab3]');
  await page.click('#unlock-button');
  await set_program(page, 'level_gen_program', (await value(page, 'level_gen_program')) + '\n% changed');
  await page.click('#generate-button');
  await page.waitForFunction(() => /generated at/.test(document.getElementById('board-status').textContent));
  // Take the old level generation program: the rules stay locked, the level goes
  await page.click('label[for=tab7]');
  await open_sections(page);
  await page.locator('#snapshot-list li[data-id]').first().getByText('Compare with current').click();
  await page.locator('.diff-program[data-field=level_gen_program]').getByRole('button').click();
  await page.waitForFunction(() => window.logic_game.editors.value('level_state') === '');
  assert.match(await page.textContent('#board-status'), /^The level was removed: it was made with another version/);
  assert.equal(await page.evaluate(() => window.logic_game.editors.get('level_gen_program').getReadOnly()), true);
});

// ---- Grader mode ---------------------------------------------------------------------------

const example = (name) => fs.readFileSync(path.join(ROOT, 'examples', name + '.json'), 'utf8');
const TINY_PDF = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj ' +
  '3 0 obj<</Type/Page/MediaBox[0 0 200 200]/Parent 2 0 R>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n');

// What Canvas' "Download submissions" gives: one zip file with the files of all students.
function canvas_zip() {
  return Buffer.from(make_zip({
    'janssenalice_1001_5001_hw3.zip': make_zip({ 'hw3/game.json': example('flag9-with-solutions'), 'hw3/report.pdf': new Uint8Array(TINY_PDF) }),
    'debruijnbob_LATE_1002_5002_game.json': example('flag5-with-solutions'),
    'debruijnbob_LATE_1002_5003_report.pdf': new Uint8Array(TINY_PDF),
    'smitcarol_1003_5004_game.json': example('flag9-with-solutions'),
  }));
}

async function load_submissions(page) {
  await page.setInputFiles('#grading-input', { name: 'submissions.zip', mimeType: 'application/zip', buffer: canvas_zip() });
  await page.waitForFunction(() => /^Loaded 3 submissions/.test(document.getElementById('grading-load-status').textContent));
}

const student_rows = (page) => page.$$eval('#grading-students tbody tr', (rows) => rows.map((r) => [...r.cells].slice(0, 3).map((c) => c.textContent.trim())));

test('grader mode: an option (also in the link), with the Grading tab and the whole board', async (t) => {
  const page = await open(t, '?file=flag5-with-solutions');
  if (!page) return;
  assert.equal(await page.isVisible('label[for=tab8]'), false);
  assert.equal(await page.isVisible('#full-view-box'), false);
  await page.check('#option-grader');
  assert.equal(await page.isVisible('label[for=tab8]'), true);
  assert.equal(await page.isVisible('#full-view'), true);
  // The flag is not visible to the player at the start: with everything shown, it is (faded)
  assert.equal(await page.locator('#visual .grid-visual-hidden').count(), 0);
  await page.check('#full-view');
  await page.waitForFunction(() => document.querySelectorAll('#visual .grid-visual-hidden').length > 0);
  assert.match(await page.locator('#visual .grid-visual-hidden').first().evaluate((e) => e.parentElement.getAttribute('aria-label')), /flag/);
  // ... also while stepping through a game
  await page.click('#step-button');
  await page.waitForFunction(() => document.getElementById('timeline-label').textContent.startsWith('Time 1'));
  assert.ok(await page.locator('#visual .grid-visual-hidden').count() > 0);
  await page.uncheck('#full-view');
  await page.waitForFunction(() => document.querySelectorAll('#visual .grid-visual-hidden').length === 0);
  // Turning grader mode off hides the tab (and the whole board)
  await page.click('label[for=tab8]');
  await page.click('label[for=tab1]');
  await page.uncheck('#option-grader');
  assert.equal(await page.isVisible('label[for=tab8]'), false);
  // In a link
  const other = await open(t, '?grader=true&tab=8');
  assert.equal(await other.isChecked('#tab8'), true);
  assert.equal(await other.isVisible('#section-grading'), true);
  assert.deepEqual(page.errors, []);
  assert.deepEqual(other.errors, []);
});

test("grading: load Canvas' download, test a game, grade it, and give feedback", async (t) => {
  const page = await open(t, '?grader=true&tab=8');
  if (!page) return;
  await load_submissions(page);
  assert.deepEqual(await student_rows(page), [['debruijnbob late', 'not started', ''], ['janssenalice', 'not started', ''], ['smitcarol', 'not started', '']]);
  // Grade Alice: her game is loaded into the page, her PDF is shown
  await page.click('#grading-students button[data-key="canvas:1001"]');
  await page.waitForFunction(() => document.getElementById('game-title').textContent === 'janssenalice');
  assert.equal(await page.evaluate(() => window.logic_game.editors.value('player_move_program')), JSON.parse(example('flag9-with-solutions')).player_move_program);
  assert.match(await page.textContent('#grading-name'), /janssenalice \(1001\)/);
  await page.waitForFunction(() => /is the game of this student \(game\.json\)/.test(document.getElementById('grading-game-line').textContent));
  await page.waitForFunction(() => /^blob:/.test(document.getElementById('grading-pdf').src));
  // Test and measure: suggestions with their evidence
  await page.fill('#grading-levels', '2');
  await page.click('#grading-measure');
  await page.waitForFunction(() => /^Done/.test(document.getElementById('grading-progress').textContent), null, { timeout: 120000 });
  assert.match(await page.textContent('#grading-results'), /New levels: 2 played: 2 won\./);
  assert.match(await page.textContent('#grading-results'), /attacker \(NPC\)/);
  // (Carol handed in the same game: she is the most similar)
  assert.match(await page.textContent('#grading-results'), /smitcarol \(a submission\)100%/);
  await page.waitForFunction(() => document.querySelectorAll('#grading-results .grading-level canvas').length === 2);
  assert.match(await page.textContent('[data-item=npc] .grading-suggestion'), /Suggested: yes\. objects that moved: attacker/);
  assert.match(await page.textContent('[data-item=novel] .grading-suggestion'), /Suggested: not met\./);
  await page.locator('#grading-accept').scrollIntoViewIfNeeded();
  await page.click('#grading-accept');
  assert.equal(await page.inputValue('[data-item=npc] select'), 'yes');
  assert.equal(await page.inputValue('[data-item=visual] select'), '');
  assert.match(await page.textContent('#grading-grade'), /not all requirements are met/);
  // The grader decides otherwise
  await page.selectOption('[data-item=novel] select', 'yes');
  await page.selectOption('[data-item=documented] select', 'yes');
  await page.selectOption('[data-item=visual] select', 'yes');
  await page.fill('[data-item=visual] .grading-points', '0.25');
  await page.fill('[data-item=visual] .grading-item-note', 'Nice icons.');
  assert.equal(await page.textContent('#grading-grade'), '9');
  // A failed level can be loaded onto the board from the list of different levels
  await page.click('#grading-results .grading-level >> nth=1');
  await page.waitForFunction(() => /level 2 of the test/.test(document.getElementById('board-message').textContent));
  // Feedback: a standard comment, a note on a line (where the cursor is), a picture of the board
  await page.click('#grading-snippet-list button >> nth=0');
  assert.match(await page.inputValue('#grading-comment'), /^Well done/);
  await page.click('label[for=tab3]');
  await page.click('#nature_program .ace_content');
  await page.evaluate(() => window.logic_game.editors.get('nature_program').gotoLine(3, 0));
  await page.click('label[for=tab8]');
  await page.click('button[data-action=grading_note_cursor]');
  assert.equal(await page.inputValue('#grading-note-program'), 'nature_program');
  assert.equal(await page.inputValue('#grading-note-line'), '3');
  await page.fill('#grading-note-text', 'Why this rule?');
  await page.click('button[data-action=grading_add_note]');
  assert.match(await page.textContent('#grading-line-notes'), /Nature's moves, line 3: Why this rule\?/);
  await page.click('button[data-action=grading_add_image]');
  assert.equal(await page.inputValue('#grading-images input'), 'Level 2 of the test');
  await page.waitForSelector('#grading-images canvas');
  // The feedback as text, as a web page and as a PDF
  const download = async (action) => {
    const [d] = await Promise.all([page.waitForEvent('download'), page.click(`button[data-action=${action}]`)]);
    return { name: d.suggestedFilename(), data: fs.readFileSync(await d.path()) };
  };
  const md = await download('grading_md_feedback');
  assert.equal(md.name, 'feedback-janssenalice-1001.md');
  assert.match(md.data.toString(), /\*\*Grade:\*\* 9/);
  assert.match(md.data.toString(), /The game is visually pleasing \(0\.5\): \*\*\+0\.25\*\* \u2014 Nice icons\./);
  assert.match(md.data.toString(), /\*\*Nature's moves, line 3:\*\* Why this rule\?/);
  assert.doesNotMatch(md.data.toString(), /Test results/);
  await page.check('#grading-include-tests');
  const html = await download('grading_html_feedback');
  assert.match(html.data.toString(), /<img src="data:image\/png;base64,/);
  assert.match(html.data.toString(), /Played 2 new levels/);
  const pdf = await download('grading_pdf_feedback');
  assert.equal(pdf.name, 'feedback-janssenalice-1001.pdf');
  assert.equal(pdf.data.subarray(0, 8).toString(), '%PDF-1.4');
  assert.match(pdf.data.toString('latin1'), /\/Filter \/DCTDecode/);
  // Done, and on to the next student (Bob: handed in late, his game is loaded)
  await page.selectOption('#grading-status', 'done');
  assert.deepEqual((await student_rows(page))[1], ['janssenalice', 'done', '9']);
  await page.click('#grading-next');
  await page.waitForFunction(() => document.getElementById('game-title').textContent === 'smitcarol');
  // All grades, and all feedback at once
  const csv = await download('grading_csv');
  const lines = csv.data.toString().trim().split('\r\n');
  assert.equal(lines.length, 4);
  assert.match(lines[2], /^janssenalice,1001,,done,9,yes,yes,yes,0\.25,0,1,0\.5,0\.5,1,/);
  const all = await download('grading_all_feedback');
  assert.equal(all.name, 'feedback.zip');
  const names = await page.evaluate(async (bytes) => {
    const { read_zip } = await import('./js/folder.js');
    return Object.keys(await read_zip(new Uint8Array(bytes), { binary: true })).sort();
  }, [...all.data]);
  assert.deepEqual(names, ['feedback/feedback-debruijnbob-1002.pdf', 'feedback/feedback-janssenalice-1001.pdf', 'feedback/feedback-smitcarol-1003.pdf', 'feedback/grades.csv']);
  // The grading is kept in this browser
  await page.evaluate(() => window.logic_game.grader.flush());
  await page.reload();
  await page.waitForSelector('body[data-ready=true]');
  await page.evaluate(() => window.logic_game.grader.ready);
  assert.deepEqual((await student_rows(page))[1], ['janssenalice', 'done', '9']);
  assert.match(await page.textContent('#grading-name'), /smitcarol/);
  await page.click('#grading-prev');
  await page.waitForFunction(() => /^Well done/.test(document.getElementById('grading-comment').value));
  await page.waitForFunction(() => /^blob:/.test(document.getElementById('grading-pdf').src));
  assert.deepEqual(page.errors, []);
  assert.deepEqual(page.external, []);
});

test('grading: export, import into another browser, compare all submissions, remove all', async (t) => {
  const page = await open(t, '?grader=true&tab=8');
  if (!page) return;
  page.on('dialog', (dialog) => dialog.accept());
  await load_submissions(page);
  await page.click('#grading-students button[data-key="canvas:1002"]');
  await page.waitForFunction(() => document.getElementById('game-title').textContent === 'debruijnbob');
  await page.fill('#grading-comment', 'From the first grader.');
  await page.selectOption('[data-item=timing] select', 'yes');
  // Similar pairs: Alice and Carol handed in the same game
  await page.click('button[data-action=grading_compare]');
  assert.match(await page.textContent('#grading-pairs'), /janssenalice \u2013 smitcarol100%/);
  const [d] = await Promise.all([page.waitForEvent('download'), page.click('button[data-action=grading_export]')]);
  const file = fs.readFileSync(await d.path());
  assert.match(d.suggestedFilename(), /^grading-\d{4}-\d\d-\d\d\.json$/);
  assert.equal(JSON.parse(file).students.length, 3);
  // Another grader imports it
  const other = await open(t, '?grader=true&tab=8');
  await other.setInputFiles('#grading-import', { name: 'grading.json', mimeType: 'application/json', buffer: file });
  await other.waitForFunction(() => /3 students added, 0 updated/.test(document.getElementById('grading-batch-status').textContent));
  // (the grade so far, in brackets: not all items are decided)
  assert.deepEqual((await student_rows(other))[0], ['debruijnbob late', 'in progress', '(6)']);
  await other.click('#grading-students button[data-key="canvas:1002"]');
  await other.waitForFunction(() => document.getElementById('grading-comment').value === 'From the first grader.');
  // (the PDF files are not in the grading file: said once the browser's storage was looked in)
  await other.waitForSelector('#grading-no-pdf', { state: 'visible' });
  assert.match(await other.textContent('#grading-no-pdf'), /The PDF file report\.pdf is not in this browser \(load the submissions again\)\./);
  // Remove all
  await page.click('button[data-action=grading_forget]');
  await page.waitForFunction(() => /All students were removed/.test(document.getElementById('grading-batch-status').textContent));
  assert.equal(await page.isVisible('#grading-students'), false);
  assert.equal(await page.isVisible('#grading-student'), false);
  assert.deepEqual(page.errors, []);
  assert.deepEqual(other.errors, []);
});

test('grading: zip files with Zip64 fields, and an entry that cannot be read', async (t) => {
  const page = await open(t, '?grader=true&tab=8');
  if (!page) return;
  const fixture = (name) => fs.readFileSync(path.join(ROOT, 'test', 'fixtures', 'zips', name));
  await page.setInputFiles('#grading-input', { name: 'submissions.zip', mimeType: 'application/zip', buffer: fixture('zip64.zip') });
  await page.waitForFunction(() => /^Loaded 2 submissions/.test(document.getElementById('grading-load-status').textContent));
  await page.setInputFiles('#grading-input', { name: 'more.zip', mimeType: 'application/zip', buffer: fixture('bzip2.zip') });
  await page.waitForFunction(() => /^Loaded 1 submission/.test(document.getElementById('grading-load-status').textContent));
  assert.match(await page.textContent('#grading-notes'), /roerich_12346_678902_game\.json was left out: it is compressed in a way that is not supported/);
  assert.deepEqual((await student_rows(page)).map((r) => r[0]), ['doejane', 'roerich']);
  assert.deepEqual(page.errors, []);
});
