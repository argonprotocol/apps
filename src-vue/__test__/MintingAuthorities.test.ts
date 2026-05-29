import { describe, expect, it, vi } from 'vitest';
import type { WalletKeys } from '../lib/WalletKeys.ts';
import { createTestDb } from './helpers/db.ts';
import {
  MintingAuthorities,
  getPendingMintingAuthorityCollateralizations,
  getOwnedEthereumMintingAuthorities,
  getNextMintingAuthoritySigner,
  restoreOwnedEthereumMintingAuthorities,
} from '../lib/MintingAuthorities.ts';
import { getEthereumHdPath } from '../lib/WalletKeys.ts';
import { DEFAULT_MEMORY_WALLET_KEYS_ETHEREUM_HD_PREFIXES } from '../lib/MemoryWalletKeys.ts';
import { mnemonicToAccount } from 'viem/accounts';
import * as mainchainStore from '../stores/mainchain.ts';

const TEST_MNEMONIC = 'test test test test test test test test test test test junk';

describe('MintingAuthorities', () => {
  it('reuses recovered sparse authority indexes when a deactivated authority can no longer be restored', async () => {
    const db = await createTestDb();
    const walletKeys = createWalletKeysStub();
    const firstSigner = (await walletKeys.getEthereumAddresses([walletKeys.getMintingAuthorityEthereumHdPath(0)]))[0];
    const missingSigner = (await walletKeys.getEthereumAddresses([walletKeys.getMintingAuthorityEthereumHdPath(1)]))[0];
    const thirdSigner = (await walletKeys.getEthereumAddresses([walletKeys.getMintingAuthorityEthereumHdPath(2)]))[0];
    const deriveAuthoritySigners = vi.spyOn(walletKeys, 'getEthereumAddresses');
    deriveAuthoritySigners.mockClear();
    const multi = vi.fn(async (signers: string[]) =>
      signers.map(signer =>
        signer === firstSigner || signer === thirdSigner
          ? someAuthority(walletKeys.vaultingAddress, signer)
          : noneAuthority(),
      ),
    );

    const client = {
      query: {
        crosschainTransfer: {
          mintingAuthoritiesBySigner: {
            multi,
          },
        },
      },
    };

    const firstLoad = await getOwnedEthereumMintingAuthorities(
      client as any,
      walletKeys as unknown as WalletKeys,
      db.walletHdKeysTable,
    );

    expect(firstLoad).toEqual([]);
    expect(deriveAuthoritySigners).not.toHaveBeenCalled();

    const restoredLoad = await restoreOwnedEthereumMintingAuthorities(
      client as any,
      walletKeys as unknown as WalletKeys,
      db.walletHdKeysTable,
    );

    expect(restoredLoad.map(x => x.authorityIndex)).toEqual([0, 2]);
    expect(restoredLoad.map(x => x.signer)).not.toContain(missingSigner);
    expect(deriveAuthoritySigners).toHaveBeenCalled();
    expect(multi).toHaveBeenCalled();

    deriveAuthoritySigners.mockClear();

    const secondLoad = await getOwnedEthereumMintingAuthorities(
      client as any,
      walletKeys as unknown as WalletKeys,
      db.walletHdKeysTable,
    );
    const restoredAgain = await restoreOwnedEthereumMintingAuthorities(
      client as any,
      walletKeys as unknown as WalletKeys,
      db.walletHdKeysTable,
    );
    deriveAuthoritySigners.mockClear();

    const councilSigner = mnemonicToAccount(TEST_MNEMONIC, {
      path: getEthereumHdPath(DEFAULT_MEMORY_WALLET_KEYS_ETHEREUM_HD_PREFIXES.councilSigner),
    }).address;
    const nextSigner = await getNextMintingAuthoritySigner({
      councilSigner,
      existingSigners: secondLoad.map(x => x.signer),
      walletHdKeysTable: db.walletHdKeysTable,
      walletKeys: walletKeys as unknown as WalletKeys,
    });

    expect(secondLoad.map(x => x.authorityIndex)).toEqual([0, 2]);
    expect(restoredAgain.map(x => x.authorityIndex)).toEqual([0, 2]);
    expect(deriveAuthoritySigners).toHaveBeenCalledTimes(1);
    expect(deriveAuthoritySigners).toHaveBeenLastCalledWith(walletKeys.getMintingAuthorityEthereumHdPaths(16, 3));
    expect(nextSigner.authorityIndex).toBe(3);
  });

  it('restores sparse authority indexes late in the derivation range and allocates after the highest recovered index', async () => {
    const db = await createTestDb();
    const walletKeys = createWalletKeysStub();
    const hundredthSigner = (
      await walletKeys.getEthereumAddresses([walletKeys.getMintingAuthorityEthereumHdPath(100)])
    )[0];
    const missingSigner = (
      await walletKeys.getEthereumAddresses([walletKeys.getMintingAuthorityEthereumHdPath(101)])
    )[0];
    const hundredSecondSigner = (
      await walletKeys.getEthereumAddresses([walletKeys.getMintingAuthorityEthereumHdPath(102)])
    )[0];
    const deriveAuthoritySigners = vi.spyOn(walletKeys, 'getEthereumAddresses');
    deriveAuthoritySigners.mockClear();

    const client = {
      query: {
        crosschainTransfer: {
          mintingAuthoritiesBySigner: {
            multi: vi.fn(async (signers: string[]) =>
              signers.map(signer =>
                signer === hundredthSigner || signer === hundredSecondSigner
                  ? someAuthority(walletKeys.vaultingAddress, signer)
                  : noneAuthority(),
              ),
            ),
          },
        },
      },
    };

    const restoredLoad = await restoreOwnedEthereumMintingAuthorities(
      client as any,
      walletKeys as unknown as WalletKeys,
      db.walletHdKeysTable,
    );
    const secondLoad = await getOwnedEthereumMintingAuthorities(
      client as any,
      walletKeys as unknown as WalletKeys,
      db.walletHdKeysTable,
    );

    deriveAuthoritySigners.mockClear();

    const councilSigner = mnemonicToAccount(TEST_MNEMONIC, {
      path: getEthereumHdPath(DEFAULT_MEMORY_WALLET_KEYS_ETHEREUM_HD_PREFIXES.councilSigner),
    }).address;
    const nextSigner = await getNextMintingAuthoritySigner({
      councilSigner,
      existingSigners: secondLoad.map(x => x.signer),
      walletHdKeysTable: db.walletHdKeysTable,
      walletKeys: walletKeys as unknown as WalletKeys,
    });

    expect(restoredLoad.map(x => x.authorityIndex)).toEqual([100, 102]);
    expect(restoredLoad.map(x => x.signer)).not.toContain(missingSigner);
    expect(secondLoad.map(x => x.authorityIndex)).toEqual([100, 102]);
    expect(deriveAuthoritySigners).toHaveBeenCalledTimes(1);
    expect(deriveAuthoritySigners).toHaveBeenLastCalledWith(walletKeys.getMintingAuthorityEthereumHdPaths(16, 103));
    expect(nextSigner.authorityIndex).toBe(103);
  });

  it('subtracts local pending collateral reservations before planning the next transfer', async () => {
    const authority = {
      signer: '0x' + '11'.repeat(20),
      authorityIndex: 0,
      isPendingActivation: false,
      isDeactivating: false,
      isActive: true,
      gatewayRemainingMicrogonCollateral: 100n,
      pendingReservedMicrogonCollateral: 0n,
      gatewayRemainingMicronotCollateral: 0n,
      pendingReservedMicronotCollateral: 0n,
      activePendingTransferIds: [],
    };
    const client = {
      consts: {
        crosschainTransfer: {
          minTransferCollateralIncrement: { toBigInt: () => 1n },
        },
      },
      query: {
        crosschainTransfer: {
          chainConfigBySourceChain: vi.fn().mockResolvedValue({
            isNone: false,
            unwrap: () => ({
              isEvm: true,
              asEvm: {
                chainId: { toBigInt: () => 1n },
                gateway: { toHex: () => '0x' + 'aa'.repeat(20) },
                argonToken: { toHex: () => '0x' + 'bb'.repeat(20) },
                argonotToken: { toHex: () => '0x' + 'cc'.repeat(20) },
              },
            }),
          }),
          pendingCollateralizationRequestsByChain: vi.fn().mockResolvedValue([
            {
              transferId: { toHex: () => '0x' + '01'.repeat(32) },
              remainingCollateral: { toBigInt: () => 30n },
            },
            {
              transferId: { toHex: () => '0x' + '02'.repeat(32) },
              remainingCollateral: { toBigInt: () => 80n },
            },
          ]),
          transferOutById: {
            multi: vi
              .fn()
              .mockResolvedValue([someTransfer('0x' + '01'.repeat(32)), someTransfer('0x' + '02'.repeat(32))]),
          },
        },
      },
    };

    const collateralizations = await getPendingMintingAuthorityCollateralizations(
      client as any,
      [authority as any],
      [
        {
          authorityIndex: 0,
          transferId: '0x' + '01'.repeat(32),
          mintingAuthorityTip: 0n,
          microgonCollateral: 30n,
          micronotCollateral: 0n,
        },
      ],
    );

    expect(collateralizations).toHaveLength(1);
    expect(collateralizations[0]).toMatchObject({
      transferId: '0x' + '02'.repeat(32),
      authorityIndex: 0,
      microgonCollateral: 70n,
      micronotCollateral: 0n,
      securityAmountMicrogons: 70n,
    });
  });

  it('does not surface collateralization work when no active minting authority is available', async () => {
    const client = {
      query: {
        crosschainTransfer: {
          chainConfigBySourceChain: vi.fn(),
          pendingCollateralizationRequestsByChain: vi.fn(),
        },
      },
    };

    const collateralizations = await getPendingMintingAuthorityCollateralizations(client as any, []);

    expect(collateralizations).toEqual([]);
    expect(client.query.crosschainTransfer.chainConfigBySourceChain).not.toHaveBeenCalled();
    expect(client.query.crosschainTransfer.pendingCollateralizationRequestsByChain).not.toHaveBeenCalled();
  });

  it('can plan an exact transfer even when the generic queue planner would spend the authority on an earlier request', async () => {
    const authority = {
      signer: '0x' + '11'.repeat(20),
      authorityIndex: 0,
      isPendingActivation: false,
      isDeactivating: false,
      isActive: true,
      gatewayRemainingMicrogonCollateral: 100n,
      pendingReservedMicrogonCollateral: 0n,
      gatewayRemainingMicronotCollateral: 0n,
      pendingReservedMicronotCollateral: 0n,
      activePendingTransferIds: [],
    };
    const firstTransferId = '0x' + '01'.repeat(32);
    const secondTransferId = '0x' + '02'.repeat(32);
    const client = {
      consts: {
        crosschainTransfer: {
          minTransferCollateralIncrement: { toBigInt: () => 1n },
        },
      },
      query: {
        crosschainTransfer: {
          chainConfigBySourceChain: vi.fn().mockResolvedValue({
            isNone: false,
            unwrap: () => ({
              isEvm: true,
              asEvm: {
                chainId: { toBigInt: () => 1n },
                gateway: { toHex: () => '0x' + 'aa'.repeat(20) },
                argonToken: { toHex: () => '0x' + 'bb'.repeat(20) },
                argonotToken: { toHex: () => '0x' + 'cc'.repeat(20) },
              },
            }),
          }),
          pendingCollateralizationRequestsByChain: vi.fn().mockResolvedValue([
            {
              transferId: { toHex: () => firstTransferId },
              remainingCollateral: { toBigInt: () => 100n },
            },
            {
              transferId: { toHex: () => secondTransferId },
              remainingCollateral: { toBigInt: () => 100n },
            },
          ]),
          transferOutById: {
            multi: vi.fn().mockResolvedValue([someTransfer(firstTransferId), someTransfer(secondTransferId)]),
          },
        },
      },
    };

    const genericCollateralizations = await getPendingMintingAuthorityCollateralizations(client as any, [
      authority as any,
    ]);
    const exactCollateralizations = await getPendingMintingAuthorityCollateralizations(
      client as any,
      [authority as any],
      [],
      secondTransferId,
    );

    expect(genericCollateralizations).toHaveLength(1);
    expect(genericCollateralizations[0].transferId).toBe(firstTransferId);
    expect(exactCollateralizations).toHaveLength(1);
    expect(exactCollateralizations[0]).toMatchObject({
      transferId: secondTransferId,
      authorityIndex: 0,
      microgonCollateral: 100n,
      micronotCollateral: 0n,
    });
  });

  it('batches all current sponsorship opportunities with utility.batch', async () => {
    const collateralizeTransfer = vi.fn((transferId: string) => ({ kind: 'collateralize', transferId }));
    const batch = vi.fn(txs => ({ kind: 'batch', txs }));
    const submitAndWatch = vi.fn(async (args: { metadata: unknown; tx: unknown }) => ({
      tx: { metadataJson: args.metadata },
      txResult: {},
    }));
    const walletKeys = {
      getVaultingKeypair: vi.fn(async () => ({ address: '5VaultSigner' })),
      getMintingAuthorityEthereumHdPath(hdIndex: number): `m/44'/60'/${string}` {
        return getEthereumHdPath(DEFAULT_MEMORY_WALLET_KEYS_ETHEREUM_HD_PREFIXES.mintingAuthority, hdIndex);
      },
      signEthereumPersonalMessage: vi
        .fn()
        .mockResolvedValueOnce(`0x${'11'.repeat(64)}1c`)
        .mockResolvedValueOnce(`0x${'22'.repeat(64)}1c`),
    };
    const collateralizations = [
      {
        transferId: '0x' + '01'.repeat(32),
        authorityIndex: 2,
        authorizationHash: '0x' + 'aa'.repeat(32),
        mintingAuthorityTip: 11n,
        microgonCollateral: 10n,
        micronotCollateral: 0n,
      },
      {
        transferId: '0x' + '02'.repeat(32),
        authorityIndex: 3,
        authorizationHash: '0x' + 'bb'.repeat(32),
        mintingAuthorityTip: 22n,
        microgonCollateral: 0n,
        micronotCollateral: 20n,
      },
    ];
    const mintingAuthorities = {
      data: {
        pendingCollateralizations: collateralizations,
        pendingCollateralizeTxInfosByTransferId: new Map(),
      },
      load: vi.fn(async () => {}),
      walletKeys,
      transactionTracker: { submitAndWatch },
      onCollateralize: vi.fn(async () => undefined),
    };
    const getMainchainClient = vi.spyOn(mainchainStore, 'getMainchainClient').mockResolvedValue({
      tx: {
        crosschainTransfer: {
          collateralizeTransfer,
        },
        utility: {
          batch,
        },
      },
    } as any);

    await MintingAuthorities.prototype.collateralize.call(mintingAuthorities);

    expect(collateralizeTransfer).toHaveBeenNthCalledWith(
      1,
      collateralizations[0].transferId,
      `0x${'11'.repeat(64)}1c`,
      collateralizations[0].microgonCollateral,
      collateralizations[0].micronotCollateral,
    );
    expect(collateralizeTransfer).toHaveBeenNthCalledWith(
      2,
      collateralizations[1].transferId,
      `0x${'22'.repeat(64)}1c`,
      collateralizations[1].microgonCollateral,
      collateralizations[1].micronotCollateral,
    );
    expect(batch).toHaveBeenCalledWith([
      { kind: 'collateralize', transferId: collateralizations[0].transferId },
      { kind: 'collateralize', transferId: collateralizations[1].transferId },
    ]);
    expect(submitAndWatch).toHaveBeenCalledWith(
      expect.objectContaining({
        tx: {
          kind: 'batch',
          txs: [
            { kind: 'collateralize', transferId: collateralizations[0].transferId },
            { kind: 'collateralize', transferId: collateralizations[1].transferId },
          ],
        },
        metadata: {
          actionType: 'collateralizeTransfer',
          collateralizations: [
            {
              authorityIndex: collateralizations[0].authorityIndex,
              transferId: collateralizations[0].transferId,
              mintingAuthorityTip: collateralizations[0].mintingAuthorityTip,
              microgonCollateral: collateralizations[0].microgonCollateral,
              micronotCollateral: collateralizations[0].micronotCollateral,
            },
            {
              authorityIndex: collateralizations[1].authorityIndex,
              transferId: collateralizations[1].transferId,
              mintingAuthorityTip: collateralizations[1].mintingAuthorityTip,
              microgonCollateral: collateralizations[1].microgonCollateral,
              micronotCollateral: collateralizations[1].micronotCollateral,
            },
          ],
        },
        useLatestNonce: true,
      }),
    );

    getMainchainClient.mockRestore();
  });
});

