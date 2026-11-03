import Fs from 'node:fs';
import Os from 'node:os';
import Path from 'node:path';
import { expect, it, vi } from 'vitest';
import { fundExistingDevAccount } from '../../dev/funding.ts';
import { getDevPaths } from '../../dev/session.ts';
import { fundArgonAccount } from '../../dev/funding/argon.ts';
import { fundDevEthereumAccount } from '../../dev/funding/ethereum.ts';
import { WalletKeys } from '../../src-vue/lib/WalletKeys.ts';

vi.mock('../../dev/environment.ts', () => ({
  configureDevEnvironment: async (profile: Parameters<typeof getDevPaths>[0]) => ({
    paths: getDevPaths(profile),
    context: {},
  }),
}));
vi.mock('../../e2e/scripts/devUpstreamServer.ts', () => ({ readComposePortWithRetry: async () => 9944 }));
vi.mock('../../dev/funding/argon.ts', () => ({ fundArgonAccount: vi.fn(async () => undefined) }));
vi.mock('../../dev/funding/ethereum.ts', () => ({ fundDevEthereumAccount: vi.fn(async () => undefined) }));

it.each([false, true])(
  'funds saved public addresses or derives an older missing Ethereum address (older: %s)',
  async older => {
    const directory = Fs.mkdtempSync(Path.join(Os.tmpdir(), 'argon-dev-funding-'));
    vi.stubEnv('ARGON_APP_INSTANCE_DIR', directory);
    vi.stubEnv('ARGON_APP_INSTANCE', 'funding-test');
    const profile = { network: 'dev-docker', instance: 'funding-test' };
    const mnemonic = 'test test test test test test test test test test test junk';
    const identity = WalletKeys.deriveIdentity(mnemonic);
    const { statePath } = getDevPaths(profile);
    Fs.writeFileSync(
      statePath,
      JSON.stringify({
        networkConfigOverride: {
          archiveUrl: 'ws://127.0.0.1:9944',
          ethereumNetwork: { executionRpcUrls: ['http://127.0.0.1:8545'] },
        },
      }),
    );
    Fs.writeFileSync(
      Path.join(directory, 'wallet.json'),
      JSON.stringify({
        encryptedMnemonic: 'synthetic-ciphertext',
        protection: 'system',
        meta: {
          miningBotAddress: identity.miningBotAddress,
          vaultingAddress: identity.vaultingAddress,
          operationalAddress: identity.operationalAddress,
          ...(!older && { ethereumAddress: identity.ethereumAddress }),
        },
      }),
    );
    if (older) Fs.writeFileSync(Path.join(directory, 'mnemonic'), mnemonic);
    try {
      if (older) {
        await fundExistingDevAccount({ ...profile, eth: '1' });
        expect(fundDevEthereumAccount).toHaveBeenCalledWith({
          to: identity.ethereumAddress,
          rpcUrl: 'http://127.0.0.1:8545',
          token: 'ETH',
          tokenAddress: undefined,
          amountBaseUnits: 10n ** 18n,
        });
        return;
      }
      await fundExistingDevAccount({ ...profile, argons: '2500', argonots: '2500' });
      expect(fundArgonAccount).toHaveBeenCalledWith({
        to: identity.vaultingAddress,
        archiveUrl: 'ws://127.0.0.1:9944',
        microgons: 2_500_000_000n,
        micronots: 2_500_000_000n,
      });
      expect(Fs.existsSync(Path.join(directory, 'mnemonic'))).toBe(false);
    } finally {
      vi.unstubAllEnvs();
      Fs.rmSync(directory, { recursive: true, force: true });
    }
  },
);
