import { setTimeout as sleep } from 'node:timers/promises';
import { NetworkConfig, raceWithTimeout, SingleFileQueue, type IEthereumSyncStatus } from '@argonprotocol/apps-core';
import {
  dispatchErrorToString,
  type ArgonClient,
  ExtrinsicError,
  getEthereumBeaconSyncBootstrapTx,
  getEthereumBeaconSyncState,
  getLatestArgonFinalizedExecutionHeader,
  getNextEthereumBeaconSyncTxs,
  isOutdatedTransactionError,
  type KeyringPair,
  TxSubmitter,
} from '@argonprotocol/mainchain';
import { createPublicClient, http } from 'viem';
import { DelegateSubmitLane } from './DelegateSubmitLane.ts';
import { isSubmissionStatusError, submitWithTerminalStatusWatch } from './submitWithTerminalStatusWatch.ts';

type IEthereumBeaconSyncServiceOptions = {
  beaconApiUrl?: string;
  pollMs?: number;
  submitLane: DelegateSubmitLane;
};

type IEthereumBeaconBootstrapOptions = {
  timeoutMs?: number;
  pollMs?: number;
  minimumExecutionBlockNumber?: bigint;
  minimumFinalizedSlot?: bigint;
};

const DEFAULT_BOOTSTRAP_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_BOOTSTRAP_POLL_MS = 1_000;
const DEFAULT_BEACON_REQUEST_TIMEOUT_MS = 10_000;
const SUBMISSION_INCLUSION_BLOCKS = 10;

export class EthereumBeaconSyncService {
  private loopPromise?: Promise<void>;
  private readonly runQueue = new SingleFileQueue();
  private shouldStop = false;
  private hasEthereumTransferGatewayConfig = false;
  private readonly pollMs: number;
  private readonly stateData: IEthereumSyncStatus;

  constructor(
    private readonly client: ArgonClient,
    private readonly options: IEthereumBeaconSyncServiceOptions,
  ) {
    this.pollMs = options.pollMs ?? 30_000;
    this.stateData = {
      mode: this.isEnabled ? 'idle' : 'disabled',
      syncAccountAddress: options.submitLane.address,
    };
  }

  public state(): IEthereumSyncStatus {
    return { ...this.stateData };
  }

  public async start(): Promise<void> {
    if (!this.isEnabled || this.loopPromise) return;

    this.shouldStop = false;
    this.loopPromise = this.loop();
    await this.runOnce();
  }

  public async shutdown(): Promise<void> {
    this.shouldStop = true;
    await this.loopPromise;
    await this.runQueue.stop(true);
  }

  public async runOnce(): Promise<void> {
    if (!this.isEnabled) {
      this.stateData.mode = 'disabled';
      return;
    }

    await this.runQueue.add(async () => {
      if (this.shouldStop) return;

      try {
        await this.runOnceInner();
      } catch (error) {
        this.recordError(error);
      } finally {
        this.stateData.lastUpdatedAt = new Date();
      }
    }).promise;
  }

