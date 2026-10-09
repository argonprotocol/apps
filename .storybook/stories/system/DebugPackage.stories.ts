import type { Meta, StoryObj } from '@storybook/vue3-vite';
import { DialogTitle } from 'reka-ui';
import { mocked, userEvent, within } from 'storybook/test';
import { revealItemInDir } from '@tauri-apps/plugin-opener';
import { appConfigDir, appLogDir, downloadDir, join, tempDir } from '@tauri-apps/api/path';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { copyFile, mkdir, readDir, remove, writeTextFile } from '@tauri-apps/plugin-fs';
import OverlayBase from '../../../src-vue/overlays/OverlayBase.vue';
import DebugPackage from '../../../src-vue/overlays/troubleshooting/DebugPackage.vue';
import { Diagnostics } from '../../../src-vue/lib/Diagnostics.ts';
import { setupAppScenario } from '../../scenarios/setupAppScenario.ts';
import { TopTab } from '../../../src-vue/interfaces/IConfig.ts';

const meta = {
  title: 'System/Debugging package',
  component: DebugPackage,
  render: () => ({
    components: { OverlayBase, DialogTitle, DebugPackage },
    template: `
      <OverlayBase :isOpen="true" :showCloseIcon="false" class="w-9/12 max-w-5xl px-3 pb-4">
        <template #title>
          <DialogTitle class="grow text-2xl font-bold">Debugging Package</DialogTitle>
          <span class="text-xs font-medium text-slate-400">Design preview</span>
        </template>
        <DebugPackage />
      </OverlayBase>
    `,
  }),
  beforeEach: () => {
    setupAppScenario({ selectedTab: TopTab.Home });
    mocked(revealItemInDir).mockResolvedValue();
    mocked(Diagnostics.prototype.hasServer).mockReturnValue(false);
    mocked(Diagnostics.prototype.load).mockResolvedValue();
    mocked(Diagnostics.prototype.downloadTroubleshootingPackage).mockResolvedValue('/storybook/server.tar.gz');
    for (const getDirectory of [appConfigDir, appLogDir, downloadDir, tempDir]) {
      mocked(getDirectory).mockResolvedValue('/storybook');
    }
    mocked(join).mockImplementation(async (...parts) => parts.join('/'));
    mocked(mkdir).mockResolvedValue();
    mocked(readDir).mockResolvedValue([]);
    mocked(copyFile).mockResolvedValue();
    mocked(remove).mockResolvedValue();
    mocked(writeTextFile).mockResolvedValue();
    mocked(listen).mockResolvedValue(() => {});
    mocked(invoke).mockResolvedValue('{}');
  },
} satisfies Meta<typeof DebugPackage>;

export default meta;
type Story = StoryObj<typeof meta>;

export const DownloadOptions: Story = {
  play: () => {
    document.querySelectorAll('[role="dialog"] button').forEach(button => button.setAttribute('inert', ''));
  },
};

export const Collecting: Story = {
  beforeEach: () => {
    mocked(Diagnostics.prototype.hasServer).mockReturnValue(true);
    mocked(Diagnostics.prototype.downloadTroubleshootingPackage).mockImplementation(async onProgress => {
      onProgress(65);
      return new Promise(() => {});
    });
  },
  play: async () => {
    const canvas = within(document.body);
    await userEvent.click(await canvas.findByRole('button', { name: /^Download$/ }));
    document.querySelectorAll('[role="dialog"] button').forEach(button => button.setAttribute('inert', ''));
  },
};

export const SaveFailed: Story = {
  beforeEach: () => {
    mocked(invoke).mockImplementation(async <T>(command: string) => {
      if (command === 'create_zip') throw new Error('Synthetic local write failure');
      return '{}' as T;
    });
  },
  play: async () => {
    const canvas = within(document.body);
    await userEvent.click(await canvas.findByRole('button', { name: /^Download$/ }));
    await canvas.findByText('Could not save the debugging package. Please try again.');
    document.querySelectorAll('[role="dialog"] button').forEach(button => button.setAttribute('inert', ''));
  },
};
