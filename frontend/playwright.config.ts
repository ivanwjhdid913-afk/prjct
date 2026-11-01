import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  fullyParallel: false,
  workers: 1,
  use: { baseURL: process.env.UI_TEST_URL ?? 'http://127.0.0.1:5173', browserName: 'chromium' },
  reporter: 'list',
});
