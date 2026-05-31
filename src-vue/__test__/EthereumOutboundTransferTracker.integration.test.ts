import { EventEmitter } from 'node:events';
import * as Vue from 'vue';
import { MoveToken } from '@argonprotocol/apps-core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EthereumOutboundTransferTracker } from '../lib/EthereumOutboundTransferTracker.ts';
import type { IEthereumTransferOutOfArgon } from '../lib/EthereumClient.ts';
import { CrosschainOutboundTransferStatus } from '../lib/db/CrosschainOutboundTransfersTable.ts';
import { WalletType } from '../lib/Wallet.ts';
import { createTestDb } from './helpers/db.ts';
import { createMockWalletKeys } from './helpers/wallet.ts';

const { getEthereumGatewayPauseReasonMock, getMainchainClientMock } = vi.hoisted(() => ({
  getEthereumGatewayPauseReasonMock: vi.fn(),
  getMainchainClientMock: vi.fn(),
}));

vi.mock('../stores/mainchain.ts', () => ({
  getMainchainClient: getMainchainClientMock,
  getEthereumGatewayPauseReason: getEthereumGatewayPauseReasonMock,
}));

describe('EthereumOutboundTransferTracker integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getEthereumGatewayPauseReasonMock.mockResolvedValue(undefined);
  });

  it('waits for a finalized head at or after the transfer block before auto-collateralizing', async () => {
    const db = await createTestDb();
    const walletKeys = createMockWalletKeys();
    const onChainTransferId = `0x${'77'.repeat(32)}`;
    const staleHeadError = new Error('stale finalized head should not be queried');
    const staleHeader = { blockNumber: 9, blockHash: '0xstale' };
    const transferHeader = { blockNumber: 10, blockHash: '0xtransfer' };
    const readyHeader = { blockNumber: 11, blockHash: '0xready' };
    const pendingCollateralization = {
      transferId: onChainTransferId,
    };
    const finalizedTxHash = `0x${'66'.repeat(32)}` as const;
    const mintingAuthorities = {
      data: {
        authorities: [],
        pendingCollateralizations: [] as unknown[],
        pendingCollateralizeTxInfosByTransferId: new Map(),
      },
      refresh: vi.fn(async (finalizedClient: { blockNumber: number }) => {
        mintingAuthorities.data.pendingCollateralizations =
          finalizedClient.blockNumber === transferHeader.blockNumber ? [pendingCollateralization] : [];
      }),
      collateralize: vi.fn(async () => ({
        tx: { metadataJson: { transferId: onChainTransferId } },
        isPostProcessed: true,
      })),
    };
    const blockWatch = createBlockWatch({
      initialHeader: staleHeader,
      getApi: async header => {
        if (header.blockNumber === staleHeader.blockNumber) {
          return {
            blockNumber: header.blockNumber,
            query: {
              crosschainTransfer: {
                pendingCollateralizationRequestsByChain: vi.fn(async () => {
                  throw staleHeadError;
                }),
                transferOutById: vi.fn(async () => {
                  throw staleHeadError;
                }),
              },
            },
          };
        }

        if (header.blockNumber === transferHeader.blockNumber) {
          return {
            blockNumber: header.blockNumber,
            query: {
              crosschainTransfer: {
                pendingCollateralizationRequestsByChain: vi.fn(async () => [
                  {
                    transferId: { toHex: () => onChainTransferId },
                    remainingCollateral: { toBigInt: () => 100n },
                  },
                ]),
                transferOutById: vi.fn(async () => ({
                  isNone: false,
                  unwrap: () => ({
                    state: { isReady: false },
                  }),
                })),
              },
            },
          };
        }

        return {
          blockNumber: header.blockNumber,
          query: {
            crosschainTransfer: {
              pendingCollateralizationRequestsByChain: vi.fn(async () => []),
              transferOutById: vi.fn(async () => ({
                isNone: false,
                unwrap: () => ({
                  state: { isReady: true },
                  mintingAuthorityCollateralBySigner: new Map([
                    [
                      '0xsigner',
                      {
                        microgonCollateral: { toBigInt: () => 100n },
                        micronotCollateral: { toBigInt: () => 0n },
                        signature: { toHex: () => `0x${'00'.repeat(64)}01` },
                      },
                    ],
                  ]),
                  asset: { isArgon: true },
                  argonAccountId: { toHex: () => `0x${'22'.repeat(32)}` },
                  argonTransferNonce: { toBigInt: () => 1n },
                  microgonsPerArgonot: { toBigInt: () => 3n },
                  destinationAccount: { toHex: () => walletKeys.ethereumAddress },
                  validUntilEthereumBlock: { toBigInt: () => 500n },
                  amount: { toBigInt: () => 100n },
                  mintingAuthorityTip: { toBigInt: () => 1n },
                }),
              })),
              chainConfigBySourceChain: vi.fn(async () => ({
                isNone: false,
                unwrap: () => ({
                  isEvm: true,
                  asEvm: {
                    chainId: { toBigInt: () => 1n },
                    argonToken: { toHex: () => `0x${'44'.repeat(20)}` },
                    argonotToken: { toHex: () => `0x${'55'.repeat(20)}` },
                  },
                }),
              })),
            },
          },
        };
      },
    });
    const transactionTracker = {
      data: { txInfos: [] },
      pendingBlockTxInfosAtLoad: [],
      load: vi.fn(async () => {}),
      ensureStoredEvents: vi.fn(async () => {}),
      submitAndWatch: vi.fn(async () =>
        createTransferOutTxInfo({
          transferId: onChainTransferId,
          blockHeight: transferHeader.blockNumber,
          moveToken: MoveToken.ARGN,
          amount: 100n,
        }),
      ),
    };
    const ethereumClient = {
      estimateFinalizeTransferOutOfArgonFee: vi.fn(async () => 1n),
      getNativeBalanceWei: vi.fn(async () => 10n),
      finalizeTransferOutOfArgon: vi.fn(async () => finalizedTxHash),
      confirmTransferOutOfArgon: vi.fn(
        async () =>
          ({
            targetTxHash: finalizedTxHash,
            targetBlockNumber: 42,
            targetBlockHash: `0x${'88'.repeat(32)}`,
            gatewayActivityNonce: 7n,
          }) satisfies IEthereumTransferOutOfArgon,
      ),
    };

    getMainchainClientMock.mockResolvedValue(createMainchainClient());

    const tracker = new EthereumOutboundTransferTracker(
      Promise.resolve(db),
      transactionTracker as any,
      blockWatch.instance as any,
      walletKeys,
      ethereumClient,
      mintingAuthorities as any,
    );

    const activeTransfer = await tracker.startMove({
      moveToken: MoveToken.ARGN,
      amount: 100n,
      sourceWalletType: WalletType.vaulting,
    });

    await vi.waitFor(async () => {
      const persisted = await db.crosschainOutboundTransfersTable.get(onChainTransferId);
      expect(persisted?.status).toBe(CrosschainOutboundTransferStatus.RequestFinalizedOnArgon);
    });

    expect(mintingAuthorities.refresh).not.toHaveBeenCalled();
    expect(mintingAuthorities.collateralize).not.toHaveBeenCalled();

    blockWatch.emitFinalized(transferHeader);
    await vi.waitFor(() => {
      expect(mintingAuthorities.collateralize).toHaveBeenCalledWith(onChainTransferId);
    });

    blockWatch.emitFinalized(readyHeader);
    await vi.waitFor(async () => {
      const persisted = await db.crosschainOutboundTransfersTable.get(onChainTransferId);
      expect(persisted?.status).toBe(CrosschainOutboundTransferStatus.TargetFinalized);
      expect(activeTransfer?.transferId).toBe(onChainTransferId);
      expect(activeTransfer?.transferState.phase).toBe('confirmedOnEthereum');
      expect(activeTransfer?.transferState.error).toBe('');
      expect(activeTransfer?.transferState.isSubmitting).toBe(false);
    });
    expect(ethereumClient.finalizeTransferOutOfArgon).toHaveBeenCalledWith(
      expect.objectContaining({
        proof: {
          authorizations: [
            expect.objectContaining({
              signature: `0x${'00'.repeat(64)}1c`,
            }),
          ],
        },
      }),
    );
  });

  it('reactively advances from preparing to confirming on Argon before the transfer is persisted', async () => {
    const db = await createTestDb();
    const walletKeys = createMockWalletKeys();
    const waitForFinalizedBlock = createDeferredPromise<void>();
    const seenPhases: string[] = [];
    const txInfo = createTransferOutTxInfo({
      transferId: `0x${'77'.repeat(32)}`,
      blockHeight: 10,
      moveToken: MoveToken.ARGN,
      amount: 100n,
    });
    const blockWatch = createBlockWatch({
      initialHeader: { blockNumber: 1, blockHash: '0xhead' },
      getApi: async header => ({
        blockNumber: header.blockNumber,
        query: {
          crosschainTransfer: {
            pendingCollateralizationRequestsByChain: vi.fn(async () => []),
            transferOutById: vi.fn(async () => ({
              isNone: false,
              unwrap: () => ({
                state: { isReady: false },
              }),
            })),
          },
        },
      }),
    });
    const transactionTracker = {
      data: { txInfos: [] },
      pendingBlockTxInfosAtLoad: [],
      load: vi.fn(async () => {}),
      ensureStoredEvents: vi.fn(async () => {}),
      submitAndWatch: vi.fn(async () => ({
        ...txInfo,
        txResult: {
          ...txInfo.txResult,
          waitForFinalizedBlock: waitForFinalizedBlock.promise,
        },
      })),
    };
    const tracker = new EthereumOutboundTransferTracker(
      Promise.resolve(db),
      transactionTracker as any,
      blockWatch.instance as any,
      walletKeys,
      {
        estimateFinalizeTransferOutOfArgonFee: vi.fn(async () => 1n),
        getNativeBalanceWei: vi.fn(async () => 10n),
        finalizeTransferOutOfArgon: vi.fn(),
        confirmTransferOutOfArgon: vi.fn(),
      },
    );
    tracker.data = Vue.reactive(tracker.data) as any;

    const stopWatching = Vue.watchEffect(() => {
      const phase = tracker.getTransferStateForToken(MoveToken.ARGN).phase;
      if (phase) {
        seenPhases.push(phase);
      }
    });

    try {
      await tracker.startMove({
        moveToken: MoveToken.ARGN,
        amount: 100n,
        sourceWalletType: WalletType.vaulting,
      });

      await vi.waitFor(() => {
        expect(seenPhases).toContain('confirmingArgon');
      });
    } finally {
      stopWatching();
      waitForFinalizedBlock.resolve();
    }
  });

  it('restores the newest pending transfer as latest after load', async () => {
    const db = await createTestDb();
    const walletKeys = createMockWalletKeys();
    const olderTransferId = `0x${'12'.repeat(32)}`;
    const newerTransferId = `0x${'34'.repeat(32)}`;
    await db.crosschainOutboundTransfersTable.insertRequestFinalizedOnArgon({
      transferId: olderTransferId,
      destinationChain: 'Ethereum',
      token: MoveToken.ARGN,
      amount: 10n,
      argonSourceAddress: walletKeys.vaultingAddress,
      destinationAddress: walletKeys.ethereumAddress,
    });
    await db.sql.execute(`UPDATE CrosschainOutboundTransfers SET updatedAt = ? WHERE transferId = ?`, [
      '2026-05-25 00:00:00',
      olderTransferId,
    ]);
    await db.crosschainOutboundTransfersTable.insertRequestFinalizedOnArgon({
      transferId: newerTransferId,
      destinationChain: 'Ethereum',
      token: MoveToken.ARGN,
      amount: 20n,
      argonSourceAddress: walletKeys.vaultingAddress,
      destinationAddress: walletKeys.ethereumAddress,
    });
    await db.sql.execute(`UPDATE CrosschainOutboundTransfers SET updatedAt = ? WHERE transferId = ?`, [
      '2026-05-26 00:00:00',
      newerTransferId,
    ]);

    const blockWatch = createBlockWatch({
      initialHeader: { blockNumber: 1, blockHash: '0xhead' },
      getApi: async header => ({
        blockNumber: header.blockNumber,
        query: {
          crosschainTransfer: {
            transferOutById: vi.fn(async () => ({
              isNone: false,
              unwrap: () => ({
                state: { isReady: false },
              }),
            })),
          },
        },
      }),
    });
    const transactionTracker = {
      data: { txInfos: [] },
      pendingBlockTxInfosAtLoad: [],
      load: vi.fn(async () => {}),
      ensureStoredEvents: vi.fn(async () => {}),
    };

    const tracker = new EthereumOutboundTransferTracker(
      Promise.resolve(db),
      transactionTracker as any,
      blockWatch.instance as any,
      walletKeys,
      {
        estimateFinalizeTransferOutOfArgonFee: vi.fn(async () => 1n),
        getNativeBalanceWei: vi.fn(async () => 10n),
        finalizeTransferOutOfArgon: vi.fn(async () => `0x${'56'.repeat(32)}` as const),
        confirmTransferOutOfArgon: vi.fn(
          async () =>
            ({
              targetTxHash: `0x${'56'.repeat(32)}`,
              targetBlockNumber: 99,
              targetBlockHash: `0x${'78'.repeat(32)}`,
              gatewayActivityNonce: 3n,
            }) satisfies IEthereumTransferOutOfArgon,
        ),
      },
    );

    await tracker.load();

    expect(tracker.getLatestTransfer(MoveToken.ARGN)?.transferId).toBe(newerTransferId);
  });

  it('shows the gateway pause when a pending activation is blocking own collateralization', async () => {
    const db = await createTestDb();
    const walletKeys = createMockWalletKeys();
    const onChainTransferId = `0x${'91'.repeat(32)}`;
    const transferHeader = { blockNumber: 10, blockHash: '0xtransfer' };
    const blockWatch = createBlockWatch({
      initialHeader: transferHeader,
      getApi: async header => ({
        blockNumber: header.blockNumber,
        query: {
          crosschainTransfer: {
            pendingCollateralizationRequestsByChain: vi.fn(async () => [
              {
                transferId: { toHex: () => onChainTransferId },
                remainingCollateral: { toBigInt: () => 100n },
              },
            ]),
            transferOutById: vi.fn(async () => ({
              isNone: false,
              unwrap: () => ({
                state: { isReady: false },
              }),
            })),
          },
        },
      }),
    });
    const transactionTracker = {
      data: { txInfos: [] },
      pendingBlockTxInfosAtLoad: [],
      load: vi.fn(async () => {}),
      ensureStoredEvents: vi.fn(async () => {}),
      submitAndWatch: vi.fn(async () =>
        createTransferOutTxInfo({
          transferId: onChainTransferId,
          blockHeight: transferHeader.blockNumber,
          moveToken: MoveToken.ARGN,
          amount: 100n,
        }),
      ),
    };
    const mintingAuthorities = {
      data: {
        authorities: [
          {
            signer: walletKeys.ethereumAddress,
            authorityIndex: 0,
            isPendingActivation: true,
            isDeactivating: false,
            isActive: false,
            gatewayRemainingMicrogonCollateral: 0n,
            pendingReservedMicrogonCollateral: 0n,
            gatewayRemainingMicronotCollateral: 0n,
            pendingReservedMicronotCollateral: 0n,
            activePendingTransferIds: [],
          },
        ],
        pendingCollateralizations: [] as unknown[],
        pendingCollateralizeTxInfosByTransferId: new Map(),
      },
      refresh: vi.fn(async () => {}),
      collateralize: vi.fn(async () => {
        throw new Error(`Transfer ${onChainTransferId} is not currently available to collateralize.`);
      }),
    };

    getMainchainClientMock.mockResolvedValue(createMainchainClient());
    getEthereumGatewayPauseReasonMock.mockResolvedValue(
      'Ethereum gateway sync is paused at activity 1 (GatewayStateDrift).',
    );

    const tracker = new EthereumOutboundTransferTracker(
      Promise.resolve(db),
      transactionTracker as any,
      blockWatch.instance as any,
      walletKeys,
      {
        estimateFinalizeTransferOutOfArgonFee: vi.fn(async () => 1n),
        getNativeBalanceWei: vi.fn(async () => 10n),
        finalizeTransferOutOfArgon: vi.fn(async () => `0x${'92'.repeat(32)}` as const),
        confirmTransferOutOfArgon: vi.fn(
          async () =>
            ({
              targetTxHash: `0x${'92'.repeat(32)}`,
              targetBlockNumber: 99,
              targetBlockHash: `0x${'93'.repeat(32)}`,
              gatewayActivityNonce: 3n,
            }) satisfies IEthereumTransferOutOfArgon,
        ),
      },
      mintingAuthorities as any,
    );

    const activeTransfer = await tracker.startMove({
      moveToken: MoveToken.ARGN,
      amount: 100n,
      sourceWalletType: WalletType.vaulting,
    });

    await vi.waitFor(async () => {
      const persisted = await db.crosschainOutboundTransfersTable.get(onChainTransferId);
      expect(persisted?.status).toBe(CrosschainOutboundTransferStatus.RequestFinalizedOnArgon);
      expect(activeTransfer?.transferState.phase).toBe('awaitingCollateralization');
      expect(activeTransfer?.transferState.error).toBe(
        'Ethereum gateway sync is paused at activity 1 (GatewayStateDrift).',
      );
      expect(activeTransfer?.transferState.awaitingCollateralizationLabel).toBe(
        'Waiting for a minting authority to collateralize this transfer on Argon...',
      );
    });
  });
});

