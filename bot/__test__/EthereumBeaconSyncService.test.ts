import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NetworkConfig } from '@argonprotocol/apps-core';

type IMockTx = { id: string };
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
    vi.fn<(submitter: { tx: IMockTx }, options?: { nonce?: number }) => Promise<IMockSubmission>>();

  return {
    submitWithTerminalStatusWatch,
  };
});

const mainchainMock = vi.hoisted(() => {
  const dispatchErrorToString = vi.fn();
  const getEthereumBeaconSyncBootstrapTx = vi.fn();
  const getEthereumBeaconSyncState = vi.fn();
  const getNextEthereumBeaconSyncTxs = vi.fn();

  class TxSubmitter {
    public readonly address: string;

    constructor(
      public readonly client: unknown,
      public readonly tx: IMockTx,
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
    dispatchErrorToString,
    getEthereumBeaconSyncBootstrapTx,
    getEthereumBeaconSyncState,
    getNextEthereumBeaconSyncTxs,
    TxSubmitter,
  };
});

vi.mock('@argonprotocol/mainchain', async () => {
  const actual = await vi.importActual<typeof import('@argonprotocol/mainchain')>('@argonprotocol/mainchain');

  return {
    ...actual,
    dispatchErrorToString: mainchainMock.dispatchErrorToString,
    getEthereumBeaconSyncBootstrapTx: mainchainMock.getEthereumBeaconSyncBootstrapTx,
    getEthereumBeaconSyncState: mainchainMock.getEthereumBeaconSyncState,
    getNextEthereumBeaconSyncTxs: mainchainMock.getNextEthereumBeaconSyncTxs,
    TxSubmitter: mainchainMock.TxSubmitter,
  };
});

import { ExtrinsicError, TxSubmissionError, TxSubmissionErrorCode, type ArgonClient } from '@argonprotocol/mainchain';
import { DelegateSubmitLane } from '../src/DelegateSubmitLane.ts';
import {
  EthereumBeaconSyncService,
  waitForFinalizedBeaconExecutionAtOrAbove,
} from '../src/EthereumBeaconSyncService.ts';

const syncKeypair = { address: 'sync-account' } as any;

describe('EthereumBeaconSyncService', () => {
  const createClient = (startingNonce = 4, hasEthereumChainConfig = true): ArgonClient =>
    ({
      isConnected: true,
      query: {
        crosschainTransfer: {
          chainConfigBySourceChain: vi.fn(async () =>
            hasEthereumChainConfig
              ? {
                  isSome: true,
                  isNone: false,
                  unwrap: () => ({
                    isEvm: true,
                  }),
                }
              : {
                  isSome: false,
                  isNone: true,
                },
          ),
        },
      },
      rpc: {
        author: {
          pendingExtrinsics: vi.fn(async () => []),
        },
        system: {
          accountNextIndex: vi.fn(async () => ({
            toNumber: () => startingNonce,
          })),
        },
      },
    }) as unknown as ArgonClient;

  beforeEach(() => {
    vi.clearAllMocks();
    NetworkConfig.setNetwork('mainnet');
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('reports disabled when beacon sync is not configured', async () => {
    const service = new EthereumBeaconSyncService(createClient(), {
      submitLane: createSubmitLane(createClient()),
    });

    await service.start();

    expect(service.state()).toEqual({ mode: 'disabled', syncAccountAddress: 'sync-account' });
    expect(mainchainMock.getEthereumBeaconSyncState).not.toHaveBeenCalled();
    expect(mainchainMock.getNextEthereumBeaconSyncTxs).not.toHaveBeenCalled();
  });

  it('waits for bootstrap before submitting maintenance transactions', async () => {
    mainchainMock.getEthereumBeaconSyncState.mockResolvedValue({
      isBootstrapped: false,
      hasNextSyncCommittee: false,
      latestFinalizedBlockRoot: '0xabc',
      latestSyncCommitteeUpdatePeriod: 11n,
      headerInterval: 32n,
    });

    const service = new EthereumBeaconSyncService(createClient(), {
      beaconApiUrl: 'https://beacon.example',
      submitLane: createSubmitLane(createClient()),
    });

    await service.runOnce();

    expect(mainchainMock.getNextEthereumBeaconSyncTxs).not.toHaveBeenCalled();
    expect(service.state()).toMatchObject({
      syncAccountAddress: 'sync-account',
      latestSyncCommitteeUpdatePeriod: 11n,
      mode: 'needsBootstrap',
    });
    expect(service.state().lastUpdatedAt).toBeInstanceOf(Date);
  });

  it('stays idle until the Ethereum transfer gateway is configured on-chain', async () => {
    const service = new EthereumBeaconSyncService(createClient(4, false), {
      beaconApiUrl: 'https://beacon.example',
      submitLane: createSubmitLane(createClient()),
    });

    await service.runOnce();

    expect(mainchainMock.getEthereumBeaconSyncState).not.toHaveBeenCalled();
    expect(mainchainMock.getNextEthereumBeaconSyncTxs).not.toHaveBeenCalled();
    expect(service.state()).toMatchObject({
      mode: 'idle',
      lastError: 'Ethereum transfer gateway is not configured on this network.',
    });
  });

  it('submits returned transactions in order and refreshes sync state', async () => {
    let resolveFirstInBlock!: () => void;
    const firstInBlock = new Promise<void>(resolve => {
      resolveFirstInBlock = resolve;
    });
    const txs: IMockTx[] = [{ id: 'tx-1' }, { id: 'tx-2' }];
    const client = createClient(12);

    mainchainMock.getEthereumBeaconSyncState
      .mockResolvedValueOnce({
        isBootstrapped: true,
        hasNextSyncCommittee: true,
        latestFinalizedBlockRoot: '0xabc',
        latestFinalizedSlot: 800n,
        nextRecommendedFinalizedSlot: 832n,
        latestSyncCommitteeUpdatePeriod: 12n,
        headerInterval: 32n,
      })
      .mockResolvedValueOnce({
        isBootstrapped: true,
        hasNextSyncCommittee: true,
        latestFinalizedBlockRoot: '0xdef',
        latestFinalizedSlot: 832n,
        nextRecommendedFinalizedSlot: 864n,
        latestSyncCommitteeUpdatePeriod: 13n,
        headerInterval: 32n,
      });
    mainchainMock.getNextEthereumBeaconSyncTxs.mockResolvedValue(txs);
    submissionMock.submitWithTerminalStatusWatch.mockImplementation(async (submitter: { tx: IMockTx }) => {
      return {
        result: {
          extrinsic: { signedHash: `${submitter.tx.id}-hash` },
          waitForInFirstBlock: submitter.tx.id === 'tx-1' ? firstInBlock : Promise.resolve(),
        },
      };
    });

    const service = new EthereumBeaconSyncService(client, {
      beaconApiUrl: 'https://beacon.example',
      submitLane: createSubmitLane(client),
    });

    const runOncePromise = service.runOnce();
    await vi.waitFor(() => {
      expect(submissionMock.submitWithTerminalStatusWatch).toHaveBeenCalledTimes(1);
    });

    expect(submissionMock.submitWithTerminalStatusWatch).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        account: syncKeypair,
        address: syncKeypair.address,
        client,
        tx: txs[0],
      }),
      { nonce: 12 },
    );

    resolveFirstInBlock();
    await vi.waitFor(() => {
      expect(submissionMock.submitWithTerminalStatusWatch).toHaveBeenCalledTimes(2);
    });

    expect(submissionMock.submitWithTerminalStatusWatch).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        account: syncKeypair,
        address: syncKeypair.address,
        client,
        tx: txs[1],
      }),
      { nonce: 13 },
    );
    await runOncePromise;

    expect(service.state()).toMatchObject({
      latestFinalizedSlot: 832n,
      latestSyncCommitteeUpdatePeriod: 13n,
      lastSubmittedTxHash: 'tx-2-hash',
      mode: 'idle',
    });
    expect(service.state().lastUpdatedAt).toBeInstanceOf(Date);
  });

  it('rechecks timed-out submitted beacon sync txs before retrying them', async () => {
    vi.useFakeTimers();
    const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const txs: IMockTx[] = [{ id: 'tx-1' }];
    const client = createClient(12);

    (client.rpc.author.pendingExtrinsics as any) = vi
      .fn()
      .mockResolvedValueOnce([
        {
          hash: {
            toHex: () => 'tx-1-hash',
          },
        },
      ])
      .mockResolvedValueOnce([]);

    mainchainMock.getEthereumBeaconSyncState
      .mockResolvedValueOnce({
        isBootstrapped: true,
        hasNextSyncCommittee: true,
        latestFinalizedBlockRoot: '0xabc',
        latestFinalizedSlot: 800n,
        nextRecommendedFinalizedSlot: 832n,
        latestSyncCommitteeUpdatePeriod: 12n,
        headerInterval: 32n,
      })
      .mockResolvedValueOnce({
        isBootstrapped: true,
        hasNextSyncCommittee: true,
        latestFinalizedBlockRoot: '0xabc',
        latestFinalizedSlot: 800n,
        nextRecommendedFinalizedSlot: 832n,
        latestSyncCommitteeUpdatePeriod: 12n,
        headerInterval: 32n,
      })
      .mockResolvedValueOnce({
        isBootstrapped: true,
        hasNextSyncCommittee: true,
        latestFinalizedBlockRoot: '0xabc',
        latestFinalizedSlot: 800n,
        nextRecommendedFinalizedSlot: 832n,
        latestSyncCommitteeUpdatePeriod: 12n,
        headerInterval: 32n,
      })
      .mockResolvedValueOnce({
        isBootstrapped: true,
        hasNextSyncCommittee: true,
        latestFinalizedBlockRoot: '0xdef',
        latestFinalizedSlot: 832n,
        nextRecommendedFinalizedSlot: 864n,
        latestSyncCommitteeUpdatePeriod: 13n,
        headerInterval: 32n,
      });
    mainchainMock.getNextEthereumBeaconSyncTxs.mockResolvedValue(txs);
    submissionMock.submitWithTerminalStatusWatch
      .mockResolvedValueOnce({
        result: {
          extrinsic: { signedHash: 'tx-1-hash' },
          waitForInFirstBlock: new Promise<void>(() => undefined),
        },
      })
      .mockResolvedValueOnce({
        result: {
          extrinsic: { signedHash: 'tx-1-retry-hash' },
          waitForInFirstBlock: Promise.resolve(),
        },
      });

    const service = new EthereumBeaconSyncService(client, {
      beaconApiUrl: 'https://beacon.example',
      submitLane: createSubmitLane(client),
    });

    const firstRunPromise = service.runOnce();
    await vi.waitFor(() => {
      expect(submissionMock.submitWithTerminalStatusWatch).toHaveBeenCalledTimes(1);
    });
    await vi.advanceTimersByTimeAsync(600_000);
    await firstRunPromise;

    expect(service.state()).toMatchObject({
      lastSubmittedTxHash: 'tx-1-hash',
      latestFinalizedSlot: 800n,
      latestSyncCommitteeUpdatePeriod: 12n,
      mode: 'submitting',
    });

    await service.runOnce();

    expect(mainchainMock.getNextEthereumBeaconSyncTxs).toHaveBeenCalledTimes(1);
    expect(submissionMock.submitWithTerminalStatusWatch).toHaveBeenCalledTimes(1);
    expect(service.state()).toMatchObject({
      lastSubmittedTxHash: 'tx-1-hash',
      latestFinalizedSlot: 800n,
      latestSyncCommitteeUpdatePeriod: 12n,
      mode: 'submitting',
    });

    await service.runOnce();

    expect(submissionMock.submitWithTerminalStatusWatch).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        account: syncKeypair,
        address: syncKeypair.address,
        client,
        tx: txs[0],
      }),
      { nonce: 12 },
    );
    expect(service.state()).toMatchObject({
      latestFinalizedSlot: 832n,
      latestSyncCommitteeUpdatePeriod: 13n,
      lastSubmittedTxHash: 'tx-1-retry-hash',
      mode: 'idle',
    });
    expect(consoleWarnSpy).toHaveBeenCalled();
  });

  it('records errors and recovers on the next pass', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    mainchainMock.getEthereumBeaconSyncState
      .mockRejectedValueOnce(new Error('beacon unavailable'))
      .mockResolvedValueOnce({
        isBootstrapped: false,
        hasNextSyncCommittee: false,
        latestFinalizedBlockRoot: '0xabc',
        latestSyncCommitteeUpdatePeriod: 14n,
        headerInterval: 32n,
      });

    const service = new EthereumBeaconSyncService(createClient(), {
      beaconApiUrl: 'https://beacon.example',
      submitLane: createSubmitLane(createClient()),
    });

    await service.runOnce();
    expect(service.state()).toMatchObject({
      mode: 'error',
      lastError: 'beacon unavailable',
    });

    await service.runOnce();
    expect(service.state()).toMatchObject({
      latestSyncCommitteeUpdatePeriod: 14n,
      mode: 'needsBootstrap',
    });
    expect(service.state().lastError).toBeUndefined();
    expect(consoleErrorSpy).toHaveBeenCalled();
  });

  it('times out stalled beacon requests instead of waiting indefinitely', async () => {
    const fetchMock = vi.fn((_input: unknown, init?: RequestInit) => {
      return new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener(
          'abort',
          () => {
            const abortError = init.signal?.reason ?? Object.assign(new Error('Aborted'), { name: 'AbortError' });
            reject(abortError);
          },
          { once: true },
        );
      });
    });
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    await expect(
      waitForFinalizedBeaconExecutionAtOrAbove('https://beacon.example', 1n, {
        timeoutMs: 25,
        pollMs: 1,
      }),
    ).rejects.toThrow(/Beacon API request timed out after \d+ms for \/eth\/v1\/beacon\/headers\/finalized/);
  });

  it('treats finality update not ready as idle instead of error', async () => {
    mainchainMock.getEthereumBeaconSyncState.mockResolvedValue({
      isBootstrapped: true,
      hasNextSyncCommittee: true,
      latestFinalizedBlockRoot: '0xabc',
      latestFinalizedSlot: 800n,
      nextRecommendedFinalizedSlot: 832n,
      latestSyncCommitteeUpdatePeriod: 12n,
      headerInterval: 32n,
    });
    mainchainMock.getNextEthereumBeaconSyncTxs.mockRejectedValue(
      new Error('Light-client finality update is not ready'),
    );

    const service = new EthereumBeaconSyncService(createClient(), {
      beaconApiUrl: 'https://beacon.example',
      submitLane: createSubmitLane(createClient()),
    });

    await service.runOnce();

    expect(service.state()).toMatchObject({
      latestFinalizedSlot: 800n,
      latestSyncCommitteeUpdatePeriod: 12n,
      mode: 'idle',
    });
    expect(service.state().lastError).toBeUndefined();
  });

  it('treats missing finality update endpoint data as idle instead of error', async () => {
    mainchainMock.getEthereumBeaconSyncState.mockResolvedValue({
      isBootstrapped: true,
      hasNextSyncCommittee: true,
      latestFinalizedBlockRoot: '0xabc',
      latestFinalizedSlot: 800n,
      nextRecommendedFinalizedSlot: 832n,
      latestSyncCommitteeUpdatePeriod: 12n,
      headerInterval: 32n,
    });
    mainchainMock.getNextEthereumBeaconSyncTxs.mockRejectedValue(
      new Error('Beacon API request failed for /eth/v1/beacon/light_client/finality_update: 404 Not Found'),
    );

    const service = new EthereumBeaconSyncService(createClient(), {
      beaconApiUrl: 'https://beacon.example',
      submitLane: createSubmitLane(createClient()),
    });

    await service.runOnce();

    expect(service.state()).toMatchObject({
      latestFinalizedSlot: 800n,
      latestSyncCommitteeUpdatePeriod: 12n,
      mode: 'idle',
    });
    expect(service.state().lastError).toBeUndefined();
  });

  it('continues when the submit error is retryable after the node drops it', async () => {
    const txs: IMockTx[] = [{ id: 'tx-1' }, { id: 'tx-2' }];
    const droppedError = new TxSubmissionError(
      TxSubmissionErrorCode.Dropped,
      'Transaction was dropped before it was included in a block.',
    );
    const client = createClient(12);

    mainchainMock.getEthereumBeaconSyncState
      .mockResolvedValueOnce({
        isBootstrapped: true,
        hasNextSyncCommittee: true,
        latestFinalizedBlockRoot: '0xabc',
        latestFinalizedSlot: 800n,
        nextRecommendedFinalizedSlot: 832n,
        latestSyncCommitteeUpdatePeriod: 12n,
        headerInterval: 32n,
      })
      .mockResolvedValueOnce({
        isBootstrapped: true,
        hasNextSyncCommittee: true,
        latestFinalizedBlockRoot: '0xdef',
        latestFinalizedSlot: 832n,
        nextRecommendedFinalizedSlot: 864n,
        latestSyncCommitteeUpdatePeriod: 13n,
        headerInterval: 32n,
      });
    mainchainMock.getNextEthereumBeaconSyncTxs.mockResolvedValue(txs);
    submissionMock.submitWithTerminalStatusWatch.mockRejectedValueOnce(droppedError).mockResolvedValueOnce({
      result: {
        extrinsic: { signedHash: 'tx-2-hash' },
        waitForInFirstBlock: Promise.resolve(),
      },
    });

    const service = new EthereumBeaconSyncService(client, {
      beaconApiUrl: 'https://beacon.example',
      submitLane: createSubmitLane(client),
    });

    await service.runOnce();

    expect(submissionMock.submitWithTerminalStatusWatch).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        account: syncKeypair,
        address: syncKeypair.address,
        client,
        tx: txs[0],
      }),
      { nonce: 12 },
    );
    expect(submissionMock.submitWithTerminalStatusWatch).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        account: syncKeypair,
        address: syncKeypair.address,
        client,
        tx: txs[1],
      }),
      { nonce: 12 },
    );
    expect(service.state()).toMatchObject({
      latestFinalizedSlot: 832n,
      latestSyncCommitteeUpdatePeriod: 13n,
      lastSubmittedTxHash: 'tx-2-hash',
      mode: 'idle',
    });
  });

  it('treats ExpectedFinalizedHeaderNotStored as idle so the next pass can retry', async () => {
    const client = createClient(12);

    mainchainMock.getEthereumBeaconSyncState.mockResolvedValue({
      isBootstrapped: true,
      hasNextSyncCommittee: true,
      latestFinalizedBlockRoot: '0xabc',
      latestFinalizedSlot: 800n,
      nextRecommendedFinalizedSlot: 832n,
      latestSyncCommitteeUpdatePeriod: 12n,
      headerInterval: 32n,
    });
    mainchainMock.getNextEthereumBeaconSyncTxs.mockResolvedValue([{ id: 'tx-1' }]);
    submissionMock.submitWithTerminalStatusWatch.mockRejectedValue(
      new ExtrinsicError('ethereumVerifier.ExpectedFinalizedHeaderNotStored'),
    );

    const service = new EthereumBeaconSyncService(client, {
      beaconApiUrl: 'https://beacon.example',
      submitLane: createSubmitLane(client),
    });

    await service.runOnce();

    expect(submissionMock.submitWithTerminalStatusWatch).toHaveBeenCalledTimes(1);
    expect(service.state()).toMatchObject({
      latestFinalizedSlot: 800n,
      latestSyncCommitteeUpdatePeriod: 12n,
      mode: 'idle',
    });
    expect(service.state().lastError).toBeUndefined();
  });
});

function createSubmitLane(client: any) {
  const lane = new DelegateSubmitLane(syncKeypair);
  lane.client = client;
  return lane;
}
