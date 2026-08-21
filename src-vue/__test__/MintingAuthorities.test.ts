import { describe, expect, it, vi } from 'vitest';
import { MoveToken } from '@argonprotocol/apps-core';
import type { WalletKeys } from '../lib/WalletKeys.ts';
import { createTestDb } from './helpers/db.ts';
import {
  MintingAuthorities,
  type IEthereumMintingAuthority,
  getActiveMintingAuthorityRemaining,
  getMintingAuthorityBackedTransfers,
  getPendingMintingAuthorizations,
  getOwnedEthereumMintingAuthorities,
  getNextMintingAuthoritySigner,
  restoreOwnedEthereumMintingAuthorities,
  type IMintingAuthorityRegisterMetadata,
} from '../lib/MintingAuthorities.ts';
import { getEthereumHdPath } from '../lib/WalletKeys.ts';
import { DEFAULT_MEMORY_WALLET_KEYS_ETHEREUM_HD_PREFIXES } from '../lib/MemoryWalletKeys.ts';
import { mnemonicToAccount } from 'viem/accounts';
import { TransactionInfo } from '../lib/TransactionInfo.ts';
import type { ITransactionRecord } from '../lib/db/TransactionsTable.ts';
import type { TxResult } from '@argonprotocol/mainchain';

const TEST_MNEMONIC = 'test test test test test test test test test test test junk';

