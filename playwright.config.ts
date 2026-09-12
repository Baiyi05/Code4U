import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end checks for the prototype.
 *
 * Playwright owns the dev server, so the specs always run against the source as
 * it is now rather than whatever was last built. Everything is localhost — these
 * tests never touch the network beyond the app itself.
 *
 *   npx playwright test                     both viewports
 *   npx playwright test --project=desktop   just one
 */
export default defineConfig({
  testDir: './e2e',
  outputDir: './e2e/.results',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 90_000,
  expect: { timeout: 10_000 },
  reporter: [['list']],

  use: {
    baseURL: 'http://127.0.0.1:3988',
    trace: 'retain-on-failure',
    // screenshots are taken per step by the specs themselves, into e2e/shots
    screenshot: 'off',
    video: 'off',
  },

  projects: [
    {
      name: 'desktop',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } },
    },
    {
      name: 'mobile',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 390, height: 844 },
        isMobile: false, // Chromium desktop build cannot do isMobile; the size is what matters
        hasTouch: true,
      },
    },
  ],

  webServer: {
    // A production build, not `next dev`: the dev overlay injects its own
    // console noise and its own copy of the 404 component, and this is closer
    // to what actually gets demoed.
    command: 'npx next build && npx next start -p 3988',
    url: 'http://127.0.0.1:3988/setup',
    reuseExistingServer: !process.env['CI'],
    timeout: 300_000,
    stdout: 'ignore',
    stderr: 'pipe',
  },
});
