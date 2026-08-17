import type { Meta, StoryObj } from '@storybook/vue3-vite';
import { expect, fn, userEvent, within } from 'storybook/test';
import { Update } from '@tauri-apps/plugin-updater';
import { createPinia, setActivePinia } from 'pinia';
import { useAppUpdater } from '../../../src-vue/stores/appUpdater.ts';
import { useRuntimeCompatibility } from '../../../src-vue/stores/runtimeCompatibility.ts';
import RuntimeCompatibilityScreen from '../../../src-vue/screens/RuntimeCompatibilityScreen.vue';

let updater: ReturnType<typeof useAppUpdater>;
let runtimeCompatibility: ReturnType<typeof useRuntimeCompatibility>;
let downloadAndInstallUpdate = fn(async () => undefined);

const meta = {
  title: 'System/Runtime compatibility',
  component: RuntimeCompatibilityScreen,
  beforeEach: () => {
    setActivePinia(createPinia());
    updater = useAppUpdater();
    runtimeCompatibility = useRuntimeCompatibility();

    downloadAndInstallUpdate = fn(async () => undefined);
    updater.downloadAndInstallUpdate = downloadAndInstallUpdate;
  },
} satisfies Meta<typeof RuntimeCompatibilityScreen>;

export default meta;
type Story = StoryObj<typeof meta>;

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

    await expect(downloadAndInstallUpdate).toHaveBeenCalledOnce();
    await expect(canvas.getByRole('button', { name: 'Downloading Update...' })).toBeDisabled();
    await expect(canvas.getByText('58.0%')).toBeInTheDocument();
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
