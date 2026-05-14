import { setTimeout } from 'node:timers/promises';
import type { IEthereumSyncStatus } from '@argonprotocol/apps-core';
import {
  getEthereumBeaconSyncState,
  getNextEthereumBeaconSyncTxs,
  type ArgonClient,
  type KeyringPair,
  TxSubmitter,
} from '@argonprotocol/mainchain';

type IEthereumBeaconSyncServiceOptions = {
  beaconApiUrl?: string;
  pollMs?: number;
  syncKeypair: KeyringPair;
};

export class EthereumBeaconSyncService {
  private loopPromise?: Promise<void>;
  private shouldStop = false;
  private readonly pollMs: number;
  private readonly stateData: IEthereumSyncStatus;

  constructor(
    private readonly client: ArgonClient,
    private readonly options: IEthereumBeaconSyncServiceOptions,
  ) {
    this.pollMs = options.pollMs ?? 30_000;
    this.stateData = {
      mode: this.isEnabled ? 'idle' : 'disabled',
      syncAccountAddress: options.syncKeypair.address,
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
  }

  public async runOnce(): Promise<void> {
    if (!this.isEnabled) {
      this.stateData.mode = 'disabled';
      return;
    }

    try {
      await this.runOnceInner();
    } catch (error) {
      this.recordError(error);
    }
  }

  private get isEnabled(): boolean {
    return Boolean(this.options.beaconApiUrl);
  }

  private async loop(): Promise<void> {
    while (!this.shouldStop) {
      await setTimeout(this.pollMs);
      if (this.shouldStop) break;
      await this.runOnce();
    }
  }

  private async runOnceInner(): Promise<void> {
    const beaconApiUrl = this.options.beaconApiUrl!;
    const syncKeypair = this.options.syncKeypair;
    const syncState = await getEthereumBeaconSyncState(this.client);

    this.stateData.latestSyncCommitteeUpdatePeriod = syncState.latestSyncCommitteeUpdatePeriod;
    delete this.stateData.lastError;

    if (!syncState.isBootstrapped) {
      this.stateData.mode = 'needsBootstrap';
      delete this.stateData.latestFinalizedSlot;
      return;
    }

    this.stateData.latestFinalizedSlot = syncState.latestFinalizedSlot;
    const txs = await getNextEthereumBeaconSyncTxs(this.client, beaconApiUrl);

    if (!txs.length) {
      this.stateData.mode = 'idle';
      return;
    }

    this.stateData.mode = 'submitting';
    const submittedTxs = [];

    for (const tx of txs) {
      if (this.shouldStop) return;

      const result = await new TxSubmitter(this.client, tx, syncKeypair).submit({
        useLatestNonce: true,
      });
      this.stateData.lastSubmittedTxHash = result.extrinsic.signedHash;
      submittedTxs.push(result);
    }

    await Promise.all(submittedTxs.map(x => x.waitForInFirstBlock));

    const refreshedState = await getEthereumBeaconSyncState(this.client);
    this.stateData.latestSyncCommitteeUpdatePeriod = refreshedState.latestSyncCommitteeUpdatePeriod;
    this.stateData.latestFinalizedSlot = refreshedState.isBootstrapped ? refreshedState.latestFinalizedSlot : undefined;
    this.stateData.mode = refreshedState.isBootstrapped ? 'idle' : 'needsBootstrap';
  }

  private recordError(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.stateData.mode = 'error';
    this.stateData.lastError = message;
    console.error('[EthereumBeaconSyncService] Error syncing beacon headers', error);
  }
}