describe('MintingAuthorities', () => {
  it('settles registration post-processing when setup fails before finalization', async () => {
    const setupError = new Error('database unavailable');
    const txInfo = new TransactionInfo<IMintingAuthorityRegisterMetadata>({
      tx: {
        metadataJson: { authorityIndex: 0 },
      } as ITransactionRecord,
      txResult: {} as TxResult,
    });
    const mintingAuthorities = new MintingAuthorities(
      Promise.reject(setupError),
      {} as WalletKeys,
      {} as any,
      {} as any,
    );

    await expect(mintingAuthorities['onRegister'](txInfo)).rejects.toThrow(setupError);
    await expect(txInfo.waitForPostProcessing).rejects.toThrow(setupError);
    expect(txInfo.isPostProcessed).toBe(true);
  });

  it('calculates transfer capacity from active unreserved collateral only', () => {
    const activeAuthority = {
      isActive: true,
      gatewayRemainingMicrogonCollateral: 10_000_000n,
      pendingReservedMicrogonCollateral: 2_000_000n,
      gatewayRemainingMicronotCollateral: 5_000_000n,
      pendingReservedMicronotCollateral: 1_000_000n,
    } as IEthereumMintingAuthority;
    const deactivatingAuthority = {
      isActive: false,
      isDeactivating: true,
      gatewayRemainingMicrogonCollateral: 99_000_000n,
      pendingReservedMicrogonCollateral: 0n,
      gatewayRemainingMicronotCollateral: 99_000_000n,
      pendingReservedMicronotCollateral: 0n,
    } as IEthereumMintingAuthority;

    expect(getActiveMintingAuthorityRemaining([activeAuthority, deactivatingAuthority], 2_000_000n)).toEqual({
      microgons: 8_000_000n,
      micronots: 4_000_000n,
      valueMicrogons: 16_000_000n,
    });
  });

  it('restores an imported active authority without local signer-index records', async () => {
    const db = await createTestDb();
    const walletKeys = createWalletKeysStub();
    const signer = (await walletKeys.getEthereumAddresses([walletKeys.getMintingAuthorityEthereumHdPath(0)]))[0];
    const finalizedClient = {
      query: {
        crosschainTransfer: {
          chainConfigBySourceChain: vi.fn(async () => ({ isNone: true })),
          councilSignerByDestinationChainAndAccountId: vi.fn(async () => ({ isNone: false })),
          mintingAuthoritiesBySigner: {
            multi: vi.fn(async (signers: string[]) =>
              signers.map(candidate =>
                candidate === signer ? someAuthority(walletKeys.vaultingAddress, candidate) : noneAuthority(),
              ),
            ),
          },
        },
      },
    };
    const mintingAuthorities = new MintingAuthorities(
      Promise.resolve(db),
      walletKeys as unknown as WalletKeys,
      {
        blockWatch: {
          start: vi.fn(async () => undefined),
          getFinalizedApi: vi.fn(async () => finalizedClient),
        },
      } as any,
      {
        pendingBlockTxInfosAtLoad: [],
        data: { txInfos: [] },
      } as any,
    );

    await mintingAuthorities.load();

    expect(mintingAuthorities.data.authorities).toHaveLength(1);
    expect(mintingAuthorities.data.authorities[0]).toMatchObject({ signer, authorityIndex: 0, isActive: true });
  });

  it('only scans missing signer indexes for a council account after its unrecognized registration', async () => {
    const db = await createTestDb();
    const walletKeys = createWalletKeysStub();
    const signer = (await walletKeys.getEthereumAddresses([walletKeys.getMintingAuthorityEthereumHdPath(0)]))[0];
    const deriveAuthoritySigners = vi.spyOn(walletKeys, 'getEthereumAddresses');
    deriveAuthoritySigners.mockClear();
    const councilSignerByDestinationChainAndAccountId = vi.fn(async () => ({ isNone: true }));
    const finalizedClient = {
      events: {
        crosschainTransfer: {
          MintingAuthorityRegistered: {
            is: (event: { method: string }) => event.method === 'MintingAuthorityRegistered',
          },
        },
      },
      query: {
        crosschainTransfer: {
          councilSignerByDestinationChainAndAccountId,
          mintingAuthoritiesBySigner: {
            multi: vi.fn(async (signers: string[]) =>
              signers.map(candidate =>
                candidate === signer ? someAuthority(walletKeys.vaultingAddress, candidate) : noneAuthority(),
              ),
            ),
          },
        },
      },
    };
    let onFinalized = (_headers: Array<{ blockNumber: number; blockHash: string }>) => undefined;
    const blockWatch = {
      start: vi.fn(async () => undefined),
      getFinalizedApi: vi.fn(async () => finalizedClient),
      getEventsWithSpec: vi.fn(async () => ({
        api: finalizedClient,
        events: [
          {
            event: {
              section: 'crosschainTransfer',
              method: 'MintingAuthorityRegistered',
              data: {
                destinationChain: { isEthereum: true },
                accountId: { toString: () => walletKeys.vaultingAddress },
                destinationSigningKey: { toHex: () => signer },
              },
            },
          },
        ],
      })),
      events: {
        on: vi.fn((_eventName, callback) => {
          onFinalized = callback;
          return vi.fn();
        }),
      },
    };
    const mintingAuthorities = new MintingAuthorities(
      Promise.resolve(db),
      walletKeys as unknown as WalletKeys,
      { blockWatch } as any,
      {
        pendingBlockTxInfosAtLoad: [],
        data: { txInfos: [] },
      } as any,
    );

    await mintingAuthorities.load();
    expect(deriveAuthoritySigners).not.toHaveBeenCalled();

    await mintingAuthorities.subscribe();
    onFinalized([{ blockNumber: 1, blockHash: '0x01' }]);

    await vi.waitFor(() => expect(councilSignerByDestinationChainAndAccountId).toHaveBeenCalledOnce());
    expect(councilSignerByDestinationChainAndAccountId).toHaveBeenCalledWith(
      'Ethereum',
      walletKeys.defaultArgonAddress,
    );
    expect(deriveAuthoritySigners).not.toHaveBeenCalled();

    councilSignerByDestinationChainAndAccountId.mockResolvedValue({ isNone: false });
    onFinalized([{ blockNumber: 2, blockHash: '0x02' }]);

    await vi.waitFor(() => expect(mintingAuthorities.data.authorities).toHaveLength(1), { timeout: 5_000 });
    expect(mintingAuthorities.data.authorities[0]).toMatchObject({ signer, authorityIndex: 0 });
    expect(deriveAuthoritySigners).toHaveBeenCalled();
  });

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

  it('subtracts local pending minting authorizations before planning the next transfer', async () => {
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

    const authorizations = await getPendingMintingAuthorizations(
      client as any,
      [authority as any],
      [
        {
          authorityIndex: 0,
          transferId: '0x' + '01'.repeat(32),
          mintingAuthorityTip: 0n,
          mintingAuthorityTipShare: 0n,
          mintingAuthorityTipValueMicrogons: 0n,
          microgonCollateral: 30n,
          micronotCollateral: 0n,
        },
      ],
    );

    expect(authorizations).toHaveLength(1);
    expect(authorizations[0]).toMatchObject({
      transferId: '0x' + '02'.repeat(32),
      authorityIndex: 0,
      moveToken: MoveToken.ARGN,
      sourceAccount: '5SourceAccount',
      destinationSigningKey: authority.signer,
      finalizeRequest: {
        argonAccountId: '0x' + 'aa'.repeat(32),
        argonTransferNonce: 1n,
        chainId: 1n,
        recipient: '0x' + 'bb'.repeat(20),
        validUntilBlock: 123n,
        token: '0x' + 'bb'.repeat(20),
        amount: 80n,
        mintingAuthorityTip: 1n,
        microgonsPerArgonot: 1_000_000n,
      },
      mintingAuthorityTip: 1n,
      microgonCollateral: 70n,
      micronotCollateral: 0n,
      securityAmountMicrogons: 70n,
    });
  });

  it('does not surface minting-authorization work when no active minting authority is available', async () => {
    const client = {
      query: {
        crosschainTransfer: {
          chainConfigBySourceChain: vi.fn(),
          pendingCollateralizationRequestsByChain: vi.fn(),
        },
      },
    };

    const authorizations = await getPendingMintingAuthorizations(client as any, []);

    expect(authorizations).toEqual([]);
    expect(client.query.crosschainTransfer.chainConfigBySourceChain).not.toHaveBeenCalled();
    expect(client.query.crosschainTransfer.pendingCollateralizationRequestsByChain).not.toHaveBeenCalled();
  });

  it("values an ARGNOT authorization's tip share at the transfer snapshot quote", async () => {
    const signer = '0x' + '11'.repeat(20);
    const transferId = '0x' + '01'.repeat(32);
    const authority = {
      signer,
      authorityIndex: 0,
      isPendingActivation: false,
      isDeactivating: false,
      isActive: true,
      gatewayRemainingMicrogonCollateral: 0n,
      pendingReservedMicrogonCollateral: 0n,
      gatewayRemainingMicronotCollateral: 2_000_000n,
      pendingReservedMicronotCollateral: 0n,
      activePendingTransferIds: [],
    } as IEthereumMintingAuthority;
    const client = {
      consts: {
        crosschainTransfer: {
          minTransferCollateralIncrement: bigintValue(1n),
        },
      },
      query: {
        crosschainTransfer: {
          chainConfigBySourceChain: vi.fn(async () => ({
            isNone: false,
            unwrap: () => ({
              isEvm: true,
              asEvm: {
                chainId: bigintValue(1n),
                gateway: hexValue('0x' + 'aa'.repeat(20)),
                argonToken: hexValue('0x' + 'bb'.repeat(20)),
                argonotToken: hexValue('0x' + 'cc'.repeat(20)),
              },
            }),
          })),
          pendingCollateralizationRequestsByChain: vi.fn(async () => [
            {
              transferId: hexValue(transferId),
              remainingCollateral: bigintValue(5_000_000n),
            },
          ]),
          transferOutById: {
            multi: vi.fn(async () => [
              {
                isNone: false,
                unwrap: () => ({
                  microgonsPerArgonot: bigintValue(4_000_000n),
                  mintingAuthorityCollateralBySigner: { keys: () => [] },
                  asset: { isArgon: false },
                  argonAccountId: accountValue('0x' + 'dd'.repeat(32), '5SourceAccount'),
                  argonTransferNonce: bigintValue(1n),
                  destinationAccount: hexValue('0x' + 'ee'.repeat(20)),
                  validUntilEthereumBlock: bigintValue(123n),
                  amount: bigintValue(5_000_000n),
                  mintingAuthorityTip: bigintValue(1_250_000n),
                }),
              },
            ]),
          },
        },
      },
    };

    const [authorization] = await getPendingMintingAuthorizations(client as any, [authority]);

    expect(authorization).toMatchObject({
      moveToken: MoveToken.ARGNOT,
      mintingAuthorityTip: 1_250_000n,
      mintingAuthorityTipShare: 500_000n,
      mintingAuthorityTipValueMicrogons: 2_000_000n,
      microgonCollateral: 0n,
      micronotCollateral: 2_000_000n,
    });
  });

  it('loads transfers already backed by an owned minting authority', async () => {
    const signer = '0x' + '11'.repeat(20);
    const transferId = '0x' + '01'.repeat(32);
    let isReady = false;
    const client = {
      query: {
        crosschainTransfer: {
          transferOutById: {
            multi: vi.fn(async () => [
              {
                isNone: false,
                unwrap: () => ({
                  state: { isReady },
                  asset: { isArgon: true },
                  argonAccountId: accountValue('0x' + 'aa'.repeat(32), '5SourceAccount'),
                  argonTransferNonce: bigintValue(7n),
                  destinationAccount: hexValue('0x' + 'bb'.repeat(20)),
                  amount: bigintValue(80n),
                  validUntilEthereumBlock: bigintValue(123n),
                  mintingAuthorityTip: bigintValue(2n),
                  microgonsPerArgonot: bigintValue(1_000_000n),
                  totalAttachedCollateral: bigintValue(60n),
                  mintingAuthorityCollateralBySigner: new Map([
                    [
                      hexValue(signer),
                      {
                        microgonCollateral: bigintValue(40n),
                        micronotCollateral: bigintValue(20n),
                      },
                    ],
                  ]),
                }),
              },
            ]),
          },
        },
      },
    };
    const authority = {
      signer,
      activePendingTransferIds: [transferId],
    } as any;
    const transfers = await getMintingAuthorityBackedTransfers(client as any, [authority]);

    expect(transfers).toEqual([
      {
        transferId,
        status: 'waitingForAuthorizations',
        moveToken: MoveToken.ARGN,
        sourceAccount: '5SourceAccount',
        sourceTransferNonce: 7n,
        destinationAccount: '0x' + 'bb'.repeat(20),
        amount: 80n,
        validUntilEthereumBlock: 123n,
        mintingAuthorityTip: 2n,
        mintingAuthorityTipShare: 1n,
        totalAttachedCollateral: 60n,
        ownedMicrogonCollateral: 40n,
        ownedMicronotCollateral: 20n,
        authoritySigners: [signer],
      },
    ]);

    isReady = true;
    await expect(getMintingAuthorityBackedTransfers(client as any, [authority])).resolves.toMatchObject([
      { transferId, status: 'readyForEthereum' },
    ]);
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

    const genericAuthorizations = await getPendingMintingAuthorizations(client as any, [authority as any]);
    const exactAuthorizations = await getPendingMintingAuthorizations(
      client as any,
      [authority as any],
      [],
      secondTransferId,
    );

    expect(genericAuthorizations).toHaveLength(1);
    expect(genericAuthorizations[0].transferId).toBe(firstTransferId);
    expect(exactAuthorizations).toHaveLength(1);
    expect(exactAuthorizations[0]).toMatchObject({
      transferId: secondTransferId,
      authorityIndex: 0,
      microgonCollateral: 100n,
      micronotCollateral: 0n,
    });
  });

  it('authorizes only the selected transfer requests', async () => {
    const collateralizeTransfer = vi.fn((transferId: string) => ({ kind: 'collateralizeTransfer', transferId }));
    const batchAll = vi.fn(txs => ({ kind: 'batchAll', txs }));
    const submitAndWatch = vi.fn(async (args: { metadata: unknown; tx: unknown }) => ({
      tx: { metadataJson: args.metadata },
      txResult: {},
    }));
    const walletKeys = {
      getVaultingKeypair: vi.fn(async () => ({ address: '5VaultSigner' })),
      getMintingAuthorityEthereumHdPath(hdIndex: number): `m/44'/60'/${string}` {
        return getEthereumHdPath(DEFAULT_MEMORY_WALLET_KEYS_ETHEREUM_HD_PREFIXES.mintingAuthority, hdIndex);
      },
      signEthereumPersonalMessage: vi.fn(async (authorizationHash: string) => {
        if (authorizationHash === `0x${'aa'.repeat(32)}`) return `0x${'11'.repeat(64)}1c`;
        if (authorizationHash === `0x${'bb'.repeat(32)}`) return `0x${'22'.repeat(64)}1c`;
        return `0x${'33'.repeat(64)}1c`;
      }),
    };
    const pendingMintingAuthorizations = [
      {
        transferId: '0x' + '01'.repeat(32),
        authorityIndex: 2,
        authorizationHash: '0x' + 'aa'.repeat(32),
        mintingAuthorityTip: 11n,
        mintingAuthorityTipShare: 5n,
        mintingAuthorityTipValueMicrogons: 5n,
        microgonCollateral: 10n,
        micronotCollateral: 0n,
      },
      {
        transferId: '0x' + '02'.repeat(32),
        authorityIndex: 3,
        authorizationHash: '0x' + 'bb'.repeat(32),
        mintingAuthorityTip: 22n,
        mintingAuthorityTipShare: 11n,
        mintingAuthorityTipValueMicrogons: 44n,
        microgonCollateral: 0n,
        micronotCollateral: 20n,
      },
      {
        transferId: '0x' + '03'.repeat(32),
        authorityIndex: 4,
        authorizationHash: '0x' + 'cc'.repeat(32),
        mintingAuthorityTip: 33n,
        mintingAuthorityTipShare: 16n,
        mintingAuthorityTipValueMicrogons: 16n,
        microgonCollateral: 30n,
        micronotCollateral: 40n,
      },
    ];
    const mintingAuthorities = {
      data: {
        pendingMintingAuthorizations,
        pendingMintingAuthorizeTxInfosByTransferId: new Map(),
      },
      load: vi.fn(async () => {}),
      miningFrames: {
        blockWatch: {
          clients: {
            get: vi.fn(async () => ({
              tx: {
                crosschainTransfer: {
                  collateralizeTransfer,
                },
                utility: {
                  batchAll,
                },
              },
            })),
          },
        },
      },
      walletKeys,
      transactionTracker: { submitAndWatch },
      onAuthorize: vi.fn(async () => undefined),
    };

    await MintingAuthorities.prototype.authorize.call(mintingAuthorities, [
      pendingMintingAuthorizations[1].transferId,
      pendingMintingAuthorizations[2].transferId,
    ]);

    expect(collateralizeTransfer).toHaveBeenCalledTimes(2);
    expect(collateralizeTransfer).toHaveBeenNthCalledWith(
      1,
      pendingMintingAuthorizations[1].transferId,
      `0x${'22'.repeat(64)}1c`,
      pendingMintingAuthorizations[1].microgonCollateral,
      pendingMintingAuthorizations[1].micronotCollateral,
    );
    expect(collateralizeTransfer).toHaveBeenNthCalledWith(
      2,
      pendingMintingAuthorizations[2].transferId,
      `0x${'33'.repeat(64)}1c`,
      pendingMintingAuthorizations[2].microgonCollateral,
      pendingMintingAuthorizations[2].micronotCollateral,
    );
    expect(batchAll).toHaveBeenCalledWith([
      { kind: 'collateralizeTransfer', transferId: pendingMintingAuthorizations[1].transferId },
      { kind: 'collateralizeTransfer', transferId: pendingMintingAuthorizations[2].transferId },
    ]);
    expect(submitAndWatch).toHaveBeenCalledWith(
      expect.objectContaining({
        tx: {
          kind: 'batchAll',
          txs: [
            { kind: 'collateralizeTransfer', transferId: pendingMintingAuthorizations[1].transferId },
            { kind: 'collateralizeTransfer', transferId: pendingMintingAuthorizations[2].transferId },
          ],
        },
        metadata: {
          actionType: 'authorizeTransfer',
          authorizations: [
            {
              authorityIndex: pendingMintingAuthorizations[1].authorityIndex,
              transferId: pendingMintingAuthorizations[1].transferId,
              mintingAuthorityTip: pendingMintingAuthorizations[1].mintingAuthorityTip,
              mintingAuthorityTipShare: pendingMintingAuthorizations[1].mintingAuthorityTipShare,
              mintingAuthorityTipValueMicrogons: pendingMintingAuthorizations[1].mintingAuthorityTipValueMicrogons,
              microgonCollateral: pendingMintingAuthorizations[1].microgonCollateral,
              micronotCollateral: pendingMintingAuthorizations[1].micronotCollateral,
            },
            {
              authorityIndex: pendingMintingAuthorizations[2].authorityIndex,
              transferId: pendingMintingAuthorizations[2].transferId,
              mintingAuthorityTip: pendingMintingAuthorizations[2].mintingAuthorityTip,
              mintingAuthorityTipShare: pendingMintingAuthorizations[2].mintingAuthorityTipShare,
              mintingAuthorityTipValueMicrogons: pendingMintingAuthorizations[2].mintingAuthorityTipValueMicrogons,
              microgonCollateral: pendingMintingAuthorizations[2].microgonCollateral,
              micronotCollateral: pendingMintingAuthorizations[2].micronotCollateral,
            },
          ],
        },
        useLatestNonce: true,
      }),
    );

    vi.clearAllMocks();

    await MintingAuthorities.prototype.authorize.call(mintingAuthorities);

    expect(collateralizeTransfer).toHaveBeenCalledTimes(3);
    expect(batchAll).toHaveBeenCalledWith(
      pendingMintingAuthorizations.map(authorization => ({
        kind: 'collateralizeTransfer',
        transferId: authorization.transferId,
      })),
    );
    expect(submitAndWatch).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: {
          actionType: 'authorizeTransfer',
          authorizations: pendingMintingAuthorizations.map(
            ({
              authorityIndex,
              transferId,
              mintingAuthorityTip,
              mintingAuthorityTipShare,
              mintingAuthorityTipValueMicrogons,
              microgonCollateral,
              micronotCollateral,
            }) => ({
              authorityIndex,
              transferId,
              mintingAuthorityTip,
              mintingAuthorityTipShare,
              mintingAuthorityTipValueMicrogons,
              microgonCollateral,
              micronotCollateral,
            }),
          ),
        },
      }),
    );
  });

  it('requests pending-activation catch-up from the next runtime gateway nonce', async () => {
    const requestEthereumGatewayCatchUp = vi.fn(async () => ({ outcome: 'Noop' as const }));
    const getEthereumRelayStatus = vi.fn(async () => ({ isReady: true }));
    const mintingAuthorities = new MintingAuthorities(
      Promise.resolve({} as any),
      {} as any,
      {
        blockWatch: {
          clients: {
            get: vi.fn(async () => ({
              query: {
                crosschainTransfer: {
                  gatewayStateBySourceChain: vi.fn(async () => ({
                    isSome: true,
                    unwrap: () => ({
                      gatewayActivityNonce: { toBigInt: () => 7n },
                    }),
                  })),
                },
              },
            })),
          },
        },
      } as any,
      { pendingBlockTxInfosAtLoad: [], data: { txInfos: [] } } as any,
      async () => ({
        serverApiClient: {
          getEthereumRelayStatus,
          requestEthereumGatewayCatchUp,
        },
      }),
    );
    const syncPendingActivationRelay = (
      mintingAuthorities as unknown as {
        syncPendingActivationRelay: (
          authorities: Array<{ isPendingActivation: boolean; signer: string }>,
        ) => Promise<void>;
      }
    ).syncPendingActivationRelay.bind(mintingAuthorities);

    await syncPendingActivationRelay([{ isPendingActivation: true, signer: '0xabc' }]);

    expect(getEthereumRelayStatus).toHaveBeenCalled();
    expect(requestEthereumGatewayCatchUp).toHaveBeenCalledWith({
      sourceChain: 'Ethereum',
      throughGatewayActivityNonce: 8n,
    });
  });

  it('does not re-request pending-activation catch-up until the runtime nonce or pending signer set changes', async () => {
    const requestEthereumGatewayCatchUp = vi.fn(async () => ({ outcome: 'Noop' as const }));
    const getEthereumRelayStatus = vi.fn(async () => ({ isReady: true }));
    const mintingAuthorities = new MintingAuthorities(
      Promise.resolve({} as any),
      {} as any,
      {
        blockWatch: {
          clients: {
            get: vi.fn(async () => ({
              query: {
                crosschainTransfer: {
                  gatewayStateBySourceChain: vi.fn(async () => ({
                    isSome: true,
                    unwrap: () => ({
                      gatewayActivityNonce: { toBigInt: () => 7n },
                    }),
                  })),
                },
              },
            })),
          },
        },
      } as any,
      { pendingBlockTxInfosAtLoad: [], data: { txInfos: [] } } as any,
      async () => ({
        serverApiClient: {
          getEthereumRelayStatus,
          requestEthereumGatewayCatchUp,
        },
      }),
    );
    const syncPendingActivationRelay = (
      mintingAuthorities as unknown as {
        syncPendingActivationRelay: (
          authorities: Array<{ isPendingActivation: boolean; signer: string }>,
        ) => Promise<void>;
      }
    ).syncPendingActivationRelay.bind(mintingAuthorities);

    await syncPendingActivationRelay([{ isPendingActivation: true, signer: '0xabc' }]);
    await syncPendingActivationRelay([{ isPendingActivation: true, signer: '0xabc' }]);

    expect(requestEthereumGatewayCatchUp).toHaveBeenCalledTimes(1);
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

function bigintValue(value: bigint) {
  return { toBigInt: () => value };
}

function hexValue(value: string) {
  return { toHex: () => value };
}

function accountValue(hex: string, address: string) {
  return { toHex: () => hex, toString: () => address };
}

function someTransfer(transferId: string) {
  return {
    isNone: false,
    isSome: true,
    unwrap: () => ({
      microgonsPerArgonot: { toBigInt: () => 1_000_000n },
      mintingAuthorityCollateralBySigner: { keys: () => [] },
      asset: { isArgon: true },
      argonAccountId: accountValue('0x' + 'aa'.repeat(32), '5SourceAccount'),
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
    defaultArgonAddress: '5VaultingAddress',
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