function createMainchainClient() {
  return {
    tx: {
      crosschainTransfer: {
        transferOut: vi.fn(() => ({ kind: 'transferOut' })),
      },
    },
    events: {
      crosschainTransfer: {
        TransferOutStarted: {
          is: (event: { section: string; method: string }) =>
            event.section === 'crosschainTransfer' && event.method === 'TransferOutStarted',
        },
      },
    },
  };
}

function createDeferredPromise<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });

  return { promise, resolve, reject };
}

function createTransferOutTxInfo(args: {
  transferId: string;
  blockHeight: number;
  moveToken: MoveToken.ARGN | MoveToken.ARGNOT;
  amount: bigint;
}) {
  return {
    tx: {
      metadataJson: {
        actionType: 'transferOutToEthereum',
        moveToken: args.moveToken,
        amount: args.amount,
        sourceWalletType: WalletType.vaulting,
        destinationAddress: `0x${'99'.repeat(20)}`,
      },
      blockHeight: args.blockHeight,
      finalizedHeadHeight: args.blockHeight,
      blockHash: '0xtransfer-block',
    },
    txResult: {
      waitForFinalizedBlock: Promise.resolve(),
      waitForInFirstBlock: Promise.resolve('0xtransfer-block'),
      events: [
        {
          section: 'crosschainTransfer',
          method: 'TransferOutStarted',
          data: {
            transferId: { toHex: () => args.transferId },
          },
        },
      ],
    },
  };
}

function createBlockWatch(args: {
  initialHeader: { blockNumber: number; blockHash: string };
  getApi: (header: { blockNumber: number; blockHash: string }) => Promise<unknown>;
}) {
  const events = new EventEmitter();
  const instance = {
    finalizedBlockHeader: args.initialHeader,
    start: vi.fn(async () => {}),
    getApi: vi.fn(args.getApi),
    events: {
      on: (eventName: string, handler: (headers: Array<{ blockNumber: number; blockHash: string }>) => void) => {
        events.on(eventName, handler);
        return () => events.off(eventName, handler);
      },
    },
  };

  return {
    instance,
    emitFinalized(header: { blockNumber: number; blockHash: string }) {
      instance.finalizedBlockHeader = header;
      events.emit('finalized', [header]);
    },
  };
}
