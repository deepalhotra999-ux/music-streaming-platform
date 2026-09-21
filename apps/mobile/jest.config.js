// jest-expo preset handles transform, module mapping, and Expo module mocks.
module.exports = {
  preset: 'jest-expo',
  testMatch: ['**/__tests__/**/*.test.[jt]s?(x)'],
  setupFiles: ['<rootDir>/jest.setup.js'],
  // The live API suite needs a running backend; run it explicitly with
  // `npm run test:live` instead of the default `npm test`.
  testPathIgnorePatterns: ['/node_modules/', '__tests__/live/'],
};
