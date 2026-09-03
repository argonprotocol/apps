import { type ArgonClient, BlockWatch } from '@argonprotocol/apps-core';
import { hexToU8a, u8aToHex } from '@argonprotocol/mainchain';
import { getMainchainClient } from '../stores/mainchain.ts';
import type { IBitcoinLockRecord } from './db/BitcoinLocksTable.ts';
import { BitcoinUtxoRole, BitcoinUtxoStatus, type IBitcoinUtxoRecord } from './db/BitcoinUtxosTable.ts';
import { ExtrinsicType, TransactionStatus } from './db/TransactionsTable.ts';
import type BitcoinLocks from './BitcoinLocks.ts';
import type BitcoinMempool from './BitcoinMempool.ts';
import { getTransactionFailureMessage, type TransactionInfo } from './TransactionInfo.ts';
import type { TransactionTracker } from './TransactionTracker.ts';
import type { WalletKeys } from './WalletKeys.ts';

export default class BitcoinOrphanReleases {
  #cosignCounterSubscriptions = new Map<string, () => void>();
  #eventScanFromBlock?: number;
  #eventScanThroughBlock?: number;

  constructor(
    private readonly bitcoinLocks: BitcoinLocks,
    private readonly blockWatch: BlockWatch,
    private readonly mempool: BitcoinMempool,
    private readonly transactionTracker: TransactionTracker,
    private readonly walletKeys: WalletKeys,
  ) {}

  public getTransactionInfo(utxoId: number, record: Pick<IBitcoinUtxoRecord, 'id'>): TransactionInfo | undefined {
    return this.transactionTracker.findLatestTxInfo(txInfo => {
      if (txInfo.tx.extrinsicType !== ExtrinsicType.BitcoinOrphanedUtxoRelease) return false;
      const metadata = txInfo.tx.metadataJson as { utxoId?: number; utxoRecordId?: number } | undefined;
      if (metadata?.utxoId !== utxoId) return false;
      return metadata.utxoRecordId === record.id;
    });
  }

  public async publishReleaseSubmission(
    record: IBitcoinUtxoRecord,
    request: { toScriptPubkey: string; bitcoinNetworkFee: bigint },
  ): Promise<void> {
    await this.bitcoinLocks.utxoTracking.setReleaseIsProcessingOnArgon(record, {
      releaseToDestinationAddress: request.toScriptPubkey,
      releaseBitcoinNetworkFee: request.bitcoinNetworkFee,
    });
    const client = await getMainchainClient(false);
    await this.syncCosignCounterSubscriptions(client).catch(error => {
      console.warn('[BitcoinOrphanReleases] Unable to watch return counter', error);
    });
  }

  public async recordReleaseRequest(record: IBitcoinUtxoRecord, blockHash: Uint8Array): Promise<void> {
    if (record.requestedReleaseAtTick != null) return;
    if (!record.releaseToDestinationAddress || record.releaseBitcoinNetworkFee == null) return;

    const client = await getMainchainClient(true);
    const api = await client.at(blockHash);
    const currentTick = await api.query.ticks.currentTick();
    if (currentTick === null) return;

    await this.bitcoinLocks.utxoTracking.setReleaseIsProcessingOnArgon(record, {
      requestedReleaseAtTick: Number(currentTick),
      releaseToDestinationAddress: record.releaseToDestinationAddress,
      releaseBitcoinNetworkFee: record.releaseBitcoinNetworkFee,
    });
  }

  public async failReleaseRequest(record: IBitcoinUtxoRecord, error: Error): Promise<void> {
    await this.bitcoinLocks.utxoTracking.setReleaseError(record, error.message);
  }

