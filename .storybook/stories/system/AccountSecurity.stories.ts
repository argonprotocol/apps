import type { Meta, StoryObj } from '@storybook/vue3-vite';
import * as Vue from 'vue';
import { mocked, userEvent, within } from 'storybook/test';
import { invoke } from '@tauri-apps/api/core';
import { cryptoWaitReady } from '@polkadot/util-crypto';
import AccountSecurity from '../../../src-vue/overlays/security-settings/AccountSecurity.vue';
import SecuritySettingsOverlay from '../../../src-vue/overlays/SecuritySettingsOverlay.vue';
import AccountAuthenticationOverlay from '../../../src-vue/overlays/AccountAuthenticationOverlay.vue';
import WalletViewPrivateKey from '../../../src-vue/wallets/components/WalletViewPrivateKey.vue';
import { AccountSecurity as AccountSecurityModel } from '../../../src-vue/lib/AccountSecurity.ts';
import { EncryptionSecret, type KeyProtection } from '../../../src-vue/lib/EncryptionSecret.ts';
import { WalletKeys } from '../../../src-vue/lib/WalletKeys.ts';
import {
  configureAccountSecurity,
  getAccountSecurity,
  getWalletKeys,
  exposeMasterMnemonic,
  useWallets,
} from '../../../src-vue/stores/wallets.ts';
import { WalletType } from '../../../src-vue/lib/Wallet.ts';
import basicEmitter from '../../../src-vue/emitters/basicEmitter.ts';
import { setupAppScenario } from '../../scenarios/setupAppScenario.ts';
import { TopTab } from '../../../src-vue/interfaces/IConfig.ts';
import App from '../../../src-vue/App.vue';
import { useStartupStore } from '../../../src-vue/stores/startup.ts';
import { useAppUpdater } from '../../../src-vue/stores/appUpdater.ts';

const mnemonic = 'test test test test test test test test test test test junk';
let protection: KeyProtection;
let wrappingKey: number[];
let saveError: string | undefined;

const meta = {
  title: 'System/Account security',
  component: AccountSecurity,
  render: () => ({
    components: { SecuritySettingsOverlay, AccountAuthenticationOverlay },
    setup() {
      Vue.onMounted(() => basicEmitter.emit('openSecuritySettingsOverlay', { screen: 'accountSecurity' }));
      return {};
    },
    template: `
      <div class="h-screen bg-slate-100">
        <div class="fixed top-4 right-4 rounded-full border border-slate-300 bg-white px-3 py-1 text-xs font-semibold text-slate-500">
          Interactive preview
        </div>
        <SecuritySettingsOverlay />
        <AccountAuthenticationOverlay />
      </div>
    `,
  }),
  beforeEach: async () => {
    setupAppScenario({ selectedTab: TopTab.Home });
    mocked(useStartupStore, { partial: true }).mockReturnValue({ isWalletReady: true });
    useAppUpdater().installedVersion = '2.5.1';
    protection = { method: 'none' };
    wrappingKey = [];
    saveError = undefined;
    mocked(invoke).mockReset();
    mocked(invoke).mockImplementation(async <T>(command: string, args: Parameters<typeof invoke>[1]) => {
      if (command === 'system_authentication_option') return 'touchId' as T;
      if (command === 'request_system_authentication') return undefined as T;
      if (command === 'lock_devtools') return undefined as T;
      if (command === 'keychain_info') return protection as T;
      if (command === 'read_wallet_file') {
        return JSON.stringify({
          encryptedMnemonic: 'synthetic-ciphertext',
          meta: WalletKeys.deriveIdentity(mnemonic),
        }) as T;
      }
      if (command === 'keychain_set_protection' || command === 'keychain_authenticate') {
        const request = args as {
          protection: KeyProtection;
          authentication: { wrappingKey?: number[] };
          newAuthentication: { wrappingKey?: number[] };
        };
        if (
          protection.method === 'passcode' &&
          JSON.stringify(request.authentication.wrappingKey) !== JSON.stringify(wrappingKey)
        )
          throw new Error('The current app passcode is incorrect.');
        if (command === 'keychain_set_protection') {
          if (saveError && request.protection.method === 'system') throw new Error(saveError);
          protection = request.protection;
          wrappingKey = request.newAuthentication.wrappingKey?.slice() ?? [];
        }
        return undefined as T;
      }
      throw new Error(`Unexpected native command in Account Security preview: ${command}`);
    });
    await cryptoWaitReady();
    const keys = WalletKeys.fromMnemonic(mnemonic);
    const security = new AccountSecurityModel(
      prompt =>
        new Promise<void>((resolve, reject) => {
          basicEmitter.emit('requestAccountAuthentication', { ...prompt, resolve, reject });
        }),
    );
    security.data = Vue.shallowReactive(security.data);
    await security.ready;
    mocked(getAccountSecurity).mockReturnValue(security);
    mocked(getWalletKeys).mockReturnValue(keys);
    mocked(exposeMasterMnemonic).mockImplementation(() => keys.exposeMasterMnemonic());
    mocked(configureAccountSecurity).mockImplementation(async ({ method, currentPasscode, newPasscode }) => {
      await new EncryptionSecret().setProtection(method, { passcode: currentPasscode, newPasscode });
      await security.getSettings();
    });
    return () => {
      mocked(getAccountSecurity).mockRestore();
      mocked(getWalletKeys).mockRestore();
      mocked(exposeMasterMnemonic).mockRestore();
      mocked(configureAccountSecurity).mockReset();
      mocked(useStartupStore).mockReset();
    };
  },
} satisfies Meta<typeof AccountSecurity>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Setup: Story = {};

