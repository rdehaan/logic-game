// Tests of the page in a real browser (Chromium, via Playwright).
//
// Needs Playwright's Chromium: run "npx playwright install chromium" once.
// To use another Chromium, set CHROMIUM_PATH to its executable.
// The tests are skipped when no browser can be started.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createServer } from '../tools/serve.mjs';
import { ROOT } from './helpers.mjs';

let chromium = null;
try {
  ({ chromium } = await import('playwright'));
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
  await page.click('label[for=tab1]');
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
  await page.click('label[for=tab1]');
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
    assert.equal(await page.textContent('#timeline-label'), `Time ${i} of ${i} (changes since the time before are marked)`);
  }
  assert.equal(await page.isDisabled('#pause-button'), true);
  assert.equal(await page.isEnabled('#stop-button'), true);
  assert.ok(await page.locator('.grid-visual-cell.changed').count() > 0);
  // Back one time: the move the player made there
  await page.click('#timeline-prev');
  assert.match(await page.textContent('#timeline-label'), /^Time 2 of 3: the player moved do\(move\(\w+\)\) /);
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
  await page.click('label[for=tab5]');
  await page.locator('#game-output .output-step', { hasText: '## STEP 3 ##' }).click();
  assert.match(await page.textContent('#timeline-label'), /^Time 2 of /);
  // A new game starts a new timeline
  await page.click('#reset-button');
  assert.equal(await page.isHidden('#timeline-box'), true);
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
  assert.match(summary, /^6 levels: (\d+ won, )?\d+ lost\.$/);
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
  await page.click('label[for=tab1]');
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
  for (const tab of [2, 3, 4, 5, 6]) await page.click(`label[for=tab${tab}]`);
  await page.waitForTimeout(300);
  const source = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');
  const precache = new Set(eval(/const PRECACHE = (\[[\s\S]*?\n\]);/.exec(source)[1]));
  const missing = [...loaded].filter((f) => f !== 'sw.js' && f !== 'favicon.ico' && !precache.has(f));
  assert.deepEqual(missing, [], 'add these files to PRECACHE in sw.js');
  // and every file in the list exists
  for (const f of precache) if (f !== './') assert.ok(fs.existsSync(path.join(ROOT, f)), f);
});
