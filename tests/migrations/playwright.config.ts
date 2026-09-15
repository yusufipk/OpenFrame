import { defineConfig, devices } from '@playwright/test';

// The rehearsal database is already migrated. Do not use the normal global setup,
// which would rebuild the schema and invalidate the upgrade evidence.
export default defineConfig({
  testDir: '.',
  testMatch: 'project-folders-playback.spec.ts',
  outputDir: '/tmp/openframe-legacy-playback-results',
  workers: 1,
  use: { ...devices['Desktop Chrome'], baseURL: 'http://localhost:3102' },
});
