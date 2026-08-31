import type { Meta, StoryObj } from '@storybook/vue3-vite';
import {
  createOperationalAccessProof,
  setFetchImplementation,
  type FetchImplementation,
} from '@argonprotocol/apps-core';
import { Keyring } from '@argonprotocol/mainchain';
import { createPinia, setActivePinia } from 'pinia';
import * as Vue from 'vue';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import basicEmitter from '../../../src-vue/emitters/basicEmitter.ts';
import DiscordVerificationOverlay from '../../../src-vue/overlays/DiscordVerificationOverlay.vue';

type Services = NonNullable<InstanceType<typeof DiscordVerificationOverlay>['$props']['services']>;

let services: Services;
let interactive = false;
let resolveResponse: ((response: Response) => void) | undefined;
let submittedBody: Record<string, unknown> | undefined;

const meta = {
  title: 'Operations/Discord verification',
  component: DiscordVerificationOverlay,
  beforeEach: () => () => setFetchImplementation(),
  render: () => ({
    components: { DiscordVerificationOverlay },
    setup() {
      Vue.onMounted(() => basicEmitter.emit('openDiscordVerificationOverlay'));
      return { services, interactive };
    },
    template:
      '<div :class="interactive ? `` : `pointer-events-none`"><DiscordVerificationOverlay :services="services" /></div>',
  }),
} satisfies Meta<typeof DiscordVerificationOverlay>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Ready: Story = {
  beforeEach: () => setupServices(successResponse()),
};

export const Connected: Story = {
  beforeEach: () => {
    setupServices(successResponse(), true);
    interactive = true;
  },
  play: async () => {
    const canvas = within(document.body);
    await waitFor(() =>
      expect(
        canvas
          .getAllByText('Connected to Discord')
          .some(element => element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })),
      ).toBe(true),
    );
    await expect(canvas.findByRole('button', { name: 'Update Discord role' })).resolves.toBeVisible();
    await expect(canvas.queryByRole('textbox', { name: 'Verification code' })).not.toBeInTheDocument();
  },
};

export const Submitting: Story = {
  beforeEach: () => {
    setupServices(new Promise(() => undefined));
    interactive = true;
  },
  play: connectDiscord,
};

export const Verified: Story = {
  beforeEach: () => {
    setupServices(Promise.resolve(successResponse()));
    interactive = true;
  },
  play: async () => {
    await connectDiscord();
    await expect(within(document.body).findByText('Discord account connected')).resolves.toBeVisible();
    await expect(submittedBody).toEqual({
      version: 1,
      discordApplicationId: APPLICATION_ID,
      verificationCode: VERIFICATION_CODE,
      operationalAccountId: operator.address,
      signature: expect.stringMatching(/^0x[0-9a-f]+$/),
      accessProof,
    });
    await expect(services.config.hasConnectedDiscord).toBe(true);
  },
};

export const RoleUpdated: Story = {
  beforeEach: () => {
    setupServices(Promise.resolve(successResponse()), true);
    interactive = true;
  },
  play: async () => {
    const canvas = within(document.body);
    await userEvent.click(await canvas.findByRole('button', { name: 'Update Discord role' }));
    await waitFor(() =>
      expect(
        canvas
          .getAllByText('Discord role updated')
          .some(element => element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })),
      ).toBe(true),
    );
    await expect(submittedBody).toEqual({
      version: 1,
      discordApplicationId: APPLICATION_ID,
      signedAt: expect.any(Number),
      operationalAccountId: operator.address,
      signature: expect.stringMatching(/^0x[0-9a-f]+$/),
    });
  },
};

export const StaleConnection: Story = {
  beforeEach: () => {
    setupServices(
      Promise.resolve(Response.json({ error: 'Discord account is not connected.' }, { status: 404 })),
      true,
    );
    interactive = true;
  },
  play: async () => {
    const canvas = within(document.body);
    await userEvent.click(await canvas.findByRole('button', { name: 'Update Discord role' }));
    await waitFor(() =>
      expect(
        canvas
          .getAllByRole('textbox', { name: 'Verification code' })
          .some(element => element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })),
      ).toBe(true),
    );
    await expect(services.config.hasConnectedDiscord).toBe(false);
  },
};

export const ServiceError: Story = {
  beforeEach: () => {
    setupServices(Promise.resolve(Response.json({ error: 'Verification code has expired.' }, { status: 410 })));
    interactive = true;
  },
  play: async () => {
    await connectDiscord();
    await expect(within(document.body).findByText('Verification code has expired.')).resolves.toBeVisible();
  },
};

export const ConfigSaveError: Story = {
  beforeEach: () => {
    setupServices(Promise.resolve(successResponse()));
    services.config.save = async () => {
      throw new Error('Config unavailable');
    };
    interactive = true;
  },
  play: async () => {
    const canvas = within(document.body);
    await connectDiscord();
    await expect(canvas.findByText('Discord account connected')).resolves.toBeVisible();
    await expect(
      canvas.findByText('Discord connected, but this app could not remember the connection.'),
    ).resolves.toBeVisible();
    await expect(services.config.hasConnectedDiscord).toBe(false);
  },
};

export const CancelledSubmission: Story = {
  beforeEach: () => {
    let resolver!: (response: Response) => void;
    const response = new Promise<Response>(resolve => (resolver = resolve));
    setupServices(response);
    resolveResponse = resolver;
    interactive = true;
  },
  play: async () => {
    const canvas = within(document.body);
    await connectDiscord();
    await userEvent.click(await canvas.findByRole('button', { name: 'Cancel' }));
    basicEmitter.emit('openDiscordVerificationOverlay');
    resolveResponse?.(successResponse());
    await waitFor(() => expect(canvas.queryByText('Discord account connected')).not.toBeInTheDocument());
    await expect(canvas.findByRole('textbox', { name: 'Verification code' })).resolves.toBeVisible();
  },
};

const APPLICATION_ID = '123456789012345678';
const DISCORD_USER_ID = '456789012345678901';
const SERVICE_URL = 'https://verify.argon.network';
const VERIFICATION_CODE = `ARGON-${'a'.repeat(32)}`;
const operator = new Keyring({ type: 'sr25519' }).addFromUri('//DiscordOperator');
const upstream = new Keyring({ type: 'sr25519' }).addFromUri('//UpstreamOperator');
const accessProof = createOperationalAccessProof(upstream, operator.address);

function setupServices(response: Response | Promise<Response>, hasConnectedDiscord = false): void {
  setActivePinia(createPinia());
  interactive = false;
  resolveResponse = undefined;
  submittedBody = undefined;
  services = {
    applicationId: APPLICATION_ID,
    serviceUrl: SERVICE_URL,
    walletKeys: {
      getOperationalKeypair: async () => operator,
    },
    getAccessProof: async () => accessProof,
    config: {
      hasConnectedDiscord,
      save: async () => undefined,
    },
  };
  setFetchImplementation(((_input: Parameters<FetchImplementation>[0], init?: Parameters<FetchImplementation>[1]) => {
    submittedBody = JSON.parse(String(init?.body));
    return Promise.resolve(response);
  }) as FetchImplementation);
}

function successResponse(): Response {
  return Response.json({ discordUserId: DISCORD_USER_ID, roles: ['treasuryUser', 'treasuryCertified'] });
}

async function connectDiscord(): Promise<void> {
  const canvas = within(document.body);
  await userEvent.type(await canvas.findByRole('textbox', { name: 'Verification code' }), VERIFICATION_CODE);
  await userEvent.click(await canvas.findByRole('button', { name: 'Connect Discord' }));
}
