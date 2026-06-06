import {
  minimumVaultDelegateBalance,
  NetworkConfig,
  type IEthereumGatewayCatchUpRequest,
  type IEthereumGatewayCatchUpResponse,
  type IEthereumGatewayRelayStatus,
  type IEthereumSyncStatus,
} from '@argonprotocol/apps-core';
import {
  buildGatewayActivityProofPayload,
  getLatestArgonFinalizedExecutionHeader,
  TxSubmitter,
} from '@argonprotocol/mainchain';
import process from 'node:process';
import { createHash } from 'node:crypto';
import { type Hex } from 'viem';
import { DelegateSubmitLane } from './DelegateSubmitLane.ts';
import { HttpError } from './HttpError.ts';
import { setTimeout as delay } from 'node:timers/promises';

export class EthereumGatewayProverService {
  private loopPromise?: Promise<void>;
  private inspectionPromise?: Promise<void>;
  private activeCatchUpPromise?: Promise<IEthereumGatewayCatchUpResponse>;
  private pendingCatchUpNonce?: bigint;
  private shouldStop = false;
  private sleepAbortController?: AbortController;
  private gatewayAddress?: Hex;
  private gatewayAddressPromise?: Promise<Hex>;
  private lastObservedRuntimeGatewayActivityNonce?: bigint;
  private lastObservedRuntimeGatewayActivityAt?: number;
  private lastStallSweepWindowIndex?: number;
  private readonly stateData: Pick<IEthereumSyncStatus, 'gatewayActivityNonceGap'> = {};

  constructor(
    private readonly submitLane: DelegateSubmitLane,
    private readonly options: {
      backgroundSweepMs?: number;
    } = {},
  ) {}

  public async start(): Promise<void> {
    if (this.loopPromise) {
      return;
    }

    this.shouldStop = false;
    this.loopPromise = this.loop();

    try {
      await this.runBackgroundSweep({ force: true });
    } catch (error) {
      console.error('[EthereumGatewayProverService] Initial catch-up failed', error);
    }
  }

  public async shutdown(): Promise<void> {
    this.shouldStop = true;
    this.sleepAbortController?.abort();
    const pending = [this.inspectionPromise, this.activeCatchUpPromise, this.loopPromise];
    for (const promise of pending) {
      await promise?.catch(() => undefined);
    }
  }

