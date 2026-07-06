import { EventEmitter } from 'node:events';
import * as Vue from 'vue';
import { MoveToken } from '@argonprotocol/apps-core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EthereumOutboundTransferTracker } from '../lib/EthereumOutboundTransferTracker.ts';
import type {
  IEthereumTransactionProgress,
  IEthereumTransferOutOfArgon,
  IFinalizedEthereumTransactionProgress,
} from '../lib/EthereumClient.ts';
import { createCrosschainTransferProgress } from '../lib/CrosschainTransferProgress.ts';
import { CrosschainOutboundTransferStatus } from '../lib/db/CrosschainOutboundTransfersTable.ts';
import { ExtrinsicType, TransactionStatus } from '../lib/db/TransactionsTable.ts';
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

  it('waits for a finalized head at or after the transfer block before auto-authorizing', async () => {
    const db = await createTestDb();
    const walletKeys = createMockWalletKeys();
    const onChainTransferId = `0x${'77'.repeat(32)}`;
    const staleHeadError = new Error('stale finalized head should not be queried');
    const staleHeader = { blockNumber: 9, blockHash: '0xstale' };
    const transferHeader = { blockNumber: 10, blockHash: '0xtransfer' };
    const readyHeader = { blockNumber: 11, blockHash: '0xready' };
    const pendingMintingAuthorization = {
      transferId: onChainTransferId,
    };
    const finalizedTxHash = `0x${'66'.repeat(32)}` as const;
    const mintingAuthorities = {
      data: {
        authorities: [],
        pendingMintingAuthorizations: [] as unknown[],
        pendingMintingAuthorizeTxInfosByTransferId: new Map(),
      },
      refresh: vi.fn(async (finalizedClient: { blockNumber: number }) => {
        mintingAuthorities.data.pendingMintingAuthorizations =
          finalizedClient.blockNumber === transferHeader.blockNumber ? [pendingMintingAuthorization] : [];
      }),
      authorize: vi.fn(async () => ({
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
                    amount: { toBigInt: () => 100n },
                    totalAttachedCollateral: { toBigInt: () => 0n },
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
    const transferOutTxInfo = createTransferOutTxInfo({
      transferId: onChainTransferId,
      blockHeight: transferHeader.blockNumber,
      moveToken: MoveToken.ARGN,
      amount: 100n,
    });
    const transactionTracker = {
      data: { txInfos: [] },
      pendingBlockTxInfosAtLoad: [],
      load: vi.fn(async () => {}),
      ensureStoredEvents: vi.fn(async () => {}),
      findLatestTxInfo: vi.fn(() => transferOutTxInfo),
      submitAndWatch: vi.fn(async () => transferOutTxInfo),
    };
    const ethereumClient = {
      estimateFinalizeTransferOutOfArgonFee: vi.fn(async () => 1n),
      getNativeBalanceWei: vi.fn(async () => 10n),
      finalizeTransferOutOfArgon: vi.fn(async () => finalizedTxHash),
      getTransactionProgress: vi.fn(
        async () =>
          ({
            blockNumber: 42,
            blockHash: `0x${'88'.repeat(32)}`,
            confirmations: 1,
            expectedConfirmations: 1,
            progressPct: 100,
            isFinalized: true,
          }) satisfies IEthereumTransactionProgress,
      ),
      getTransactionFinalityPollMs: vi.fn(() => 1),
      waitForTransactionFinality: vi.fn(
        async () =>
          ({
            blockNumber: 42,
            blockHash: `0x${'88'.repeat(32)}`,
            confirmations: 1,
            expectedConfirmations: 1,
            progressPct: 100,
            isFinalized: true,
          }) satisfies IFinalizedEthereumTransactionProgress,
      ),
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
      sourceWalletType: WalletType.defaultArgon,
    });

    await vi.waitFor(async () => {
      const persisted = await db.crosschainOutboundTransfersTable.get(activeTransfer!.id);
      expect(persisted?.status).toBe(CrosschainOutboundTransferStatus.RequestFinalizedOnArgon);
      expect(persisted?.transferId).toBe(onChainTransferId);
    });

    expect(mintingAuthorities.refresh).not.toHaveBeenCalled();
    expect(mintingAuthorities.authorize).not.toHaveBeenCalled();

    blockWatch.emitFinalized(transferHeader);
    await vi.waitFor(() => {
      expect(mintingAuthorities.authorize).toHaveBeenCalledWith(onChainTransferId);
    });

    blockWatch.emitFinalized(readyHeader);
    await vi.waitFor(async () => {
      const persisted = await db.crosschainOutboundTransfersTable.get(activeTransfer!.id);
      expect(persisted?.status).toBe(CrosschainOutboundTransferStatus.TransferFinalizedOnTargetChain);
      expect(activeTransfer?.persistedRecord?.transferId).toBe(onChainTransferId);
      expect(activeTransfer?.transferState.progress.overallProgressPct).toBe(100);
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

  it('keeps reconciling Minting Authorization after a retryable finalized-block read error', async () => {
    const db = await createTestDb();
    const walletKeys = createMockWalletKeys();
    const onChainTransferId = `0x${'78'.repeat(32)}`;
    const transferHeader = { blockNumber: 10, blockHash: '0xtransfer' };
    const readyHeader = { blockNumber: 11, blockHash: '0xready' };
    const finalizedTxHash = `0x${'79'.repeat(32)}` as const;
    const transferOutTxInfo = createTransferOutTxInfo({
      transferId: onChainTransferId,
      blockHeight: transferHeader.blockNumber,
      moveToken: MoveToken.ARGN,
      amount: 100n,
      txId: 78,
    });

    const blockWatch = createBlockWatch({
      initialHeader: transferHeader,
      getApi: async header =>
        header.blockNumber === transferHeader.blockNumber
          ? {
              blockNumber: header.blockNumber,
              query: {
                crosschainTransfer: {
                  transferOutById: vi.fn(async () => {
                    throw new Error('PRUNED_RPC: WebSocket is not connected');
                  }),
                },
              },
            }
          : {
              blockNumber: header.blockNumber,
              query: {
                crosschainTransfer: {
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
            },
    });
    const transactionTracker = {
      data: { txInfos: [] },
      pendingBlockTxInfosAtLoad: [],
      load: vi.fn(async () => {}),
      ensureStoredEvents: vi.fn(async () => {}),
      findLatestTxInfo: vi.fn(() => transferOutTxInfo),
      submitAndWatch: vi.fn(async () => transferOutTxInfo),
    };
    const ethereumClient = {
      estimateFinalizeTransferOutOfArgonFee: vi.fn(async () => 1n),
      getNativeBalanceWei: vi.fn(async () => 10n),
      finalizeTransferOutOfArgon: vi.fn(async () => finalizedTxHash),
      getTransactionProgress: vi.fn(
        async () =>
          ({
            blockNumber: 42,
            blockHash: `0x${'80'.repeat(32)}`,
            confirmations: 1,
            expectedConfirmations: 1,
            progressPct: 100,
            isFinalized: true,
          }) satisfies IEthereumTransactionProgress,
      ),
      getTransactionFinalityPollMs: vi.fn(() => 1),
      waitForTransactionFinality: vi.fn(
        async () =>
          ({
            blockNumber: 42,
            blockHash: `0x${'80'.repeat(32)}`,
            confirmations: 1,
            expectedConfirmations: 1,
            progressPct: 100,
            isFinalized: true,
          }) satisfies IFinalizedEthereumTransactionProgress,
      ),
      confirmTransferOutOfArgon: vi.fn(
        async () =>
          ({
            targetTxHash: finalizedTxHash,
            targetBlockNumber: 42,
            targetBlockHash: `0x${'80'.repeat(32)}`,
            gatewayActivityNonce: 5n,
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
    );

    const activeTransfer = await tracker.startMove({
      moveToken: MoveToken.ARGN,
      amount: 100n,
      sourceWalletType: WalletType.defaultArgon,
    });

    await vi.waitFor(async () => {
      const persisted = await db.crosschainOutboundTransfersTable.get(activeTransfer!.id);
      expect(persisted?.status).toBe(CrosschainOutboundTransferStatus.RequestFinalizedOnArgon);
      expect(activeTransfer?.transferState.error).toBe('');
      expect(activeTransfer?.transferState.progress.currentStepLabel).toBe(
        'Step 2 of 3: Waiting for Minting Authorization',
      );
    });

    blockWatch.emitFinalized(readyHeader);

    await vi.waitFor(async () => {
      const persisted = await db.crosschainOutboundTransfersTable.get(activeTransfer!.id);
      expect(persisted?.status).toBe(CrosschainOutboundTransferStatus.TransferFinalizedOnTargetChain);
      expect(activeTransfer?.transferState.error).toBe('');
      expect(activeTransfer?.transferState.isSubmitting).toBe(false);
    });
  });

  it('serializes finalized transfer reconciliation while Argon completion is already in flight', async () => {
    const db = await createTestDb();
    const walletKeys = createMockWalletKeys();
    const onChainTransferId = `0x${'7a'.repeat(32)}`;
    const transferHeader = { blockNumber: 10, blockHash: '0xtransfer' };
    const readyHeader = { blockNumber: 11, blockHash: '0xready' };
    const finalizedTxHash = `0x${'7b'.repeat(32)}` as const;
    const firstTransferRead = createDeferredPromise<unknown>();
    const readyTransferOption = {
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
    };
    const finalizedProgress = {
      blockNumber: 42,
      blockHash: `0x${'7c'.repeat(32)}`,
      confirmations: 1,
      expectedConfirmations: 1,
      progressPct: 100,
      isFinalized: true,
    } satisfies IFinalizedEthereumTransactionProgress;
    const transferOutTxInfo = createTransferOutTxInfo({
      transferId: onChainTransferId,
      blockHeight: transferHeader.blockNumber,
      moveToken: MoveToken.ARGN,
      amount: 100n,
      txId: 7,
    });

    const blockWatch = createBlockWatch({
      initialHeader: transferHeader,
      getApi: async header => ({
        blockNumber: header.blockNumber,
        query: {
          crosschainTransfer: {
            transferOutById: vi.fn(async () => {
              if (header.blockNumber === transferHeader.blockNumber) {
                return await firstTransferRead.promise;
              }

              return readyTransferOption;
            }),
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
      }),
    });
    const transactionTracker = {
      data: { txInfos: [] },
      pendingBlockTxInfosAtLoad: [],
      load: vi.fn(async () => {}),
      ensureStoredEvents: vi.fn(async () => {}),
      findLatestTxInfo: vi.fn(() => transferOutTxInfo),
      submitAndWatch: vi.fn(async () => transferOutTxInfo),
    };
    const ethereumClient = {
      estimateFinalizeTransferOutOfArgonFee: vi.fn(async () => 1n),
      getNativeBalanceWei: vi.fn(async () => 10n),
      finalizeTransferOutOfArgon: vi.fn(async () => finalizedTxHash),
      getTransactionProgress: vi.fn(async () => finalizedProgress satisfies IEthereumTransactionProgress),
      getTransactionFinalityPollMs: vi.fn(() => 1),
      waitForTransactionFinality: vi.fn(async () => finalizedProgress),
      confirmTransferOutOfArgon: vi.fn(
        async () =>
          ({
            targetTxHash: finalizedTxHash,
            targetBlockNumber: finalizedProgress.blockNumber,
            targetBlockHash: finalizedProgress.blockHash,
            gatewayActivityNonce: 8n,
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
    );

    const activeTransfer = await tracker.startMove({
      moveToken: MoveToken.ARGN,
      amount: 100n,
      sourceWalletType: WalletType.defaultArgon,
    });

    await vi.waitFor(async () => {
      const persisted = await db.crosschainOutboundTransfersTable.get(activeTransfer!.id);
      expect(persisted?.status).toBe(CrosschainOutboundTransferStatus.RequestFinalizedOnArgon);
    });

    blockWatch.emitFinalized(readyHeader);
    await new Promise(resolve => setTimeout(resolve, 25));
    expect(ethereumClient.finalizeTransferOutOfArgon).not.toHaveBeenCalled();

    firstTransferRead.resolve(readyTransferOption);

    await vi.waitFor(async () => {
      const persisted = await db.crosschainOutboundTransfersTable.get(activeTransfer!.id);
      expect(persisted?.status).toBe(CrosschainOutboundTransferStatus.TransferFinalizedOnTargetChain);
      expect(activeTransfer?.transferState.error).toBe('');
      expect(activeTransfer?.transferState.isSubmitting).toBe(false);
    });
    expect(ethereumClient.finalizeTransferOutOfArgon).toHaveBeenCalledOnce();
  });

  it('updates Minting Authorization progress from Argon when another authority is funding the transfer', async () => {
    const db = await createTestDb();
    const walletKeys = createMockWalletKeys();
    const transferId = 'outbound-progress-from-chain';
    const onChainTransferId = `0x${'81'.repeat(32)}`;
    const waitingHeader = { blockNumber: 12, blockHash: '0xwaiting' };
    const readyHeader = { blockNumber: 13, blockHash: '0xready' };
    const finalizedTxHash = `0x${'82'.repeat(32)}` as const;
    const transferOutTxInfo = createTransferOutTxInfo({
      transferId: onChainTransferId,
      blockHeight: waitingHeader.blockNumber,
      moveToken: MoveToken.ARGN,
      amount: 100n,
      localTransferId: transferId,
      txId: 81,
    });

    const blockWatch = createBlockWatch({
      initialHeader: waitingHeader,
      getApi: async header =>
        header.blockNumber === waitingHeader.blockNumber
          ? {
              blockNumber: header.blockNumber,
              query: {
                crosschainTransfer: {
                  transferOutById: vi.fn(async () => ({
                    isNone: false,
                    unwrap: () => ({
                      state: { isReady: false },
                      amount: { toBigInt: () => 100n },
                      totalAttachedCollateral: { toBigInt: () => 40n },
                    }),
                  })),
                },
              },
            }
          : {
              blockNumber: header.blockNumber,
              query: {
                crosschainTransfer: {
                  transferOutById: vi.fn(async () => ({
                    isNone: false,
                    unwrap: () => ({
                      state: { isReady: true },
                      totalAttachedCollateral: { toBigInt: () => 100n },
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
            },
    });

    await db.crosschainOutboundTransfersTable.recordRequestSubmittedToArgon({
      id: transferId,
      destinationChain: 'Ethereum',
      token: MoveToken.ARGN,
      amount: 100n,
      argonSourceAddress: walletKeys.vaultingAddress,
      destinationAddress: walletKeys.ethereumAddress,
      argonRequestTransactionId: transferOutTxInfo.tx.id,
      progressJson: createCrosschainTransferProgress([
        'Finalizing on Argon',
        'Waiting for Minting Authorization',
        'Sending to Ethereum',
      ]),
    });
    await db.crosschainOutboundTransfersTable.recordRequestFinalizedOnArgon({
      id: transferId,
      transferId: onChainTransferId,
      progressJson: createCrosschainTransferProgress([
        'Finalizing on Argon',
        'Waiting for Minting Authorization',
        'Sending to Ethereum',
      ]),
    });

    const tracker = new EthereumOutboundTransferTracker(
      Promise.resolve(db),
      {
        data: { txInfos: [transferOutTxInfo] },
        pendingBlockTxInfosAtLoad: [],
        load: vi.fn(async () => {}),
        ensureStoredEvents: vi.fn(async () => {}),
        findLatestTxInfo: vi.fn(() => transferOutTxInfo),
      } as any,
      blockWatch.instance as any,
      walletKeys,
      {
        estimateFinalizeTransferOutOfArgonFee: vi.fn(async () => 1n),
        getNativeBalanceWei: vi.fn(async () => 10n),
        finalizeTransferOutOfArgon: vi.fn(async () => finalizedTxHash),
        getTransactionProgress: vi.fn(
          async () =>
            ({
              blockNumber: 42,
              blockHash: `0x${'83'.repeat(32)}`,
              confirmations: 1,
              expectedConfirmations: 1,
              progressPct: 100,
              isFinalized: true,
            }) satisfies IEthereumTransactionProgress,
        ),
        getTransactionFinalityPollMs: vi.fn(() => 1),
        waitForTransactionFinality: vi.fn(
          async () =>
            ({
              blockNumber: 42,
              blockHash: `0x${'83'.repeat(32)}`,
              confirmations: 1,
              expectedConfirmations: 1,
              progressPct: 100,
              isFinalized: true,
            }) satisfies IFinalizedEthereumTransactionProgress,
        ),
        confirmTransferOutOfArgon: vi.fn(
          async () =>
            ({
              targetTxHash: finalizedTxHash,
              targetBlockNumber: 42,
              targetBlockHash: `0x${'83'.repeat(32)}`,
              gatewayActivityNonce: 8n,
            }) satisfies IEthereumTransferOutOfArgon,
        ),
      },
    );

    await tracker.load();

    await vi.waitFor(() => {
      const transfer = tracker.getTransfer(transferId);
      expect(transfer?.transferState.progress.currentStepLabel).toBe('Step 2 of 3: Waiting for Minting Authorization');
      expect(transfer?.transferState.progress.currentStepDetail).toBe(
        'Waiting for Minting Authorization (40% authorized)',
      );
      expect(transfer?.transferState.error).toBe('');
    });

    blockWatch.emitFinalized(readyHeader);

    await vi.waitFor(async () => {
      const persisted = await db.crosschainOutboundTransfersTable.get(transferId);
      expect(persisted?.status).toBe(CrosschainOutboundTransferStatus.TransferFinalizedOnTargetChain);
      expect(tracker.getTransfer(transferId)?.transferState.error).toBe('');
    });
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
                amount: { toBigInt: () => 100n },
                totalAttachedCollateral: { toBigInt: () => 0n },
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
      findLatestTxInfo: vi.fn(() => undefined),
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
        getTransactionProgress: vi.fn(),
        getTransactionFinalityPollMs: vi.fn(() => 1),
        waitForTransactionFinality: vi.fn(),
      },
    );
    tracker.data = Vue.reactive(tracker.data) as any;

    const stopWatching = Vue.watchEffect(() => {
      const currentStepLabel = tracker.getTransferStateForToken(MoveToken.ARGN).progress.currentStepLabel;
      if (currentStepLabel) {
        seenPhases.push(currentStepLabel);
      }
    });

    try {
      await tracker.startMove({
        moveToken: MoveToken.ARGN,
        amount: 100n,
        sourceWalletType: WalletType.defaultArgon,
      });

      await vi.waitFor(() => {
        expect(seenPhases).toContain('Step 1 of 3: Finalizing on Argon');
      });
    } finally {
      stopWatching();
      waitForFinalizedBlock.resolve();
    }
  });

  it('persists the pending Minting Authorization transaction while Minting Authorization is still in flight', async () => {
    const db = await createTestDb();
    const walletKeys = createMockWalletKeys();
    const onChainTransferId = `0x${'71'.repeat(32)}`;
    const transferHeader = { blockNumber: 10, blockHash: '0xtransfer' };
    const waitForPostProcessing = createDeferredPromise<void>();
    const pendingMintingAuthorizationTx = {
      tx: {
        id: 42,
        metadataJson: {
          authorizations: [{ transferId: onChainTransferId }],
        },
      },
      isPostProcessed: false,
      waitForPostProcessing: waitForPostProcessing.promise,
      subscribeToProgress: vi.fn(() => () => {}),
      getStatus: vi.fn(() => ({
        progressPct: 0,
        confirmations: 0,
        expectedConfirmations: 3,
      })),
    };
    const transferOutTxInfo = createTransferOutTxInfo({
      transferId: onChainTransferId,
      blockHeight: transferHeader.blockNumber,
      moveToken: MoveToken.ARGN,
      amount: 100n,
      txId: 84,
    });
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
                amount: { toBigInt: () => 100n },
                totalAttachedCollateral: { toBigInt: () => 0n },
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
      findLatestTxInfo: vi.fn(() => transferOutTxInfo),
      submitAndWatch: vi.fn(async () => transferOutTxInfo),
    };
    const mintingAuthorities = {
      data: {
        authorities: [],
        pendingMintingAuthorizations: [] as unknown[],
        pendingMintingAuthorizeTxInfosByTransferId: new Map(),
      },
      refresh: vi.fn(async () => {}),
      authorize: vi.fn(async () => pendingMintingAuthorizationTx),
    };

    getMainchainClientMock.mockResolvedValue(createMainchainClient());

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
        getTransactionProgress: vi.fn(),
        getTransactionFinalityPollMs: vi.fn(() => 1),
        waitForTransactionFinality: vi.fn(),
      },
      mintingAuthorities as any,
    );

    const activeTransfer = await tracker.startMove({
      moveToken: MoveToken.ARGN,
      amount: 100n,
      sourceWalletType: WalletType.defaultArgon,
    });

    await vi.waitFor(async () => {
      const persisted = await db.crosschainOutboundTransfersTable.get(activeTransfer!.id);
      expect(persisted?.status).toBe(CrosschainOutboundTransferStatus.RequestFinalizedOnArgon);
      expect(persisted?.mintingAuthorizationTransactionId).toBe(42);
      expect(activeTransfer?.transferState.progress.currentStepLabel).toBe(
        'Step 2 of 3: Waiting for Minting Authorization',
      );
      expect(activeTransfer?.transferState.progress.currentStepDetail).toBe(
        'Submitting Minting Authorization to Argon...',
      );
    });
  });

  it('restores the newest pending transfer as latest after load', async () => {
    const db = await createTestDb();
    const walletKeys = createMockWalletKeys();
    const olderId = 'outbound-older';
    const newerId = 'outbound-newer';
    const olderTransferId = `0x${'12'.repeat(32)}`;
    const newerTransferId = `0x${'34'.repeat(32)}`;
    const olderTxInfo = createTransferOutTxInfo({
      transferId: olderTransferId,
      blockHeight: 1,
      moveToken: MoveToken.ARGN,
      amount: 10n,
      localTransferId: olderId,
      txId: 12,
    });
    const newerTxInfo = createTransferOutTxInfo({
      transferId: newerTransferId,
      blockHeight: 1,
      moveToken: MoveToken.ARGN,
      amount: 20n,
      localTransferId: newerId,
      txId: 34,
    });
    await db.crosschainOutboundTransfersTable.recordRequestSubmittedToArgon({
      id: olderId,
      destinationChain: 'Ethereum',
      token: MoveToken.ARGN,
      amount: 10n,
      argonSourceAddress: walletKeys.vaultingAddress,
      destinationAddress: walletKeys.ethereumAddress,
      argonRequestTransactionId: olderTxInfo.tx.id,
      progressJson: createCrosschainTransferProgress([
        'Finalizing on Argon',
        'Waiting for Minting Authorization',
        'Sending to Ethereum',
      ]),
    });
    await db.crosschainOutboundTransfersTable.recordRequestFinalizedOnArgon({
      id: olderId,
      transferId: olderTransferId,
      progressJson: createCrosschainTransferProgress([
        'Finalizing on Argon',
        'Waiting for Minting Authorization',
        'Sending to Ethereum',
      ]),
    });
    await db.sql.execute(`UPDATE CrosschainOutboundTransfers SET updatedAt = ? WHERE id = ?`, [
      '2026-05-25 00:00:00',
      olderId,
    ]);
    await db.crosschainOutboundTransfersTable.recordRequestSubmittedToArgon({
      id: newerId,
      destinationChain: 'Ethereum',
      token: MoveToken.ARGN,
      amount: 20n,
      argonSourceAddress: walletKeys.vaultingAddress,
      destinationAddress: walletKeys.ethereumAddress,
      argonRequestTransactionId: newerTxInfo.tx.id,
      progressJson: createCrosschainTransferProgress([
        'Finalizing on Argon',
        'Waiting for Minting Authorization',
        'Sending to Ethereum',
      ]),
    });
    await db.crosschainOutboundTransfersTable.recordRequestFinalizedOnArgon({
      id: newerId,
      transferId: newerTransferId,
      progressJson: createCrosschainTransferProgress([
        'Finalizing on Argon',
        'Waiting for Minting Authorization',
        'Sending to Ethereum',
      ]),
    });
    await db.sql.execute(`UPDATE CrosschainOutboundTransfers SET updatedAt = ? WHERE id = ?`, [
      '2026-05-26 00:00:00',
      newerId,
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
                amount: { toBigInt: () => 100n },
                totalAttachedCollateral: { toBigInt: () => 0n },
              }),
            })),
          },
        },
      }),
    });
    const transactionTracker = {
      data: { txInfos: [newerTxInfo, olderTxInfo] },
      pendingBlockTxInfosAtLoad: [],
      load: vi.fn(async () => {}),
      ensureStoredEvents: vi.fn(async () => {}),
      findLatestTxInfo: vi.fn((matcher: (txInfo: typeof newerTxInfo) => boolean) =>
        [newerTxInfo, olderTxInfo].find(txInfo => matcher(txInfo)),
      ),
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
        getTransactionProgress: vi.fn(
          async () =>
            ({
              blockNumber: 99,
              blockHash: `0x${'78'.repeat(32)}`,
              confirmations: 1,
              expectedConfirmations: 1,
              progressPct: 100,
              isFinalized: true,
            }) satisfies IEthereumTransactionProgress,
        ),
        getTransactionFinalityPollMs: vi.fn(() => 1),
        waitForTransactionFinality: vi.fn(
          async () =>
            ({
              blockNumber: 99,
              blockHash: `0x${'78'.repeat(32)}`,
              confirmations: 1,
              expectedConfirmations: 1,
              progressPct: 100,
              isFinalized: true,
            }) satisfies IFinalizedEthereumTransactionProgress,
        ),
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

    expect(tracker.getLatestTransfer(MoveToken.ARGN)?.id).toBe(newerId);
    expect(tracker.getLatestTransfer(MoveToken.ARGN)?.persistedRecord?.transferId).toBe(newerTransferId);
  });

  it('restores a pending transfer-out tx without its outbound row even when an older failed transfer exists', async () => {
    const db = await createTestDb();
    const walletKeys = createMockWalletKeys();
    const failedTransferId = 'outbound-failed-older';
    const pendingTransferId = 'outbound-pending-newer';
    const waitForFinalizedBlock = createDeferredPromise<void>();
    const transactionTracker = {
      data: {
        txInfos: [
          createTransferOutTxInfo({
            transferId: `0x${'45'.repeat(32)}`,
            blockHeight: 25,
            moveToken: MoveToken.ARGNOT,
            amount: 25n,
            localTransferId: pendingTransferId,
            txId: 77,
            submittedAtTime: new Date('2026-05-27T00:00:00Z'),
            waitForFinalizedBlock: waitForFinalizedBlock.promise,
          }),
        ],
      },
      pendingBlockTxInfosAtLoad: [],
      load: vi.fn(async () => {}),
      ensureStoredEvents: vi.fn(async () => {}),
      findLatestTxInfo: vi.fn(() => undefined),
    };

    await db.crosschainOutboundTransfersTable.recordRequestSubmittedToArgon({
      id: failedTransferId,
      destinationChain: 'Ethereum',
      token: MoveToken.ARGNOT,
      amount: 10n,
      argonSourceAddress: walletKeys.defaultArgonAddress,
      destinationAddress: walletKeys.ethereumAddress,
      progressJson: createCrosschainTransferProgress([
        'Finalizing on Argon',
        'Waiting for Minting Authorization',
        'Sending to Ethereum',
      ]),
    });
    await db.crosschainOutboundTransfersTable.recordFailed({
      id: failedTransferId,
      failureReason: 'older failure',
    });
    await db.sql.execute(`UPDATE CrosschainOutboundTransfers SET createdAt = ?, updatedAt = ? WHERE id = ?`, [
      '2026-05-26 00:00:00',
      '2026-05-26 00:00:00',
      failedTransferId,
    ]);

    const tracker = new EthereumOutboundTransferTracker(
      Promise.resolve(db),
      transactionTracker as any,
      createBlockWatch({
        initialHeader: { blockNumber: 25, blockHash: '0xheader' },
        getApi: async () => ({}),
      }).instance as any,
      walletKeys,
      {} as any,
    );

    await tracker.load();

    const latestTransfer = tracker.getLatestTransfer(MoveToken.ARGNOT);
    expect(latestTransfer?.id).toBe(pendingTransferId);
    expect(latestTransfer?.persistedRecord).toBeUndefined();
    expect(latestTransfer?.transferState.amount).toBe(25n);
    expect(latestTransfer?.transferState.isSubmitting).toBe(true);
    expect(latestTransfer?.transferState.needsAttention).toBe(false);
    expect(latestTransfer?.transferState.progress.currentStepLabel).toBe('Step 1 of 3: Finalizing on Argon');
  });

  it('shows the gateway pause when a pending activation is blocking its own minting authorization', async () => {
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
                amount: { toBigInt: () => 100n },
                totalAttachedCollateral: { toBigInt: () => 0n },
              }),
            })),
          },
        },
      }),
    });
    const transferOutTxInfo = createTransferOutTxInfo({
      transferId: onChainTransferId,
      blockHeight: transferHeader.blockNumber,
      moveToken: MoveToken.ARGN,
      amount: 100n,
      txId: 92,
    });
    const transactionTracker = {
      data: { txInfos: [] },
      pendingBlockTxInfosAtLoad: [],
      load: vi.fn(async () => {}),
      ensureStoredEvents: vi.fn(async () => {}),
      findLatestTxInfo: vi.fn(() => transferOutTxInfo),
      submitAndWatch: vi.fn(async () => transferOutTxInfo),
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
        pendingMintingAuthorizations: [] as unknown[],
        pendingMintingAuthorizeTxInfosByTransferId: new Map(),
      },
      refresh: vi.fn(async () => {}),
      authorize: vi.fn(async () => {
        throw new Error(`Transfer ${onChainTransferId} is not currently available to authorize.`);
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
        getTransactionProgress: vi.fn(
          async () =>
            ({
              blockNumber: 99,
              blockHash: `0x${'93'.repeat(32)}`,
              confirmations: 1,
              expectedConfirmations: 1,
              progressPct: 100,
              isFinalized: true,
            }) satisfies IEthereumTransactionProgress,
        ),
        getTransactionFinalityPollMs: vi.fn(() => 1),
        waitForTransactionFinality: vi.fn(
          async () =>
            ({
              blockNumber: 99,
              blockHash: `0x${'93'.repeat(32)}`,
              confirmations: 1,
              expectedConfirmations: 1,
              progressPct: 100,
              isFinalized: true,
            }) satisfies IFinalizedEthereumTransactionProgress,
        ),
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
      sourceWalletType: WalletType.defaultArgon,
    });

    await vi.waitFor(async () => {
      const persisted = await db.crosschainOutboundTransfersTable.get(activeTransfer!.id);
      expect(persisted?.status).toBe(CrosschainOutboundTransferStatus.RequestFinalizedOnArgon);
      expect(activeTransfer?.transferState.progress.currentStepLabel).toBe(
        'Step 2 of 3: Waiting for Minting Authorization',
      );
      expect(activeTransfer?.transferState.error).toBe(
        'Ethereum gateway sync is paused at activity 1 (GatewayStateDrift).',
      );
      expect(activeTransfer?.transferState.progress.currentStepDetail).toBe(
        'Waiting for Minting Authorization (0% authorized)',
      );
    });
  });

  it('ignores stale fully-covered minting authorization failures and keeps the transfer moving', async () => {
    const db = await createTestDb();
    const walletKeys = createMockWalletKeys();
    const transferId = 'outbound-covered-race';
    const onChainTransferId = `0x${'94'.repeat(32)}`;
    const staleAuthorizationError = new Error(
      'The outbound transfer cannot accept more collateral because it is already fully covered.',
    );
    const blockWatch = createBlockWatch({
      initialHeader: { blockNumber: 12, blockHash: '0xpending' },
      getApi: async header => ({
        blockNumber: header.blockNumber,
        query: {
          crosschainTransfer: {
            pendingCollateralizationRequestsByChain: vi.fn(async () => [
              {
                transferId: { toHex: () => onChainTransferId },
                remainingCollateral: { toBigInt: () => 50n },
              },
            ]),
            transferOutById: vi.fn(async () => ({
              isNone: false,
              unwrap: () => ({
                state: { isReady: false },
                amount: { toBigInt: () => 100n },
                totalAttachedCollateral: { toBigInt: () => 50n },
              }),
            })),
          },
        },
      }),
    });
    const staleTxInfo = {
      tx: {
        id: 42,
        extrinsicType: ExtrinsicType.CrosschainTransferAuthorize,
        status: TransactionStatus.Finalized,
        metadataJson: {
          authorizations: [{ transferId: onChainTransferId }],
        },
      },
      txResult: {
        submissionError: undefined,
        extrinsicError: staleAuthorizationError,
      },
      isPostProcessed: false,
    };
    const authorizationTxInfo = {
      tx: {
        id: 43,
        extrinsicType: ExtrinsicType.CrosschainTransferAuthorize,
        status: TransactionStatus.Submitted,
        metadataJson: {
          authorizations: [{ transferId: onChainTransferId }],
        },
      },
      txResult: {
        submissionError: undefined,
      },
      isPostProcessed: true,
      waitForPostProcessing: Promise.resolve(),
      getStatus: vi.fn(() => ({
        progressPct: 0,
        confirmations: 0,
        expectedConfirmations: 3,
      })),
      subscribeToProgress: vi.fn(
        (
          callback: (
            progress: { progressPct: number; confirmations: number; expectedConfirmations: number; isMaxed: boolean },
            error?: Error,
          ) => void,
        ) => {
          callback(
            {
              progressPct: 0,
              confirmations: 0,
              expectedConfirmations: 3,
              isMaxed: false,
            },
            staleAuthorizationError,
          );
          return () => {};
        },
      ),
    };
    const authorize = vi.fn(async () => authorizationTxInfo);
    const mintingAuthorities = {
      data: {
        authorities: [],
        pendingMintingAuthorizations: [{ transferId: onChainTransferId }] as unknown[],
        pendingMintingAuthorizeTxInfosByTransferId: new Map([[onChainTransferId, staleTxInfo]]),
      },
      refresh: vi.fn(async () => {}),
      authorize,
    };

    const tracker = new EthereumOutboundTransferTracker(
      Promise.resolve(db),
      {
        data: { txInfos: [] },
        pendingBlockTxInfosAtLoad: [],
        load: vi.fn(async () => {}),
        ensureStoredEvents: vi.fn(async () => {}),
        findLatestTxInfo: vi.fn(() => staleTxInfo),
      } as any,
      blockWatch.instance as any,
      walletKeys,
      {
        estimateFinalizeTransferOutOfArgonFee: vi.fn(async () => 1n),
        getNativeBalanceWei: vi.fn(async () => 10n),
        finalizeTransferOutOfArgon: vi.fn(async () => `0x${'95'.repeat(32)}` as const),
        getTransactionProgress: vi.fn(async () => {
          throw new Error('should not reach Ethereum finalization while still waiting on authorization');
        }),
        getTransactionFinalityPollMs: vi.fn(() => 1),
        waitForTransactionFinality: vi.fn(async () => {
          throw new Error('should not reach Ethereum finalization while still waiting on authorization');
        }),
        confirmTransferOutOfArgon: vi.fn(async () => {
          throw new Error('should not reach Ethereum finalization while still waiting on authorization');
        }),
      },
      mintingAuthorities as any,
    );

    await db.crosschainOutboundTransfersTable.recordRequestSubmittedToArgon({
      id: transferId,
      destinationChain: 'Ethereum',
      token: MoveToken.ARGN,
      amount: 100n,
      argonSourceAddress: walletKeys.vaultingAddress,
      destinationAddress: walletKeys.ethereumAddress,
      argonRequestTransactionId: staleTxInfo.tx.id,
      progressJson: createCrosschainTransferProgress([
        'Finalizing on Argon',
        'Waiting for Minting Authorization',
        'Sending to Ethereum',
      ]),
    });
    await db.crosschainOutboundTransfersTable.recordRequestFinalizedOnArgon({
      id: transferId,
      transferId: onChainTransferId,
      progressJson: createCrosschainTransferProgress([
        'Finalizing on Argon',
        'Waiting for Minting Authorization',
        'Sending to Ethereum',
      ]),
    });
    await db.crosschainOutboundTransfersTable.patch(transferId, {
      mintingAuthorizationTransactionId: 42,
    });

    await tracker.load();

    await vi.waitFor(() => {
      expect(authorize).toHaveBeenCalledWith(onChainTransferId);
      expect(tracker.getTransfer(transferId)?.transferState.error).toBe('');
      expect(tracker.getTransfer(transferId)?.transferState.needsAttention).toBe(false);
      expect(tracker.getTransfer(transferId)?.transferState.progress.currentStepLabel).toBe(
        'Step 2 of 3: Waiting for Minting Authorization',
      );
    });
  });

  it('dismisses a failed Minting Authorization transfer when dismissed', async () => {
    const db = await createTestDb();
    const walletKeys = createMockWalletKeys();
    const transferId = 'outbound-failed';
    const onChainTransferId = `0x${'a1'.repeat(32)}`;
    const blockWatch = createBlockWatch({
      initialHeader: { blockNumber: 12, blockHash: '0xready' },
      getApi: async header => ({
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
      }),
    });
    const tracker = new EthereumOutboundTransferTracker(
      Promise.resolve(db),
      {
        data: { txInfos: [] },
        pendingBlockTxInfosAtLoad: [],
        load: vi.fn(async () => {}),
        ensureStoredEvents: vi.fn(async () => {}),
        findLatestTxInfo: vi.fn(() => undefined),
      } as any,
      blockWatch.instance as any,
      walletKeys,
      {
        estimateFinalizeTransferOutOfArgonFee: vi.fn(async () => 1n),
        getNativeBalanceWei: vi.fn(async () => 10n),
        finalizeTransferOutOfArgon: vi.fn(async () => `0x${'a2'.repeat(32)}` as const),
        getTransactionProgress: vi.fn(
          async () =>
            ({
              blockNumber: 99,
              blockHash: `0x${'a3'.repeat(32)}`,
              confirmations: 1,
              expectedConfirmations: 1,
              progressPct: 100,
              isFinalized: true,
            }) satisfies IEthereumTransactionProgress,
        ),
        getTransactionFinalityPollMs: vi.fn(() => 1),
        waitForTransactionFinality: vi.fn(
          async () =>
            ({
              blockNumber: 99,
              blockHash: `0x${'a3'.repeat(32)}`,
              confirmations: 1,
              expectedConfirmations: 1,
              progressPct: 100,
              isFinalized: true,
            }) satisfies IFinalizedEthereumTransactionProgress,
        ),
        confirmTransferOutOfArgon: vi.fn(
          async () =>
            ({
              targetTxHash: `0x${'a2'.repeat(32)}`,
              targetBlockNumber: 99,
              targetBlockHash: `0x${'a3'.repeat(32)}`,
              gatewayActivityNonce: 9n,
            }) satisfies IEthereumTransferOutOfArgon,
        ),
      },
    );

    await db.crosschainOutboundTransfersTable.recordRequestSubmittedToArgon({
      id: transferId,
      destinationChain: 'Ethereum',
      token: MoveToken.ARGN,
      amount: 100n,
      argonSourceAddress: walletKeys.vaultingAddress,
      destinationAddress: walletKeys.ethereumAddress,
      progressJson: createCrosschainTransferProgress([
        'Finalizing on Argon',
        'Waiting for Minting Authorization',
        'Sending to Ethereum',
      ]),
    });
    await db.crosschainOutboundTransfersTable.recordRequestFinalizedOnArgon({
      id: transferId,
      transferId: onChainTransferId,
      progressJson: createCrosschainTransferProgress([
        'Finalizing on Argon',
        'Waiting for Minting Authorization',
        'Sending to Ethereum',
      ]),
    });
    await db.crosschainOutboundTransfersTable.recordFailed({
      id: transferId,
      failureReason: 'manual retry needed',
    });

    await tracker.load();

    await vi.waitFor(() => {
      const transfer = tracker.getTransfer(transferId);
      expect(transfer?.transferState.needsAttention).toBe(true);
      expect(transfer?.transferState.error).toBe('manual retry needed');
      expect(transfer?.transferState.isSubmitting).toBe(false);
    });

    await tracker.dismissFailedTransfer(transferId);

    const persisted = await db.crosschainOutboundTransfersTable.get(transferId);
    expect(persisted?.status).toBe(CrosschainOutboundTransferStatus.RequestFinalizedOnArgon);
    expect(persisted?.failureReason).toBe('manual retry needed');
    expect(persisted?.isFailureAcknowledged).toBe(true);
    expect(tracker.getTransfer(transferId)).toBeUndefined();
  });

  it('keeps a dismissed Minting Authorization failure hidden after restart', async () => {
    const db = await createTestDb();
    const walletKeys = createMockWalletKeys();
    const transferId = 'outbound-acknowledged-step-2';
    const onChainTransferId = `0x${'c4'.repeat(32)}`;
    const blockWatch = createBlockWatch({
      initialHeader: { blockNumber: 12, blockHash: '0xready' },
      getApi: async () => ({}),
    });

    await db.crosschainOutboundTransfersTable.recordRequestSubmittedToArgon({
      id: transferId,
      destinationChain: 'Ethereum',
      token: MoveToken.ARGN,
      amount: 100n,
      argonSourceAddress: walletKeys.vaultingAddress,
      destinationAddress: walletKeys.ethereumAddress,
      progressJson: createCrosschainTransferProgress([
        'Finalizing on Argon',
        'Waiting for Minting Authorization',
        'Sending to Ethereum',
      ]),
    });
    await db.crosschainOutboundTransfersTable.recordRequestFinalizedOnArgon({
      id: transferId,
      transferId: onChainTransferId,
      progressJson: createCrosschainTransferProgress([
        'Finalizing on Argon',
        'Waiting for Minting Authorization',
        'Sending to Ethereum',
      ]),
    });
    await db.crosschainOutboundTransfersTable.recordFailed({
      id: transferId,
      failureReason: 'stale notice from an earlier build',
    });
    await db.crosschainOutboundTransfersTable.acknowledgeFailed(transferId);

    const tracker = new EthereumOutboundTransferTracker(
      Promise.resolve(db),
      {
        data: { txInfos: [] },
        pendingBlockTxInfosAtLoad: [],
        load: vi.fn(async () => {}),
        ensureStoredEvents: vi.fn(async () => {}),
        findLatestTxInfo: vi.fn(() => undefined),
      } as any,
      blockWatch.instance as any,
      walletKeys,
      {} as any,
    );

    await tracker.load();

    const persisted = await db.crosschainOutboundTransfersTable.get(transferId);
    expect(persisted?.status).toBe(CrosschainOutboundTransferStatus.RequestFinalizedOnArgon);
    expect(persisted?.failureReason).toBe('stale notice from an earlier build');
    expect(persisted?.isFailureAcknowledged).toBe(true);
    expect(tracker.getTransfer(transferId)).toBeUndefined();
  });

  it('keeps a minting-authorized transfer pending when the Ethereum wallet is short on fees', async () => {
    const db = await createTestDb();
    const walletKeys = createMockWalletKeys();
    const transferId = 'outbound-needs-eth';
    const targetTxHash = `0x${'c2'.repeat(32)}` as const;
    const blockWatch = createBlockWatch({
      initialHeader: { blockNumber: 12, blockHash: '0xready' },
      getApi: async () => ({}),
    });
    let ethereumBalanceWei = 0n;

    await db.crosschainOutboundTransfersTable.recordRequestSubmittedToArgon({
      id: transferId,
      destinationChain: 'Ethereum',
      token: MoveToken.ARGN,
      amount: 100n,
      argonSourceAddress: walletKeys.vaultingAddress,
      destinationAddress: walletKeys.ethereumAddress,
      progressJson: createCrosschainTransferProgress([
        'Finalizing on Argon',
        'Waiting for Minting Authorization',
        'Sending to Ethereum',
      ]),
    });
    await db.crosschainOutboundTransfersTable.recordRequestFinalizedOnArgon({
      id: transferId,
      transferId: `0x${'c1'.repeat(32)}`,
      progressJson: createCrosschainTransferProgress([
        'Finalizing on Argon',
        'Waiting for Minting Authorization',
        'Sending to Ethereum',
      ]),
    });
    await db.crosschainOutboundTransfersTable.recordMintingAuthorized({
      id: transferId,
      mintingAuthorizedMicrogons: 100n,
      mintingAuthorizedMicronots: 0n,
      finalizeRequestJson: {
        argonAccountId: `0x${'22'.repeat(32)}`,
        argonTransferNonce: 1n,
        chainId: 1n,
        microgonsPerArgonot: 3n,
        recipient: walletKeys.ethereumAddress,
        validUntilBlock: 500n,
        token: `0x${'44'.repeat(20)}`,
        amount: 100n,
        mintingAuthorityTip: 1n,
      },
      finalizeProofJson: {
        authorizations: [
          {
            microgonCollateral: 100n,
            micronotCollateral: 0n,
            signature: `0x${'00'.repeat(64)}1c`,
          },
        ],
      },
      progressJson: createCrosschainTransferProgress([
        'Finalizing on Argon',
        'Waiting for Minting Authorization',
        'Sending to Ethereum',
      ]),
    });

    const tracker = new EthereumOutboundTransferTracker(
      Promise.resolve(db),
      {
        data: { txInfos: [] },
        pendingBlockTxInfosAtLoad: [],
        load: vi.fn(async () => {}),
        ensureStoredEvents: vi.fn(async () => {}),
        findLatestTxInfo: vi.fn(() => undefined),
      } as any,
      blockWatch.instance as any,
      walletKeys,
      {
        estimateFinalizeTransferOutOfArgonFee: vi.fn(async () => 5n),
        getNativeBalanceWei: vi.fn(async () => ethereumBalanceWei),
        finalizeTransferOutOfArgon: vi.fn(async () => targetTxHash),
        getTransactionProgress: vi.fn(
          async () =>
            ({
              blockNumber: 99,
              blockHash: `0x${'c3'.repeat(32)}`,
              confirmations: 1,
              expectedConfirmations: 1,
              progressPct: 100,
              isFinalized: true,
            }) satisfies IEthereumTransactionProgress,
        ),
        getTransactionFinalityPollMs: vi.fn(() => 1),
        waitForTransactionFinality: vi.fn(
          async () =>
            ({
              blockNumber: 99,
              blockHash: `0x${'c3'.repeat(32)}`,
              confirmations: 1,
              expectedConfirmations: 1,
              progressPct: 100,
              isFinalized: true,
            }) satisfies IFinalizedEthereumTransactionProgress,
        ),
        confirmTransferOutOfArgon: vi.fn(
          async () =>
            ({
              targetTxHash,
              targetBlockNumber: 99,
              targetBlockHash: `0x${'c3'.repeat(32)}`,
              gatewayActivityNonce: 13n,
            }) satisfies IEthereumTransferOutOfArgon,
        ),
      },
    );

    await tracker.load();

    await vi.waitFor(async () => {
      const persisted = await db.crosschainOutboundTransfersTable.get(transferId);
      const transfer = tracker.getTransfer(transferId);
      expect(persisted?.status).toBe(CrosschainOutboundTransferStatus.MintingAuthorized);
      expect(persisted?.failureReason).toBeNull();
      expect(transfer?.transferState.hasPersistedTransfer).toBe(true);
      expect(transfer?.transferState.needsAttention).toBe(false);
      expect(transfer?.transferState.isSubmitting).toBe(false);
      expect(transfer?.transferState.progress.currentStepLabel).toBe('Step 3 of 3: Sending to Ethereum');
      expect(transfer?.transferState.progress.currentStepDetail).toBe(
        'Waiting for ETH to cover the Ethereum network fee.',
      );
      expect(transfer?.transferState.progress.currentStepHint).toBe(
        'This transfer will continue automatically after the wallet is funded.',
      );
      expect(transfer?.transferState.error).toContain('Add about');
    });

    ethereumBalanceWei = 10n;
    blockWatch.emitFinalized({ blockNumber: 13, blockHash: '0xafter-funding' });

    await vi.waitFor(async () => {
      const persisted = await db.crosschainOutboundTransfersTable.get(transferId);
      expect(persisted?.status).toBe(CrosschainOutboundTransferStatus.TransferFinalizedOnTargetChain);
      expect(persisted?.failureReason).toBeNull();
      expect(tracker.getTransfer(transferId)?.transferState.error).toBe('');
    });
  });

  it('recovers a submitted Ethereum transfer after app restart', async () => {
    const db = await createTestDb();
    const walletKeys = createMockWalletKeys();
    const transferId = 'outbound-submitted-target-chain';
    const targetTxHash = `0x${'b2'.repeat(32)}` as const;
    const blockWatch = createBlockWatch({
      initialHeader: { blockNumber: 12, blockHash: '0xready' },
      getApi: async () => ({}),
    });
    const transactionTracker = {
      data: { txInfos: [] },
      pendingBlockTxInfosAtLoad: [],
      load: vi.fn(async () => {}),
      ensureStoredEvents: vi.fn(async () => {}),
      findLatestTxInfo: vi.fn(() => undefined),
    };

    await db.crosschainOutboundTransfersTable.recordRequestSubmittedToArgon({
      id: transferId,
      destinationChain: 'Ethereum',
      token: MoveToken.ARGN,
      amount: 100n,
      argonSourceAddress: walletKeys.vaultingAddress,
      destinationAddress: walletKeys.ethereumAddress,
      progressJson: createCrosschainTransferProgress([
        'Finalizing on Argon',
        'Waiting for Minting Authorization',
        'Sending to Ethereum',
      ]),
    });
    await db.crosschainOutboundTransfersTable.recordRequestFinalizedOnArgon({
      id: transferId,
      transferId: `0x${'b1'.repeat(32)}`,
      progressJson: createCrosschainTransferProgress([
        'Finalizing on Argon',
        'Waiting for Minting Authorization',
        'Sending to Ethereum',
      ]),
    });
    await db.crosschainOutboundTransfersTable.recordMintingAuthorized({
      id: transferId,
      mintingAuthorizedMicrogons: 100n,
      mintingAuthorizedMicronots: 0n,
      finalizeRequestJson: {
        argonAccountId: `0x${'22'.repeat(32)}`,
        argonTransferNonce: 1n,
        chainId: 1n,
        microgonsPerArgonot: 3n,
        recipient: walletKeys.ethereumAddress,
        validUntilBlock: 500n,
        token: `0x${'44'.repeat(20)}`,
        amount: 100n,
        mintingAuthorityTip: 1n,
      },
      finalizeProofJson: {
        authorizations: [
          {
            microgonCollateral: 100n,
            micronotCollateral: 0n,
            signature: `0x${'00'.repeat(64)}1c`,
          },
        ],
      },
      progressJson: createCrosschainTransferProgress([
        'Finalizing on Argon',
        'Waiting for Minting Authorization',
        'Sending to Ethereum',
      ]),
    });
    await db.crosschainOutboundTransfersTable.recordTransferSubmittedToTargetChain({
      id: transferId,
      targetTxHash,
      progressJson: createCrosschainTransferProgress([
        'Finalizing on Argon',
        'Waiting for Minting Authorization',
        'Sending to Ethereum',
      ]),
    });
    const trackerBeforeRestart = new EthereumOutboundTransferTracker(
      Promise.resolve(db),
      transactionTracker as any,
      blockWatch.instance as any,
      walletKeys,
      {
        estimateFinalizeTransferOutOfArgonFee: vi.fn(async () => {
          throw new Error('should not re-estimate after Ethereum submission');
        }),
        getNativeBalanceWei: vi.fn(async () => 10n),
        finalizeTransferOutOfArgon: vi.fn(async () => {
          throw new Error('should not resubmit after Ethereum submission');
        }),
        getTransactionProgress: vi.fn(
          async () =>
            ({
              blockNumber: 99,
              blockHash: `0x${'b3'.repeat(32)}`,
              confirmations: 0,
              expectedConfirmations: 1,
              progressPct: 0,
              isFinalized: false,
            }) satisfies IEthereumTransactionProgress,
        ),
        getTransactionFinalityPollMs: vi.fn(() => 1),
        waitForTransactionFinality: vi.fn(async () => {
          throw new Error('temporary rpc issue');
        }),
        confirmTransferOutOfArgon: vi.fn(async () => {
          throw new Error('should not confirm before finality is available');
        }),
      },
    );

    await trackerBeforeRestart.load();

    await vi.waitFor(async () => {
      const persisted = await db.crosschainOutboundTransfersTable.get(transferId);
      const transfer = trackerBeforeRestart.getTransfer(transferId);
      expect(persisted?.status).toBe(CrosschainOutboundTransferStatus.TransferSubmittedToTargetChain);
      expect(persisted?.failureReason).toBeNull();
      expect(transfer?.transferState.isSubmitting).toBe(true);
      expect(transfer?.transferState.needsAttention).toBe(false);
      expect(transfer?.transferState.error).toBe('');
    });

    const trackerAfterRestart = new EthereumOutboundTransferTracker(
      Promise.resolve(db),
      transactionTracker as any,
      blockWatch.instance as any,
      walletKeys,
      {
        estimateFinalizeTransferOutOfArgonFee: vi.fn(async () => {
          throw new Error('should not re-estimate after Ethereum submission');
        }),
        getNativeBalanceWei: vi.fn(async () => 10n),
        finalizeTransferOutOfArgon: vi.fn(async () => {
          throw new Error('should not resubmit after Ethereum submission');
        }),
        getTransactionProgress: vi.fn(
          async () =>
            ({
              blockNumber: 99,
              blockHash: `0x${'b3'.repeat(32)}`,
              confirmations: 1,
              expectedConfirmations: 1,
              progressPct: 100,
              isFinalized: true,
            }) satisfies IEthereumTransactionProgress,
        ),
        getTransactionFinalityPollMs: vi.fn(() => 1),
        waitForTransactionFinality: vi.fn(
          async () =>
            ({
              blockNumber: 99,
              blockHash: `0x${'b3'.repeat(32)}`,
              confirmations: 1,
              expectedConfirmations: 1,
              progressPct: 100,
              isFinalized: true,
            }) satisfies IFinalizedEthereumTransactionProgress,
        ),
        confirmTransferOutOfArgon: vi.fn(
          async () =>
            ({
              targetTxHash,
              targetBlockNumber: 99,
              targetBlockHash: `0x${'b3'.repeat(32)}`,
              gatewayActivityNonce: 11n,
            }) satisfies IEthereumTransferOutOfArgon,
        ),
      },
    );

    await trackerAfterRestart.load();

    await vi.waitFor(async () => {
      const persisted = await db.crosschainOutboundTransfersTable.get(transferId);
      expect(persisted?.status).toBe(CrosschainOutboundTransferStatus.TransferFinalizedOnTargetChain);
      expect(persisted?.failureReason).toBeNull();
      expect(trackerAfterRestart.getTransfer(transferId)?.transferState.error).toBe('');
      expect(trackerAfterRestart.getTransfer(transferId)?.transferState.progress.overallProgressPct).toBe(100);
    });
  });

  it('caps the max transfer-out amount to leave room for the tip and existential deposit', async () => {
    getMainchainClientMock.mockResolvedValue(createMainchainClient());

    const tracker = new EthereumOutboundTransferTracker(
      Promise.resolve(await createTestDb()),
      { data: { txInfos: [] } } as any,
      { start: vi.fn(async () => {}) } as any,
      createMockWalletKeys(),
      {} as any,
    );

    await expect(tracker.getMaximumTransferOutAmount(205293660000n, MoveToken.ARGNOT)).resolves.toBe(205088561438n);
  });

  it('rejects an outbound amount that would dip below the minimum balance', async () => {
    getMainchainClientMock.mockResolvedValue(createMainchainClient());

    const tracker = new EthereumOutboundTransferTracker(
      Promise.resolve(await createTestDb()),
      { data: { txInfos: [] } } as any,
      { start: vi.fn(async () => {}) } as any,
      createMockWalletKeys(),
      {} as any,
    );

    await expect(
      tracker.startMove({
        moveToken: MoveToken.ARGNOT,
        amount: 205088571428n,
        availableAmount: 205293660000n,
        sourceWalletType: WalletType.defaultArgon,
      }),
    ).rejects.toThrow('A small ARGNOT tip is reserved and the account must keep its minimum balance');
  });
});

