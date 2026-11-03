import type { Meta, StoryObj } from '@storybook/vue3-vite';
import { fn, mocked, userEvent, within } from 'storybook/test';
import { Update } from '@tauri-apps/plugin-updater';
import { createPinia, setActivePinia } from 'pinia';
import { useAppUpdater } from '../../../src-vue/stores/appUpdater.ts';
import { useRuntimeCompatibility } from '../../../src-vue/stores/runtimeCompatibility.ts';
import AppBootstrap from '../../../src-vue/AppBootstrap.vue';
import App from '../../../src-vue/App.vue';
import { useStartupStore } from '../../../src-vue/stores/startup.ts';
import { exposeMasterMnemonic } from '../../../src-vue/stores/wallets.ts';
import { appLogDir } from '@tauri-apps/api/path';
import { invoke } from '@tauri-apps/api/core';

let updater: ReturnType<typeof useAppUpdater>;
let runtimeCompatibility: ReturnType<typeof useRuntimeCompatibility>;
let downloadAndInstallUpdate = fn(async () => undefined);

const meta = {
  title: 'System/App startup',
  component: AppBootstrap,
  render: () => ({ components: { App }, template: '<App />' }),
  beforeEach: () => {
    setActivePinia(createPinia());
    updater = useAppUpdater();
    runtimeCompatibility = useRuntimeCompatibility();
    mocked(useStartupStore, { partial: true }).mockReturnValue({
      isWalletReady: false,
      isLoading: true,
      errorMessage: '',
      initialize: fn(async () => undefined),
    });

    downloadAndInstallUpdate = fn(async () => undefined);
    updater.downloadAndInstallUpdate = downloadAndInstallUpdate;
    mocked(exposeMasterMnemonic).mockResolvedValue('test test test test test test test test test test test junk');
    mocked(appLogDir).mockResolvedValue('/synthetic/logs');
    mocked(invoke).mockRejectedValue(new Error('Native services are unavailable in this preview.'));
    return () => {
      mocked(useStartupStore).mockReset();
      mocked(exposeMasterMnemonic).mockRestore();
      mocked(appLogDir).mockRestore();
      mocked(invoke).mockRestore();
    };
  },
} satisfies Meta<typeof AppBootstrap>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Loading: Story = {
  beforeEach: () => {
    runtimeCompatibility.phase = 'loading';
  },
};

export const NetworkUpgrade: Story = {
  beforeEach: () => {
    runtimeCompatibility.phase = 'paused';
  },
};

export const UpdateRequired: Story = {
  beforeEach: () => {
    runtimeCompatibility.phase = 'upgrade-required';
    updater.update = createUpdate();
  },
};

export const DownloadingUpdate: Story = {
  beforeEach: () => {
    runtimeCompatibility.phase = 'upgrade-required';
    updater.update = createUpdate();
    updater.isDownloading = true;
    updater.downloadProgress = 0.58;
  },
};

export const DownloadFailed: Story = {
  beforeEach: () => {
    runtimeCompatibility.phase = 'upgrade-required';
    updater.update = createUpdate();
    updater.downloadProgress = 0.41;
    updater.errorMessage = 'Error downloading update. Please try again later.';
  },
};

export const InstallUpdateInteraction: Story = {
  beforeEach: () => {
    runtimeCompatibility.phase = 'upgrade-required';
    updater.update = createUpdate();
    downloadAndInstallUpdate.mockImplementation(async () => {
      updater.isDownloading = true;
      updater.downloadProgress = 0.58;
    });
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    await userEvent.click(canvas.getByRole('button', { name: 'Install Update' }));
  },
};

function createUpdate() {
  return new Update({
    rid: 0,
    currentVersion: '2.0.0',
    version: '2.1.0',
    rawJson: {},
  });
}