  public async reconcileOrphanReturns(lock: IBitcoinLockRecord): Promise<void> {
    const records = this.bitcoinLocks.utxoTracking
      .getUnresolvedOrphanRecords([lock])
      .filter(record => record.status === BitcoinUtxoStatus.ReleaseIsProcessingOnArgon);

    for (const record of records) {
      if (!record.releaseToDestinationAddress || record.releaseBitcoinNetworkFee == null) continue;

      if (record.requestedReleaseAtTick == null) {
        const txInfo = this.getTransactionInfo(record.lockUtxoId, record);
        const txFailure = getTransactionFailureMessage(txInfo);

        if (!txInfo || txFailure) {
          const recoveredFromChain = await this.syncReleaseRequestFromChain(lock, record);
          if (!recoveredFromChain) {
            await this.bitcoinLocks.utxoTracking.setReleaseError(
              record,
              txFailure ?? 'Orphan return was interrupted before submission. Please retry the return.',
            );
            continue;
          }
        } else {
          if (txInfo.tx.status !== TransactionStatus.Finalized) continue;
          await this.ensureObservedAtTick(record, txInfo);
        }
      }

      if (!record.releaseCosignVaultSignature || record.releaseCosignHeight == null) continue;
      await this.submitToBitcoin(lock, record, {
        toScriptPubkey: record.releaseToDestinationAddress,
        bitcoinNetworkFee: record.releaseBitcoinNetworkFee,
        vaultSignature: record.releaseCosignVaultSignature,
      });
    }
  }

  public async syncBitcoinProcessing(oracleBitcoinBlockHeight: number): Promise<void> {
    const locksByUtxoId = this.bitcoinLocks.data.locksByUtxoId;
    const tasks = Object.values(locksByUtxoId)
      .flatMap(lock => this.bitcoinLocks.utxoTracking.getUtxosForLock(lock))
      .filter(record => {
        if (record.status !== BitcoinUtxoStatus.ReleaseIsProcessingOnBitcoin) return false;
        const lock = locksByUtxoId[record.lockUtxoId];
        const fundingRecord = lock ? this.bitcoinLocks.utxoTracking.getAcceptedFundingRecordForLock(lock) : undefined;
        const fundingRecordId = fundingRecord?.id ?? lock?.fundingUtxo?.id;
        return record.id !== fundingRecordId;
      })
      .map(async record => {
        const lock = locksByUtxoId[record.lockUtxoId];
        if (!lock || !record.releaseTxid) return;

        try {
          await this.bitcoinLocks.utxoTracking.updateReleaseLastConfirmationCheck(record);
        } catch (error) {
          console.warn('[BitcoinOrphanReleases] Error updating return confirmation check', error);
        }

        const mempoolTxStatus = await this.mempool
          .getTxStatus(record.releaseTxid, oracleBitcoinBlockHeight)
          .catch(() => undefined);
        if (mempoolTxStatus?.isConfirmed) {
          await this.bitcoinLocks.utxoTracking.setReleaseComplete(record, mempoolTxStatus.transactionBlockHeight);
        }
      });

    await Promise.allSettled(tasks);
  }

