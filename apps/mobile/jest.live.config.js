// Dedicated config for the live-backend integration suite.
// Run with: npm run test:live   (requires the Phase 4 API on EXPO_PUBLIC_API_URL)
//
// Uses the node environment (not the jest-expo RN sandbox) so the suite gets
// a real WHATWG fetch for genuine HTTP against the running backend.
module.exports = {
  preset: 'jest-expo',
  testEnvironment: 'node',
  // The live suite only imports the pure-TS API layer and brings its own
  // HTTP transport (Node http module), so the preset's RN setup files are
  // irrelevant here.
  testMatch: ['**/__tests__/live/**/*.test.[jt]s?(x)'],
  testTimeout: 30000,
};
