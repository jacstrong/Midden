import { defineConfig, devices } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const dataDir = process.env.MIDDEN_E2E_DATA ?? mkdtempSync(join(tmpdir(), 'midden-e2e-data-'));

/**
 * Two families of projects:
 *  - standalone-*: open the single-file build via file:// in each engine.
 *  - hosted: drive a built server (started below) in Chromium.
 */
export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : 'list',
  use: { trace: 'on-first-retry' },
  projects: [
    {
      name: 'standalone-chromium',
      testMatch: /(standalone|legacy-compat).*\.spec\.ts/,
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'standalone-firefox',
      testMatch: /(standalone|legacy-compat).*\.spec\.ts/,
      use: { ...devices['Desktop Firefox'] },
    },
    {
      name: 'standalone-webkit',
      testMatch: /(standalone|legacy-compat).*\.spec\.ts/,
      use: { ...devices['Desktop Safari'] },
    },
    {
      name: 'hosted',
      testMatch: /hosted.*\.spec\.ts/,
      use: { ...devices['Desktop Chrome'], baseURL: 'http://127.0.0.1:18090' },
      fullyParallel: false,
      workers: 1,
    },
  ],
  webServer: {
    command: `node --no-warnings=ExperimentalWarning ${join(root, 'packages/server/dist/main.js')}`,
    url: 'http://127.0.0.1:18090/api/health',
    reuseExistingServer: false,
    timeout: 30_000,
    env: {
      MIDDEN_PORT: '18090',
      MIDDEN_HOST: '127.0.0.1',
      MIDDEN_DATA: dataDir,
      MIDDEN_PUBLIC_DIR: join(root, 'packages/web/dist'),
      MIDDEN_ADMIN_USER: 'admin',
      MIDDEN_ADMIN_PASSWORD: 'e2e-admin-password',
      MIDDEN_ARGON2_MEMORY_KIB: '8192',
      MIDDEN_LOGIN_RATE_LIMIT: '1000',
      MIDDEN_LOG_LEVEL: 'warn',
    },
  },
});