  public async syncCosignCounterSubscriptions(client: ArgonClient): Promise<void> {
    const subscriptions = new Map<string, { vaultId: number; ownerAccount: string }>();
    const locksByUtxoId = this.bitcoinLocks.data.locksByUtxoId;
    const locks = Object.values(locksByUtxoId);

    for (const record of this.bitcoinLocks.utxoTracking.getUnresolvedOrphanRecords(locks)) {
      if (record.status !== BitcoinUtxoStatus.ReleaseIsProcessingOnArgon || record.releaseCosignVaultSignature) {
        continue;
      }
      const lock = locksByUtxoId[record.lockUtxoId];
      if (!lock) continue;

      const ownerAccount = lock.ownerAccount;
      if (!ownerAccount) continue;
      subscriptions.set(`${lock.vaultId}:${ownerAccount}`, { vaultId: lock.vaultId, ownerAccount });
    }

    for (const [key, { vaultId, ownerAccount }] of subscriptions) {
      if (this.#cosignCounterSubscriptions.has(key)) continue;

      let previousCount: number | undefined;
      const unsubscribe = await client.query.vaults.orphanedUtxoAccountsByVaultId(vaultId, ownerAccount, count => {
        const nextCount = count;
        if (previousCount !== undefined && nextCount < previousCount) {
          const bestBlockNumber = this.blockWatch.bestBlockHeader.blockNumber;
          const scanThroughBlock = bestBlockNumber + 1;
          const latestProcessedBlock = this.bitcoinLocks.data.latestArgonBlock?.blockNumber ?? bestBlockNumber - 1;
          const scanFromBlock = Math.max(1, Math.min(latestProcessedBlock + 1, bestBlockNumber));

          this.#eventScanFromBlock = Math.min(this.#eventScanFromBlock ?? scanFromBlock, scanFromBlock);
          this.#eventScanThroughBlock = Math.max(this.#eventScanThroughBlock ?? scanThroughBlock, scanThroughBlock);
        }
        previousCount = nextCount;
      });
      this.#cosignCounterSubscriptions.set(key, unsubscribe);
    }

    for (const [key, unsubscribe] of this.#cosignCounterSubscriptions) {
      if (subscriptions.has(key)) continue;
      unsubscribe();
      this.#cosignCounterSubscriptions.delete(key);
    }
  }

  public async recoverPendingCosignEvents(settledThroughBlock: number): Promise<void> {
    const requestedThroughBlock = this.#eventScanThroughBlock;
    if (this.#eventScanFromBlock === undefined || requestedThroughBlock === undefined) return;

    const scanThroughBlock = Math.min(requestedThroughBlock, settledThroughBlock);
    if (this.#eventScanFromBlock > scanThroughBlock) return;

    while (this.#eventScanFromBlock !== undefined && this.#eventScanFromBlock <= scanThroughBlock) {
      const block = await this.blockWatch.getHeaderByBlockNumber(this.#eventScanFromBlock);
      const events = (await this.blockWatch.getEvents(block)).filter(({ event }) => {
        return event.section === 'bitcoinLocks' && event.method === 'OrphanedUtxoCosigned';
      });
      if (events.length) await this.bitcoinLocks.recovery.recoverBlock(block, events);
      this.#eventScanFromBlock = block.blockNumber + 1;
    }

    if (this.#eventScanFromBlock > requestedThroughBlock) {
      this.#eventScanFromBlock = undefined;
      this.#eventScanThroughBlock = undefined;
    }

    const locksByUtxoId = this.bitcoinLocks.data.locksByUtxoId;
    const locks = Object.values(locksByUtxoId);
    const locksWithRecoveredCosigns = new Set(
      this.bitcoinLocks.utxoTracking
        .getUnresolvedOrphanRecords(locks)
        .filter(record => record.releaseCosignVaultSignature)
        .map(record => locksByUtxoId[record.lockUtxoId])
        .filter((lock): lock is IBitcoinLockRecord => lock !== undefined),
    );
    for (const lock of locksWithRecoveredCosigns) {
      await this.reconcileOrphanReturns(lock);
    }
  }

  public shutdown(): void {
    for (const unsubscribe of this.#cosignCounterSubscriptions.values()) unsubscribe();
    this.#cosignCounterSubscriptions.clear();
  }

  private async createVaultSignature(
    lock: IBitcoinLockRecord,
    record: Pick<IBitcoinUtxoRecord, 'txid' | 'vout' | 'satoshis'>,
    releaseRequest: { toScriptPubkey: string; bitcoinNetworkFee: bigint },
  ): Promise<Uint8Array> {
    const vault = this.bitcoinLocks.myVault;
    if (!vault) throw new Error('No vault available to cosign this release.');

    const vaultSignature = await vault.createVaultSignatureForMyOrphanedUtxoRelease({
      lock,
      txid: record.txid,
      vout: record.vout,
      satoshis: record.satoshis,
      toScriptPubkey: releaseRequest.toScriptPubkey,
      bitcoinNetworkFee: releaseRequest.bitcoinNetworkFee,
    });
    if (!vaultSignature) throw new Error('Failed to generate vault signature for orphan release.');
    return vaultSignature;
  }

  private async ensureObservedAtTick(record: IBitcoinUtxoRecord, txInfo: TransactionInfo): Promise<void> {
    const blockHash = txInfo.tx.blockHash ?? (await txInfo.txResult.waitForInFirstBlock);
    await this.recordReleaseRequest(record, typeof blockHash === 'string' ? hexToU8a(blockHash) : blockHash);
  }

  private async syncReleaseRequestFromChain(lock: IBitcoinLockRecord, record: IBitcoinUtxoRecord): Promise<boolean> {
    if (record.requestedReleaseAtTick != null) return true;

    const client = await getMainchainClient(true);
    if (!lock.ownerAccount) return false;
    const orphan = await client.query.bitcoinLocks.orphanedUtxosByAccount(lock.ownerAccount, {
      txid: record.txid,
      outputIndex: record.vout,
    });
    if (!orphan || orphan.utxoId !== lock.utxoId || !orphan.cosignRequest) return false;

    const request = orphan.cosignRequest;
    const blockHash = await client.rpc.chain.getBlockHash(request.createdAtArgonBlockNumber);
    const apiAt = await client.at(blockHash);
    const currentTick = await apiAt.query.ticks.currentTick();
    if (currentTick === null) return false;
    const requestedReleaseAtTick = Number(currentTick);

    await this.bitcoinLocks.utxoTracking.setReleaseIsProcessingOnArgon(record, {
      requestedReleaseAtTick,
      releaseToDestinationAddress: u8aToHex(request.toScriptPubkey, undefined, false),
      releaseBitcoinNetworkFee: request.bitcoinNetworkFee,
    });
    return true;
  }

  private async submitToBitcoin(
    lock: IBitcoinLockRecord,
    record: IBitcoinUtxoRecord,
    args: { toScriptPubkey: string; bitcoinNetworkFee: bigint; vaultSignature?: Uint8Array },
  ): Promise<void> {
    try {
      const vaultSignature =
        args.vaultSignature ??
        (record.releaseCosignVaultSignature && record.releaseCosignHeight != null
          ? record.releaseCosignVaultSignature
          : undefined) ??
        (await this.createVaultSignature(lock, record, {
          toScriptPubkey: args.toScriptPubkey,
          bitcoinNetworkFee: args.bitcoinNetworkFee,
        }));
      const bitcoinNetwork = this.bitcoinLocks.bitcoinNetwork;
      const ownerXpriv = await this.walletKeys.getBitcoinChildXpriv(lock.hdPath, bitcoinNetwork);
      const cosign = this.bitcoinLocks.createCosignScript({ lock, fundedSatoshis: record.satoshis });
      const tx = cosign.cosignAndGenerateTx({
        releaseRequest: {
          toScriptPubkey: args.toScriptPubkey,
          bitcoinNetworkFee: args.bitcoinNetworkFee,
        },
        vaultCosignature: vaultSignature,
        utxoRef: { txid: record.txid, vout: record.vout },
        utxoSatoshis: record.satoshis,
        ownerXpriv,
      });
      if (!tx || !tx.isFinal) throw new Error('Failed to generate orphan release transaction.');

      const txid = tx.id;
      const hexTx = u8aToHex(tx.toBytes(true, true), undefined, false);
      const oracleBitcoinBlockHeight = this.bitcoinLocks.data.oracleBitcoinBlockHeight;
      const existingTxStatus = await this.mempool.getTxStatus(txid, oracleBitcoinBlockHeight).catch(() => undefined);
      if (existingTxStatus?.isConfirmed) {
        const mempoolTip = await this.mempool.getTipHeight().catch(() => oracleBitcoinBlockHeight);
        await this.bitcoinLocks.utxoTracking.setReleaseSeenOnBitcoinAndProcessing(record, txid, mempoolTip);
        return;
      }

      let bitcoinTxid: string;
      try {
        bitcoinTxid = await this.mempool.broadcastTx(hexTx);
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
      const mempoolTip = await this.mempool.getTipHeight().catch(() => oracleBitcoinBlockHeight);
      await this.bitcoinLocks.utxoTracking.setReleaseSeenOnBitcoinAndProcessing(record, bitcoinTxid, mempoolTip);
    } catch (error) {
      await this.bitcoinLocks.utxoTracking.setStatusError(record, String(error));
    }
  }

  private async continueAfterArgonInclusion(
    lock: IBitcoinLockRecord,
    record: IBitcoinUtxoRecord,
    args: { toScriptPubkey: string; bitcoinNetworkFee: bigint; vaultSignature: Uint8Array },
    txInfo: TransactionInfo,
  ): Promise<void> {
    try {
      await txInfo.txResult.waitForInFirstBlock;
      const txFailure = getTransactionFailureMessage(txInfo);
      if (txFailure) {
        await this.bitcoinLocks.utxoTracking.setReleaseError(record, txFailure);
        return;
      }

      await this.ensureObservedAtTick(record, txInfo);
      await this.bitcoinLocks.utxoTracking.setReleaseCosign(record, {
        releaseCosignVaultSignature: args.vaultSignature,
        releaseCosignHeight: txInfo.txResult.blockNumber!,
      });
      await this.submitToBitcoin(lock, record, args);
    } catch (error) {
      await this.bitcoinLocks.utxoTracking.setReleaseError(record, String(error));
    }
  }
}
