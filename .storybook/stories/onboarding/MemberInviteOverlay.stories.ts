import type { Meta, StoryObj } from '@storybook/vue3-vite';
import * as Vue from 'vue';
import { within } from 'storybook/test';
import { setupMemberInviteScenario } from '../../scenarios/setupOnboardingOverlayScenario.ts';
import { expectEventuallyVisible } from '../../support/expectEventuallyVisible.ts';
import basicEmitter from '../../../src-vue/emitters/basicEmitter.ts';
import MemberInviteOverlay from '../../../src-vue/overlays/MemberInviteOverlay.vue';

const meta = {
  title: 'Onboarding/Member invite',
  component: MemberInviteOverlay,
  render: () => ({
    components: { MemberInviteOverlay },
    setup() {
      Vue.onMounted(() => basicEmitter.emit('openMemberInviteOverlay'));
    },
    template: '<MemberInviteOverlay />',
  }),
} satisfies Meta<typeof MemberInviteOverlay>;

export default meta;
type Story = StoryObj<typeof meta>;

export const VaultRequired: Story = {
  beforeEach: () => setupMemberInviteScenario('vaultRequired'),
};

export const LoadingCapacity: Story = {
  beforeEach: () => setupMemberInviteScenario('loading'),
};

export const CapacityLoadFailed: Story = {
  beforeEach: () => setupMemberInviteScenario('loadError'),
};

export const CurrentRuntime: Story = {
  beforeEach: () => setupMemberInviteScenario('currentRuntime'),
  play: async () => {
    await expectEventuallyVisible(within(document.body).findByText('Attach Bitcoin Lock Fees Waivers'));
  },
};

export const PreviousRuntime: Story = {
  beforeEach: () => setupMemberInviteScenario('previousRuntime'),
  play: async () => {
    await expectEventuallyVisible(
      within(document.body).findByText('This waiver works on a single Bitcoin lock until the system is upgraded.'),
    );
  },
};