function someAuthority(accountId: string, signer: string) {
  return {
    isSome: true,
    unwrap: () => ({
      accountId: { toString: () => accountId },
      destinationChain: { isEthereum: true },
      destinationSigningKey: { toHex: () => signer },
      state: {
        isActive: true,
        isDeactivating: false,
        isPendingActivation: false,
      },
      gatewayRemainingMicrogonCollateral: { toBigInt: () => 0n },
      pendingReservedMicrogonCollateral: { toBigInt: () => 0n },
      gatewayRemainingMicronotCollateral: { toBigInt: () => 0n },
      pendingReservedMicronotCollateral: { toBigInt: () => 0n },
      activePendingTransferIds: [],
    }),
  };
}

function noneAuthority() {
  return {
    isNone: true,
  };
}

function someTransfer(transferId: string) {
  return {
    isNone: false,
    isSome: true,
    unwrap: () => ({
      microgonsPerArgonot: { toBigInt: () => 1_000_000n },
      mintingAuthorityCollateralBySigner: { keys: () => [] },
      asset: { isArgon: true },
      argonAccountId: { toHex: () => '0x' + 'aa'.repeat(32) },
      argonTransferNonce: { toBigInt: () => 1n },
      destinationAccount: { toHex: () => '0x' + 'bb'.repeat(20) },
      validUntilEthereumBlock: { toBigInt: () => 123n },
      amount: { toBigInt: () => 80n },
      mintingAuthorityTip: { toBigInt: () => 1n },
      transferId,
    }),
  };
}

