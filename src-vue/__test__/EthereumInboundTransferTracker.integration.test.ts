import { MoveToken } from '@argonprotocol/apps-core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb } from './helpers/db.ts';
import { createMockWalletKeys } from './helpers/wallet.ts';
import { EthereumInboundTransferTracker } from '../lib/EthereumInboundTransferTracker.ts';
import type { EthereumClient } from '../lib/EthereumClient.ts';
import {
  CrosschainInboundTransferStatus,
  type ICrosschainInboundTransferRecord,
} from '../lib/db/CrosschainInboundTransfersTable.ts';
import type { TransactionTracker } from '../lib/TransactionTracker.ts';
import { WalletType } from '../lib/Wallet.ts';

const { getEthereumGatewayPauseReasonMock, getMainchainClientMock } = vi.hoisted(() => ({
  getEthereumGatewayPauseReasonMock: vi.fn(),
  getMainchainClientMock: vi.fn(),
}));

vi.mock('../stores/mainchain.ts', () => ({
  getMainchainClient: getMainchainClientMock,
  getEthereumGatewayPauseReason: getEthereumGatewayPauseReasonMock,
}));

describe('EthereumInboundTransferTracker integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getEthereumGatewayPauseReasonMock.mockResolvedValue(undefined);
  });

  it('persists a confirmed transfer and silently nudges the upstream server until Argon catches up', async () => {
    const db = await createTestDb();
    const walletKeys = createMockWalletKeys();
    let provenNonce = 6n;
    const mainchainClient = createMainchainClient({
      getProvenNonce: () => provenNonce,
    });
    getMainchainClientMock.mockResolvedValue(mainchainClient);

    const upstreamCatchUp = vi.fn(async () => {
      provenNonce = 7n;
      return { outcome: 'Noop' as const, throughGatewayActivityNonce: 7n };
    });
    const tracker = new EthereumInboundTransferTracker(
      Promise.resolve(db),
      createTransactionTracker(),
      walletKeys,
      createEthereumClient({
        sourceAddress: walletKeys.ethereumAddress,
        destinationAddress: walletKeys.investmentAddress,
        sourceTxHash: `0x${'11'.repeat(32)}`,
        sourceBlockNumber: 42,
        sourceBlockHash: `0x${'22'.repeat(32)}`,
        sourceLogIndex: 7,
        gatewayActivityNonce: 7n,
      }),
      undefined,
      {
        operatorHost: 'https://upstream.example',
        requestEthereumGatewayCatchUp: upstreamCatchUp,
      },
    );

    const activeTransfer = await tracker.startMove({
      moveToken: MoveToken.ARGN,
      amountBaseUnits: 5_000_000_000_000n,
      targetWalletType: WalletType.investment,
    });

    await vi.waitFor(() => {
      expect(upstreamCatchUp).toHaveBeenCalledWith({
        sourceChain: 'Ethereum',
        throughGatewayActivityNonce: 7n,
      });
    });

    await vi.waitFor(async () => {
      const persisted = await db.crosschainInboundTransfersTable.get(activeTransfer!.transferId);
      expect(persisted).toMatchObject({
        transferId: activeTransfer!.transferId,
        sourceChain: 'Ethereum',
        argonDestinationAddress: walletKeys.investmentAddress,
        gatewayActivityNonce: 7n,
        status: CrosschainInboundTransferStatus.ArgonFinalized,
      });
    });

    expect(activeTransfer?.transferState.phase).toBe('confirmedOnArgon');
    expect(activeTransfer?.transferState.isSubmitting).toBe(false);
  });

  it('nudges the local server relayer when the operator server is available', async () => {
    const db = await createTestDb();
    const walletKeys = createMockWalletKeys();
    let provenNonce = 6n;
    const requestEthereumGatewayCatchUp = vi.fn(async () => {
      provenNonce = 7n;
      return {
        outcome: 'Submitted' as const,
        estimatedFee: 5n,
        delegateAddress: '5Delegate',
        argonTxHash: '0x1',
        extrinsicMethodJson: { section: 'crosschainTransfer', method: 'proveGatewayActivity' },
        txNonce: 1,
        txSubmittedAtBlockHeight: 10,
        txSubmittedAtTime: new Date('2026-05-19T12:00:00.000Z'),
      };
    });
    const mainchainClient = createMainchainClient({
      getProvenNonce: () => provenNonce,
    });
    getMainchainClientMock.mockResolvedValue(mainchainClient);

    const tracker = new EthereumInboundTransferTracker(
      Promise.resolve(db),
      createTransactionTracker(),
      walletKeys,
      createEthereumClient({
        sourceAddress: walletKeys.ethereumAddress,
        destinationAddress: walletKeys.investmentAddress,
        sourceTxHash: `0x${'33'.repeat(32)}`,
        sourceBlockNumber: 42,
        sourceBlockHash: `0x${'44'.repeat(32)}`,
        sourceLogIndex: 8,
        gatewayActivityNonce: 7n,
      }),
      {
        getEthereumRelayStatus: vi.fn(async () => ({ isReady: true })),
        requestEthereumGatewayCatchUp,
      },
      {
        operatorHost: undefined,
        requestEthereumGatewayCatchUp: vi.fn(),
      },
    );

    const activeTransfer = await tracker.startMove({
      moveToken: MoveToken.ARGN,
      amountBaseUnits: 5_000_000_000_000n,
      targetWalletType: WalletType.investment,
    });

    await vi.waitFor(() => {
      expect(requestEthereumGatewayCatchUp).toHaveBeenCalledWith({
        sourceChain: 'Ethereum',
        throughGatewayActivityNonce: 7n,
      });
    });

    await vi.waitFor(async () => {
      const persisted = await db.crosschainInboundTransfersTable.get(activeTransfer!.transferId);
      expect(persisted?.status).toBe(CrosschainInboundTransferStatus.ArgonFinalized);
    });
  });

  it('falls back upstream when the local server relay is not ready', async () => {
    const db = await createTestDb();
    const walletKeys = createMockWalletKeys();
    let provenNonce = 6n;
    const mainchainClient = createMainchainClient({
      getProvenNonce: () => provenNonce,
    });
    getMainchainClientMock.mockResolvedValue(mainchainClient);

    const upstreamCatchUp = vi.fn(async () => {
      provenNonce = 7n;
      return { outcome: 'Noop' as const, throughGatewayActivityNonce: 7n };
    });
    const tracker = new EthereumInboundTransferTracker(
      Promise.resolve(db),
      createTransactionTracker(),
      walletKeys,
      createEthereumClient({
        sourceAddress: walletKeys.ethereumAddress,
        destinationAddress: walletKeys.investmentAddress,
        sourceTxHash: `0x${'35'.repeat(32)}`,
        sourceBlockNumber: 42,
        sourceBlockHash: `0x${'46'.repeat(32)}`,
        sourceLogIndex: 8,
        gatewayActivityNonce: 7n,
      }),
      {
        getEthereumRelayStatus: vi.fn(async () => ({
          isReady: false,
          reason: 'Vault delegate cannot afford Ethereum gateway relay.',
        })),
        requestEthereumGatewayCatchUp: vi.fn(),
      },
      {
        operatorHost: 'https://upstream.example',
        requestEthereumGatewayCatchUp: upstreamCatchUp,
      },
    );

    const activeTransfer = await tracker.startMove({
      moveToken: MoveToken.ARGN,
      amountBaseUnits: 5_000_000_000_000n,
      targetWalletType: WalletType.investment,
    });

    expect(activeTransfer?.transferState.error).toBe('');
    await vi.waitFor(() => {
      expect(upstreamCatchUp).toHaveBeenCalledWith({
        sourceChain: 'Ethereum',
        throughGatewayActivityNonce: 7n,
      });
    });

    await vi.waitFor(async () => {
      const persisted = await db.crosschainInboundTransfersTable.get(activeTransfer!.transferId);
      expect(persisted?.status).toBe(CrosschainInboundTransferStatus.ArgonFinalized);
    });
  });

  it('surfaces a paused gateway sync immediately and skips the upstream fallback', async () => {
    const db = await createTestDb();
    const walletKeys = createMockWalletKeys();
    let provenNonce = 6n;
    const mainchainClient = createMainchainClient({
      getProvenNonce: () => provenNonce,
    });
    getMainchainClientMock.mockResolvedValue(mainchainClient);
    getEthereumGatewayPauseReasonMock.mockResolvedValue(
      'Ethereum gateway sync is paused at activity 5 (GatewayStateDrift).',
    );

    const upstreamCatchUp = vi.fn(async () => ({ outcome: 'Noop' as const, throughGatewayActivityNonce: 7n }));
    const tracker = new EthereumInboundTransferTracker(
      Promise.resolve(db),
      createTransactionTracker(),
      walletKeys,
      createEthereumClient({
        sourceAddress: walletKeys.ethereumAddress,
        destinationAddress: walletKeys.investmentAddress,
        sourceTxHash: `0x${'36'.repeat(32)}`,
        sourceBlockNumber: 42,
        sourceBlockHash: `0x${'47'.repeat(32)}`,
        sourceLogIndex: 8,
        gatewayActivityNonce: 7n,
        waitEstimateMs: 60_000,
      }),
      {
        getEthereumRelayStatus: vi.fn(async () => ({ isReady: true })),
        requestEthereumGatewayCatchUp: vi.fn(),
      },
      {
        operatorHost: 'https://upstream.example',
        requestEthereumGatewayCatchUp: upstreamCatchUp,
      },
    );

    const activeTransfer = await tracker.startMove({
      moveToken: MoveToken.ARGN,
      amountBaseUnits: 5_000_000_000_000n,
      targetWalletType: WalletType.investment,
    });

    await vi.waitFor(() => {
      expect(activeTransfer?.transferState.error).toBe(
        'Ethereum gateway sync is paused at activity 5 (GatewayStateDrift).',
      );
    });
    expect(upstreamCatchUp).not.toHaveBeenCalled();

    provenNonce = 7n;
    await vi.waitFor(async () => {
      const persisted = await db.crosschainInboundTransfersTable.get(activeTransfer!.transferId);
      expect(persisted?.status).toBe(CrosschainInboundTransferStatus.ArgonFinalized);
    });
  });

  it('finalizes a resumed transfer once another runner has already proven the gateway activity', async () => {
    const db = await createTestDb();
    const walletKeys = createMockWalletKeys();
    const mainchainClient = createMainchainClient({
      getProvenNonce: () => 9n,
    });
    getMainchainClientMock.mockResolvedValue(mainchainClient);

    const persistedRecord = await insertTransferRecord(db, walletKeys.ethereumAddress, {
      transferId: 'eth-transfer-1',
      token: MoveToken.ARGNOT,
      argonDestinationAddress: walletKeys.vaultingAddress,
      sourceTxHash: `0x${'55'.repeat(32)}`,
      sourceBlockNumber: 54,
      sourceBlockHash: `0x${'66'.repeat(32)}`,
      sourceLogIndex: 5,
      gatewayActivityNonce: 9n,
      status: CrosschainInboundTransferStatus.SourceFinalized,
    });

    const tracker = new EthereumInboundTransferTracker(
      Promise.resolve(db),
      createTransactionTracker(),
      walletKeys,
      createEthereumClient({
        sourceAddress: walletKeys.ethereumAddress,
        destinationAddress: persistedRecord.argonDestinationAddress,
        sourceTxHash: persistedRecord.sourceTxHash!,
        sourceBlockNumber: persistedRecord.sourceBlockNumber!,
        sourceBlockHash: persistedRecord.sourceBlockHash!,
        sourceLogIndex: persistedRecord.sourceLogIndex!,
        gatewayActivityNonce: persistedRecord.gatewayActivityNonce!,
      }),
      undefined,
      {
        operatorHost: undefined,
        requestEthereumGatewayCatchUp: vi.fn(),
      },
    );

    await tracker.load();

    await vi.waitFor(async () => {
      const updated = await db.crosschainInboundTransfersTable.get(persistedRecord.transferId);
      expect(updated).toMatchObject({
        status: CrosschainInboundTransferStatus.ArgonFinalized,
        argonBlockNumber: 144,
        argonBlockHash: `0x${'aa'.repeat(32)}`,
      });
    });

    expect(tracker.getTransferStateForToken(MoveToken.ARGNOT)).toEqual({
      isSubmitting: false,
      hasPersistedTransfer: false,
      targetWalletType: WalletType.vaulting,
      phase: 'confirmedOnArgon',
      error: '',
    });
  });
});