  public static async ensureBootstrapped(
    client: ArgonClient,
    beaconApiUrl: string,
    sudoKeypair: KeyringPair,
    options: IEthereumBeaconBootstrapOptions = {},
  ): Promise<void> {
    const startedAt = Date.now();
    console.log('[EthereumBeaconSyncService] Checking bootstrap state');
    const state = await getEthereumBeaconSyncState(client);
    if (state.isBootstrapped) {
      console.log(`[EthereumBeaconSyncService] Bootstrap already present after ${Date.now() - startedAt}ms`);
      return;
    }

    const timeoutMs = options.timeoutMs ?? DEFAULT_BOOTSTRAP_TIMEOUT_MS;
    const pollMs = options.pollMs ?? DEFAULT_BOOTSTRAP_POLL_MS;
    const minimumExecutionBlockNumber = options.minimumExecutionBlockNumber ?? 1n;
    const minimumFinalizedSlot = options.minimumFinalizedSlot ?? 0n;

    console.log(
      `[EthereumBeaconSyncService] Waiting for finalized beacon execution block >= ${minimumExecutionBlockNumber} and slot >= ${minimumFinalizedSlot}`,
    );
    await waitForFinalizedBeaconExecutionAtOrAbove(beaconApiUrl, minimumExecutionBlockNumber, {
      timeoutMs,
      pollMs,
      minimumFinalizedSlot,
    });
    console.log(`[EthereumBeaconSyncService] Finalized beacon execution is ready after ${Date.now() - startedAt}ms`);

    const bootstrapTxStartedAt = Date.now();
    let bootstrapTx;
    let lastBootstrapError: Error | undefined;

    while (Date.now() - bootstrapTxStartedAt < timeoutMs) {
      try {
        bootstrapTx = await getEthereumBeaconSyncBootstrapTx(client, beaconApiUrl);
        console.log(
          `[EthereumBeaconSyncService] Built beacon bootstrap transaction after ${Date.now() - bootstrapTxStartedAt}ms`,
        );
        break;
      } catch (error) {
        if (!(error instanceof Error)) {
          throw error;
        }

        lastBootstrapError = error;
        if (!isBootstrapEndpointNotReady(error.message)) {
          throw error;
        }
        await sleep(pollMs);
      }
    }

    if (!bootstrapTx) {
      const lastErrorSuffix = lastBootstrapError ? ` Last error: ${lastBootstrapError.message}` : '';
      throw new Error(
        `Ethereum beacon light-client bootstrap endpoint did not become ready within ${Math.floor(timeoutMs / 1000)}s.${lastErrorSuffix}`,
      );
    }

    console.log('[EthereumBeaconSyncService] Submitting beacon bootstrap sudo transaction');
    const result = await new TxSubmitter(client, client.tx.sudo.sudo(bootstrapTx), sudoKeypair).submit();
    console.log('[EthereumBeaconSyncService] Waiting for beacon bootstrap transaction to enter a block');
    await result.waitForInFirstBlock;
    console.log(
      `[EthereumBeaconSyncService] Beacon bootstrap transaction entered a block after ${Date.now() - startedAt}ms`,
    );

    const sudoResultEvent = result.events.find(event => client.events.sudo.Sudid.is(event));
    if (!sudoResultEvent || !client.events.sudo.Sudid.is(sudoResultEvent)) {
      throw new Error('Bootstrap transaction did not emit sudo.Sudid.');
    }
    if (sudoResultEvent.data.sudoResult.isErr) {
      throw new Error(`Bootstrap failed: ${dispatchErrorToString(client, sudoResultEvent.data.sudoResult.asErr)}`);
    }

    console.log(`[EthereumBeaconSyncService] Beacon bootstrap completed successfully in ${Date.now() - startedAt}ms`);
  }

  private get isEnabled(): boolean {
    return Boolean(this.options.beaconApiUrl);
  }

  private async loop(): Promise<void> {
    while (!this.shouldStop) {
      await sleep(this.pollMs);
      if (this.shouldStop) break;
      await this.runOnce();
    }
  }