function createWalletKeysStub() {
  const ethereumAddress = mnemonicToAccount(TEST_MNEMONIC, {
    path: getEthereumHdPath(DEFAULT_MEMORY_WALLET_KEYS_ETHEREUM_HD_PREFIXES.primary),
  }).address;

  return {
    councilSignerEthereumHdPath: getEthereumHdPath(DEFAULT_MEMORY_WALLET_KEYS_ETHEREUM_HD_PREFIXES.councilSigner),
    ethereumAddress,
    ethereumHdPrefixes: DEFAULT_MEMORY_WALLET_KEYS_ETHEREUM_HD_PREFIXES,
    vaultingAddress: '5VaultingAddress',
    getMintingAuthorityEthereumHdPath(hdIndex: number): `m/44'/60'/${string}` {
      return getEthereumHdPath(DEFAULT_MEMORY_WALLET_KEYS_ETHEREUM_HD_PREFIXES.mintingAuthority, hdIndex);
    },
    getMintingAuthorityEthereumHdPaths(count: number, startIndex = 0): `m/44'/60'/${string}`[] {
      return Array.from({ length: count }, (_, offset) => this.getMintingAuthorityEthereumHdPath(startIndex + offset));
    },
    getEthereumAddresses: vi.fn(async (hdPaths: `m/44'/60'/${string}`[]) => {
      return hdPaths.map(
        path =>
          mnemonicToAccount(TEST_MNEMONIC, {
            path,
          }).address,
      );
    }),
  };
}