function createEthereumClient(args: {
  sourceAddress: string;
  destinationAddress: string;
  sourceTxHash: `0x${string}`;
  sourceBlockNumber: number;
  sourceBlockHash: `0x${string}`;
  sourceLogIndex: number;
  gatewayActivityNonce: bigint;
  pollMs?: number;
  waitEstimateMs?: number;
}): Pick<
  EthereumClient,
  | 'sourceAddress'
  | 'executionRpcUrl'
  | 'startTransferToArgon'
  | 'confirmTransferToArgon'
  | 'getTransferToArgonPollMs'
  | 'getTransferToArgonWaitEstimateMs'
> {
  return {
    sourceAddress: args.sourceAddress,
    executionRpcUrl: 'http://ethereum.test',
    startTransferToArgon: vi.fn(async () => ({
      moveToken: MoveToken.ARGN,
      amountBaseUnits: 5_000_000_000_000n,
      destinationAddress: args.destinationAddress,
      executionRpcUrl: 'http://ethereum.test',
      sourceTxHash: args.sourceTxHash,
    })),
    confirmTransferToArgon: vi.fn(async () => ({
      moveToken: MoveToken.ARGN,
      amountBaseUnits: 5_000_000_000_000n,
      destinationAddress: args.destinationAddress,
      executionRpcUrl: 'http://ethereum.test',
      sourceTxHash: args.sourceTxHash,
      sourceBlockNumber: args.sourceBlockNumber,
      sourceBlockHash: args.sourceBlockHash,
      sourceLogIndex: args.sourceLogIndex,
      gatewayActivityNonce: args.gatewayActivityNonce,
    })),
    getTransferToArgonPollMs: () => args.pollMs ?? 1,
    getTransferToArgonWaitEstimateMs: () => args.waitEstimateMs ?? 1_000,
  };
}

