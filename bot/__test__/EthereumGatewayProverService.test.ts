import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NetworkConfig } from '@argonprotocol/apps-core';

type IMockSignedTx = {
  method: { toHuman(): unknown };
  nonce: { toNumber(): number };
};
type IMockTxResult = {
  extrinsic: {
    signedHash?: string;
    submittedAtBlockNumber?: number;
    submittedTime?: Date;
    method?: unknown;
    nonce?: number;
  };
  waitForInFirstBlock?: Promise<unknown>;
  blockNumber?: number;
};
type IMockWatchedSubmission = {
  result: IMockTxResult;
  signedTx?: IMockSignedTx;
};
type IMockSubmission = IMockTxResult | IMockWatchedSubmission | null | undefined;

const submissionMock = vi.hoisted(() => {
  const submitWithTerminalStatusWatch =
    vi.fn<(submitter: { tx: unknown }, options?: { nonce?: number }) => Promise<IMockSubmission>>();

  return {
    submitWithTerminalStatusWatch,
  };
});

const gatewayProofMock = vi.hoisted(() => {
  return {
    buildGatewayActivityProofPayload: vi.fn(),
    getLatestArgonFinalizedExecutionHeader: vi.fn(async () => ({ blockNumber: 160n })),
  };
});

const viemMock = vi.hoisted(() => {
  return {
    createPublicClient: vi.fn(),
    readContract: vi.fn(),
  };
});

const mainchainMock = vi.hoisted(() => {
  class TxSubmitter {
    public readonly address: string;

    constructor(
      public readonly client: unknown,
      public readonly tx: unknown,
      public readonly account: { address: string },
    ) {
      this.address = account.address;
    }

    public async submit(options?: { nonce?: number }) {
      const submission = await submissionMock.submitWithTerminalStatusWatch(this, options);
      if (!submission || !('result' in submission)) {
        return submission;
      }

      const { result, signedTx } = submission;
      if (signedTx) {
        result.extrinsic.method ??= signedTx.method.toHuman();
        result.extrinsic.nonce ??= signedTx.nonce.toNumber();
      }

      return result;
    }
  }

  return {
    buildGatewayActivityProofPayload: gatewayProofMock.buildGatewayActivityProofPayload,
    getLatestArgonFinalizedExecutionHeader: gatewayProofMock.getLatestArgonFinalizedExecutionHeader,
    TxSubmitter,
  };
});

vi.mock('viem', async () => {
  const actual = await vi.importActual<typeof import('viem')>('viem');
  return {
    ...actual,
    createPublicClient: viemMock.createPublicClient,
  };
});

vi.mock('@argonprotocol/mainchain', async () => {
  const actual = await vi.importActual<typeof import('@argonprotocol/mainchain')>('@argonprotocol/mainchain');
  return {
    ...actual,
    buildGatewayActivityProofPayload: mainchainMock.buildGatewayActivityProofPayload,
    getLatestArgonFinalizedExecutionHeader: mainchainMock.getLatestArgonFinalizedExecutionHeader,
    TxSubmitter: mainchainMock.TxSubmitter,
  };
});

import { TxSubmissionError, TxSubmissionErrorCode } from '@argonprotocol/mainchain';
import { DelegateSubmitLane } from '../src/DelegateSubmitLane.ts';
import { EthereumGatewayProverService } from '../src/EthereumGatewayProverService.ts';

const relayKeypair = { address: '5RelayDelegate' } as any;
let currentClientArgs:
  | {
      latestLocatorIndex?: bigint;
      latestLocatorEndGatewayActivityNonce?: bigint;
    }
  | undefined;