function createMainchainClient() {
  const now = BigInt(Date.now());

  return {
    tx: {
      crosschainTransfer: {
        transferOut: vi.fn(() => ({ kind: 'transferOut' })),
      },
    },
    query: {
      ethereumVerifier: {
        latestExecutionHeaderAnchorBlockHash: vi.fn(async () => ({
          isNone: false,
          unwrap: () => ({ toHex: () => `0x${'aa'.repeat(32)}` }),
        })),
        executionHeaderAnchors: vi.fn(async () => ({
          isNone: false,
          unwrap: () => ({
            timestampMillis: { toBigInt: () => now },
          }),
        })),
      },
    },
    consts: {
      crosschainTransfer: {
        maxVerifiedExecutionBlockAgeTicks: {
          toBigInt: () => 60n,
        },
        transferOutMintingAuthorityTipBasisPoints: {
          toNumber: () => 10,
        },
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
  localTransferId?: string;
  txId?: number;
  submittedAtTime?: Date;
  waitForFinalizedBlock?: Promise<void>;
}) {
  return {
    tx: {
      id: args.txId ?? 1,
      extrinsicType: ExtrinsicType.CrosschainTransferTransferOut,
      extrinsicHash: `0x${'ab'.repeat(32)}`,
      status: TransactionStatus.Submitted,
      submittedAtTime: args.submittedAtTime ?? new Date('2026-05-26T00:00:00Z'),
      metadataJson: {
        actionType: 'transferOutToEthereum',
        localTransferId: args.localTransferId ?? 'outbound-test',
        moveToken: args.moveToken,
        amount: args.amount,
        sourceWalletType: WalletType.defaultArgon,
        destinationAddress: `0x${'99'.repeat(20)}`,
      },
      blockHeight: args.blockHeight,
      finalizedHeadHeight: args.blockHeight,
      blockHash: '0xtransfer-block',
    },
    txResult: {
      waitForFinalizedBlock: args.waitForFinalizedBlock ?? Promise.resolve(),
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
    getStatus: vi.fn(() => ({
      progressPct: 0,
      confirmations: 0,
      expectedConfirmations: 3,
    })),
    subscribeToProgress: vi.fn(() => () => {}),
  };
}

function createBlockWatch(args: {
  initialHeader: { blockNumber: number; blockHash: string };
  getApi: (header: { blockNumber: number; blockHash: string }) => Promise<unknown>;
}) {
  const events = new EventEmitter();
  const instance = {
    finalizedBlockHeader: args.initialHeader,
    bestBlockHeader: {
      ...args.initialHeader,
      blockTime: Date.now(),
    },
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
      instance.bestBlockHeader = {
        ...header,
        blockTime: Date.now(),
      };
      events.emit('finalized', [header]);
    },
  };
}
