import {
  BitcoinLock,
  type ArgonClient,
  type ArgonQueryClient,
  type BlockWatch,
  type Currency,
  type IBlockHeaderInfo,
  type RuntimeSystemEventRecord,
} from '@argonprotocol/apps-core';
import { hexToU8a, u8aToHex } from '@argonprotocol/mainchain';
import { toRuntimeEvent } from '@argonprotocol/runtime-client';

import { BitcoinLockStatus, type IBitcoinLockRecord } from '../interfaces/IBitcoinLockRecord.ts';
import {
  BitcoinReleaseKind,
  BitcoinReleaseStatus,
  type IBitcoinReleaseRecord,
} from '../interfaces/IBitcoinReleaseRecord.ts';
import {
  BitcoinUtxoSpendStatus,
  BitcoinUtxoStatus,
  type IBitcoinUtxoRecord,
} from '../interfaces/IBitcoinUtxoRecord.ts';
import type BitcoinUtxoTracking from './BitcoinUtxoTracking.ts';
import type BitcoinLocks from './BitcoinLocks.ts';
import type BitcoinMempool from './BitcoinMempool.ts';
import type { Db } from './Db.ts';
import { getMainchainClient } from '../stores/mainchain.ts';
import { getTransactionFailureMessage, type TransactionInfo } from './TransactionInfo.ts';
import type { TransactionTracker } from './TransactionTracker.ts';
import { ExtrinsicType, TransactionStatus } from './db/TransactionsTable.ts';
import { isWalletSigningUnavailableError, type WalletKeys } from './WalletKeys.ts';

const releaseProgress: Partial<Record<BitcoinReleaseStatus, number>> = {
  [BitcoinReleaseStatus.SubmittingRequestOnArgon]: 0,
  [BitcoinReleaseStatus.WaitingForVaultCosign]: 1,
  [BitcoinReleaseStatus.ReadyForBitcoinBroadcast]: 2,
  [BitcoinReleaseStatus.ConfirmingOnBitcoin]: 3,
  [BitcoinReleaseStatus.WaitingForArgonRecognition]: 4,
  [BitcoinReleaseStatus.Complete]: 5,
};

export default class BitcoinReleases {
  public data: { releasesById: Record<string, IBitcoinReleaseRecord> } = { releasesById: {} };
  private readonly reportedMissingReleaseForLocks = new Set<string>();
  #orphanCosignCounterSubscriptions = new Map<string, () => void>();
  #orphanEventScanFromBlock?: number;
  #orphanEventScanThroughBlock?: number;

  constructor(
    private readonly bitcoinLocks: BitcoinLocks,
    private readonly dbPromise: Promise<Db>,
    private readonly utxoTracking: BitcoinUtxoTracking,
    private readonly mempool: BitcoinMempool,
    private readonly walletKeys: WalletKeys,
    private readonly currency: Currency,
    private readonly blockWatch: BlockWatch,
    private readonly transactionTracker: TransactionTracker,
  ) {}

  public async load(): Promise<void> {
    const db = await this.dbPromise;
    const releases = await db.bitcoinReleasesTable.fetchAll();
    this.data.releasesById = Object.fromEntries(releases.map(release => [release.id, release]));
  }

  public getById(id: string): IBitcoinReleaseRecord | undefined {
    return this.data.releasesById[id];
  }

  public getActiveForLock(lock: IBitcoinLockRecord): IBitcoinReleaseRecord | undefined {
    return lock.activeReleaseId ? this.getById(lock.activeReleaseId) : undefined;
  }

  public getActiveForUtxo(utxo: Pick<IBitcoinUtxoRecord, 'activeReleaseId'>): IBitcoinReleaseRecord | undefined {
    return utxo.activeReleaseId ? this.getById(utxo.activeReleaseId) : undefined;
  }

  public getActiveOrphanReleases(): IBitcoinReleaseRecord[] {
    return Object.values(this.data.releasesById).filter(release => {
      const inputUtxo =
        release.inputUtxoIds.length === 1 ? this.utxoTracking.getUtxoRecordById(release.inputUtxoIds[0]) : undefined;
      return (
        release.kind === BitcoinReleaseKind.Orphan &&
        inputUtxo?.activeReleaseId === release.id &&
        release.status !== BitcoinReleaseStatus.Complete &&
        release.status !== BitcoinReleaseStatus.Cancelled &&
        release.status !== BitcoinReleaseStatus.Failed
      );
    });
  }