describe('EthereumGatewayProverService', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    viemMock.createPublicClient.mockReturnValue({
      readContract: viemMock.readContract,
    });
    NetworkConfig.setNetwork('dev-docker');
    NetworkConfig.setRuntimeOverride('dev-docker', {
      ethereumNetwork: {
        executionRpcUrl: 'http://ethereum.test',
      },
    });
  });

  it('returns Noop when the mainchain helper reports nothing new to prove', async () => {
    gatewayProofMock.buildGatewayActivityProofPayload.mockResolvedValue(null);
    const service = new EthereumGatewayProverService(
      createSubmitLane(createClient({ runtimeGatewayActivityNonce: 5n })),
    );

    await expect(
      service.runToCheckpoint({
        sourceChain: 'Ethereum',
        throughGatewayActivityNonce: 6n,
      }),
    ).resolves.toEqual({
      outcome: 'Noop',
      throughGatewayActivityNonce: 5n,
    });
    expect(gatewayProofMock.buildGatewayActivityProofPayload).toHaveBeenCalledWith(expect.anything(), {
      executionRpcUrl: 'http://ethereum.test',
      gatewayAddress: '0xgateway',
      throughExecutionBlockNumber: 160n,
    });
  });

  it('skips heavy gateway proof discovery when the runtime already covers the latest locator nonce', async () => {
    const client = createClient({
      runtimeGatewayActivityNonce: 7n,
      latestLocatorIndex: 3n,
      latestLocatorEndGatewayActivityNonce: 7n,
    });
    const service = new EthereumGatewayProverService(createSubmitLane(client), {
      backgroundSweepMs: 1_000,
    });
    const runBackgroundSweep = (
      service as unknown as {
        runBackgroundSweep: () => Promise<void>;
      }
    ).runBackgroundSweep.bind(service);

    await runBackgroundSweep();

    expect(gatewayProofMock.getLatestArgonFinalizedExecutionHeader).not.toHaveBeenCalled();
    expect(gatewayProofMock.buildGatewayActivityProofPayload).not.toHaveBeenCalled();
  });

  it('submits proveGatewayActivity through the delegate lane until a checkpoint is fully caught up', async () => {
    const signedTx = {
      method: { toHuman: () => ({ section: 'crosschainTransfer', method: 'proveGatewayActivity' }) },
      nonce: { toNumber: () => 9 },
    };
    const tx = {
      paymentInfo: vi.fn(async () => ({
        partialFee: {
          toBigInt: () => 11n,
        },
      })),
    };
    const client = createClient({ tx, accountNextNonce: 9 });
    const service = new EthereumGatewayProverService(createSubmitLane(client), {
      shouldApplySharedRelayStagger: true,
    });

    gatewayProofMock.buildGatewayActivityProofPayload
      .mockResolvedValueOnce({
        previousGatewayActivityNonce: 6n,
        proof: { batch: 'proof-1' },
        gatewayActivityNonceRange: { start: 7n, end: 7n },
        executionBlockNumberRange: { start: 160n, end: 160n },
        activities: [{ gatewayState: { gatewayActivityNonce: 7n } }],
      })
      .mockResolvedValueOnce({
        previousGatewayActivityNonce: 7n,
        proof: { batch: 'proof-2' },
        gatewayActivityNonceRange: { start: 8n, end: 9n },
        executionBlockNumberRange: { start: 160n, end: 160n },
        activities: [{ gatewayState: { gatewayActivityNonce: 9n } }],
      });
    submissionMock.submitWithTerminalStatusWatch.mockResolvedValue({
      signedTx,
      result: {
        extrinsic: {
          signedHash: '0xrelaytx',
          submittedAtBlockNumber: 321,
          submittedTime: new Date('2026-05-13T16:00:00.000Z'),
        },
        blockNumber: 321,
        waitForInFirstBlock: Promise.resolve(new Uint8Array([1])),
      },
    });

    await expect(
      service.runToCheckpoint({ sourceChain: 'Ethereum', throughGatewayActivityNonce: 9n }),
    ).resolves.toEqual({
      outcome: 'Submitted',
      delegateAddress: '5RelayDelegate',
      argonTxHash: '0xrelaytx',
      extrinsicMethodJson: { section: 'crosschainTransfer', method: 'proveGatewayActivity' },
      txNonce: 9,
      txSubmittedAtBlockHeight: 321,
      txSubmittedAtTime: new Date('2026-05-13T16:00:00.000Z'),
      estimatedFee: 11n,
      throughGatewayActivityNonce: 9n,
    });
    expect(submissionMock.submitWithTerminalStatusWatch).toHaveBeenCalledTimes(2);
  });

  it('retries with a refreshed nonce when the node drops the delegate submission', async () => {
    const client = createClient();
    const service = new EthereumGatewayProverService(createSubmitLane(client), {
      shouldApplySharedRelayStagger: true,
    });
    const accountNextIndex = client.rpc.system.accountNextIndex as ReturnType<typeof vi.fn>;
    accountNextIndex.mockResolvedValueOnce({ toNumber: () => 4 }).mockResolvedValueOnce({ toNumber: () => 5 });

    gatewayProofMock.buildGatewayActivityProofPayload
      .mockResolvedValueOnce({
        previousGatewayActivityNonce: 6n,
        proof: { batch: 'proof' },
        gatewayActivityNonceRange: { start: 7n, end: 7n },
        executionBlockNumberRange: { start: 160n, end: 160n },
        activities: [{ gatewayState: { gatewayActivityNonce: 7n } }],
      })
      .mockResolvedValueOnce({
        previousGatewayActivityNonce: 6n,
        proof: { batch: 'proof' },
        gatewayActivityNonceRange: { start: 7n, end: 7n },
        executionBlockNumberRange: { start: 160n, end: 160n },
        activities: [{ gatewayState: { gatewayActivityNonce: 7n } }],
      });
    submissionMock.submitWithTerminalStatusWatch.mockImplementationOnce(
      async (_submitter, options?: { nonce?: number }) => {
        const droppedSubmission = Promise.reject(
          new TxSubmissionError(
            TxSubmissionErrorCode.Dropped,
            'Transaction was dropped before it was included in a block.',
          ),
        );
        droppedSubmission.catch(() => undefined);

        return {
          signedTx: {
            method: { toHuman: () => ({ section: 'crosschainTransfer', method: 'proveGatewayActivity' }) },
            nonce: { toNumber: () => options?.nonce ?? 0 },
          },
          result: {
            extrinsic: {
              signedHash: '0xstale',
              submittedAtBlockNumber: 321,
              submittedTime: new Date('2026-05-13T16:00:00.000Z'),
            },
            waitForInFirstBlock: droppedSubmission,
          },
        };
      },
    );
    submissionMock.submitWithTerminalStatusWatch.mockImplementationOnce(
      async (_submitter, options?: { nonce?: number }) => ({
        signedTx: {
          method: { toHuman: () => ({ section: 'crosschainTransfer', method: 'proveGatewayActivity' }) },
          nonce: { toNumber: () => options?.nonce ?? 0 },
        },
        result: {
          extrinsic: {
            signedHash: '0xrelaytx',
            submittedAtBlockNumber: 322,
            submittedTime: new Date('2026-05-13T16:00:01.000Z'),
          },
          blockNumber: 322,
          waitForInFirstBlock: Promise.resolve(new Uint8Array([1])),
        },
      }),
    );

    await expect(
      service.runToCheckpoint({ sourceChain: 'Ethereum', throughGatewayActivityNonce: 7n }),
    ).resolves.toEqual({
      outcome: 'Submitted',
      delegateAddress: '5RelayDelegate',
      argonTxHash: '0xrelaytx',
      extrinsicMethodJson: { section: 'crosschainTransfer', method: 'proveGatewayActivity' },
      txNonce: 5,
      txSubmittedAtBlockHeight: 322,
      txSubmittedAtTime: new Date('2026-05-13T16:00:01.000Z'),
      estimatedFee: 7n,
      throughGatewayActivityNonce: 7n,
    });
    expect(submissionMock.submitWithTerminalStatusWatch).toHaveBeenCalledTimes(2);
  });

  it('releases a timed-out first-block wait so a later catch-up can run', async () => {
    vi.useFakeTimers();

    const client = createClient();
    const service = new EthereumGatewayProverService(createSubmitLane(client), {
      shouldApplySharedRelayStagger: true,
    });
    gatewayProofMock.buildGatewayActivityProofPayload.mockResolvedValue({
      previousGatewayActivityNonce: 6n,
      proof: { batch: 'proof' },
      gatewayActivityNonceRange: { start: 7n, end: 7n },
      executionBlockNumberRange: { start: 160n, end: 160n },
      activities: [{ gatewayState: { gatewayActivityNonce: 7n } }],
    });
    submissionMock.submitWithTerminalStatusWatch
      .mockImplementationOnce(async (_submitter, options?: { nonce?: number }) => ({
        signedTx: {
          method: { toHuman: () => ({ section: 'crosschainTransfer', method: 'proveGatewayActivity' }) },
          nonce: { toNumber: () => options?.nonce ?? 0 },
        },
        result: {
          extrinsic: {
            signedHash: '0xtimeout',
            submittedAtBlockNumber: 321,
            submittedTime: new Date('2026-05-13T16:00:00.000Z'),
          },
          blockNumber: 321,
          waitForInFirstBlock: new Promise(() => undefined),
        },
      }))
      .mockImplementationOnce(async (_submitter, options?: { nonce?: number }) => ({
        signedTx: {
          method: { toHuman: () => ({ section: 'crosschainTransfer', method: 'proveGatewayActivity' }) },
          nonce: { toNumber: () => options?.nonce ?? 0 },
        },
        result: {
          extrinsic: {
            signedHash: '0xretry',
            submittedAtBlockNumber: 322,
            submittedTime: new Date('2026-05-13T16:01:00.000Z'),
          },
          blockNumber: 322,
          waitForInFirstBlock: Promise.resolve(new Uint8Array([1])),
        },
      }));

    const firstCatchUp = service.runToCheckpoint({
      sourceChain: 'Ethereum',
      throughGatewayActivityNonce: 7n,
    });
    await vi.advanceTimersByTimeAsync(60_000);

    await expect(firstCatchUp).resolves.toEqual({
      outcome: 'Submitted',
      delegateAddress: '5RelayDelegate',
      argonTxHash: '0xtimeout',
      extrinsicMethodJson: { section: 'crosschainTransfer', method: 'proveGatewayActivity' },
      txNonce: 4,
      txSubmittedAtBlockHeight: 321,
      txSubmittedAtTime: new Date('2026-05-13T16:00:00.000Z'),
      estimatedFee: 7n,
      throughGatewayActivityNonce: 7n,
    });
    await expect(
      service.runToCheckpoint({ sourceChain: 'Ethereum', throughGatewayActivityNonce: 7n }),
    ).resolves.toEqual({
      outcome: 'Submitted',
      delegateAddress: '5RelayDelegate',
      argonTxHash: '0xretry',
      extrinsicMethodJson: { section: 'crosschainTransfer', method: 'proveGatewayActivity' },
      txNonce: 5,
      txSubmittedAtBlockHeight: 322,
      txSubmittedAtTime: new Date('2026-05-13T16:01:00.000Z'),
      estimatedFee: 7n,
      throughGatewayActivityNonce: 7n,
    });
    expect(submissionMock.submitWithTerminalStatusWatch).toHaveBeenCalledTimes(2);
  });

  it('rejects when the delegate cannot afford the relay reserve', async () => {
    const client = createClient({
      balance: 12n,
      existentialDeposit: 10n,
      tx: {
        paymentInfo: vi.fn(async () => ({
          partialFee: {
            toBigInt: () => 5n,
          },
        })),
      },
    });
    const service = new EthereumGatewayProverService(createSubmitLane(client), {
      shouldApplySharedRelayStagger: true,
    });

    gatewayProofMock.buildGatewayActivityProofPayload.mockResolvedValue({
      previousGatewayActivityNonce: 6n,
      proof: { batch: 'proof' },
      gatewayActivityNonceRange: { start: 7n, end: 7n },
      executionBlockNumberRange: { start: 160n, end: 160n },
      activities: [{ gatewayState: { gatewayActivityNonce: 7n } }],
    });

    await expect(
      service.runToCheckpoint({ sourceChain: 'Ethereum', throughGatewayActivityNonce: 7n }),
    ).resolves.toEqual({
      outcome: 'Rejected',
      reason: 'Vault delegate cannot afford Ethereum gateway relay. Balance=12 required=15.',
      reasonCode: 'delegateInsufficientFunds',
      estimatedFee: 5n,
      throughGatewayActivityNonce: 7n,
    });
    expect(submissionMock.submitWithTerminalStatusWatch).not.toHaveBeenCalled();
  });

  it('reports relay readiness without submitting work', async () => {
    const service = new EthereumGatewayProverService(createSubmitLane(createClient({ balance: 1_000_000n })));

    await expect(service.getRelayStatus()).resolves.toEqual({
      isReady: true,
    });
  });

  it('reports not ready until the verifier retains a finalized execution header anchor', async () => {
    const service = new EthereumGatewayProverService(
      createSubmitLane(createClient({ hasLatestExecutionHeaderAnchor: false })),
    );

    await expect(service.getRelayStatus()).resolves.toEqual({
      isReady: false,
      reason: 'Ethereum verifier has not retained a finalized execution header yet.',
      reasonCode: 'missingExecutionAnchor',
    });
  });

  it('stays idle when the Ethereum transfer gateway is not configured on this network', async () => {
    const service = new EthereumGatewayProverService(createSubmitLane(createClient({ hasEthereumChainConfig: false })));

    await expect(service.getRelayStatus()).resolves.toEqual({
      isReady: false,
      reason: 'Ethereum transfer gateway is not configured on this network.',
    });

    await service.start();
    expect(submissionMock.submitWithTerminalStatusWatch).not.toHaveBeenCalled();

    await service.shutdown();
  });

  it('reports when gateway sync is paused and stops catch-up there', async () => {
    const service = new EthereumGatewayProverService(
      createSubmitLane(
        createClient({
          gatewaySyncPause: {
            failedGatewayActivityNonce: 5n,
            lastGoodGatewayActivityNonce: 4n,
            reason: 'MintingAuthorityNotFound',
          },
        }),
      ),
    );

    await expect(service.getRelayStatus()).resolves.toEqual({
      isReady: false,
      reason: 'Ethereum gateway sync is paused at activity 5 (MintingAuthorityNotFound).',
      reasonCode: 'gatewayPaused',
    });
    await expect(
      service.runToCheckpoint({ sourceChain: 'Ethereum', throughGatewayActivityNonce: 5n }),
    ).resolves.toEqual({
      outcome: 'Rejected',
      reason: 'Ethereum gateway sync is paused at activity 5 (MintingAuthorityNotFound).',
      reasonCode: 'gatewayPaused',
      throughGatewayActivityNonce: 4n,
    });
  });

  it('skips proof building when the runtime nonce already covers the requested checkpoint', async () => {
    const service = new EthereumGatewayProverService(
      createSubmitLane(createClient({ runtimeGatewayActivityNonce: 7n })),
    );

    await expect(
      service.runToCheckpoint({ sourceChain: 'Ethereum', throughGatewayActivityNonce: 7n }),
    ).resolves.toEqual({
      outcome: 'Noop',
      throughGatewayActivityNonce: 7n,
    });
    expect(gatewayProofMock.buildGatewayActivityProofPayload).not.toHaveBeenCalled();
  });

  it('coalesces concurrent catch-up requests into one submission', async () => {
    const signedTx = {
      method: { toHuman: () => ({ section: 'crosschainTransfer', method: 'proveGatewayActivity' }) },
      nonce: { toNumber: () => 4 },
    };
    const client = createClient();
    const service = new EthereumGatewayProverService(createSubmitLane(client));
    let releaseBuildProofPlan!: (value: unknown) => void;
    const buildProofPlan = new Promise(resolve => {
      releaseBuildProofPlan = resolve;
    });

    gatewayProofMock.buildGatewayActivityProofPayload.mockReturnValueOnce(buildProofPlan);
    submissionMock.submitWithTerminalStatusWatch.mockResolvedValue({
      signedTx,
      result: {
        extrinsic: {
          signedHash: '0xrelaytx',
          submittedAtBlockNumber: 321,
          submittedTime: new Date('2026-05-13T16:00:00.000Z'),
        },
        blockNumber: 321,
        waitForInFirstBlock: Promise.resolve(new Uint8Array([1])),
      },
    });

    const first = service.runToCheckpoint({ sourceChain: 'Ethereum', throughGatewayActivityNonce: 7n });
    const second = service.runToCheckpoint({ sourceChain: 'Ethereum', throughGatewayActivityNonce: 7n });

    releaseBuildProofPlan({
      previousGatewayActivityNonce: 6n,
      proof: { batch: 'proof' },
      gatewayActivityNonceRange: { start: 7n, end: 7n },
      executionBlockNumberRange: { start: 160n, end: 160n },
      activities: [{ gatewayState: { gatewayActivityNonce: 7n } }],
    });

    await expect(Promise.all([first, second])).resolves.toEqual([
      {
        outcome: 'Submitted',
        delegateAddress: '5RelayDelegate',
        argonTxHash: '0xrelaytx',
        extrinsicMethodJson: { section: 'crosschainTransfer', method: 'proveGatewayActivity' },
        txNonce: 4,
        txSubmittedAtBlockHeight: 321,
        txSubmittedAtTime: new Date('2026-05-13T16:00:00.000Z'),
        estimatedFee: 7n,
        throughGatewayActivityNonce: 7n,
      },
      {
        outcome: 'Submitted',
        delegateAddress: '5RelayDelegate',
        argonTxHash: '0xrelaytx',
        extrinsicMethodJson: { section: 'crosschainTransfer', method: 'proveGatewayActivity' },
        txNonce: 4,
        txSubmittedAtBlockHeight: 321,
        txSubmittedAtTime: new Date('2026-05-13T16:00:00.000Z'),
        estimatedFee: 7n,
        throughGatewayActivityNonce: 7n,
      },
    ]);
    expect(gatewayProofMock.buildGatewayActivityProofPayload).toHaveBeenCalledTimes(1);
    expect(submissionMock.submitWithTerminalStatusWatch).toHaveBeenCalledTimes(1);
  });

  it('does not bypass staggered relay scheduling on startup', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-13T16:00:00.000Z'));

    const signedTx = {
      method: { toHuman: () => ({ section: 'crosschainTransfer', method: 'proveGatewayActivity' }) },
      nonce: { toNumber: () => 5 },
    };
    const client = createClient({ runtimeGatewayActivityNonce: 6n, accountNextNonce: 5, freeHeadersInterval: 2n });
    const service = new EthereumGatewayProverService(createSubmitLane(client));

    gatewayProofMock.buildGatewayActivityProofPayload.mockResolvedValue({
      previousGatewayActivityNonce: 6n,
      proof: { batch: 'proof' },
      gatewayActivityNonceRange: { start: 7n, end: 7n },
      executionBlockNumberRange: { start: 160n, end: 160n },
      activities: [{ gatewayState: { gatewayActivityNonce: 7n } }],
    });
    submissionMock.submitWithTerminalStatusWatch.mockResolvedValue({
      signedTx,
      result: {
        extrinsic: {
          signedHash: '0xrelaytx',
          submittedAtBlockNumber: 321,
          submittedTime: new Date('2026-05-13T16:00:00.000Z'),
        },
        blockNumber: 321,
        waitForInFirstBlock: Promise.resolve(new Uint8Array([1])),
      },
    });

    await service.start();

    expect(submissionMock.submitWithTerminalStatusWatch).not.toHaveBeenCalled();

    await service.shutdown();
  });

  it('bypasses staggered relay scheduling when disabled', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-13T16:00:00.000Z'));

    const signedTx = {
      method: { toHuman: () => ({ section: 'crosschainTransfer', method: 'proveGatewayActivity' }) },
      nonce: { toNumber: () => 5 },
    };
    const client = createClient({ runtimeGatewayActivityNonce: 6n, accountNextNonce: 5, freeHeadersInterval: 2n });
    const service = new EthereumGatewayProverService(createSubmitLane(client), {
      shouldApplySharedRelayStagger: false,
    });

    gatewayProofMock.buildGatewayActivityProofPayload.mockResolvedValue({
      previousGatewayActivityNonce: 6n,
      proof: { batch: 'proof' },
      gatewayActivityNonceRange: { start: 7n, end: 7n },
      executionBlockNumberRange: { start: 160n, end: 160n },
      activities: [{ gatewayState: { gatewayActivityNonce: 7n } }],
    });
    submissionMock.submitWithTerminalStatusWatch.mockResolvedValue({
      signedTx,
      result: {
        extrinsic: {
          signedHash: '0xrelaytx',
          submittedAtBlockNumber: 321,
          submittedTime: new Date('2026-05-13T16:00:00.000Z'),
        },
        blockNumber: 321,
        waitForInFirstBlock: Promise.resolve(new Uint8Array([1])),
      },
    });

    await service.start();

    expect(submissionMock.submitWithTerminalStatusWatch).toHaveBeenCalledTimes(1);

    await service.shutdown();
  });

  it('rechecks shared relay work inside the stagger window after startup', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-13T16:00:00.000Z'));

    const signedTx = {
      method: { toHuman: () => ({ section: 'crosschainTransfer', method: 'proveGatewayActivity' }) },
      nonce: { toNumber: () => 5 },
    };
    const client = createClient({ runtimeGatewayActivityNonce: 6n, accountNextNonce: 5, freeHeadersInterval: 2n });
    const service = new EthereumGatewayProverService(createSubmitLane(client));

    gatewayProofMock.buildGatewayActivityProofPayload.mockResolvedValue({
      previousGatewayActivityNonce: 6n,
      proof: { batch: 'proof' },
      gatewayActivityNonceRange: { start: 7n, end: 7n },
      executionBlockNumberRange: { start: 160n, end: 160n },
      activities: [{ gatewayState: { gatewayActivityNonce: 7n } }],
    });
    submissionMock.submitWithTerminalStatusWatch.mockResolvedValue({
      signedTx,
      result: {
        extrinsic: {
          signedHash: '0xrelaytx',
          submittedAtBlockNumber: 321,
          submittedTime: new Date('2026-05-13T16:00:00.000Z'),
        },
        blockNumber: 321,
        waitForInFirstBlock: Promise.resolve(new Uint8Array([1])),
      },
    });

    await service.start();
    expect(submissionMock.submitWithTerminalStatusWatch).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(72_000);

    expect(submissionMock.submitWithTerminalStatusWatch).toHaveBeenCalledTimes(1);

    await service.shutdown();
  });

  it('waits for a stagger window before submitting shared relay work', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-13T16:00:00.000Z'));

    const signedTx = {
      method: { toHuman: () => ({ section: 'crosschainTransfer', method: 'proveGatewayActivity' }) },
      nonce: { toNumber: () => 5 },
    };
    const client = createClient({ runtimeGatewayActivityNonce: 6n, accountNextNonce: 5, freeHeadersInterval: 2n });
    const service = new EthereumGatewayProverService(createSubmitLane(client), {
      backgroundSweepMs: 1_000,
      shouldApplySharedRelayStagger: true,
    });
    const runBackgroundSweep = (
      service as unknown as {
        runBackgroundSweep: () => Promise<void>;
      }
    ).runBackgroundSweep.bind(service);

    gatewayProofMock.buildGatewayActivityProofPayload.mockResolvedValue({
      previousGatewayActivityNonce: 6n,
      proof: { batch: 'proof' },
      gatewayActivityNonceRange: { start: 7n, end: 7n },
      executionBlockNumberRange: { start: 160n, end: 160n },
      activities: [
        {
          kind: 'TransferOutOfArgonFinalized',
          gatewayState: { gatewayActivityNonce: 7n },
        },
      ],
    });
    submissionMock.submitWithTerminalStatusWatch.mockResolvedValue({
      signedTx,
      result: {
        extrinsic: {
          signedHash: '0xrelaytx',
          submittedAtBlockNumber: 321,
          submittedTime: new Date('2026-05-13T16:00:00.000Z'),
        },
        blockNumber: 321,
        waitForInFirstBlock: Promise.resolve(new Uint8Array([1])),
      },
    });

    await runBackgroundSweep();
    expect(gatewayProofMock.buildGatewayActivityProofPayload).toHaveBeenCalledTimes(1);
    expect(submissionMock.submitWithTerminalStatusWatch).not.toHaveBeenCalled();

    vi.setSystemTime(new Date('2026-05-13T16:00:23.000Z'));
    await runBackgroundSweep();
    expect(gatewayProofMock.buildGatewayActivityProofPayload).toHaveBeenCalledTimes(2);
    expect(submissionMock.submitWithTerminalStatusWatch).not.toHaveBeenCalled();

    vi.setSystemTime(new Date('2026-05-13T16:01:11.000Z'));
    await runBackgroundSweep();
    expect(gatewayProofMock.buildGatewayActivityProofPayload).toHaveBeenCalledTimes(3);
    expect(submissionMock.submitWithTerminalStatusWatch).toHaveBeenCalledTimes(1);
  });

  it('submits older shared relay backlog without waiting for a stagger window', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-13T16:00:00.000Z'));

    const signedTx = {
      method: { toHuman: () => ({ section: 'crosschainTransfer', method: 'proveGatewayActivity' }) },
      nonce: { toNumber: () => 5 },
    };
    const client = createClient({ runtimeGatewayActivityNonce: 6n, accountNextNonce: 5, freeHeadersInterval: 2n });
    const service = new EthereumGatewayProverService(createSubmitLane(client), {
      backgroundSweepMs: 1_000,
    });
    const runBackgroundSweep = (
      service as unknown as {
        runBackgroundSweep: () => Promise<void>;
      }
    ).runBackgroundSweep.bind(service);

    gatewayProofMock.buildGatewayActivityProofPayload.mockResolvedValue({
      previousGatewayActivityNonce: 6n,
      proof: { batch: 'proof' },
      gatewayActivityNonceRange: { start: 7n, end: 7n },
      executionBlockNumberRange: { start: 150n, end: 150n },
      activities: [
        {
          kind: 'TransferOutOfArgonFinalized',
          gatewayState: { gatewayActivityNonce: 7n },
        },
      ],
    });
    submissionMock.submitWithTerminalStatusWatch.mockResolvedValue({
      signedTx,
      result: {
        extrinsic: {
          signedHash: '0xrelaytx',
          submittedAtBlockNumber: 321,
          submittedTime: new Date('2026-05-13T16:00:00.000Z'),
        },
        blockNumber: 321,
        waitForInFirstBlock: Promise.resolve(new Uint8Array([1])),
      },
    });

    await runBackgroundSweep();

    expect(gatewayProofMock.buildGatewayActivityProofPayload).toHaveBeenCalledTimes(1);
    expect(submissionMock.submitWithTerminalStatusWatch).toHaveBeenCalledTimes(1);
  });

  it('rechecks older shared relay backlog on the next Argon tick after submitting', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-13T16:00:00.000Z'));
    NetworkConfig.setNetwork('mainnet');
    NetworkConfig.setRuntimeOverride('mainnet', {
      ethereumNetwork: {
        executionRpcUrl: 'http://ethereum.test',
      },
    });

    const signedTx = {
      method: { toHuman: () => ({ section: 'crosschainTransfer', method: 'proveGatewayActivity' }) },
      nonce: { toNumber: () => 5 },
    };
    const client = createClient({ runtimeGatewayActivityNonce: 6n, accountNextNonce: 5, freeHeadersInterval: 2n });
    const service = new EthereumGatewayProverService(createSubmitLane(client));

    gatewayProofMock.buildGatewayActivityProofPayload.mockResolvedValue({
      previousGatewayActivityNonce: 6n,
      proof: { batch: 'proof' },
      gatewayActivityNonceRange: { start: 7n, end: 7n },
      executionBlockNumberRange: { start: 150n, end: 150n },
      activities: [
        {
          kind: 'TransferOutOfArgonFinalized',
          gatewayState: { gatewayActivityNonce: 7n },
        },
      ],
    });
    submissionMock.submitWithTerminalStatusWatch.mockResolvedValue({
      signedTx,
      result: {
        extrinsic: {
          signedHash: '0xrelaytx',
          submittedAtBlockNumber: 321,
          submittedTime: new Date('2026-05-13T16:00:00.000Z'),
        },
        blockNumber: 321,
        waitForInFirstBlock: Promise.resolve(new Uint8Array([1])),
      },
    });

    await service.start();

    expect(submissionMock.submitWithTerminalStatusWatch).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(59_000);
    expect(submissionMock.submitWithTerminalStatusWatch).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(submissionMock.submitWithTerminalStatusWatch).toHaveBeenCalledTimes(2);

    await service.shutdown();
  });

  it('rechecks older shared relay backlog on the next Argon tick after a noop relay result', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-13T16:00:00.000Z'));
    NetworkConfig.setNetwork('mainnet');
    NetworkConfig.setRuntimeOverride('mainnet', {
      ethereumNetwork: {
        executionRpcUrl: 'http://ethereum.test',
      },
    });

    const signedTx = {
      method: { toHuman: () => ({ section: 'crosschainTransfer', method: 'proveGatewayActivity' }) },
      nonce: { toNumber: () => 5 },
    };
    const client = createClient({ runtimeGatewayActivityNonce: 6n, accountNextNonce: 5, freeHeadersInterval: 2n });
    const service = new EthereumGatewayProverService(createSubmitLane(client));

    gatewayProofMock.buildGatewayActivityProofPayload.mockResolvedValue({
      previousGatewayActivityNonce: 6n,
      proof: { batch: 'proof' },
      gatewayActivityNonceRange: { start: 7n, end: 7n },
      executionBlockNumberRange: { start: 150n, end: 150n },
      activities: [
        {
          kind: 'TransferOutOfArgonFinalized',
          gatewayState: { gatewayActivityNonce: 7n },
        },
      ],
    });
    submissionMock.submitWithTerminalStatusWatch
      .mockRejectedValueOnce(new Error('Already imported'))
      .mockResolvedValueOnce({
        signedTx,
        result: {
          extrinsic: {
            signedHash: '0xrelaytx',
            submittedAtBlockNumber: 321,
            submittedTime: new Date('2026-05-13T16:01:00.000Z'),
          },
          blockNumber: 321,
          waitForInFirstBlock: Promise.resolve(new Uint8Array([1])),
        },
      });

    await service.start();

    expect(submissionMock.submitWithTerminalStatusWatch).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(59_000);
    expect(submissionMock.submitWithTerminalStatusWatch).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(submissionMock.submitWithTerminalStatusWatch).toHaveBeenCalledTimes(2);

    await service.shutdown();
  });

  it('prioritizes owned outbound relay work without waiting for a stagger window', async () => {
    const signedTx = {
      method: { toHuman: () => ({ section: 'crosschainTransfer', method: 'proveGatewayActivity' }) },
      nonce: { toNumber: () => 5 },
    };
    const client = createClient({
      runtimeGatewayActivityNonce: 6n,
      accountNextNonce: 5,
      freeHeadersInterval: 2n,
      mintingAuthorityOwnersBySigner: {
        '0x00000000000000000000000000000000000000aa': '5VaultOperator',
      },
    });
    const service = new EthereumGatewayProverService(createSubmitLane(client), {
      backgroundSweepMs: 1_000,
      vaultOperatorAddress: '5VaultOperator',
    });
    const runBackgroundSweep = (
      service as unknown as {
        runBackgroundSweep: () => Promise<void>;
      }
    ).runBackgroundSweep.bind(service);

    gatewayProofMock.buildGatewayActivityProofPayload.mockResolvedValue({
      previousGatewayActivityNonce: 6n,
      proof: { batch: 'proof' },
      gatewayActivityNonceRange: { start: 7n, end: 7n },
      executionBlockNumberRange: { start: 160n, end: 160n },
      activities: [
        {
          kind: 'TransferOutOfArgonFinalized',
          mintingCollateral: [{ signingKey: '0x00000000000000000000000000000000000000aa' }],
          gatewayState: { gatewayActivityNonce: 7n },
        },
      ],
    });
    submissionMock.submitWithTerminalStatusWatch.mockResolvedValue({
      signedTx,
      result: {
        extrinsic: {
          signedHash: '0xrelaytx',
          submittedAtBlockNumber: 321,
          submittedTime: new Date('2026-05-13T16:00:00.000Z'),
        },
        blockNumber: 321,
        waitForInFirstBlock: Promise.resolve(new Uint8Array([1])),
      },
    });

    await runBackgroundSweep();

    expect(gatewayProofMock.buildGatewayActivityProofPayload).toHaveBeenCalledTimes(1);
    expect(submissionMock.submitWithTerminalStatusWatch).toHaveBeenCalledTimes(1);
  });
});

