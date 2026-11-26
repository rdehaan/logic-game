// The checks of `npm run lint`: ESLint's recommended rules, with the globals of
// each kind of file (the page, the service worker, Node).
import js from '@eslint/js';
import globals from 'globals';

export default [
  // (js/mode-gringo.js comes from potassco.github.io, and is kept as it is there)
  { ignores: ['vendor/', 'node_modules/', 'test-results/', 'js/mode-gringo.js'] },
  js.configs.recommended,
  {
    rules: {
      // ({ pdf_files, ...rest } = st: leaving out a field is fine)
      'no-unused-vars': ['error', { ignoreRestSiblings: true }],
    },
  },
  {
    files: ['js/**/*.js'],
    // (ace: the editor, which the page loads with a script tag)
    languageOptions: { globals: { ...globals.browser, ace: 'readonly' } },
  },
  {
    // (a plain script, loaded in <head> before the modules: see the file)
    files: ['js/theme.js'],
    languageOptions: { sourceType: 'script' },
  },
  {
    files: ['sw.js'],
    languageOptions: { sourceType: 'script', globals: { ...globals.serviceworker } },
  },
  {
    // (the tests also hold code that runs in the page, through page.evaluate)
    files: ['bin/**', 'cli/**', 'tools/**', 'test/**', 'eslint.config.js'],
    languageOptions: { globals: { ...globals.node, ...globals.browser, ace: 'readonly' } },
  },
];
