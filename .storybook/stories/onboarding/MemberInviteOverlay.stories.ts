import type { Meta, StoryObj } from '@storybook/vue3-vite';
import * as Vue from 'vue';
import { expect, userEvent, within } from 'storybook/test';
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
    const canvas = within(document.body);
    await expectEventuallyVisible(canvas.findByText('Attach Bitcoin Lock Fees Waivers'));
    expect(canvas.queryByText(/Activate member onboarding before creating an invite/)).not.toBeInTheDocument();
    await expect(canvas.findByRole('slider', { name: 'Bitcoin lock fee waiver amount' })).resolves.toBeEnabled();
  },
};

export const FeeWaiverAvailabilityOpen: Story = {
  ...CurrentRuntime,
  play: async () => {
    const canvas = within(document.body);
    await userEvent.click(await canvas.findByRole('button', { name: '7 days' }));
    await expectEventuallyVisible(canvas.findByText('Fee Waiver Availability'));
    await expect(canvas.findByTestId('input-number')).resolves.toHaveTextContent('7');
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

export const OnboardingInactive: Story = {
  beforeEach: () => setupMemberInviteScenario('onboardingInactive'),
  play: async () => {
    await expectEventuallyVisible(
      within(document.body).findByText(/Activate member onboarding before creating an invite/),
    );
  },
};

export const BitcoinSpaceRequired: Story = {
  beforeEach: () => setupMemberInviteScenario('bitcoinSpaceRequired'),
  play: async () => {
    await expectEventuallyVisible(
      within(document.body).findByText(/Member invites require at least \$1 of available Bitcoin lock space/),
    );
  },
};

export const InsufficientBitcoinWaiver: Story = {
  beforeEach: () => setupMemberInviteScenario('insufficientBitcoinWaiver'),
  play: async () => {
    await expectEventuallyVisible(
      within(document.body).findByText(/will not be able to lock enough Bitcoin for Treasury verification/),
    );
  },
};

export const InsufficientBondCapacity: Story = {
  beforeEach: () => setupMemberInviteScenario('insufficientBondCapacity'),
  play: async () => {
    await expectEventuallyVisible(
      within(document.body).findByText(/will not be able to buy enough bonds for Treasury verification/),
    );
  },
};

export const SetupInProgress: Story = {
  beforeEach: () => setupMemberInviteScenario('setupProgress'),
  play: async () => {
    await submitInvite();
    await expectEventuallyVisible(within(document.body).findByText('Preparing your vault to create this invite.'));
  },
};

export const Creating: Story = {
  beforeEach: () => setupMemberInviteScenario('creating'),
  play: async () => {
    await submitInvite();
    await expectEventuallyVisible(within(document.body).findByRole('button', { name: 'Creating…' }));
  },
};

export const CreateFailed: Story = {
  beforeEach: () => setupMemberInviteScenario('createError'),
  play: async () => {
    await submitInvite();
    await expectEventuallyVisible(within(document.body).findByText('The invite service is unavailable.'));
  },
};

async function submitInvite() {
  const canvas = within(document.body);
  await userEvent.type(await canvas.findByPlaceholderText('Who is this invite for?'), 'Morgan');
  await userEvent.click(await canvas.findByRole('button', { name: 'Create Invite' }));
}
