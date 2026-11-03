import { beforeEach, expect, it, onTestFinished, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { AccountSecurity, type AccountAuthenticationPrompt } from '../lib/AccountSecurity.ts';
import { createTestWallet } from './helpers/wallet.ts';
import { createTestDb } from './helpers/db.ts';
import { WalletsForEthereum } from '../lib/WalletsForEthereum.ts';
import { GlobalCouncil, type IGlobalCouncilApproval } from '../lib/GlobalCouncil.ts';
import {
  MoveFrom,
  MoveTo,
  MoveToken,
  type ArgonClient,
  type ArgonApi,
  type MiningFrames,
} from '@argonprotocol/apps-core';
import { mnemonicToAccount } from 'viem/accounts';
import { recoverMessageAddress, type Hex } from 'viem';
import type { SubmittableExtrinsic } from '@argonprotocol/mainchain';
import { MintingAuthorities } from '../lib/MintingAuthorities.ts';
import { EthereumOutboundTransferTracker } from '../lib/EthereumOutboundTransferTracker.ts';
import type { TransactionTracker } from '../lib/TransactionTracker.ts';
import { MoveCapital } from '../lib/MoveCapital.ts';
import { WalletKeys } from '../lib/WalletKeys.ts';
import { WalletSecrets } from '../lib/WalletSecrets.ts';
import { WalletForEthereum } from '../lib/WalletForEthereum.ts';
import { EncryptionSecret, type KeyProtection } from '../lib/EncryptionSecret.ts';
import { WalletType } from '../lib/Wallet.ts';
import * as mainchain from '../stores/mainchain.ts';
import { createCipheriv } from 'node:crypto';
import { miniSecretFromUri } from '@argonprotocol/apps-core';
import { hexToU8a } from '@argonprotocol/mainchain';
import { Config } from '../lib/Config.ts';
import { instanceChecks } from '../lib/Utils.ts';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

const mnemonic = 'test test test test test test test test test test test junk';
let writeError: Error | undefined;
let authenticationError: Error | undefined;
let confirmations = 0;
let nativeProtection: KeyProtection;
let nativeWrappingKey: Buffer | undefined;
let settingsContext: Parameters<AccountSecurity['configure']>[1];

it('requires fresh approval for an external send but not an internal move', async () => {
  const { walletKeys, security } = encryptedTestAccount();
  await security.ready;
  await security.configure({ method: 'system' }, settingsContext);
  confirmations = 0;
  authenticationError = new Error('Authentication canceled');

  const transactions = {
    data: { txInfos: [] },
    findLatestTxAttempt: async () => {
      throw new Error('Synthetic transaction preparation reached');
    },
  } as unknown as TransactionTracker;
  const capital = new MoveCapital(walletKeys, transactions, security.authenticate.bind(security));
  await expect(
    capital.move({
      moveFrom: MoveFrom.DefaultArgon,
      moveTo: MoveTo.External,
      externalAddress: walletKeys.vaultingAddress,
      assetsToMove: { [MoveToken.ARGN]: 100n },
    }),
  ).rejects.toThrow('Authentication canceled');
  expect(capital.data.pendingExternalTransfer).toBeUndefined();
  expect(transactions.data.txInfos).toEqual([]);

  await expect(
    capital.move({
      moveFrom: MoveFrom.DefaultArgon,
      moveTo: MoveTo.MiningBot,
      assetsToMove: { [MoveToken.ARGN]: 100n },
    }),
  ).rejects.toThrow('Synthetic transaction preparation reached');
  expect(confirmations).toBe(1);
});

beforeEach(async () => {
  writeError = undefined;
  authenticationError = undefined;
  confirmations = 0;
  nativeProtection = { method: 'none' };
  nativeWrappingKey = undefined;
  const identity = WalletKeys.deriveIdentity(mnemonic);
  const key = Buffer.from(hexToU8a(miniSecretFromUri(`${mnemonic}//wallet-encryption`)));
  const nonce = Buffer.alloc(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  const encryptedMnemonic = Buffer.concat([
    nonce,
    cipher.update(mnemonic),
    cipher.final(),
    cipher.getAuthTag(),
  ]).toString('base64');
  let wallet = JSON.stringify({ encryptedMnemonic, meta: identity, protection: 'none' });
  const db = await createTestDb();
  onTestFinished(() => db.close());
  instanceChecks.delete(Config.prototype.constructor);
  settingsContext = {
    walletKeys: new WalletKeys(identity, new WalletSecrets({ encryptedMnemonic })),
    db,
    config: new Config(Promise.resolve(db)),
  };
  await settingsContext.config.load();
  settingsContext.config.setCertificationDetails({ hasSavedMnemonic: true });
  const authenticateNative = (authentication: { wrappingKey?: number[] }) => {
    if (nativeProtection.method === 'system') {
      confirmations++;
      if (authenticationError) throw authenticationError;
    }
    if (nativeProtection.method === 'passcode') {
      if (!nativeWrappingKey?.equals(Buffer.from(authentication.wrappingKey ?? [])))
        throw new Error('The current app passcode is incorrect.');
    }
  };
  vi.mocked(invoke)
    .mockReset()
    .mockImplementation(async (command, args) => {
      if (command === 'system_authentication_option') return 'touchId';
      if (command === 'keychain_info') return nativeProtection;
      if (command === 'read_wallet_file') return wallet;
      if (command === 'write_wallet_file') {
        wallet = (args as { contents: string }).contents;
        return;
      }
      if (command === 'cleanup_mnemonic_files') return;
      if (command === 'keychain_set_protection') {
        const replacement = args as {
          protection: KeyProtection;
          authentication: { wrappingKey?: number[] };
          newAuthentication: { wrappingKey?: number[] };
        };
        authenticateNative(replacement.authentication);
        if (replacement.protection.method === 'system') {
          confirmations++;
          if (authenticationError) throw authenticationError;
        }
        if (writeError) throw writeError;
        nativeProtection = replacement.protection;
        nativeWrappingKey = Buffer.from(replacement.newAuthentication.wrappingKey ?? []);
        return;
      }
      authenticateNative((args as { authentication: { wrappingKey?: number[] } }).authentication);
      if (command === 'keychain_encrypt') return 'encrypted-synthetic-secret';
      if (command === 'keychain_decrypt') return (args as { ciphertexts: string[] }).ciphertexts.map(() => mnemonic);
      if (command === 'keychain_authenticate') return;
      if (command === 'request_system_authentication') {
        confirmations++;
        if (authenticationError) throw authenticationError;
        return;
      }
      throw new Error(`Unexpected native command: ${command}`);
    });
});

it('requires encryption access before saving and publishing an imported Ethereum wallet', async () => {
  const db = await createTestDb();
  const { walletKeys } = createTestWallet(mnemonic);
  const security: AccountSecurity = new AccountSecurity();
  await security.ready;
  await security.configure({ method: 'system' }, settingsContext);
  const wallets = new WalletsForEthereum(
    walletKeys,
    Promise.resolve(db),
    Promise.resolve(db.financialCacheTable),
    security.request.bind(security),
  );
  const address = '0x1a642f0e3c3af545e7acbd38b07251b3990914f1';
  try {
    authenticationError = new Error('Authentication canceled');
    await expect(
      wallets.importPrivateKey({ name: 'Test wallet', privateKey: `  ${'01'.repeat(32)}  ` }),
    ).rejects.toThrow('canceled');
    expect(await db.walletsTable.fetchEthereumWallets()).toEqual([]);
    expect(wallets.persistedWallets).toEqual([]);

    authenticationError = undefined;
    const wallet = await wallets.importPrivateKey({ name: 'Test wallet', privateKey: `  ${'01'.repeat(32)}  ` });
    expect((await db.walletsTable.fetchEthereumWallets()).map(record => record.address)).toEqual([address]);
    expect(wallets.persistedWallets).toEqual([wallet]);
  } finally {
    wallets.dispose();
    await db.close();
  }
});

it('shares minting approval within a transfer and requires fresh approval for a separate transfer', async () => {
  const db = await createTestDb();
  const { walletKeys, security } = encryptedTestAccount();
  await security.ready;
  await security.configure({ method: 'system' }, settingsContext);
  confirmations = 0;

  const address = walletKeys.coreEthereumAddress;
  const hdPath = walletKeys.getMintingAuthorityEthereumHdPath(0);
  const [signer] = await walletKeys.getEthereumAddresses([hdPath]);
  await db.walletHdKeysTable.upsert({
    keyRole: 'mintingAuthority',
    scopeKey: walletKeys.vaultingAddress.toLowerCase(),
    hdIndex: 0,
    hdPath,
    address: signer,
  });
  let transferId = `0x${'01'.repeat(32)}`;
  const signatures: Hex[] = [];
  const client = {
    consts: { crosschainTransfer: { minTransferCollateralIncrement: 1n } },
    query: {
      crosschainTransfer: {
        mintingAuthoritiesBySigner: {
          multi: async () => [
            {
              accountId: walletKeys.vaultingAddress,
              destinationChain: { type: 'Ethereum' },
              destinationSigningKey: signer,
              state: { type: 'Active' },
              gatewayRemainingMicrogonCollateral: 1_000n,
              pendingReservedMicrogonCollateral: 0n,
              gatewayRemainingMicronotCollateral: 0n,
              pendingReservedMicronotCollateral: 0n,
              activePendingTransferIds: [],
            },
          ],
        },
        chainConfigBySourceChain: async () => ({
          type: 'Evm',
          value: {
            chainId: 1n,
            gateway: `0x${'aa'.repeat(20)}`,
            argonToken: `0x${'bb'.repeat(20)}`,
            argonotToken: `0x${'cc'.repeat(20)}`,
          },
        }),
        pendingCollateralizationRequestsByChain: async () => [{ transferId, remainingCollateral: 100n }],
        transferOutById: {
          multi: async () => [
            {
              microgonsPerArgonot: 1_000_000n,
              mintingAuthorityCollateralBySigner: {},
              asset: { type: 'Argon' },
              argonAccountId: walletKeys.defaultArgonAddress,
              argonTransferNonce: 1n,
              destinationAccount: address,
              validUntilEthereumBlock: 123n,
              amount: 100n,
              mintingAuthorityTip: 0n,
            },
          ],
        },
        transferTotalsByAccount: {
          multi: async () => [
            { microgonsOut: 0n, micronotsOut: 0n, argonTransfersOutCount: 0, argonotTransfersOutCount: 0 },
          ],
        },
      },
      operationalAccounts: { operationalAccountBySubAccount: { multi: async () => [] } },
    },
    tx: {
      crosschainTransfer: {
        collateralizeTransfer: (_: string, signature: Hex) => {
          signatures.push(signature);
          return {} as SubmittableExtrinsic;
        },
      },
    },
  } as unknown as ArgonClient & ArgonApi;
  const frames = {
    blockWatch: {
      start: async () => undefined,
      getFinalizedApi: async () => client,
      clients: { get: async () => client },
    },
  } as unknown as MiningFrames;
  const transactions = {
    data: { txInfos: [] },
    pendingBlockTxInfosAtLoad: [],
    findLatestTxInfo: () => undefined,
    submitAndWatch: async () => {
      throw new Error('Synthetic transport unavailable');
    },
  } as unknown as TransactionTracker;
  const authorities = new MintingAuthorities(
    Promise.resolve(db),
    walletKeys,
    frames,
    transactions,
    async () => undefined,
  );
  const outbound = new EthereumOutboundTransferTracker(
    Promise.resolve(db),
    transactions,
    frames.blockWatch,
    walletKeys,
    reason => security.createBatch(reason),
    undefined,
    authorities,
    undefined,
    async destination => new WalletForEthereum(destination, undefined, undefined, true),
  );
  try {
    const first = outbound['trackTransfer'](transferId, MoveToken.ARGN);
    first.destinationAddress = address;
    first.transferState.sourceWalletType = WalletType.argon;
    const request = { transferId, transfer: first, finalizedClient: client, approvalPercent: 0 };
    await outbound['maybeSubmitMintingAuthorization'](request);
    expect(confirmations).toBe(1);
    expect(signatures).toHaveLength(1);
    expect(first.transferState.error).toBe('Synthetic transport unavailable');

    authenticationError = new Error('Authentication canceled');
    await outbound['maybeSubmitMintingAuthorization'](request);
    expect(confirmations).toBe(1);
    expect(signatures).toHaveLength(2);

    transferId = `0x${'02'.repeat(32)}`;
    const second = outbound['trackTransfer'](transferId, MoveToken.ARGN);
    second.destinationAddress = address;
    second.transferState.sourceWalletType = WalletType.argon;
    const nextRequest = { transferId, transfer: second, finalizedClient: client, approvalPercent: 0 };
    await outbound['maybeSubmitMintingAuthorization'](nextRequest);
    expect(confirmations).toBe(2);
    expect(signatures).toHaveLength(2);
    authenticationError = undefined;
    await outbound['maybeSubmitMintingAuthorization'](nextRequest);
    expect(confirmations).toBe(3);
    expect(signatures).toHaveLength(3);
    expect(second.transferState.error).toBe('Synthetic transport unavailable');
    expect(await db.transactionsTable.fetchAll()).toEqual([]);
  } finally {
    outbound.shutdown();
    await db.close();
  }
});

function encryptedTestAccount() {
  const security = new AccountSecurity();
  const walletKeys = new WalletKeys(
    WalletKeys.deriveIdentity(mnemonic),
    new WalletSecrets({ encryptedMnemonic: 'encrypted-synthetic-mnemonic' }, security),
  );
  walletKeys.initializeSession(mnemonic);
  return { walletKeys, security };
}

it('persists backup acknowledgement before enabling protection, including after a failed settings write', async () => {
  const security = new AccountSecurity();
  const { db, config } = settingsContext;
  const failure = vi.spyOn(db, 'execute').mockRejectedValueOnce(new Error('Synthetic settings write failure'));
  onTestFinished(() => failure.mockRestore());

  await expect(security.configure({ method: 'system' }, settingsContext)).rejects.toThrow(
    'Synthetic settings write failure',
  );
  expect(config.certificationDetails?.hasSavedMnemonic).toBe(true);
  expect((await db.configTable.fetchAllAsObject()).certificationDetails).toBeUndefined();
  expect(nativeProtection.method).toBe('none');

  await security.configure({ method: 'system' }, settingsContext);
  expect(JSON.parse((await db.configTable.fetchAllAsObject()).certificationDetails!)).toMatchObject({
    hasSavedMnemonic: true,
  });
  expect(nativeProtection.method).toBe('system');
});

it('loads native protection after restarting and requires the current passcode to change it', async () => {
  const security = new AccountSecurity();
  await security.ready;
  await expect(
    security.configure({ method: 'passcode', newPasscode: '12345678901234' }, settingsContext),
  ).rejects.toThrow('15');
  expect(nativeProtection.method).toBe('none');
  await security.configure({ method: 'passcode', newPasscode: 'river moon fern' }, settingsContext);

  expect(nativeProtection.method).toBe('passcode');

  const restarted = new AccountSecurity();
  await restarted.ready;
  expect(restarted.data.method).toBe('passcode');
  await expect(
    restarted.configure({ method: 'none', currentPasscode: 'River moon fern' }, settingsContext),
  ).rejects.toThrow('incorrect');
  expect(nativeProtection.method).toBe('passcode');
  await restarted.configure({ method: 'none', currentPasscode: 'river moon fern' }, settingsContext);
  expect(nativeProtection.method).toBe('none');
  expect(restarted.data.method).toBe('none');
});

it('preserves the committed setting on cancellation or write failure, and allows retry', async () => {
  const security = new AccountSecurity();
  await security.ready;
  authenticationError = new Error('Authentication canceled');
  await expect(security.configure({ method: 'system' }, settingsContext)).rejects.toThrow('canceled');
  expect(nativeProtection.method).toBe('none');
  expect(security.data.method).toBe('none');

  authenticationError = undefined;
  await security.configure({ method: 'system' }, settingsContext);
  const previous = nativeProtection;
  authenticationError = new Error('Authentication canceled');
  await expect(security.configure({ method: 'none' }, settingsContext)).rejects.toThrow('canceled');
  expect(nativeProtection).toEqual(previous);

  authenticationError = undefined;
  writeError = new Error('Keychain is unavailable');
  await expect(security.configure({ method: 'none' }, settingsContext)).rejects.toThrow('unavailable');
  expect(nativeProtection).toEqual(previous);
  expect(security.data.method).toBe('system');
  writeError = undefined;
  await security.configure({ method: 'none' }, settingsContext);
  expect(security.data.method).toBe('none');
  expect(nativeProtection.method).toBe('none');
});

it('serializes settings changes so a queued change must verify the newly saved passcode', async () => {
  const security = new AccountSecurity();
  await security.ready;
  const enable = security.configure({ method: 'passcode', newPasscode: 'synthetic-passcode' }, settingsContext);
  const disable = security.configure({ method: 'none' }, settingsContext);
  const outcomes = await Promise.allSettled([enable, disable]);
  expect(outcomes.map(x => x.status)).toEqual(['fulfilled', 'rejected']);
  expect(security.data.method).toBe('passcode');
  expect(nativeProtection.method).toBe('passcode');
});

it('does not treat unreadable native protection as disabled', async () => {
  nativeProtection = { method: 'unsupported' } as unknown as KeyProtection;
  const security = new AccountSecurity();
  await expect(security.ready).rejects.toThrow();
  expect(security.data.isLoaded).toBe(false);
  await expect(security.configure({ method: 'none' }, settingsContext)).rejects.toThrow();
  expect(nativeProtection.method).toBe('unsupported');
  nativeProtection = { method: 'none' };
  await security.getSettings();
  expect(security.data.isLoaded).toBe(true);
  await expect(security.ready).resolves.toBeUndefined();
});

it('does not show missing keychain material as unprotected settings', async () => {
  const native = vi.mocked(invoke).getMockImplementation()!;
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === 'keychain_info') return null;
    return native(command, args);
  });
  const security = new AccountSecurity();
  await expect(security.ready).rejects.toThrow('encryption key is unavailable');
  expect(security.data.isLoaded).toBe(false);
  await expect(security.configure({ method: 'none' }, settingsContext)).rejects.toThrow(
    'encryption key is unavailable',
  );
});

it('does not offer Linux fingerprint confirmation as hardware-backed key protection', async () => {
  const native = vi.mocked(invoke).getMockImplementation()!;
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === 'system_authentication_option') return 'fingerprint';
    return native(command, args);
  });
  const security = new AccountSecurity();
  await security.ready;
  expect(security.data.systemOption).toBeNull();
});
