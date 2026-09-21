// Phase 5 — mobile ESLint overrides.
// Base rules come from the repo root config; this file only declares the
// globals that tooling JS files need (Node env for configs, jest globals
// for the shared setup file).

import rootConfig from '../../eslint.config.mjs';

export default [
  ...rootConfig,
  {
    files: ['babel.config.js', 'jest.config.js', 'jest.live.config.js'],
    languageOptions: {
      globals: {
        module: 'writable',
        require: 'readonly',
        process: 'readonly',
        __dirname: 'readonly',
      },
    },
  },
  {
    files: ['jest.setup.js'],
    languageOptions: {
      globals: {
        jest: 'readonly',
        require: 'readonly',
        module: 'writable',
      },
    },
    rules: {
      // jest.mock factories idiomatically use require(); this is a plain
      // setup script, not application source.
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
];