  public async getRelayStatus(): Promise<IEthereumGatewayRelayStatus> {
    try {
      const client = this.requireClient();
      this.requireExecutionRpcUrl();
      await this.loadGatewayAddress();
      const gatewaySyncPause = await client.query.crosschainTransfer.gatewaySyncPauseBySourceChain('Ethereum');
      if (!gatewaySyncPause.isNone) {
        const pause = gatewaySyncPause.unwrap();
        return {
          isReady: false,
          reason:
            `Ethereum gateway sync is paused at activity ${pause.failedGatewayActivityNonce.toBigInt()}` +
            ` (${pause.reason.type}).`,
        };
      }

      const latestExecutionHeaderAnchorHash =
        await client.query.ethereumVerifier.latestExecutionHeaderAnchorBlockHash();
      if (latestExecutionHeaderAnchorHash.isNone) {
        return {
          isReady: false,
          reason: 'Ethereum verifier has not retained a finalized execution header yet.',
        };
      }

      const delegateBalance = await client.query.system
        .account(this.submitLane.address)
        .then(x => x.data.free.toBigInt());
      if (delegateBalance < minimumVaultDelegateBalance) {
        return {
          isReady: false,
          reason: 'Vault delegate needs more funds before Ethereum relays can run.',
        };
      }

      return {
        isReady: true,
      };
    } catch (error) {
      return {
        isReady: false,
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  }

  public async runToCheckpoint(request: IEthereumGatewayCatchUpRequest): Promise<IEthereumGatewayCatchUpResponse> {
    if (this.inspectionPromise) {
      await this.inspectionPromise;
    }
    return await this.queueCheckpoint(request.throughGatewayActivityNonce);
  }

  public state(): Pick<IEthereumSyncStatus, 'gatewayActivityNonceGap'> {
    return { ...this.stateData };
  }

  private async loop(): Promise<void> {
    try {
      while (!this.shouldStop) {
        await this.wait(this.getRelaySweepMs());
        if (this.shouldStop) {
          break;
        }

        try {
          await this.runBackgroundSweep();
        } catch (error) {
          console.error('[EthereumGatewayProverService] Background catch-up failed', error);
        }
      }
    } finally {
      this.loopPromise = undefined;
      this.sleepAbortController = undefined;
    }
  }

  private async runBackgroundSweep(args: { force?: boolean } = {}): Promise<void> {
    if (this.inspectionPromise || this.activeCatchUpPromise) {
      return;
    }

    this.inspectionPromise = (async (): Promise<void> => {
      const relayStatus = await this.getRelayStatus();
      if (!relayStatus.isReady) {
        return;
      }

      const client = this.requireClient();
      const currentRuntimeGatewayActivityNonce = await this.loadCurrentRuntimeGatewayActivityNonce(client);
      const now = Date.now();
      const runtimeNonceMovedForward =
        this.lastObservedRuntimeGatewayActivityNonce === undefined ||
        currentRuntimeGatewayActivityNonce > this.lastObservedRuntimeGatewayActivityNonce;
      this.lastObservedRuntimeGatewayActivityNonce = currentRuntimeGatewayActivityNonce;
      if (runtimeNonceMovedForward) {
        this.lastObservedRuntimeGatewayActivityAt = now;
        this.lastStallSweepWindowIndex = undefined;
      }

      if (!args.force && !runtimeNonceMovedForward) {
        const stalledSince = this.lastObservedRuntimeGatewayActivityAt ?? now;
        const stallSweepWindow = getStallSweepWindow(client, this.submitLane.address, stalledSince, now);
        if (!stallSweepWindow || stallSweepWindow.windowIndex === this.lastStallSweepWindowIndex) {
          return;
        }

        this.lastStallSweepWindowIndex = stallSweepWindow.windowIndex;
        console.log(
          `[EthereumGatewayProverService] Runtime gateway nonce stalled at ${currentRuntimeGatewayActivityNonce}; ` +
            `running staggered catch-up sweep after ${stallSweepWindow.stalledMs}ms (window ${stallSweepWindow.windowIndex})`,
        );
      }

      const executionRpcUrl = this.requireExecutionRpcUrl();
      const gatewayAddress = await this.loadGatewayAddress();
      const latestExecutionHeader = await getLatestArgonFinalizedExecutionHeader(client);
      const proofPayload = await buildGatewayActivityProofPayload(client, {
        executionRpcUrl,
        gatewayAddress,
        throughExecutionBlockNumber: latestExecutionHeader.blockNumber,
      });
      if (!proofPayload) {
        this.stateData.gatewayActivityNonceGap = 0n;
        return;
      }

      this.stateData.gatewayActivityNonceGap =
        proofPayload.gatewayActivityNonceRange.end - currentRuntimeGatewayActivityNonce;

      if (runtimeNonceMovedForward) {
        console.log(
          `[EthereumGatewayProverService] Runtime gateway nonce advanced to ${currentRuntimeGatewayActivityNonce}; checking for more relay work`,
        );
      }

      await this.queueCheckpoint(proofPayload.gatewayActivityNonceRange.end);
    })();

    try {
      await this.inspectionPromise;
    } finally {
      this.inspectionPromise = undefined;
    }
  }

  private async queueCheckpoint(throughGatewayActivityNonce: bigint): Promise<IEthereumGatewayCatchUpResponse> {
    this.pendingCatchUpNonce =
      this.pendingCatchUpNonce === undefined || throughGatewayActivityNonce > this.pendingCatchUpNonce
        ? throughGatewayActivityNonce
        : this.pendingCatchUpNonce;

    this.activeCatchUpPromise ??= this.processCheckpointQueue();
    return await this.activeCatchUpPromise;
  }

  private async processCheckpointQueue(): Promise<IEthereumGatewayCatchUpResponse> {
    let latestResponse: IEthereumGatewayCatchUpResponse = {
      outcome: 'Noop',
    };

    try {
      while (this.pendingCatchUpNonce !== undefined) {
        const throughGatewayActivityNonce = this.pendingCatchUpNonce;
        this.pendingCatchUpNonce = undefined;
        const client = this.requireClient();
        const currentRuntimeGatewayActivityNonce = await this.loadCurrentRuntimeGatewayActivityNonce(client);
        if (currentRuntimeGatewayActivityNonce >= throughGatewayActivityNonce) {
          latestResponse = {
            outcome: 'Noop',
            throughGatewayActivityNonce: currentRuntimeGatewayActivityNonce,
          };
          continue;
        }

        const executionRpcUrl = this.requireExecutionRpcUrl();
        const gatewayAddress = await this.loadGatewayAddress();
        latestResponse = await this.runToCheckpointWithContext(
          throughGatewayActivityNonce,
          client,
          executionRpcUrl,
          gatewayAddress,
        );

        if (this.pendingCatchUpNonce !== undefined && isCheckpointSatisfied(latestResponse, this.pendingCatchUpNonce)) {
          this.pendingCatchUpNonce = undefined;
        }

        if (latestResponse.outcome !== 'Submitted') {
          return latestResponse;
        }
      }

      return latestResponse;
    } finally {
      this.activeCatchUpPromise = undefined;
    }
  }

  private async runToCheckpointWithContext(
    throughGatewayActivityNonce: bigint,
    client: ReturnType<EthereumGatewayProverService['requireClient']>,
    executionRpcUrl: string,
    gatewayAddress: Hex,
  ): Promise<IEthereumGatewayCatchUpResponse> {
    let latestResponse: IEthereumGatewayCatchUpResponse | undefined;

    while (true) {
      const gatewaySyncPause = await client.query.crosschainTransfer.gatewaySyncPauseBySourceChain('Ethereum');
      if (!gatewaySyncPause.isNone) {
        const pause = gatewaySyncPause.unwrap();
        return {
          outcome: 'Rejected',
          reason:
            `Ethereum gateway sync is paused at activity ${pause.failedGatewayActivityNonce.toBigInt()}` +
            ` (${pause.reason.type}).`,
          throughGatewayActivityNonce: pause.lastGoodGatewayActivityNonce.toBigInt(),
        };
      }

      const currentRuntimeGatewayActivityNonce = await this.loadCurrentRuntimeGatewayActivityNonce(client);
      if (currentRuntimeGatewayActivityNonce >= throughGatewayActivityNonce) {
        this.stateData.gatewayActivityNonceGap = 0n;
        return {
          outcome: 'Noop',
          throughGatewayActivityNonce: currentRuntimeGatewayActivityNonce,
        };
      }

      const latestExecutionHeader = await getLatestArgonFinalizedExecutionHeader(client);
      const proofPayload = await buildGatewayActivityProofPayload(client, {
        executionRpcUrl,
        gatewayAddress,
        throughExecutionBlockNumber: latestExecutionHeader.blockNumber,
      });
      if (!proofPayload) {
        this.stateData.gatewayActivityNonceGap = 0n;
        return (
          latestResponse ?? {
            outcome: 'Noop',
            throughGatewayActivityNonce: currentRuntimeGatewayActivityNonce,
          }
        );
      }

      this.stateData.gatewayActivityNonceGap =
        proofPayload.gatewayActivityNonceRange.end - currentRuntimeGatewayActivityNonce;

      const tx = client.tx.crosschainTransfer.proveGatewayActivity(
        'Ethereum',
        proofPayload.previousGatewayActivityNonce,
        proofPayload.proof,
      );
      const estimatedFee = (await tx.paymentInfo(this.submitLane.address)).partialFee.toBigInt();
      const delegateBalance = await client.query.system
        .account(this.submitLane.address)
        .then(x => x.data.free.toBigInt());
      const existentialDeposit = client.consts.balances.existentialDeposit.toBigInt();
      const minimumRequiredBalance = estimatedFee + existentialDeposit;

      if (delegateBalance < minimumRequiredBalance) {
        return {
          outcome: 'Rejected',
          reason: `Vault delegate cannot afford Ethereum gateway relay. Balance=${delegateBalance} required=${minimumRequiredBalance}.`,
          estimatedFee,
          throughGatewayActivityNonce: proofPayload.activities.at(-1)?.gatewayState.gatewayActivityNonce,
        };
      }

      try {
        latestResponse = await this.submitLane.runExclusive(
          async (lockedClient, getNonce): Promise<IEthereumGatewayCatchUpResponse> => {
            const submitter = new TxSubmitter(lockedClient, tx, this.submitLane.keypair);
            const signedTx = await submitter.sign({ nonce: await getNonce() });
            const submitted = await submitter.submitSigned(signedTx);
            await submitted.waitForInFirstBlock;

            return {
              outcome: 'Submitted',
              delegateAddress: this.submitLane.address,
              argonTxHash: submitted.extrinsic.signedHash,
              extrinsicMethodJson: signedTx.method.toHuman(),
              txNonce: signedTx.nonce.toNumber(),
              txSubmittedAtBlockHeight: submitted.blockNumber ?? submitted.extrinsic.submittedAtBlockNumber,
              txSubmittedAtTime: submitted.extrinsic.submittedTime,
              estimatedFee,
              throughGatewayActivityNonce: proofPayload.activities.at(-1)?.gatewayState.gatewayActivityNonce,
            };
          },
        );
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        if (reason.includes('Transaction is outdated') || reason.includes('Invalid Transaction: Stale')) {
          this.submitLane.invalidateNonce();
          continue;
        }
        if (isRedundantCatchUpError(reason)) {
          return {
            outcome: 'Noop',
            throughGatewayActivityNonce: proofPayload.activities.at(-1)?.gatewayState.gatewayActivityNonce,
          };
        }

        return {
          outcome: 'Rejected',
          reason,
          estimatedFee,
          throughGatewayActivityNonce: proofPayload.activities.at(-1)?.gatewayState.gatewayActivityNonce,
        };
      }

      if (proofPayload.gatewayActivityNonceRange.end >= throughGatewayActivityNonce) {
        return latestResponse;
      }
    }
  }

  private async loadGatewayAddress(): Promise<Hex> {
    if (this.gatewayAddress) {
      return this.gatewayAddress;
    }

    this.gatewayAddressPromise ??= (async () => {
      const client = this.submitLane.client;
      if (!client) {
        throw new HttpError('Bot mainchain client is not ready.', 503);
      }

      const chainConfig = await client.query.crosschainTransfer.chainConfigBySourceChain('Ethereum');
      if (chainConfig.isNone || !chainConfig.unwrap().isEvm) {
        throw new HttpError('Ethereum transfer gateway is not configured on this network.', 503);
      }

      return chainConfig.unwrap().asEvm.gateway.toHex();
    })();

    try {
      this.gatewayAddress = await this.gatewayAddressPromise;
      return this.gatewayAddress;
    } finally {
      this.gatewayAddressPromise = undefined;
    }
  }

  private requireClient() {
    const client = this.submitLane.client;
    if (!client) {
      throw new HttpError('Bot mainchain client is not ready.', 503);
    }

    return client;
  }

  private requireExecutionRpcUrl(): string {
    const executionRpcUrl = NetworkConfig.get().ethereumNetwork.executionRpcUrl.trim() || undefined;
    if (!executionRpcUrl) {
      throw new HttpError('Ethereum execution RPC is not configured on this network.', 503);
    }

    return executionRpcUrl;
  }

  private async loadCurrentRuntimeGatewayActivityNonce(
    client: ReturnType<EthereumGatewayProverService['requireClient']>,
  ): Promise<bigint> {
    const gatewayState = await client.query.crosschainTransfer.gatewayStateBySourceChain('Ethereum');
    if (gatewayState.isNone) {
      return 0n;
    }

    return gatewayState.unwrap().gatewayActivityNonce.toBigInt();
  }

  private getRelaySweepMs(): number {
    if (this.options.backgroundSweepMs !== undefined) {
      return this.options.backgroundSweepMs;
    }

    const relaySweepMs = getEthereumFinalityMillisFromEnv();
    if (relaySweepMs !== undefined) {
      return relaySweepMs;
    }

    const finalityBlocks = NetworkConfig.get().ethereumNetwork.finalityBlocks;
    if (!Number.isFinite(finalityBlocks) || finalityBlocks <= 0) {
      throw new Error('Ethereum finality blocks are missing from the network config.');
    }

    return finalityBlocks * 12_000;
  }

  private async wait(ms: number): Promise<void> {
    if (!ms || this.shouldStop) {
      return;
    }

    const controller = new AbortController();
    this.sleepAbortController = controller;

    try {
      await delay(ms, undefined, { signal: controller.signal });
    } catch (error) {
      if (!isAbortError(error)) {
        throw error;
      }
    } finally {
      if (this.sleepAbortController === controller) {
        this.sleepAbortController = undefined;
      }
    }
  }
}

function isRedundantCatchUpError(reason: string): boolean {
  return (
    reason.includes('Priority is too low') ||
    reason.includes('Transaction is outdated') ||
    reason.includes('Invalid Transaction: Stale') ||
    reason.includes('Stale') ||
    reason.includes('Already imported')
  );
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function isCheckpointSatisfied(
  response: IEthereumGatewayCatchUpResponse,
  throughGatewayActivityNonce: bigint,
): boolean {
  return (
    response.throughGatewayActivityNonce !== undefined &&
    response.throughGatewayActivityNonce >= throughGatewayActivityNonce
  );
}

function getEthereumFinalityMillisFromEnv(): number | undefined {
  const raw = process.env.ETHEREUM_FINALITY_MILLIS?.trim();
  const value = Number.parseInt(raw ?? '', 10);

  if (!Number.isFinite(value) || value <= 0) {
    return undefined;
  }

  return value;
}

function getStallSweepWindow(
  client: { consts: { ethereumVerifier: { freeHeadersInterval: { toBigInt(): bigint } } } },
  operatorAddress: string,
  stalledSince: number,
  now: number,
): { windowIndex: number; stalledMs: number } | undefined {
  const rotationSlots = client.consts.ethereumVerifier.freeHeadersInterval.toBigInt();
  if (rotationSlots <= 0n) {
    throw new Error('Ethereum verifier free header interval must be positive.');
  }

  const rotationMs = Number(rotationSlots * 12_000n);
  if (!Number.isFinite(rotationMs) || rotationMs <= 0) {
    return;
  }

  const stalledMs = Math.max(0, now - stalledSince);
  const windowIndex = Math.floor(stalledMs / rotationMs);
  if (windowIndex < 1) {
    return;
  }

  const windowStart = stalledSince + windowIndex * rotationMs;
  const hash = createHash('sha256').update(`${operatorAddress}:${windowIndex}`).digest();
  const normalized = hash.readBigUInt64BE(0);
  const offsetMs = Number((normalized * BigInt(rotationMs)) / (1n << 64n));
  if (now < windowStart + offsetMs) {
    return;
  }

  return { windowIndex, stalledMs };
}
