import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type IMockSubmitResult = {
  extrinsic: { signedHash: string };
  waitForInFirstBlock: Promise<void>;
};

type IMockTx = { id: string };
type IMockSubmitOptions = { useLatestNonce?: boolean };

const mainchainMock = vi.hoisted(() => {
  const dispatchErrorToString = vi.fn();
  const getEthereumBeaconSyncBootstrapTx = vi.fn();
  const getEthereumBeaconSyncState = vi.fn();
  const getNextEthereumBeaconSyncTxs = vi.fn();
  const isOutdatedTransactionError = vi.fn((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    return message.includes('Invalid Transaction: Transaction is outdated');
  });
  const submitTx =
    vi.fn<(tx: IMockTx, syncKeypair: unknown, options?: IMockSubmitOptions) => Promise<IMockSubmitResult>>();

  class TxSubmitter {
    private readonly tx: unknown;
    private readonly syncKeypair: unknown;

    constructor(_client: unknown, tx: unknown, syncKeypair: unknown) {
      this.tx = tx;
      this.syncKeypair = syncKeypair;
    }

    public submit(options?: IMockSubmitOptions): Promise<IMockSubmitResult> {
      return submitTx(this.tx as IMockTx, this.syncKeypair, options);
    }
  }

  return {
    dispatchErrorToString,
    getEthereumBeaconSyncBootstrapTx,
    getEthereumBeaconSyncState,
    getNextEthereumBeaconSyncTxs,
    isOutdatedTransactionError,
    submitTx,
    TxSubmitter,
  };
});

vi.mock('@argonprotocol/mainchain', () => ({
  dispatchErrorToString: mainchainMock.dispatchErrorToString,
  getEthereumBeaconSyncBootstrapTx: mainchainMock.getEthereumBeaconSyncBootstrapTx,
  getEthereumBeaconSyncState: mainchainMock.getEthereumBeaconSyncState,
  getNextEthereumBeaconSyncTxs: mainchainMock.getNextEthereumBeaconSyncTxs,
  isOutdatedTransactionError: mainchainMock.isOutdatedTransactionError,
  TxSubmitter: mainchainMock.TxSubmitter,
}));

import {
  EthereumBeaconSyncService,
  waitForFinalizedBeaconExecutionAtOrAbove,
} from '../src/EthereumBeaconSyncService.ts';

describe('EthereumBeaconSyncService', () => {
  const client = {} as any;
  const syncKeypair = { address: 'sync-account' } as any;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('reports disabled when beacon sync is not configured', async () => {
    const service = new EthereumBeaconSyncService(client, { syncKeypair });

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

    const service = new EthereumBeaconSyncService(client, {
      beaconApiUrl: 'https://beacon.example',
      syncKeypair,
    });

    await service.runOnce();

    expect(mainchainMock.getNextEthereumBeaconSyncTxs).not.toHaveBeenCalled();
    expect(service.state()).toMatchObject({
      syncAccountAddress: 'sync-account',
      latestSyncCommitteeUpdatePeriod: 11n,
      mode: 'needsBootstrap',
    });
  });

  it('submits returned transactions in order and refreshes sync state', async () => {
    let resolveFirstInBlock!: () => void;
    const firstInBlock = new Promise<void>(resolve => {
      resolveFirstInBlock = resolve;
    });
    const txs: IMockTx[] = [{ id: 'tx-1' }, { id: 'tx-2' }];

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
    mainchainMock.submitTx.mockImplementation(async (tx: IMockTx) => {
      return {
        extrinsic: { signedHash: `${tx.id}-hash` },
        waitForInFirstBlock: tx.id === 'tx-1' ? firstInBlock : Promise.resolve(),
      };
    });

    const service = new EthereumBeaconSyncService(client, {
      beaconApiUrl: 'https://beacon.example',
      syncKeypair,
    });

    const runOncePromise = service.runOnce();
    await vi.waitFor(() => {
      expect(mainchainMock.submitTx).toHaveBeenCalledTimes(1);
    });

    expect(mainchainMock.submitTx).toHaveBeenNthCalledWith(1, txs[0], syncKeypair, {
      useLatestNonce: true,
    });

    resolveFirstInBlock();
    await vi.waitFor(() => {
      expect(mainchainMock.submitTx).toHaveBeenCalledTimes(2);
    });

    expect(mainchainMock.submitTx).toHaveBeenNthCalledWith(2, txs[1], syncKeypair, {
      useLatestNonce: true,
    });
    await runOncePromise;

    expect(service.state()).toMatchObject({
      latestFinalizedSlot: 832n,
      latestSyncCommitteeUpdatePeriod: 13n,
      lastSubmittedTxHash: 'tx-2-hash',
      mode: 'idle',
    });
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

    const service = new EthereumBeaconSyncService(client, {
      beaconApiUrl: 'https://beacon.example',
      syncKeypair,
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
});