  private async runOnceInner(): Promise<void> {
    const beaconApiUrl = this.options.beaconApiUrl!;
    const submitLane = this.options.submitLane;
    delete this.stateData.latestExecutionAnchorBlockNumber;
    delete this.stateData.latestEthereumBlockNumber;

    if (!this.client.isConnected) {
      this.stateData.mode = 'idle';
      this.stateData.lastError = 'Mainchain WebSocket is not connected; waiting to retry.';
      return;
    }

    if (!(await this.loadHasEthereumTransferGatewayConfig())) {
      this.stateData.mode = 'idle';
      this.stateData.lastError = 'Ethereum transfer gateway is not configured on this network.';
      delete this.stateData.latestFinalizedSlot;
      return;
    }

    const syncState = await getEthereumBeaconSyncState(this.client);

    this.stateData.latestSyncCommitteeUpdatePeriod = syncState.latestSyncCommitteeUpdatePeriod;
    delete this.stateData.lastError;

    if (!syncState.isBootstrapped) {
      this.stateData.mode = 'needsBootstrap';
      delete this.stateData.latestFinalizedSlot;
      return;
    }

    this.stateData.latestFinalizedSlot = syncState.latestFinalizedSlot;
    await this.updateExecutionLag();

    if (this.stateData.mode === 'submitting' && this.stateData.lastSubmittedTxHash) {
      const pendingExtrinsics = await this.client.rpc.author.pendingExtrinsics();
      const isSubmittedTxStillPending = pendingExtrinsics.some(
        pendingExtrinsic => pendingExtrinsic.hash.toHex() === this.stateData.lastSubmittedTxHash,
      );

      if (isSubmittedTxStillPending) {
        return;
      }

      console.warn(
        `[EthereumBeaconSyncService] Submitted beacon sync tx ${this.stateData.lastSubmittedTxHash} ` +
          'is no longer pending before inclusion was observed; retrying',
      );
      submitLane.invalidateNonce();
      this.stateData.mode = 'idle';
      delete this.stateData.lastSubmittedTxHash;
    }

    let txs;
    try {
      txs = await getNextEthereumBeaconSyncTxs(this.client, beaconApiUrl);
    } catch (error) {
      if (isLightClientFinalityUpdateNotReady(error)) {
        this.stateData.mode = 'idle';
        return;
      }
      throw error;
    }

    if (!txs.length) {
      this.stateData.mode = 'idle';
      return;
    }

    this.stateData.mode = 'submitting';
    for (const tx of txs) {
      if (this.shouldStop) return;

      try {
        const result = await submitLane.runExclusive(async (client, getNonce) => {
          return (
            await submitWithTerminalStatusWatch(new TxSubmitter(client, tx, submitLane.keypair), {
              nonce: await getNonce(),
            })
          ).result;
        });
        this.stateData.lastSubmittedTxHash = result.extrinsic.signedHash;
        const inclusionTimeoutMs = NetworkConfig.tickMillis * SUBMISSION_INCLUSION_BLOCKS;
        const observedInFirstBlock = await raceWithTimeout(
          result.waitForInFirstBlock.then(() => true),
          inclusionTimeoutMs,
          () => false,
        );

        if (!observedInFirstBlock) {
          console.warn(
            `[EthereumBeaconSyncService] Submitted beacon sync tx ${result.extrinsic.signedHash} ` +
              `but did not observe its first block within ${inclusionTimeoutMs}ms; will re-check next sweep`,
          );
          return;
        }
      } catch (error) {
        if (isRetryableBeaconSyncSubmitError(error)) {
          submitLane.invalidateNonce();
          continue;
        }
        if (
          error instanceof ExtrinsicError &&
          error.errorCode === 'ethereumVerifier.ExpectedFinalizedHeaderNotStored'
        ) {
          this.stateData.mode = 'idle';
          return;
        }
        throw error;
      }
    }

    const refreshedState = await getEthereumBeaconSyncState(this.client);
    this.stateData.latestSyncCommitteeUpdatePeriod = refreshedState.latestSyncCommitteeUpdatePeriod;
    this.stateData.latestFinalizedSlot = refreshedState.isBootstrapped ? refreshedState.latestFinalizedSlot : undefined;
    this.stateData.mode = refreshedState.isBootstrapped ? 'idle' : 'needsBootstrap';
    if (refreshedState.isBootstrapped) {
      await this.updateExecutionLag();
    } else {
      delete this.stateData.latestExecutionAnchorBlockNumber;
      delete this.stateData.latestEthereumBlockNumber;
    }
  }

  private async loadHasEthereumTransferGatewayConfig(): Promise<boolean> {
    if (this.hasEthereumTransferGatewayConfig) {
      return true;
    }

    const chainConfig = await this.client.query.crosschainTransfer.chainConfigBySourceChain('Ethereum');
    this.hasEthereumTransferGatewayConfig = chainConfig.isSome && chainConfig.unwrap().isEvm;
    return this.hasEthereumTransferGatewayConfig;
  }

  private recordError(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.stateData.mode = 'error';
    this.stateData.lastError = message;
    console.error('[EthereumBeaconSyncService] Error syncing beacon headers', error);
  }

  private async updateExecutionLag(): Promise<void> {
    try {
      const latestExecutionAnchor = await getLatestArgonFinalizedExecutionHeader(this.client);
      this.stateData.latestExecutionAnchorBlockNumber = latestExecutionAnchor.blockNumber;

      const executionRpcUrl = NetworkConfig.get().ethereumNetwork.executionRpcUrl.trim();
      if (!executionRpcUrl) {
        return;
      }

      try {
        const latestEthereumBlockNumber = await createPublicClient({
          transport: http(executionRpcUrl),
        }).getBlockNumber();
        this.stateData.latestEthereumBlockNumber = latestEthereumBlockNumber;
      } catch {
        delete this.stateData.latestEthereumBlockNumber;
      }
    } catch {
      delete this.stateData.latestExecutionAnchorBlockNumber;
      delete this.stateData.latestEthereumBlockNumber;
    }
  }
}

