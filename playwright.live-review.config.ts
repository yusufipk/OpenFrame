import { defineConfig, devices } from '@playwright/test';
import main from './playwright.config';

const appServer = Array.isArray(main.webServer) ? main.webServer[0] : main.webServer;
const appEnv = appServer?.env ?? {};
const baseURL = String(main.use?.baseURL ?? 'http://localhost:3100');
const secret = 'fixed-test-only-secret-32-characters';
const liveEnv = {
  OPENFRAME_ENABLE_LIVE_REVIEW: 'true',
  LIVE_REVIEW_SECRET: secret,
  LIVE_REVIEW_PUBLIC_URL: 'ws://localhost:3101/ws',
  LIVE_REVIEW_INTERNAL_URL: 'http://localhost:3101',
  LIVE_REVIEW_ALLOWED_ORIGIN: baseURL,
};

export default defineConfig({
  ...main,
  testMatch: '**/live-review*.spec.ts',
  projects: [{ name: 'chromium-live-review', use: { ...devices['Desktop Chrome'] } }],
  workers: 1,
  retries: 0,
  webServer: [
    ...(appServer
      ? [{ ...appServer, reuseExistingServer: false, env: { ...appEnv, ...liveEnv } }]
      : []),
    {
      command: 'bun run test:db:bootstrap && bun scripts/live-review-server.ts',
      port: 3101,
      reuseExistingServer: false,
      timeout: 120_000,
      stdout: 'pipe',
      stderr: 'pipe',
      env: {
        ...appEnv,
        ...liveEnv,
        LIVE_REVIEW_APP_URL: baseURL,
        LIVE_REVIEW_PORT: '3101',
      },
    },
  ],
});
