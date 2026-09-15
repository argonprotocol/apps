import type { Meta, StoryObj } from '@storybook/vue3-vite';
import { setFetchImplementation, signTreasuryMemberSeal, type FetchImplementation } from '@argonprotocol/apps-core';
import { Keyring } from '@argonprotocol/mainchain';
import { createPinia, setActivePinia } from 'pinia';
import * as Vue from 'vue';
import { mocked, userEvent, within } from 'storybook/test';
import basicEmitter from '../../../src-vue/emitters/basicEmitter.ts';
import DiscordVerificationOverlay from '../../../src-vue/overlays/DiscordVerificationOverlay.vue';
import { getConfig } from '../../../src-vue/stores/config.ts';
import { getUpstreamOperatorClient } from '../../../src-vue/stores/upstreamOperator.ts';
import { getWalletKeys } from '../../../src-vue/stores/wallets.ts';

let interactive = false;
let resolveResponse: ((response: Response) => void) | undefined;

const meta = {
  title: 'Operations/Discord verification',
  component: DiscordVerificationOverlay,
  beforeEach: () => () => setFetchImplementation(),
  render: () => ({
    components: { DiscordVerificationOverlay },
    setup() {
      Vue.onMounted(() => basicEmitter.emit('openDiscordVerificationOverlay'));
      return { interactive };
    },
    template: '<div :class="interactive ? `` : `pointer-events-none`"><DiscordVerificationOverlay /></div>',
  }),
} satisfies Meta<typeof DiscordVerificationOverlay>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Ready: Story = {
  beforeEach: () => {
    setupState(successResponse());
  },
};

export const Connected: Story = {
  beforeEach: () => {
    setupState(successResponse(), true);
    interactive = true;
  },
};

export const Submitting: Story = {
  beforeEach: () => {
    setupState(new Promise(() => undefined));
    interactive = true;
  },
  play: connectDiscord,
};

export const Verified: Story = {
  beforeEach: () => {
    setupState(Promise.resolve(successResponse()));
    interactive = true;
  },
  play: connectDiscord,
};

export const RoleUpdated: Story = {
  beforeEach: () => {
    setupState(Promise.resolve(successResponse()), true);
    interactive = true;
  },
  play: async () => {
    const canvas = within(document.body);
    await userEvent.click(await canvas.findByRole('button', { name: 'Update Discord role' }));
  },
};

export const StaleConnection: Story = {
  beforeEach: () => {
    setupState(Promise.resolve(Response.json({ error: 'Discord account is not connected.' }, { status: 404 })), true);
    interactive = true;
  },
  play: async () => {
    const canvas = within(document.body);
    await userEvent.click(await canvas.findByRole('button', { name: 'Update Discord role' }));
  },
};

export const ServiceError: Story = {
  beforeEach: () => {
    setupState(Promise.resolve(Response.json({ error: 'Verification code has expired.' }, { status: 410 })));
    interactive = true;
  },
  play: connectDiscord,
};

export const ConfigSaveError: Story = {
  beforeEach: () => {
    const config = setupState(Promise.resolve(successResponse()));
    config.save = async () => {
      throw new Error('Config unavailable');
    };
    interactive = true;
  },
  play: connectDiscord,
};

export const CancelledSubmission: Story = {
  beforeEach: () => {
    let resolver!: (response: Response) => void;
    const response = new Promise<Response>(resolve => (resolver = resolve));
    setupState(response);
    resolveResponse = resolver;
    interactive = true;
  },
  play: async () => {
    const canvas = within(document.body);
    await connectDiscord();
    await userEvent.click(await canvas.findByRole('button', { name: 'Cancel' }));
    basicEmitter.emit('openDiscordVerificationOverlay');
    resolveResponse?.(successResponse());
  },
};

const DISCORD_USER_ID = '456789012345678901';
const VERIFICATION_CODE = `ARGON-${'a'.repeat(32)}`;
const operator = new Keyring({ type: 'sr25519' }).addFromUri('//DiscordOperator');
const upstream = new Keyring({ type: 'sr25519' }).addFromUri('//UpstreamOperator');

function setupState(response: Response | Promise<Response>, hasConnectedDiscord = false) {
  setActivePinia(createPinia());
  interactive = false;
  resolveResponse = undefined;

  const config = Vue.reactive({
    hasConnectedDiscord,
    save: async () => undefined,
  });
  mocked(getConfig, { partial: true }).mockReturnValue(config);
  mocked(getWalletKeys, { partial: true }).mockReturnValue({
    getOperationalKeypair: async () => operator,
  });
  mocked(getUpstreamOperatorClient, { partial: true }).mockReturnValue({
    getTreasuryMemberSeal: async proof =>
      signTreasuryMemberSeal(upstream, proof, {
        genesisHash: `0x${'11'.repeat(32)}`,
        vaultId: 12,
      }),
  });
  setFetchImplementation((() => Promise.resolve(response)) as FetchImplementation);

  return config;
}

function successResponse(): Response {
  return Response.json({ discordUserId: DISCORD_USER_ID, roles: ['treasuryUser', 'treasuryCertified'] });
}

async function connectDiscord(): Promise<void> {
  const canvas = within(document.body);
  await userEvent.type(await canvas.findByRole('textbox', { name: 'Verification code' }), VERIFICATION_CODE);
  await userEvent.click(await canvas.findByRole('button', { name: 'Connect Discord' }));
}
