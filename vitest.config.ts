import { defineConfig } from 'vitest/config';

const INTEGRATION_TEST_GLOB = '**/__test__/**/*.integration.test.ts';
const E2E_TEST_GLOB = 'e2e/__test__/**/*.e2e.test.ts';
const APP_SETUP_FILE = './vitest.setup.ts';

export default defineConfig({
  test: {
    retry: 1,
    reporters: process.env.GITHUB_ACTIONS ? ['dot', 'github-actions'] : ['dot'],
    maxWorkers: process.env.VITEST_MAX_WORKERS ?? '50%',
    disableConsoleIntercept: true,
    projects: [
      {
        test: {
          name: 'src-vue',
          testTimeout: 30_000,
          hookTimeout: 30_000,
          include: ['src-vue/__test__/**/*.test.ts'],
          exclude: [INTEGRATION_TEST_GLOB],
          setupFiles: APP_SETUP_FILE,
          // silent: false
        },
      },
      {
        test: {
          name: 'core',
          testTimeout: 240_000,
          hookTimeout: 120_000,
          include: ['core/__test__/**/*.test.ts'],
          exclude: [INTEGRATION_TEST_GLOB],
        },
      },
      {
        test: {
          name: 'indexer',
          testTimeout: 240_000,
          hookTimeout: 120_000,
          include: ['indexer/__test__/**/*.test.ts'],
          exclude: [INTEGRATION_TEST_GLOB],
        },
      },
      {
        test: {
          name: 'bot',
          testTimeout: 240_000,
          hookTimeout: 120_000,
          include: ['bot/__test__/**/*.test.ts'],
          exclude: [INTEGRATION_TEST_GLOB],
          env: {
            ROUTER_URL: 'na',
          },
        },
      },
      {
        test: {
          name: 'router',
          testTimeout: 120_000,
          hookTimeout: 120_000,
          include: ['router/__test__/**/*.test.ts'],
          exclude: [INTEGRATION_TEST_GLOB],
        },
      },
      {
        test: {
          name: 'integration',
          testTimeout: 240_000,
          hookTimeout: 120_000,
          include: [INTEGRATION_TEST_GLOB],
          setupFiles: APP_SETUP_FILE,
          fileParallelism: false,
          maxWorkers: 1,
          sequence: {
            concurrent: false,
            groupOrder: 1,
            shuffle: false,
          },
          env: {
            ROUTER_URL: 'na',
          },
        },
      },
      {
        test: {
          name: 'e2e',
          include: [E2E_TEST_GLOB],
          isolate: false,
          fileParallelism: false,
          maxWorkers: 1,
          sequence: {
            concurrent: false,
            groupOrder: 2,
            shuffle: false,
          },
          hookTimeout: 10 * 60_000,
          testTimeout: 45 * 60_000,
          env: {
            ARGON_E2E_HEADLESS: process.env.ARGON_E2E_HEADLESS ?? '1',
            CI: process.env.CI ?? '1',
            E2E_SCREENSHOT_MODE: process.env.E2E_SCREENSHOT_MODE ?? '',
            E2E_SCREENSHOT_DIR: process.env.E2E_SCREENSHOT_DIR ?? '',
            E2E_SCREENSHOT_SESSION: process.env.E2E_SCREENSHOT_SESSION ?? '',
          },
          deps: {
            inline: ['@argonprotocol/apps-core'],
          },
        },
      },
    ],
  },
});