function createMainchainClient(args: {
  getProvenNonce: () => bigint;
  proofTx?: { paymentInfo: ReturnType<typeof vi.fn> };
}) {
  const proofTx =
    args.proofTx ??
    ({
      paymentInfo: vi.fn(async () => ({
        partialFee: {
          toBigInt: () => 1n,
        },
      })),
    } as const);

  const query = {
    crosschainTransfer: {
      chainConfigBySourceChain: vi.fn(async () => ({
        isNone: false,
        unwrap: () => ({
          isEthereum: true,
          asEthereum: {
            gateway: {
              toHex: () => '0xgateway',
            },
          },
        }),
      })),
      gatewayStateBySourceChain: vi.fn(async () => ({
        isNone: false,
        isSome: true,
        unwrap: () => ({
          gatewayActivityNonce: {
            toBigInt: () => args.getProvenNonce(),
          },
        }),
      })),
    },
    ethereumVerifier: {
      latestExecutionHeaderAnchorBlockHash: vi.fn(async () => ({
        isNone: false,
        unwrap: () => ({
          toHex: () => `0x${'bb'.repeat(32)}`,
        }),
      })),
      executionHeaderAnchors: vi.fn(async () => ({
        isNone: false,
        unwrap: () => ({
          blockNumber: {
            toBigInt: () => 999n,
          },
        }),
      })),
    },
    system: {
      account: vi.fn(async () => ({
        data: {
          free: {
            toBigInt: () => 1_000_000n,
          },
        },
      })),
    },
  };

  return {
    tx: {
      crosschainTransfer: {
        proveGatewayActivity: vi.fn(() => proofTx),
      },
    },
    query,
    at: vi.fn(async () => ({
      query: {
        crosschainTransfer: query.crosschainTransfer,
      },
    })),
    rpc: {
      chain: {
        getFinalizedHead: vi.fn(async () => ({
          toHex: () => `0x${'aa'.repeat(32)}`,
        })),
        getHeader: vi.fn(async () => ({
          number: {
            toNumber: () => 144,
          },
        })),
      },
    },
  };
}

