import { defineConfig, devices } from '@playwright/test';
import { DEFAULT_SESSION_PORT } from './src/protocol/index.ts';

const chromiumExecutablePath = process.env.PLAYWRIGHT_EXECUTABLE_PATH;

export default defineConfig({
  testDir: './tests',
  timeout: 30_000,
  expect: {
    timeout: 5_000,
  },
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:5173',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  // Two servers, because the client and the session are two things: Vite serves the page, the session
  // server owns the match in a room. The session is started here rather than inside a test so that the
  // two-context scenarios meet the same room for the whole run, exactly as two windows of a real session
  // would, and so that a developer running `npx playwright test` gets a room without starting anything.
  // `--strictPort` on Vite is not tidiness: without it a busy 5173 makes the dev server take 5174 quietly,
  // and then the health check below is answered by the wrong process and every session test fails on a
  // port that moved rather than on a session that broke.
  webServer: [
    {
      command: 'npm run dev -- --host 127.0.0.1 --port 5173 --strictPort',
      url: 'http://127.0.0.1:5173',
      reuseExistingServer: !process.env.CI,
    },
    {
      command: `npm run server -- --port ${DEFAULT_SESSION_PORT}`,
      url: `http://127.0.0.1:${DEFAULT_SESSION_PORT}/api/health`,
      reuseExistingServer: !process.env.CI,
    },
  ],
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        launchOptions: chromiumExecutablePath ? { executablePath: chromiumExecutablePath } : undefined,
      },
    },
  ],
});