  public getLatestForLock(lock: IBitcoinLockRecord): IBitcoinReleaseRecord | undefined {
    return Object.values(this.data.releasesById)
      .filter(release => release.kind === BitcoinReleaseKind.Lock && release.lockId === lock.lockId)
      .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime())[0];
  }

  public getLatestForUtxo(utxo: Pick<IBitcoinUtxoRecord, 'id' | 'lockId'>): IBitcoinReleaseRecord | undefined {
    return Object.values(this.data.releasesById)
      .filter(
        release =>
          release.kind === BitcoinReleaseKind.Orphan &&
          release.lockId === utxo.lockId &&
          release.inputUtxoIds.includes(utxo.id),
      )
      .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime())[0];
  }

  public getInputUtxos(release: IBitcoinReleaseRecord): IBitcoinUtxoRecord[] {
    return release.inputUtxoIds.map(id => {
      const utxo = this.utxoTracking.getUtxoRecordById(id);
      if (!utxo || utxo.lockId !== release.lockId) {
        throw new Error(`Bitcoin release ${release.id} has an unavailable input UTXO ${id}`);
      }
      return utxo;
    });
  }

  public async createLockRelease(
    lock: IBitcoinLockRecord,
    release: Omit<IBitcoinReleaseRecord, 'createdAt' | 'updatedAt'>,
  ): Promise<IBitcoinReleaseRecord> {
    if (release.kind !== BitcoinReleaseKind.Lock || !lock.lockId || release.lockId !== lock.lockId) {
      throw new Error('Bitcoin release does not belong to the selected lock.');
    }
    if (lock.activeReleaseId && lock.activeReleaseId !== release.id) {
      throw new Error(`Bitcoin lock ${lock.lockId} already has an active release`);
    }

    if (
      release.inputUtxoIds.length !== lock.fundingUtxoIds.length ||
      release.inputUtxoIds.some((id, index) => id !== lock.fundingUtxoIds[index])
    ) {
      throw new Error(`Bitcoin release ${release.id} does not match the Lock's current funding inputs`);
    }

    const inputUtxos = release.inputUtxoIds.map(id => {
      const utxo = this.utxoTracking.getUtxoRecordById(id);
      if (!utxo || utxo.lockId !== lock.lockId) {
        throw new Error(`Bitcoin release ${release.id} has an unavailable input UTXO ${id}`);
      }
      if (utxo.activeReleaseId && utxo.activeReleaseId !== release.id) {
        throw new Error(`Bitcoin UTXO ${id} already belongs to release ${utxo.activeReleaseId}`);
      }
      if (utxo.spendStatus === BitcoinUtxoSpendStatus.Spent) {
        throw new Error(`Bitcoin UTXO ${id} is already spent`);
      }
      return utxo;
    });

    const db = await this.dbPromise;
    const lockDraft = { ...lock };
    const utxoDrafts = inputUtxos.map(utxo => ({ ...utxo }));
    const persisted = await db.transaction(async transaction => {
      const persisted = await transaction.bitcoinReleasesTable.insert(release);
      if (
        persisted.kind !== release.kind ||
        persisted.lockId !== release.lockId ||
        persisted.toScriptPubkey !== release.toScriptPubkey ||
        persisted.bitcoinNetworkFee !== release.bitcoinNetworkFee ||
        persisted.inputUtxoIds.length !== release.inputUtxoIds.length ||
        persisted.inputUtxoIds.some((id, index) => id !== release.inputUtxoIds[index])
      ) {
        throw new Error(`Bitcoin release ${release.id} already contains a different request`);
      }
      await transaction.bitcoinLocksTable.setActiveRelease(lockDraft, release.id);
      for (const utxo of utxoDrafts) await transaction.bitcoinUtxosTable.setActiveRelease(utxo, release.id);
      return persisted;
    });

    Object.assign(lock, lockDraft);
    utxoDrafts.forEach((utxo, index) => Object.assign(inputUtxos[index], utxo));
    this.data.releasesById[persisted.id] = persisted;
    return persisted;
  }

  public async createOrphanRelease(
    utxo: IBitcoinUtxoRecord,
    release: Omit<IBitcoinReleaseRecord, 'createdAt' | 'updatedAt'>,
  ): Promise<IBitcoinReleaseRecord> {
    if (
      release.kind !== BitcoinReleaseKind.Orphan ||
      release.lockId !== utxo.lockId ||
      release.inputUtxoIds.length !== 1 ||
      release.inputUtxoIds[0] !== utxo.id
    ) {
      throw new Error('Bitcoin orphan release does not belong to the selected UTXO.');
    }
    if (utxo.status !== BitcoinUtxoStatus.Orphaned || utxo.spendStatus === BitcoinUtxoSpendStatus.Spent) {
      throw new Error('This orphan return is not currently available.');
    }
    if (utxo.activeReleaseId && utxo.activeReleaseId !== release.id) {
      throw new Error(`Bitcoin UTXO ${utxo.id} already belongs to release ${utxo.activeReleaseId}`);
    }

    const db = await this.dbPromise;
    const utxoDraft = { ...utxo };
    const persisted = await db.transaction(async transaction => {
      const persisted = await transaction.bitcoinReleasesTable.insert(release);
      if (
        persisted.kind !== release.kind ||
        persisted.lockId !== release.lockId ||
        persisted.toScriptPubkey !== release.toScriptPubkey ||
        persisted.bitcoinNetworkFee !== release.bitcoinNetworkFee ||
        persisted.inputUtxoIds.length !== 1 ||
        persisted.inputUtxoIds[0] !== utxo.id
      ) {
        throw new Error(`Bitcoin release ${release.id} already contains a different request`);
      }
      await transaction.bitcoinUtxosTable.setActiveRelease(utxoDraft, release.id);
      return persisted;
    });

    Object.assign(utxo, utxoDraft);
    this.data.releasesById[persisted.id] = persisted;
    return persisted;
  }

  public async recordArgonRequest(
    release: IBitcoinReleaseRecord,
    facts: Pick<IBitcoinReleaseRecord, 'requestedReleaseAtTick'> &
      Partial<Pick<IBitcoinReleaseRecord, 'insuredMicrogons' | 'argonTxFeeMicrogons'>>,
  ): Promise<void> {
    await this.advance(release, BitcoinReleaseStatus.WaitingForVaultCosign, facts);
  }

  public async recordVaultCosign(
    release: IBitcoinReleaseRecord,
    facts: Pick<IBitcoinReleaseRecord, 'vaultSignatures'> & Partial<Pick<IBitcoinReleaseRecord, 'cosignBlockNumber'>>,
  ): Promise<void> {
    if (facts.vaultSignatures.length !== release.inputUtxoIds.length) {
      throw new Error(
        `Bitcoin release ${release.id} has ${facts.vaultSignatures.length} signatures for ${release.inputUtxoIds.length} inputs`,
      );
    }
    await this.advance(release, BitcoinReleaseStatus.ReadyForBitcoinBroadcast, facts);
  }

  public async recordCompensation(release: IBitcoinReleaseRecord, compensationMicrogons: bigint): Promise<void> {
    await this.update(release, { compensationMicrogons });
  }

  public async recordBitcoinBroadcast(
    release: IBitcoinReleaseRecord,
    facts: Pick<
      IBitcoinReleaseRecord,
      'bitcoinTxid' | 'bitcoinFirstSeenAt' | 'bitcoinFirstSeenHeight' | 'bitcoinFirstSeenOracleHeight'
    >,
  ): Promise<void> {
    await this.advance(release, BitcoinReleaseStatus.ConfirmingOnBitcoin, facts);
  }

  public async recordPreparedBitcoinTransaction(release: IBitcoinReleaseRecord, bitcoinTxid: string): Promise<void> {
    await this.update(release, { bitcoinTxid, statusError: undefined });
  }

  public async recordBitcoinConfirmation(
    release: IBitcoinReleaseRecord,
    facts: Pick<IBitcoinReleaseRecord, 'bitcoinConfirmedHeight'>,
  ): Promise<void> {
    await this.advance(release, BitcoinReleaseStatus.WaitingForArgonRecognition, facts);
  }

  public async recordBitcoinConfirmationCheck(
    release: IBitcoinReleaseRecord,
    bitcoinLastConfirmationCheckOracleHeight: number,
  ): Promise<void> {
    await this.update(release, {
      bitcoinLastConfirmationCheckAt: new Date(),
      bitcoinLastConfirmationCheckOracleHeight,
    });
  }

  public async recordRetryableError(release: IBitcoinReleaseRecord, error: unknown): Promise<void> {
    await this.update(release, { statusError: String(error) });
  }

  public async finalizeLockRequest(
    lock: IBitcoinLockRecord,
    releaseId: string,
    blockHash: Uint8Array,
    argonTxFeeMicrogons: bigint,
  ): Promise<void> {
    await this.bitcoinLocks.runInQueueForLock(
      lock,
      async () => {
        if (this.bitcoinLocks.isTerminalLock(lock)) return;
        const release = this.getById(releaseId);
        if (!release || lock.activeReleaseId !== release.id) return;

        const client = await getMainchainClient(true);
        const api = await client.at(blockHash);
        const request = await BitcoinLock.getReleaseRequest(api, lock.lockId!);
        if (!request) {
          console.warn(`[BitcoinReleases] Missing canonical release request for ${lock.uuid} after finalization`);
          return;
        }
        const currentTick = await api.query.ticks.currentTick();
        if (currentTick === null) return;
        if (
          request.toScriptPubkey !== release.toScriptPubkey ||
          request.bitcoinNetworkFee !== release.bitcoinNetworkFee
        ) {
          throw new Error(`Bitcoin release ${release.id} does not match its finalized Argon request`);
        }
        await this.recordArgonRequest(release, {
          requestedReleaseAtTick: Number(currentTick),
          insuredMicrogons: request.insuredMicrogons,
          argonTxFeeMicrogons,
        });
      },
      { waitForHistoryRecovery: true },
    );
    this.bitcoinLocks.publishFinancialRevision();
  }

  public async finalizeOrphanRequest(release: IBitcoinReleaseRecord, blockHash: Uint8Array): Promise<void> {
    if (
      release.kind !== BitcoinReleaseKind.Orphan ||
      release.status !== BitcoinReleaseStatus.SubmittingRequestOnArgon
    ) {
      return;
    }

    const client = await getMainchainClient(true);
    const api = await client.at(blockHash);
    const currentTick = await api.query.ticks.currentTick();
    if (currentTick === null) throw new Error(`Bitcoin release ${release.id} finalized without a current tick`);

    await this.recordArgonRequest(release, { requestedReleaseAtTick: Number(currentTick) });
    await this.syncOrphanCosignCounterSubscriptions(client);

    const lock = this.bitcoinLocks.getLockById(release.lockId);
    if (lock) await this.reconcileOrphanReleases(lock);
  }

  public async reconcileLockRelease(lock: IBitcoinLockRecord, hasNewOracleBitcoinBlockHeight: boolean): Promise<void> {
    if (this.bitcoinLocks.isTerminalLock(lock)) return;

    let release = this.getActiveForLock(lock);
    if (!release) {
      this.reportMissingReleaseForLock(lock);
      return;
    }

    let archiveClient: ArgonClient | undefined;
    const getArchiveClient = async (): Promise<ArgonClient> => {
      archiveClient ??= await getMainchainClient(true);
      return archiveClient;
    };

    if (release.status === BitcoinReleaseStatus.SubmittingRequestOnArgon) {
      await this.syncLockArgonRequest(lock, await getArchiveClient()).catch(error => {
        console.warn(`[BitcoinReleases] Error syncing release request for ${lock.uuid}`, error);
      });
      release = this.getActiveForLock(lock) ?? release;
    }

    if (release.status === BitcoinReleaseStatus.WaitingForVaultCosign) {
      await this.syncLockVaultCosign(lock, await getArchiveClient()).catch(error => {
        console.warn(`[BitcoinReleases] Error syncing release cosign for ${lock.uuid}`, error);
      });
      release = this.getActiveForLock(lock) ?? release;
    }

    if (release.status === BitcoinReleaseStatus.ReadyForBitcoinBroadcast && this.walletKeys.canSign) {
      await this.submitLockToBitcoin(lock, release).catch(error => {
        console.warn(`[BitcoinReleases] Error submitting release to Bitcoin for ${lock.uuid}`, error);
      });
      release = this.getActiveForLock(lock) ?? release;
    }

    if (release.status === BitcoinReleaseStatus.ConfirmingOnBitcoin) {
      const confirmingRelease = release;
      if (hasNewOracleBitcoinBlockHeight) {
        await this.recordBitcoinConfirmationCheck(
          confirmingRelease,
          this.bitcoinLocks.data.oracleBitcoinBlockHeight,
        ).catch(error =>
          console.warn(`[BitcoinReleases] Error updating release confirmation check for ${lock.uuid}`, error),
        );
      }

      await this.syncLockBitcoinConfirmation(confirmingRelease).catch(async error => {
        await this.recordRetryableError(confirmingRelease, error);
        console.warn(`[BitcoinReleases] Error syncing release completion for ${lock.uuid}`, error);
      });
      release = this.getActiveForLock(lock) ?? confirmingRelease;
    }

    if (release.status === BitcoinReleaseStatus.WaitingForArgonRecognition && release.cosignBlockNumber !== undefined) {
      await this.completeCosignedLockRelease(lock, release, await getArchiveClient()).catch(async error => {
        await this.recordRetryableError(release, error);
        console.warn(`[BitcoinReleases] Error finalizing cosigned release for ${lock.uuid}`, error);
      });
    }
  }

  public async reconcileOrphanReleases(lock: IBitcoinLockRecord): Promise<void> {
    const releases = this.getActiveOrphanReleases().filter(release => release.lockId === lock.lockId);

    for (let release of releases) {
      const utxo = this.getInputUtxos(release)[0];
      if (!utxo || utxo.activeReleaseId !== release.id) continue;

      if (release.status === BitcoinReleaseStatus.SubmittingRequestOnArgon) {
        const txInfo = this.getOrphanTransactionInfo(release);
        const txFailure = getTransactionFailureMessage(txInfo);

        if (!txInfo || txFailure) {
          const recoveredFromChain = await this.syncOrphanRequestFromChain(lock, utxo, release);
          if (!recoveredFromChain) {
            await this.recordRetryableError(
              release,
              txFailure ?? 'Orphan return was interrupted before submission. Please retry the return.',
            );
            continue;
          }
        } else {
          if (txInfo.tx.status !== TransactionStatus.Finalized) continue;
          const blockHash = txInfo.tx.blockHash ?? (await txInfo.txResult.waitForInFirstBlock);
          await this.finalizeOrphanRequest(release, typeof blockHash === 'string' ? hexToU8a(blockHash) : blockHash);
        }
        release = this.getById(release.id) ?? release;
      }

      if (release.status === BitcoinReleaseStatus.WaitingForVaultCosign && this.walletKeys.canSign) {
        await this.syncOrphanVaultCosign(lock, release);
        release = this.getById(release.id) ?? release;
      }

      if (release.status === BitcoinReleaseStatus.ReadyForBitcoinBroadcast && this.walletKeys.canSign) {
        await this.submitOrphanToBitcoin(lock, release);
      }
    }
  }

  public async syncOrphanBitcoinProcessing(oracleBitcoinBlockHeight: number): Promise<void> {
    const tasks = this.getActiveOrphanReleases()
      .filter(release => release.status === BitcoinReleaseStatus.ConfirmingOnBitcoin && release.bitcoinTxid)
      .map(async release => {
        const utxo = this.getInputUtxos(release)[0];
        if (!utxo || utxo.activeReleaseId !== release.id || !release.bitcoinTxid) return;

        try {
          await this.recordBitcoinConfirmationCheck(release, oracleBitcoinBlockHeight);
        } catch (error) {
          console.warn('[BitcoinReleases] Error updating orphan return confirmation check', error);
        }

        const status = await this.mempool
          .getTxStatus(release.bitcoinTxid, oracleBitcoinBlockHeight)
          .catch(() => undefined);
        if (status?.isConfirmed) {
          await this.completeOrphanRelease(utxo, release, status.transactionBlockHeight);
        }
      });

    await Promise.allSettled(tasks);
  }

  public async syncOrphanVaultCosign(lock: IBitcoinLockRecord, release: IBitcoinReleaseRecord): Promise<void> {
    if (release.kind !== BitcoinReleaseKind.Orphan || release.status !== BitcoinReleaseStatus.WaitingForVaultCosign) {
      return;
    }

    const utxo = this.getInputUtxos(release)[0];
    if (!utxo || utxo.activeReleaseId !== release.id) return;
    const signature = await this.bitcoinLocks.myVault?.createVaultSignatureForMyOrphanedUtxoRelease({
      lock,
      txid: utxo.txid,
      vout: utxo.vout,
      satoshis: utxo.satoshis,
      toScriptPubkey: release.toScriptPubkey,
      bitcoinNetworkFee: release.bitcoinNetworkFee,
    });
    if (signature) await this.recordVaultCosign(release, { vaultSignatures: [signature] });
  }

  public async syncOrphanCosignCounterSubscriptions(client: ArgonClient): Promise<void> {
    const subscriptions = new Map<string, { vaultId: number; ownerAccount: string }>();

    for (const release of this.getActiveOrphanReleases()) {
      if (release.status !== BitcoinReleaseStatus.WaitingForVaultCosign) continue;
      const lock = this.bitcoinLocks.getLockById(release.lockId);
      if (!lock?.ownerAccount) continue;
      subscriptions.set(`${lock.vaultId}:${lock.ownerAccount}`, {
        vaultId: lock.vaultId,
        ownerAccount: lock.ownerAccount,
      });
    }

    for (const [key, { vaultId, ownerAccount }] of subscriptions) {
      if (this.#orphanCosignCounterSubscriptions.has(key)) continue;

      let previousCount: number | undefined;
      const unsubscribe = await client.query.vaults.orphanedUtxoAccountsByVaultId(vaultId, ownerAccount, count => {
        const nextCount = count;
        if (previousCount !== undefined && nextCount < previousCount) {
          const bestBlockNumber = this.blockWatch.bestBlockHeader.blockNumber;
          const scanThroughBlock = bestBlockNumber + 1;
          const latestProcessedBlock = this.bitcoinLocks.data.latestArgonBlock?.blockNumber ?? bestBlockNumber - 1;
          const scanFromBlock = Math.max(1, Math.min(latestProcessedBlock + 1, bestBlockNumber));

          this.#orphanEventScanFromBlock = Math.min(this.#orphanEventScanFromBlock ?? scanFromBlock, scanFromBlock);
          this.#orphanEventScanThroughBlock = Math.max(
            this.#orphanEventScanThroughBlock ?? scanThroughBlock,
            scanThroughBlock,
          );
        }
        previousCount = nextCount;
      });
      this.#orphanCosignCounterSubscriptions.set(key, unsubscribe);
    }

    for (const [key, unsubscribe] of this.#orphanCosignCounterSubscriptions) {
      if (subscriptions.has(key)) continue;
      unsubscribe();
      this.#orphanCosignCounterSubscriptions.delete(key);
    }
  }

  public async recoverPendingOrphanCosignEvents(settledThroughBlock: number): Promise<void> {
    const requestedThroughBlock = this.#orphanEventScanThroughBlock;
    if (this.#orphanEventScanFromBlock === undefined || requestedThroughBlock === undefined) return;

    const scanThroughBlock = Math.min(requestedThroughBlock, settledThroughBlock);
    if (this.#orphanEventScanFromBlock > scanThroughBlock) return;

    const locksToReconcile = new Set<IBitcoinLockRecord>();
    while (this.#orphanEventScanFromBlock !== undefined && this.#orphanEventScanFromBlock <= scanThroughBlock) {
      const block = await this.blockWatch.getHeaderByBlockNumber(this.#orphanEventScanFromBlock);
      const events = await this.blockWatch.getEvents(block);
      for (const { event } of events) {
        const runtimeEvent = toRuntimeEvent(event);
        if (runtimeEvent?.section !== 'bitcoinLocks' || runtimeEvent.method !== 'OrphanedUtxoCosigned') continue;

        const lockId = runtimeEvent.data.lockId ?? runtimeEvent.data.utxoId;
        const { accountId, signature, utxoRef } = runtimeEvent.data;
        if (lockId === undefined) continue;
        const lock = this.bitcoinLocks.getLockById(lockId);
        if (!lock || (accountId && accountId !== lock.ownerAccount)) continue;
        const utxo = this.utxoTracking.getUtxoRecord(lockId, utxoRef.txid, utxoRef.outputIndex);
        if (!utxo) continue;
        const release = this.getActiveForUtxo(utxo);
        if (!release || release.kind !== BitcoinReleaseKind.Orphan) continue;

        await this.recordVaultCosign(release, {
          vaultSignatures: [signature],
          cosignBlockNumber: block.blockNumber,
        });
        locksToReconcile.add(lock);
      }
      this.#orphanEventScanFromBlock = block.blockNumber + 1;
    }

    if (this.#orphanEventScanFromBlock > requestedThroughBlock) {
      this.#orphanEventScanFromBlock = undefined;
      this.#orphanEventScanThroughBlock = undefined;
    }

    for (const lock of locksToReconcile) await this.reconcileOrphanReleases(lock);
  }

  public shutdown(): void {
    for (const unsubscribe of this.#orphanCosignCounterSubscriptions.values()) unsubscribe();
    this.#orphanCosignCounterSubscriptions.clear();
  }

  public async completeLockReleaseFromArgon(
    lock: IBitcoinLockRecord,
    release: IBitcoinReleaseRecord,
    block: IBlockHeaderInfo,
    api: ArgonQueryClient,
    eventRecord: RuntimeSystemEventRecord,
  ): Promise<void> {
    const rates = await this.currency.fetchMainchainRatesAtBlock({ api, block }).catch(error => {
      console.warn(`[BitcoinReleases] Unable to load removal price for ${lock.uuid}`, error);
      return undefined;
    });
    const extrinsicIndex = eventRecord.phase.type === 'ApplyExtrinsic' ? eventRecord.phase.value : undefined;
    const blockTime = new Date(block.blockTime);

    await this.completeLockRelease(
      lock,
      release,
      {
        argonCompletionBlockNumber: block.blockNumber,
        argonCompletionBlockHash: block.blockHash,
        argonCompletionBlockTime: blockTime,
        argonCompletionExtrinsicIndex: extrinsicIndex,
      },
      {
        removalBlockNumber: block.blockNumber,
        removalBlockHash: block.blockHash,
        removalBlockTime: blockTime,
        removalExtrinsicIndex: extrinsicIndex,
        removalReason: 'released',
        btcPriceAtRemovalMicrogons: rates?.BTC,
      },
    );
  }

  public async buildLockBitcoinTransaction(
    lock: IBitcoinLockRecord,
    release: IBitcoinReleaseRecord,
    addTx?: string,
  ): Promise<{ txid: string; bytes: Uint8Array }> {
    if (lock.cosignVersion !== 'v1') {
      throw new Error(`Unsupported cosign version: ${lock.cosignVersion}`);
    }

    const fundingUtxos = this.getInputUtxos(release);
    if (release.vaultSignatures.length !== fundingUtxos.length) {
      throw new Error(`Bitcoin release ${release.id} cosignature count does not match its input count`);
    }
    const outpoints = new Set<string>();
    for (const record of fundingUtxos) {
      const outpoint = `${record.txid}:${record.vout}`;
      if (outpoints.has(outpoint)) {
        throw new Error(`Bitcoin lock ${lock.lockId} has duplicate funding UTXO ${outpoint}`);
      }
      outpoints.add(outpoint);
    }

    const cosign = this.bitcoinLocks.createCosignScript({ lock, fundedSatoshis: lock.fundedSatoshis });
    const tx = cosign.cosignAndGenerateTx({
      releaseRequest: {
        toScriptPubkey: release.toScriptPubkey,
        bitcoinNetworkFee: release.bitcoinNetworkFee,
      },
      vaultCosignatures: release.vaultSignatures,
      utxos: fundingUtxos.map(record => ({
        utxoRef: { txid: record.txid, vout: record.vout },
        satoshis: record.satoshis,
      })),
      ownerXpriv: await this.walletKeys.getBitcoinChildXpriv(lock.hdPath, this.bitcoinLocks.bitcoinNetwork),
      addTx,
    });
    if (!tx?.isFinal) {
      throw new Error(`Failed to build finalized release transaction for lock ${lock.lockId}`);
    }
    return { bytes: tx.toBytes(true, true), txid: `0x${tx.hash}` };
  }

  public async completeLockRelease(
    lock: IBitcoinLockRecord,
    release: IBitcoinReleaseRecord,
    completion: Pick<
      IBitcoinReleaseRecord,
      | 'argonCompletionBlockNumber'
      | 'argonCompletionBlockHash'
      | 'argonCompletionBlockTime'
      | 'argonCompletionExtrinsicIndex'
    >,
    removal: Pick<
      IBitcoinLockRecord,
      | 'removalBlockNumber'
      | 'removalBlockHash'
      | 'removalBlockTime'
      | 'removalExtrinsicIndex'
      | 'removalReason'
      | 'btcPriceAtRemovalMicrogons'
    >,
  ): Promise<void> {
    if (release.kind !== BitcoinReleaseKind.Lock || lock.activeReleaseId !== release.id) return;

    const inputUtxos = this.getInputUtxos(release);
    const releaseDraft = { ...release };
    const lockDraft = { ...lock };
    const utxoDrafts = inputUtxos.map(utxo => ({ ...utxo }));
    const db = await this.dbPromise;
    await db.transaction(async transaction => {
      await transaction.bitcoinReleasesTable.update(releaseDraft, {
        ...completion,
        status: BitcoinReleaseStatus.Complete,
        statusError: undefined,
      });
      await transaction.bitcoinLocksTable.recordRemoval(lockDraft, BitcoinLockStatus.Released, removal);
      await transaction.bitcoinLocksTable.setReleased(lockDraft);
      for (const utxo of utxoDrafts) await transaction.bitcoinUtxosTable.setSpent(utxo, release.id);
    });

    Object.assign(release, releaseDraft);
    Object.assign(lock, lockDraft);
    utxoDrafts.forEach((utxo, index) => Object.assign(inputUtxos[index], utxo));
    this.data.releasesById[release.id] = release;
  }

  public async completeOrphanRelease(
    utxo: IBitcoinUtxoRecord,
    release: IBitcoinReleaseRecord,
    bitcoinConfirmedHeight: number,
  ): Promise<void> {
    if (
      release.kind !== BitcoinReleaseKind.Orphan ||
      utxo.activeReleaseId !== release.id ||
      release.inputUtxoIds.length !== 1 ||
      release.inputUtxoIds[0] !== utxo.id
    ) {
      return;
    }

    const releaseDraft = { ...release };
    const utxoDraft = { ...utxo };
    const db = await this.dbPromise;
    await db.transaction(async transaction => {
      await transaction.bitcoinReleasesTable.update(releaseDraft, {
        status: BitcoinReleaseStatus.Complete,
        bitcoinConfirmedHeight,
        statusError: undefined,
      });
      await transaction.bitcoinUtxosTable.setSpent(utxoDraft, release.id);
    });

    Object.assign(release, releaseDraft);
    Object.assign(utxo, utxoDraft);
    this.data.releasesById[release.id] = release;
  }

  public async failRelease(release: IBitcoinReleaseRecord, error: unknown): Promise<void> {
    const db = await this.dbPromise;
    const failed = await db.transaction(async transaction => {
      const releaseDraft = await transaction.bitcoinReleasesTable.getById(release.id);
      if (!releaseDraft || releaseDraft.status !== BitcoinReleaseStatus.SubmittingRequestOnArgon) return;

      const inputIds = new Set(releaseDraft.inputUtxoIds);
      const utxoDrafts = (await transaction.bitcoinUtxosTable.fetchByLockId(releaseDraft.lockId)).filter(utxo =>
        inputIds.has(utxo.id),
      );
      let lockDraft: IBitcoinLockRecord | undefined;
      if (releaseDraft.kind === BitcoinReleaseKind.Lock) {
        lockDraft = await transaction.bitcoinLocksTable.getByLockId(releaseDraft.lockId);
        if (!lockDraft || lockDraft.activeReleaseId !== releaseDraft.id) return;
      } else if (utxoDrafts.length !== 1 || utxoDrafts[0].activeReleaseId !== releaseDraft.id) {
        return;
      }

      await transaction.bitcoinReleasesTable.update(releaseDraft, {
        status: BitcoinReleaseStatus.Failed,
        statusError: String(error),
      });
      if (lockDraft) {
        await transaction.bitcoinLocksTable.clearActiveRelease(lockDraft, BitcoinLockStatus.LockFunded);
      }
      for (const utxo of utxoDrafts) await transaction.bitcoinUtxosTable.setActiveRelease(utxo, undefined);
      return { releaseDraft, lockDraft, utxoDrafts };
    });
    if (!failed) return;

    Object.assign(release, failed.releaseDraft);
    Object.assign(this.data.releasesById[release.id] ?? release, failed.releaseDraft);
    for (const utxo of failed.utxoDrafts) {
      const currentUtxo = this.utxoTracking.getUtxoRecordById(utxo.id);
      if (currentUtxo) Object.assign(currentUtxo, utxo);
    }
    if (failed.lockDraft) {
      const currentLock = this.bitcoinLocks.getLockById(failed.lockDraft.lockId!);
      if (currentLock) Object.assign(currentLock, failed.lockDraft);
    }
  }

  private async submitLockToBitcoin(lock: IBitcoinLockRecord, release: IBitcoinReleaseRecord): Promise<void> {
    if (this.bitcoinLocks.isTerminalLock(lock) || release.status !== BitcoinReleaseStatus.ReadyForBitcoinBroadcast) {
      return;
    }

    try {
      const { bytes, txid } = await this.buildLockBitcoinTransaction(lock, release);
      if (release.bitcoinTxid && release.bitcoinTxid !== txid) {
        throw new Error(`Bitcoin release ${release.id} rebuilt a different transaction`);
      }
      if (!release.bitcoinTxid) await this.recordPreparedBitcoinTransaction(release, txid);

      const oracleBitcoinBlockHeight = this.bitcoinLocks.data.oracleBitcoinBlockHeight;
      const existingTxStatus = await this.mempool.getTxStatus(txid, oracleBitcoinBlockHeight);
      if (existingTxStatus?.isConfirmed) {
        await this.recordBitcoinBroadcast(release, {
          bitcoinTxid: txid,
          bitcoinFirstSeenAt: release.bitcoinFirstSeenAt ?? new Date(),
          bitcoinFirstSeenHeight: existingTxStatus.transactionBlockHeight,
          bitcoinFirstSeenOracleHeight: release.bitcoinFirstSeenOracleHeight ?? oracleBitcoinBlockHeight,
        });
        await this.recordBitcoinConfirmation(release, {
          bitcoinConfirmedHeight: existingTxStatus.transactionBlockHeight,
        });
        return;
      }

      let releasedTxid: string;
      try {
        releasedTxid = await this.mempool.broadcastTx(u8aToHex(bytes, undefined, false));
      } catch (error) {
        const message = String(error ?? '').toLowerCase();
        const wasAlreadyBroadcast =
          message.includes('txn-already-in-mempool') ||
          message.includes('txn-already-known') ||
          message.includes('already in mempool') ||
          message.includes('already known') ||
          message.includes('already have transaction');
        if (!wasAlreadyBroadcast) throw error;
        releasedTxid = txid;
      }
      if (releasedTxid !== txid) throw new Error(`Bitcoin release ${release.id} broadcast returned a different txid`);
      const tip = await this.mempool.getTipHeight();
      await this.recordBitcoinBroadcast(release, {
        bitcoinTxid: releasedTxid,
        bitcoinFirstSeenAt: new Date(),
        bitcoinFirstSeenHeight: tip,
        bitcoinFirstSeenOracleHeight: oracleBitcoinBlockHeight,
      });
    } catch (error) {
      if (isWalletSigningUnavailableError(error)) throw error;
      await this.recordRetryableError(release, error);
      throw error;
    }
  }

  private getOrphanTransactionInfo(release: Pick<IBitcoinReleaseRecord, 'id'>): TransactionInfo | undefined {
    return this.transactionTracker.findLatestTxInfo(txInfo => {
      if (txInfo.tx.extrinsicType !== ExtrinsicType.BitcoinOrphanedUtxoRelease) return false;
      const metadata = txInfo.tx.metadataJson as { releaseId?: string } | undefined;
      return metadata?.releaseId === release.id;
    });
  }

  private async syncOrphanRequestFromChain(
    lock: IBitcoinLockRecord,
    utxo: IBitcoinUtxoRecord,
    release: IBitcoinReleaseRecord,
  ): Promise<boolean> {
    if (release.status !== BitcoinReleaseStatus.SubmittingRequestOnArgon) return true;

    const client = await getMainchainClient(true);
    if (!lock.ownerAccount) return false;
    const orphan = await client.query.bitcoinLocks.orphanedUtxosByAccount(lock.ownerAccount, {
      txid: utxo.txid,
      outputIndex: utxo.vout,
    });
    if (!orphan || orphan.lockId !== lock.lockId || !orphan.cosignRequest) return false;

    const request = orphan.cosignRequest;
    if (
      u8aToHex(request.toScriptPubkey) !== release.toScriptPubkey ||
      request.bitcoinNetworkFee !== release.bitcoinNetworkFee
    ) {
      throw new Error(`Bitcoin release ${release.id} does not match the runtime orphan return request`);
    }

    const blockHash = await client.rpc.chain.getBlockHash(request.createdAtArgonBlockNumber);
    const api = await client.at(blockHash);
    const currentTick = await api.query.ticks.currentTick();
    if (currentTick === null) return false;
    await this.recordArgonRequest(release, { requestedReleaseAtTick: Number(currentTick) });
    await this.syncOrphanCosignCounterSubscriptions(client);
    return true;
  }

  private async submitOrphanToBitcoin(lock: IBitcoinLockRecord, release: IBitcoinReleaseRecord): Promise<void> {
    if (release.status !== BitcoinReleaseStatus.ReadyForBitcoinBroadcast) return;

    try {
      const utxo = this.getInputUtxos(release)[0];
      if (!utxo || release.vaultSignatures.length !== 1) {
        throw new Error(`Bitcoin release ${release.id} does not have one input and one vault signature`);
      }

      const ownerXpriv = await this.walletKeys.getBitcoinChildXpriv(lock.hdPath, this.bitcoinLocks.bitcoinNetwork);
      const cosign = this.bitcoinLocks.createCosignScript({ lock, fundedSatoshis: utxo.satoshis });
      const tx = cosign.cosignAndGenerateTx({
        releaseRequest: {
          toScriptPubkey: release.toScriptPubkey,
          bitcoinNetworkFee: release.bitcoinNetworkFee,
        },
        vaultCosignatures: release.vaultSignatures,
        utxos: [{ utxoRef: { txid: utxo.txid, vout: utxo.vout }, satoshis: utxo.satoshis }],
        ownerXpriv,
      });
      if (!tx?.isFinal) throw new Error('Failed to generate orphan release transaction.');

      const txid = `0x${tx.hash}`;
      if (release.bitcoinTxid && release.bitcoinTxid !== txid) {
        throw new Error(`Bitcoin release ${release.id} rebuilt a different transaction`);
      }
      if (!release.bitcoinTxid) await this.recordPreparedBitcoinTransaction(release, txid);

      const oracleBitcoinBlockHeight = this.bitcoinLocks.data.oracleBitcoinBlockHeight;
      const existingTxStatus = await this.mempool.getTxStatus(txid, oracleBitcoinBlockHeight);
      if (existingTxStatus?.isConfirmed) {
        await this.recordBitcoinBroadcast(release, {
          bitcoinTxid: txid,
          bitcoinFirstSeenAt: release.bitcoinFirstSeenAt ?? new Date(),
          bitcoinFirstSeenHeight: existingTxStatus.transactionBlockHeight,
          bitcoinFirstSeenOracleHeight: release.bitcoinFirstSeenOracleHeight ?? oracleBitcoinBlockHeight,
        });
        await this.completeOrphanRelease(utxo, release, existingTxStatus.transactionBlockHeight);
        return;
      }

      let bitcoinTxid: string;
      try {
        bitcoinTxid = await this.mempool.broadcastTx(u8aToHex(tx.toBytes(true, true), undefined, false));
      } catch (error) {
        const message = String(error ?? '').toLowerCase();
        const wasAlreadyBroadcast =
          message.includes('txn-already-in-mempool') ||
          message.includes('txn-already-known') ||
          message.includes('already in mempool') ||
          message.includes('already known') ||
          message.includes('already have transaction');
        if (!wasAlreadyBroadcast) throw error;
        bitcoinTxid = txid;
      }
      if (bitcoinTxid !== txid) throw new Error(`Bitcoin release ${release.id} broadcast returned a different txid`);
      const tip = await this.mempool.getTipHeight();
      await this.recordBitcoinBroadcast(release, {
        bitcoinTxid,
        bitcoinFirstSeenAt: new Date(),
        bitcoinFirstSeenHeight: tip,
        bitcoinFirstSeenOracleHeight: oracleBitcoinBlockHeight,
      });
    } catch (error) {
      if (isWalletSigningUnavailableError(error)) throw error;
      await this.recordRetryableError(release, error);
      throw error;
    }
  }

  private async syncLockArgonRequest(lock: IBitcoinLockRecord, apiClient: ArgonQueryClient): Promise<void> {
    const release = this.getActiveForLock(lock);
    if (!release || release.status !== BitcoinReleaseStatus.SubmittingRequestOnArgon) return;

    const request = await BitcoinLock.getReleaseRequest(apiClient, lock.lockId!);
    if (!request) return;

    const currentLock = await BitcoinLock.get(apiClient, lock.lockId!);
    if (!currentLock) throw new Error(`Bitcoin lock ${lock.lockId} is unavailable while its release is active`);
    const currentInputIds = currentLock.fundingUtxos.map(fundingUtxo => {
      const record = this.utxoTracking.getUtxoRecord(lock.lockId!, fundingUtxo.utxoRef.txid, fundingUtxo.utxoRef.vout);
      if (!record) throw new Error(`Bitcoin release ${release.id} is missing a current runtime input`);
      return record.id;
    });
    if (
      currentInputIds.length !== release.inputUtxoIds.length ||
      currentInputIds.some((id, index) => id !== release.inputUtxoIds[index])
    ) {
      throw new Error(`Bitcoin release ${release.id} no longer matches the runtime funding inputs`);
    }
    if (request.toScriptPubkey !== release.toScriptPubkey || request.bitcoinNetworkFee !== release.bitcoinNetworkFee) {
      throw new Error(`Bitcoin release ${release.id} does not match its runtime request`);
    }

    const currentTick = await apiClient.query.ticks.currentTick();
    if (currentTick === null) return;
    await this.recordArgonRequest(release, {
      requestedReleaseAtTick: Number(currentTick),
      insuredMicrogons: request.insuredMicrogons,
      argonTxFeeMicrogons: release.argonTxFeeMicrogons,
    });
  }

  public async syncLockVaultCosign(lock: IBitcoinLockRecord, archiveClient: ArgonClient): Promise<void> {
    const release = this.getActiveForLock(lock);
    if (!release || release.status !== BitcoinReleaseStatus.WaitingForVaultCosign) return;

    const cosign = await BitcoinLock.findVaultCosignatures(archiveClient, lock.lockId!);
    if (cosign) {
      await this.recordVaultCosign(release, {
        vaultSignatures: cosign.signatures,
        cosignBlockNumber: cosign.blockHeight,
      });
      return;
    }

    const vault = this.bitcoinLocks.myVault;
    if (lock.vaultId !== vault?.vaultId || !this.walletKeys.canSign) return;

    const result = await vault.cosignMyLock(lock);
    if (!result?.txInfo) return;
    const txFailure = getTransactionFailureMessage(result.txInfo);
    if (txFailure) throw new Error(txFailure);

    if (result.txInfo.txResult.blockNumber == null) {
      void this.continueLockCosignAfterArgonInclusion(lock, release.id, result.vaultSignatures, result.txInfo);
      return;
    }

    await this.recordVaultCosign(release, {
      vaultSignatures: result.vaultSignatures,
      cosignBlockNumber: result.txInfo.txResult.blockNumber,
    });
  }

  private async continueLockCosignAfterArgonInclusion(
    lock: IBitcoinLockRecord,
    releaseId: string,
    vaultSignatures: Uint8Array[],
    txInfo: TransactionInfo,
  ): Promise<void> {
    try {
      await txInfo.txResult.waitForInFirstBlock;
      await this.bitcoinLocks.runInQueueForLock(
        lock,
        async () => {
          if (this.bitcoinLocks.isTerminalLock(lock)) return;
          const txFailure = getTransactionFailureMessage(txInfo);
          if (txFailure || txInfo.txResult.blockNumber == null) return;

          const release = this.getById(releaseId);
          if (!release || lock.activeReleaseId !== release.id) return;
          await this.recordVaultCosign(release, {
            vaultSignatures,
            cosignBlockNumber: txInfo.txResult.blockNumber,
          });
        },
        { waitForHistoryRecovery: true },
      );
    } catch (error) {
      console.warn(`[BitcoinReleases] Error continuing release after Argon inclusion for ${lock.uuid}`, error);
    }
  }

  private async syncLockBitcoinConfirmation(release: IBitcoinReleaseRecord): Promise<void> {
    if (release.status !== BitcoinReleaseStatus.ConfirmingOnBitcoin || !release.bitcoinTxid) return;
    const status = await this.mempool.getTxStatus(release.bitcoinTxid, this.bitcoinLocks.data.oracleBitcoinBlockHeight);
    if (!status?.isConfirmed) return;
    await this.recordBitcoinConfirmation(release, {
      bitcoinConfirmedHeight: status.transactionBlockHeight,
    });
  }

  private async completeCosignedLockRelease(
    lock: IBitcoinLockRecord,
    release: IBitcoinReleaseRecord,
    archiveClient: ArgonClient,
  ): Promise<void> {
    const cosign = await BitcoinLock.findVaultCosignatures(archiveClient, lock.lockId!);
    if (!cosign) return;

    const block = await this.blockWatch.getHeaderByBlockNumber(cosign.blockHeight);
    const { api, events } = await this.blockWatch.getEventsWithSpec(block);
    const eventRecord = events.find(({ event }) => {
      const runtimeEvent = toRuntimeEvent(event);
      if (runtimeEvent?.section !== 'bitcoinLocks' || runtimeEvent.method !== 'BitcoinUtxoCosigned') return false;
      return (runtimeEvent.data.lockId ?? runtimeEvent.data.utxoId) === lock.lockId;
    });
    if (!eventRecord) throw new Error(`Bitcoin release ${release.id} is missing its finalized cosign event`);

    await this.completeLockReleaseFromArgon(lock, release, block, api, eventRecord);
  }

  private reportMissingReleaseForLock(lock: IBitcoinLockRecord): void {
    if (lock.status !== BitcoinLockStatus.Releasing || this.reportedMissingReleaseForLocks.has(lock.uuid)) return;
    this.reportedMissingReleaseForLocks.add(lock.uuid);
    console.error(
      `[BitcoinReleases] Lock ${lock.uuid} is marked Releasing but has no active Release. This lock cannot progress until its Release is recovered.`,
      { lockId: lock.lockId },
    );
  }

  private async advance(
    release: IBitcoinReleaseRecord,
    status: BitcoinReleaseStatus,
    facts: Partial<Omit<IBitcoinReleaseRecord, 'id' | 'kind' | 'lockId' | 'status' | 'createdAt' | 'updatedAt'>>,
  ): Promise<void> {
    const currentProgress = releaseProgress[release.status];
    const nextProgress = releaseProgress[status];
    if (currentProgress === undefined || nextProgress === undefined) return;

    await this.update(release, {
      ...facts,
      ...(nextProgress >= currentProgress ? { status, statusError: undefined } : {}),
    });
  }

  private async update(
    release: IBitcoinReleaseRecord,
    patch: Partial<Omit<IBitcoinReleaseRecord, 'id' | 'kind' | 'lockId' | 'createdAt'>>,
  ): Promise<void> {
    const draft = { ...release };
    const db = await this.dbPromise;
    await db.bitcoinReleasesTable.update(draft, patch);
    Object.assign(release, draft);
    this.data.releasesById[release.id] = release;
  }
}