function createTransactionTracker(
  overrides: Partial<{
    load: () => Promise<void>;
    submitAndWatch: (args: unknown) => Promise<unknown>;
  }> = {},
): TransactionTracker {
  return {
    load: overrides.load ?? vi.fn(async () => undefined),
    submitAndWatch:
      overrides.submitAndWatch ??
      vi.fn(async () => {
        throw new Error('submitAndWatch should not be called in this test');
      }),
  } as unknown as TransactionTracker;
}

async function insertTransferRecord(
  db: Awaited<ReturnType<typeof createTestDb>>,
  sourceAddress: string,
  args: {
    transferId: string;
    token: MoveToken.ARGN | MoveToken.ARGNOT;
    argonDestinationAddress: string;
    sourceTxHash: `0x${string}`;
    sourceBlockNumber: number;
    sourceBlockHash: `0x${string}`;
    sourceLogIndex: number;
    gatewayActivityNonce: bigint;
    status: CrosschainInboundTransferStatus;
  },
): Promise<ICrosschainInboundTransferRecord> {
  return (await db.crosschainInboundTransfersTable.upsert({
    transferId: args.transferId,
    sourceChain: 'Ethereum',
    token: args.token,
    amountBaseUnits: 5_000_000_000_000n,
    sourceAddress,
    argonDestinationAddress: args.argonDestinationAddress,
    sourceTxHash: args.sourceTxHash,
    sourceBlockNumber: args.sourceBlockNumber,
    sourceBlockHash: args.sourceBlockHash,
    sourceLogIndex: args.sourceLogIndex,
    gatewayActivityNonce: args.gatewayActivityNonce,
    status: args.status,
  }))!;
}
