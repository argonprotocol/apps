import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    retry: 1,
    reporters: process.env.GITHUB_ACTIONS ? ['dot', 'github-actions'] : ['dot'],
    maxWorkers: 1,
    disableConsoleIntercept: true,
    projects: [
      {
        test: {
          name: 'src-vue',
          testTimeout: 30_000,
          hookTimeout: 30_000,
          include: ['src-vue/__test__/**/*.test.ts'],
          setupFiles: './vitest.setup.ts',
          // silent: false
        },
      },
      {
        test: {
          name: 'core',
          testTimeout: 240_000,
          hookTimeout: 120_000,
          include: ['core/__test__/**/*.test.ts'],
        },
      },
      {
        test: {
          name: 'indexer',
          testTimeout: 240_000,
          hookTimeout: 120_000,
          include: ['indexer/__test__/**/*.test.ts'],
        },
      },
      {
        test: {
          name: 'bot',
          testTimeout: 240_000,
          hookTimeout: 120_000,
          include: ['bot/__test__/**/*.test.ts'],
          env: {
            STATUS_URL: 'na',
          },
        },
      },
      {
        test: {
          name: 'e2e',
          include: ['e2e/__test__/**/*.test.ts'],
          isolate: false,
          fileParallelism: false,
          maxWorkers: 1,
          sequence: {
            concurrent: false,
            shuffle: false,
          },
          hookTimeout: 10 * 60_000,
          testTimeout: 45 * 60_000,
          env: {
            ARGON_E2E_HEADLESS: process.env.ARGON_E2E_HEADLESS ?? '1',
            CI: process.env.CI ?? '1',
          },
          deps: {
            inline: ['@argonprotocol/apps-core'],
          },
        },
      },
    ],
  },
});