export async function waitForFinalizedBeaconExecutionAtOrAbove(
  beaconApiUrl: string,
  minimumExecutionBlockNumber: bigint,
  options: {
    timeoutMs?: number;
    pollMs?: number;
    minimumFinalizedSlot?: bigint;
  } = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_BOOTSTRAP_TIMEOUT_MS;
  const pollMs = options.pollMs ?? DEFAULT_BOOTSTRAP_POLL_MS;
  const minimumFinalizedSlot = options.minimumFinalizedSlot ?? 0n;
  const startedAt = Date.now();
  let lastError: Error | undefined;
  let lastProgressLogAt = 0;

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const finalizedHeaderTimeoutMs = Math.max(
        1,
        Math.min(DEFAULT_BEACON_REQUEST_TIMEOUT_MS, timeoutMs - (Date.now() - startedAt)),
      );
      const finalizedHeader = await getBeaconJson<{
        data: {
          root: string;
          header: {
            message: {
              slot: string;
            };
          };
        };
      }>(beaconApiUrl, '/eth/v1/beacon/headers/finalized', finalizedHeaderTimeoutMs);
      const lastSeenFinalizedSlot = BigInt(finalizedHeader.data.header.message.slot);

      const finalizedBlockTimeoutMs = Math.max(
        1,
        Math.min(DEFAULT_BEACON_REQUEST_TIMEOUT_MS, timeoutMs - (Date.now() - startedAt)),
      );
      const finalizedBlock = await getBeaconJson<{
        data: {
          message: {
            body: {
              execution_payload: {
                block_number: string;
              };
            };
          };
        };
      }>(beaconApiUrl, `/eth/v2/beacon/blocks/${finalizedHeader.data.root}`, finalizedBlockTimeoutMs);
      const lastSeenExecutionBlockNumber = BigInt(finalizedBlock.data.message.body.execution_payload.block_number);

      if (
        lastSeenExecutionBlockNumber >= minimumExecutionBlockNumber &&
        lastSeenFinalizedSlot >= minimumFinalizedSlot
      ) {
        return;
      }

      lastError = new Error(
        `waiting for finalized execution block >= ${minimumExecutionBlockNumber} and slot >= ${minimumFinalizedSlot}; latest block=${lastSeenExecutionBlockNumber} slot=${lastSeenFinalizedSlot}`,
      );
      if (Date.now() - lastProgressLogAt >= 10_000) {
        lastProgressLogAt = Date.now();
        console.log(
          `[EthereumBeaconSyncService] Still waiting for finalized beacon execution block >= ${minimumExecutionBlockNumber} and slot >= ${minimumFinalizedSlot}; latest block=${lastSeenExecutionBlockNumber} slot=${lastSeenFinalizedSlot}`,
        );
      }
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (Date.now() - lastProgressLogAt >= 10_000) {
        lastProgressLogAt = Date.now();
        console.log(`[EthereumBeaconSyncService] Still waiting for finalized beacon execution: ${lastError.message}`);
      }
    }

    await sleep(pollMs);
  }

  const lastErrorSuffix = lastError ? ` (${lastError.message})` : '';
  throw new Error(
    `finalized beacon execution block did not reach block >= ${minimumExecutionBlockNumber} and slot >= ${minimumFinalizedSlot} within ${Math.floor(timeoutMs / 1000)}s${lastErrorSuffix}`,
  );
}

function isBootstrapEndpointNotReady(message: string): boolean {
  return message.includes('/eth/v1/beacon/light_client/bootstrap/') && message.includes('404');
}

function isLightClientFinalityUpdateNotReady(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes('Light-client finality update is not ready') ||
    message.includes('Light-client update is unavailable') ||
    (message.includes('/eth/v1/beacon/light_client/finality_update') && message.includes('404'))
  );
}

function isRetryableBeaconSyncSubmitError(error: unknown): boolean {
  return isOutdatedTransactionError(error) || isSubmissionStatusError(error);
}

async function getBeaconJson<T>(
  beaconApiUrl: string,
  path: string,
  timeoutMs = DEFAULT_BEACON_REQUEST_TIMEOUT_MS,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(new URL(path, beaconApiUrl), {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
      throw new Error(`Beacon API request timed out after ${timeoutMs}ms for ${path}`);
    }
    throw error;
  }

  if (!response.ok) {
    throw new Error(`Beacon API request failed (${response.status}) for ${path}`);
  }

  return (await response.json()) as T;
}
