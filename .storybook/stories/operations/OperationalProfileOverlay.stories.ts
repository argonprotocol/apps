import type { Meta, StoryObj } from '@storybook/vue3-vite';
import * as Vue from 'vue';
import { expect, userEvent, within } from 'storybook/test';
import { setupOperationalProfileScenario } from '../../scenarios/setupOnboardingOverlayScenario.ts';
import { expectEventuallyVisible } from '../../support/expectEventuallyVisible.ts';
import basicEmitter, { type IOperationalProfileRequest } from '../../../src-vue/emitters/basicEmitter.ts';
import OperationalProfileOverlay from '../../../src-vue/overlays/OperationalProfileOverlay.vue';

let profileRequest: IOperationalProfileRequest;

const meta = {
  title: 'Operations/Profile',
  component: OperationalProfileOverlay,
  render: () => ({
    components: { OperationalProfileOverlay },
    setup() {
      Vue.onMounted(() => basicEmitter.emit('openOperationalProfileOverlay', profileRequest));
    },
    template: '<OperationalProfileOverlay />',
  }),
} satisfies Meta<typeof OperationalProfileOverlay>;

export default meta;
type Story = StoryObj<typeof meta>;

export const DraftName: Story = {
  beforeEach: () => {
    profileRequest = { draftName: 'AtlasOperator', onSelect: () => undefined };
    setupOperationalProfileScenario('draft');
  },
};

export const VaultRequired: Story = {
  beforeEach: () => {
    profileRequest = { draftName: 'AtlasOperator', onSelect: () => undefined };
    setupOperationalProfileScenario('vaultRequired');
  },
};

export const LoadFailed: Story = {
  beforeEach: () => {
    profileRequest = { draftName: 'AtlasOperator', onSelect: () => undefined };
    setupOperationalProfileScenario('loadError');
  },
};

export const SettingsWithFlexibleAssets: Story = {
  beforeEach: () => {
    profileRequest = { screen: 'settings' };
    setupOperationalProfileScenario('settingsFlexible');
  },
  play: async () => {
    const canvas = within(document.body);
    await expectEventuallyVisible(canvas.findByText('Onboarding Settings'));
    await expectEventuallyVisible(canvas.findByRole('button', { name: /Operations Name/ }));
    await expectEventuallyVisible(canvas.findByRole('button', { name: /Flexible Assets/ }));
  },
};

export const SettingsWithoutFlexibleAssets: Story = {
  beforeEach: () => {
    profileRequest = { screen: 'settings' };
    setupOperationalProfileScenario('settingsBasic');
  },
  play: async () => {
    const canvas = within(document.body);
    await expectEventuallyVisible(canvas.findByText('Onboarding Settings'));
    expect(canvas.queryByRole('button', { name: /Flexible Assets/ })).not.toBeInTheDocument();
  },
};

export const EditOperationsNameFromSettings: Story = {
  beforeEach: () => {
    profileRequest = { screen: 'settings' };
    setupOperationalProfileScenario('settingsFlexible');
  },
  play: async () => {
    const canvas = within(document.body);
    await userEvent.click(await canvas.findByRole('button', { name: /Operations Name/ }));
    await expectEventuallyVisible(canvas.findByText('Your Operational Profile'));
    await expect(canvas.findByPlaceholderText('ArgonFamily')).resolves.toHaveValue('AtlasOperator');
  },
};
