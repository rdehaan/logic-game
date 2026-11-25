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
  await page.route((url) => !url.href.startsWith(base) && !url.href.startsWith('blob:'), (route) => {
    page.external.push(route.request().url());
    route.abort();
  });
  await page.goto(base + query);
  await page.waitForSelector('body[data-ready=true]', { timeout: 30000 });
  t.after(() => page.close());
  return page;
}

const game_output = (page) => page.textContent('#game-output');

async function wait_for_verdict(page, pattern = /WIN!|LOSE!|STOPPED!|TIMEOUT!/, timeout = 60000) {
  await page.waitForFunction((source) => new RegExp(source).test(document.getElementById('game-output').textContent),
    pattern.source, { timeout });
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
  await page.waitForFunction(() => /STEP 1 /.test(document.getElementById('game-output').textContent));
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
  assert.match(await page.textContent('#work-notice'), /You are working on your own version of Find the flag 3 \(saved /);
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
  assert.match(await page.textContent('#work-notice'), /your own version of Find the flag 3 \(saved /);
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
  // The marks of the cells that changed can be turned off
  assert.equal(await page.locator('.grid-visual-cell.changed').first().evaluate((e) => getComputedStyle(e).boxShadow !== 'none'), true);
  await page.uncheck('#mark-changes');
  assert.equal(await page.locator('.grid-visual-cell.changed').first().evaluate((e) => getComputedStyle(e).boxShadow), 'none');
  await page.check('#mark-changes');
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
  assert.match(await page.textContent('#debug-step'), /Player input:/);
  assert.match(await page.textContent('#debug-messages'), /^WIN!/);
  await page.click('#debug-next');
  assert.match(await page.textContent('#timeline-label'), /^Time 1 of /);
  assert.match(await page.textContent('#debug-step-label'), /^Step 2:/);
  // or all steps at once
  await page.check('#show-all-output');
  assert.equal(await page.isHidden('#debug-steps'), true);
  await page.locator('#game-output .output-step', { hasText: '## STEP 3 ##' }).click();
  assert.match(await page.textContent('#timeline-label'), /^Time 2 of /);
  await page.uncheck('#show-all-output');
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
  // Changing the level generation removes the level when locking (here with Lock rules and play)
  await page.click('#unlock-button');
  await set_program(page, 'level_gen_program', (await value(page, 'level_gen_program')) + '\n% changed');
  await page.click('#play-button');
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
  await page.uncheck('#option-mark-changes');
  assert.equal(await page.isVisible('label[for=tab6]'), true);
  assert.equal(await page.locator('#example-games optgroup[label=Solutions]').count(), 1);
  assert.equal(await page.evaluate(() => window.logic_game.solver.timeout_ms), 25000);
  await page.reload();
  await page.waitForSelector('body[data-ready=true]');
  assert.equal(await page.isVisible('label[for=tab6]'), true);
  assert.equal(await page.isChecked('#option-editor'), true);
  assert.equal(await page.isChecked('#mark-changes'), false);
  assert.equal(await page.evaluate(() => window.logic_game.solver.timeout_ms), 25000);
  // A link can turn them off (only for that visit)
  await page.goto(base + '?internals=false&timeout=5');
  await page.waitForSelector('body[data-ready=true]');
  assert.equal(await page.isHidden('label[for=tab6]'), true);
  assert.equal(await page.evaluate(() => window.logic_game.solver.timeout_ms), 5000);
  await page.goto(base);
  await page.waitForSelector('body[data-ready=true]');
  assert.equal(await page.isVisible('label[for=tab6]'), true);
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
  assert.equal(await page.locator('#game-output .output-step').count(), Number(steps));
  // A link to the level gives the same level
  const level_state = await page.evaluate(() => window.logic_game.editors.value('level_state'));
  await page.click('label[for=tab7]');
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

test('snapshots: keep, compare, take one program, restore', async (t) => {
  const page = await open(t, '?file=flag3&tab=7');
  if (!page) return;
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
  await set_program(other, 'player_move_program', 'other work.');
  await wait_saved(other, 'other work.');
  await other.setInputFiles('#file-input', { name: 'p.json', mimeType: 'application/json', buffer: file });
  await other.waitForFunction(() => /Done loading the project Find the flag 2 \(1 snapshot\)/.test(document.getElementById('upload-status').textContent));
  assert.equal(await value(other, 'player_move_program'), '% my work\ndo(move(up)).');
  assert.deepEqual((await snapshot_names(other)).sort(), ['Automatic snapshot before loading a file', 'first']);
  assert.match(await other.textContent('#work-notice'), /your own version of Find the flag 2/);
  // A plain game file still loads as before; a file that is not a game is refused
  await other.setInputFiles('#file-input', { name: 'x.json', mimeType: 'application/json', buffer: Buffer.from('{"a": 1}') });
  await other.waitForFunction(() => /Loading failed: this is not a game or project file/.test(document.getElementById('upload-status').textContent));
});

test('everything in this browser: the list, a backup, and opening a game from the list', async (t) => {
  const page = await open(t, '?file=flag1&tab=7');
  if (!page) return;
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
  assert.match(await page.textContent('#work-notice'), /Linked to the folder linked on your computer/);
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
  for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
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
      assert.ok(r.board_height <= viewport.height * 0.7 + 4, `${what}: the board is higher than 70% of the screen`);
      assert.ok(r.page_width <= viewport.width, `${what}: the page is wider than the screen`);
      assert.equal(r.overflow, false, `${what}: items do not fit in a cell`);
      assert.ok(r.cell_w >= 6, what);
    }
    // The board follows the size of the window
    await page.evaluate(async () => (await import('./js/grid-visual.js')).show_grid('setting(grid_width(8)). setting(grid_height(6)).'));
    const before = await page.locator('#visual').boundingBox();
    await page.setViewportSize({ width: Math.round(viewport.width * 0.6), height: viewport.height });
    await page.waitForFunction((w) => document.getElementById('visual').getBoundingClientRect().width < w, before.width);
  }
});