export const TouchIdUnavailable: Story = {
  beforeEach: () => {
    saveError =
      'Touch ID is unavailable in this app build because its keychain signing permissions are missing. Use App Passcode instead.';
  },
  play: async () => {
    const screen = within(document.body);
    await userEvent.click(await screen.findByText('Touch ID'));
    await userEvent.click(await screen.findByRole('checkbox'));
    await userEvent.click(await screen.findByRole('button', { name: /^Save$/ }));
  },
};

export const SetPasscode: Story = {
  play: async () => {
    const screen = within(document.body);
    await userEvent.click(await screen.findByText('App Passcode'));
    await userEvent.type(await screen.findByLabelText('Passcode'), 'synthetic-passcode');
  },
};

export const StartupUnlock: Story = {
  beforeEach: () => {
    // Dialogs portal to body, outside the story's root element.
    const wasInert = document.body.inert;
    document.body.inert = true;
    mocked(useStartupStore, { partial: true }).mockReturnValue({
      isWalletReady: false,
      isLoading: true,
      errorMessage: '',
      initialize: () =>
        new Promise<void>((resolve, reject) => {
          basicEmitter.emit('requestAccountAuthentication', {
            reason: 'unlock your account',
            method: 'passcode',
            verify: async () => {
              throw new Error('Fixed preview');
            },
            resolve,
            reject,
          });
        }),
    });
    return () => {
      mocked(useStartupStore).mockReset();
      document.body.inert = wasInert;
    };
  },
  render: () => ({
    components: { App },
    template: `
      <App />
      <div class="fixed top-4 right-4 z-50 rounded-full border border-slate-300 bg-white px-3 py-1 text-xs font-semibold text-slate-500">
        Fixed state preview
      </div>
    `,
  }),
};

export const RevealPrivateKey: Story = {
  beforeEach: async () => {
    mocked(useWallets, { partial: true }).mockReturnValue({});
    await new EncryptionSecret().setProtection('passcode', { newPasscode: 'synthetic-passcode' });
    await getAccountSecurity().getSettings();
  },
  render: () => ({
    components: { AccountAuthenticationOverlay, WalletViewPrivateKey },
    setup() {
      return { WalletType };
    },
    template: `
      <div class="h-screen bg-slate-100">
        <div class="fixed top-4 right-4 rounded-full border border-slate-300 bg-white px-3 py-1 text-xs font-semibold text-slate-500">
          Interactive preview: synthetic-passcode
        </div>
        <AccountAuthenticationOverlay />
        <div class="mx-auto max-w-xl">
          <WalletViewPrivateKey :isDragging="false" :showBack="false" :showHeader="false" :walletType="WalletType.ethereum" />
        </div>
      </div>
    `,
  }),
};

export const ContinueTransfer: Story = {
  render: () => ({
    components: { AccountAuthenticationOverlay },
    setup() {
      let attempts = 0;
      Vue.onMounted(() => {
        basicEmitter.emit('requestAccountAuthentication', {
          reason: 'complete your Ethereum transfer',
          method: 'system',
          canCancel: false,
          verify: async () => {
            if (attempts++ === 0) throw new Error('Device authentication was canceled. Try again to continue.');
          },
          resolve: () => undefined,
          reject: () => undefined,
        });
      });
    },
    template: `
      <div class="h-screen bg-slate-100">
        <div class="fixed top-4 right-4 rounded-full border border-slate-300 bg-white px-3 py-1 text-xs font-semibold text-slate-500">
          Interactive preview · synthetic authentication
        </div>
        <AccountAuthenticationOverlay />
      </div>
    `,
  }),
};

export const StartupRecovery: Story = {
  beforeEach: () => {
    const wasInert = document.body.inert;
    mocked(useStartupStore, { partial: true }).mockReturnValue({
      isWalletReady: false,
      isLoading: false,
      errorMessage: 'Your account is still locked. Try again to unlock it.',
      initialize: async () => {
        throw new Error('Synthetic locked startup');
      },
    });
    return () => {
      document.body.inert = wasInert;
      mocked(useStartupStore).mockRestore();
    };
  },
  render: () => ({
    components: { App },
    template: `
      <App />
      <div class="fixed top-4 right-4 rounded-full border border-slate-300 bg-white px-3 py-1 text-xs font-semibold text-slate-500">Fixed state preview</div>
    `,
  }),
  play: async () => {
    const screen = within(document.body);
    await userEvent.click(await screen.findByRole('button', { name: 'Recover from Mnemonic' }));
    document.body.inert = true;
  },
};
