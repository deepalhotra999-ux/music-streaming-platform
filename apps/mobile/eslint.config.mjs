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
    // Phase 23 — the CarPlay config plugin is plain Node, like babel.config.
    files: ['modules/waveform-carplay/app.plugin.js'],
    languageOptions: {
      globals: {
        module: 'writable',
        require: 'readonly',
        process: 'readonly',
        __dirname: 'readonly',
      },
    },
    rules: {
      // Config plugins idiomatically use require(); this is tooling, not app source.
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
  {
    // Phase 23 — plugin unit tests run under Jest like every other test.
    files: ['modules/waveform-carplay/__tests__/**/*.js'],
    languageOptions: {
      globals: {
        jest: 'readonly',
        describe: 'readonly',
        test: 'readonly',
        expect: 'readonly',
        require: 'readonly',
        module: 'writable',
        process: 'readonly',
        __dirname: 'readonly',
        structuredClone: 'readonly',
      },
    },
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
  {
    // Phase 24 — native-module static tests are plain Node, like the
    // CarPlay plugin tests above.
    files: ['modules/waveform-android-auto/__tests__/**/*.js'],
    languageOptions: {
      globals: {
        jest: 'readonly',
        describe: 'readonly',
        test: 'readonly',
        expect: 'readonly',
        require: 'readonly',
        module: 'writable',
        process: 'readonly',
        __dirname: 'readonly',
        structuredClone: 'readonly',
      },
    },
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
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