function createSubmitLane(client: ReturnType<typeof createClient>) {
  const lane = new DelegateSubmitLane(relayKeypair);
  lane.client = client as any;
  return lane;
}

function createClient(
  args: {
    tx?: { paymentInfo: ReturnType<typeof vi.fn> };
    accountNextNonce?: number;
    balance?: bigint;
    existentialDeposit?: bigint;
    hasEthereumChainConfig?: boolean;
    gatewaySyncPause?: {
      failedGatewayActivityNonce: bigint;
      lastGoodGatewayActivityNonce: bigint;
      reason: string;
    };
    hasLatestExecutionHeaderAnchor?: boolean;
    runtimeGatewayActivityNonce?: bigint;
    freeHeadersInterval?: bigint;
    mintingAuthorityOwnersBySigner?: Record<string, string>;
    latestLocatorIndex?: bigint;
    latestLocatorEndGatewayActivityNonce?: bigint;
  } = {},
) {
  currentClientArgs = {
    latestLocatorIndex: args.latestLocatorIndex ?? 1n,
    latestLocatorEndGatewayActivityNonce:
      args.latestLocatorEndGatewayActivityNonce ?? (args.runtimeGatewayActivityNonce ?? 0n) + 1n,
  };
  const tx =
    args.tx ??
    ({
      paymentInfo: vi.fn(async () => ({
        partialFee: {
          toBigInt: () => 7n,
        },
      })),
    } as const);

  return {
    tx: {
      crosschainTransfer: {
        proveGatewayActivity: vi.fn(() => tx),
      },
    },
    query: {
      crosschainTransfer: {
        gatewayStateBySourceChain: vi.fn(async () => ({
          isNone: args.runtimeGatewayActivityNonce == null,
          unwrap: () => ({
            gatewayActivityNonce: {
              toBigInt: () => args.runtimeGatewayActivityNonce ?? 0n,
            },
          }),
        })),
        chainConfigBySourceChain: vi.fn(async () => ({
          isNone: args.hasEthereumChainConfig === false,
          unwrap: () => ({
            isEvm: args.hasEthereumChainConfig !== false,
            asEvm: {
              gateway: {
                toHex: () => '0xgateway',
              },
            },
          }),
        })),
        mintingAuthoritiesBySigner: vi.fn(async (signingKey: string) => {
          const owner = args.mintingAuthorityOwnersBySigner?.[signingKey.toLowerCase()];
          return {
            isNone: owner == null,
            isSome: owner != null,
            unwrap: () => ({
              destinationChain: {
                isEthereum: true,
              },
              accountId: {
                toString: () => owner,
              },
            }),
          };
        }),
        gatewaySyncPauseBySourceChain: vi.fn(async () => ({
          isNone: args.gatewaySyncPause == null,
          unwrap: () => ({
            failedGatewayActivityNonce: {
              toBigInt: () => args.gatewaySyncPause?.failedGatewayActivityNonce ?? 0n,
            },
            lastGoodGatewayActivityNonce: {
              toBigInt: () => args.gatewaySyncPause?.lastGoodGatewayActivityNonce ?? 0n,
            },
            reason: {
              type: args.gatewaySyncPause?.reason ?? 'Manual',
            },
          }),
        })),
      },
      system: {
        account: vi.fn(async () => ({
          data: {
            free: {
              toBigInt: () => args.balance ?? 1_000_000n,
            },
          },
        })),
      },
      ethereumVerifier: {
        latestExecutionHeaderAnchorBlockHash: vi.fn(async () => ({
          isNone: args.hasLatestExecutionHeaderAnchor === false,
        })),
      },
    },
    consts: {
      balances: {
        existentialDeposit: {
          toBigInt: () => args.existentialDeposit ?? 10_000n,
        },
      },
      ethereumVerifier: {
        freeHeadersInterval: {
          toBigInt: () => args.freeHeadersInterval ?? 32n,
        },
      },
    },
    rpc: {
      system: {
        accountNextIndex: vi.fn(async () => ({
          toNumber: () => args.accountNextNonce ?? 4,
        })),
      },
    },
  };
}

viemMock.readContract.mockImplementation(async args => {
  const parameters = args as { functionName: string; args?: bigint[] };
  if (parameters.functionName === 'latestActivityBlockLocatorIndex') {
    return currentClientArgs?.latestLocatorIndex ?? 1n;
  }
  if (parameters.functionName === 'activityBlockLocators') {
    return [0n, 0n, currentClientArgs?.latestLocatorEndGatewayActivityNonce ?? 1n, `0x${'00'.repeat(32)}`] as const;
  }
  throw new Error(`Unexpected readContract(${parameters.functionName})`);
});
