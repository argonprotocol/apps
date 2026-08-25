import { BitcoinLock, TxSubmitter } from '@argonprotocol/apps-core';
import { addressBytesHex, CosignScript } from '@argonprotocol/bitcoin';
import { ArgonClient, type SubmittableExtrinsic, u8aToHex } from '@argonprotocol/mainchain';
import type { BlockWatch } from '@argonprotocol/apps-core';
import { getMainchainClient } from '../stores/mainchain.ts';
import type { IBitcoinLockRecord } from './db/BitcoinLocksTable.ts';
import { BitcoinUtxoStatus, type IBitcoinUtxoRecord } from './db/BitcoinUtxosTable.ts';
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

  public async requestCandidateReturn(args: {
    lock: IBitcoinLockRecord;
    candidateRecord: IBitcoinUtxoRecord;
    toScriptPubkey: string;
    bitcoinNetworkFee?: bigint;
    feeRatePerSatVb?: bigint;
  }): Promise<TransactionInfo | undefined> {
    return await this.bitcoinLocks.runInQueueForUtxo(args.lock, 90e3, () => this.requestCandidateReturnUnqueued(args));
  }

  public async estimatedCandidateReturnArgonTxFee(args: {
    lock: IBitcoinLockRecord;
    candidateRecord: IBitcoinUtxoRecord;
    liquidLockingAddress: string;
    toScriptPubkey: string;
    feeRatePerSatVb?: bigint;
    tip?: bigint;
  }): Promise<bigint> {
    if (!args.lock.utxoId) return 0n;

    const client = await getMainchainClient(false);
    const request = await this.createRequest({
      lock: args.lock,
      record: args.candidateRecord,
      toScriptPubkey: args.toScriptPubkey,
      feeRatePerSatVb: args.feeRatePerSatVb ?? 5n,
    });
    const tx = await this.buildCandidateReturnTx({
      client,
      lock: args.lock,
      request,
      // Estimated fee only; signature bytes length needs to be valid, content is not used for weight estimation.
      vaultSignature: new Uint8Array(71).fill(1),
    });
    const fee = await tx.paymentInfo(args.liquidLockingAddress, { tip: args.tip ?? 0n });
    return fee.partialFee.toBigInt();
  }

  public async requestOrphanReturn(args: {
    lock: IBitcoinLockRecord;
    record: IBitcoinUtxoRecord;
    toScriptPubkey: string;
    bitcoinNetworkFee?: bigint;
    feeRatePerSatVb?: bigint;
  }): Promise<TransactionInfo | undefined> {
    return await this.bitcoinLocks.runInQueueForUtxo(args.lock, 90e3, () => this.requestOrphanReturnUnqueued(args), {
      allowOrphanRecovery: true,
    });
  }

  public async getOrphanReturnFeeQuote(args: {
    lock: IBitcoinLockRecord;
    record: IBitcoinUtxoRecord;
    toScriptPubkey: string;
    bitcoinNetworkFee?: bigint;
    feeRatePerSatVb?: bigint;
  }): Promise<{ canAfford: boolean; availableBalance: bigint; txFee: bigint }> {
    const client = await getMainchainClient(false);
    const request = await this.createRequest(args);
    const tx = await this.buildOrphanReturnRequestTx(client, request);
    const txSigner = await this.walletKeys.getLiquidLockingKeypair();

    return await new TxSubmitter(client, tx, txSigner).canAfford();
  }

  public getTransactionInfo(utxoId: number, record: Pick<IBitcoinUtxoRecord, 'id'>): TransactionInfo | undefined {
    return this.transactionTracker.findLatestTxInfo(txInfo => {
      if (txInfo.tx.extrinsicType !== ExtrinsicType.BitcoinOrphanedUtxoRelease) return false;
      const metadata = txInfo.tx.metadataJson as { utxoId?: number; utxoRecordId?: number } | undefined;
      if (metadata?.utxoId !== utxoId) return false;
      return metadata.utxoRecordId === record.id;
    });
  }

  public async onRequestedReleaseInBlock(record: IBitcoinUtxoRecord, txInfo: TransactionInfo): Promise<void> {
    const { txResult } = txInfo;
    const postProcessor = txInfo.createPostProcessor();
    try {
      await txResult.waitForInFirstBlock;
      const txFailure = getTransactionFailureMessage(txInfo);
      if (txFailure) {
        await this.bitcoinLocks.utxoTracking.setReleaseError(record, txFailure);
        return;
      }

      await this.ensureObservedAtTick(record, txInfo);
    } catch (error) {
      await this.bitcoinLocks.utxoTracking.setReleaseError(record, String(error));
      throw error;
    } finally {
      postProcessor.resolve();
    }
  }

  public async reconcileCandidateReturns(lock: IBitcoinLockRecord): Promise<void> {
    if (!lock.utxoId) return;

    const fundingRecord = this.bitcoinLocks.utxoTracking.getAcceptedFundingRecordForLock(lock);
    const fundingRecordId = fundingRecord?.id ?? lock.fundingUtxoRecordId ?? undefined;
    const records = this.bitcoinLocks.utxoTracking
      .getMismatchOrphanReleases(lock.utxoId, undefined, fundingRecordId)
      .filter(record => record.status === BitcoinUtxoStatus.ReleaseIsProcessingOnArgon);

    for (const record of records) {
      if (!record.releaseToDestinationAddress || record.releaseBitcoinNetworkFee == null) continue;

      const txInfo = this.getTransactionInfo(record.lockUtxoId, record);
      if (!txInfo) {
        if (record.requestedReleaseAtTick == null) {
          const recoveredFromChain = await this.syncReleaseRequestFromChain(lock, record);
          if (!recoveredFromChain) {
            await this.bitcoinLocks.utxoTracking.setReleaseError(
              record,
              'Mismatch return was interrupted before submission. Please retry return or collect the adjusted amount.',
            );
            continue;
          }
        }
        await this.submitToBitcoin(lock, record, {
          toScriptPubkey: record.releaseToDestinationAddress,
          bitcoinNetworkFee: record.releaseBitcoinNetworkFee,
        });
        continue;
      }

      const txFailure = getTransactionFailureMessage(txInfo);
      if (txFailure) {
        await this.bitcoinLocks.utxoTracking.setReleaseError(record, txFailure);
        continue;
      }
      if (txInfo.tx.status !== TransactionStatus.Finalized) continue;

      await this.ensureObservedAtTick(record, txInfo);
      const vaultSignature =
        record.releaseCosignVaultSignature && record.releaseCosignHeight != null
          ? record.releaseCosignVaultSignature
          : await this.createVaultSignature(lock, record, {
              toScriptPubkey: record.releaseToDestinationAddress,
              bitcoinNetworkFee: record.releaseBitcoinNetworkFee,
            });
      if (!record.releaseCosignVaultSignature || record.releaseCosignHeight == null) {
        await this.bitcoinLocks.utxoTracking.setReleaseCosign(record, {
          releaseCosignVaultSignature: vaultSignature,
          releaseCosignHeight: txInfo.txResult.blockNumber!,
        });
      }
      await this.submitToBitcoin(lock, record, {
        toScriptPubkey: record.releaseToDestinationAddress,
        bitcoinNetworkFee: record.releaseBitcoinNetworkFee,
        vaultSignature,
      });
    }
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
        const fundingRecordId = fundingRecord?.id ?? lock?.fundingUtxoRecordId ?? undefined;
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

      const ownerAccount = lock.lockDetails.ownerAccount;
      subscriptions.set(`${lock.vaultId}:${ownerAccount}`, { vaultId: lock.vaultId, ownerAccount });
    }

    for (const [key, { vaultId, ownerAccount }] of subscriptions) {
      if (this.#cosignCounterSubscriptions.has(key)) continue;

      let previousCount: number | undefined;
      const unsubscribe = await client.query.vaults.orphanedUtxoAccountsByVaultId(vaultId, ownerAccount, count => {
        const nextCount = count.toNumber();
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

  private async requestCandidateReturnUnqueued(args: {
    lock: IBitcoinLockRecord;
    candidateRecord: IBitcoinUtxoRecord;
    toScriptPubkey: string;
    bitcoinNetworkFee?: bigint;
    feeRatePerSatVb?: bigint;
  }): Promise<TransactionInfo | undefined> {
    const { lock } = args;
    const candidateRecord =
      this.bitcoinLocks.utxoTracking
        .getUtxosForLock(lock)
        .find(record => record.txid === args.candidateRecord.txid && record.vout === args.candidateRecord.vout) ??
      args.candidateRecord;
    if (!lock.utxoId) {
      throw new Error('This lock has no Bitcoin funding ID yet.');
    }
    const candidate = this.bitcoinLocks
      .getMismatchViewState(lock)
      .candidates.find(x => x.record.txid === candidateRecord.txid && x.record.vout === candidateRecord.vout);
    if (!candidate?.canReturn) {
      throw new Error('This mismatch return is not currently available.');
    }

    const client = await getMainchainClient(false);
    let record: IBitcoinUtxoRecord | undefined;

    try {
      const request = await this.createRequest({
        lock,
        record: candidateRecord,
        toScriptPubkey: args.toScriptPubkey,
        bitcoinNetworkFee: args.bitcoinNetworkFee,
        feeRatePerSatVb: args.feeRatePerSatVb,
      });
      const vaultSignature = await this.createVaultSignature(lock, candidateRecord, {
        toScriptPubkey: request.toScriptPubkeyHex,
        bitcoinNetworkFee: request.bitcoinNetworkFee,
      });
      const tx = await this.buildCandidateReturnTx({
        client,
        lock,
        request,
        vaultSignature,
      });

      if (
        [
          BitcoinUtxoStatus.ReleaseIsProcessingOnArgon,
          BitcoinUtxoStatus.ReleaseIsProcessingOnBitcoin,
          BitcoinUtxoStatus.ReleaseComplete,
        ].includes(candidateRecord.status)
      ) {
        return this.getTransactionInfo(lock.utxoId, candidateRecord);
      }

      await this.bitcoinLocks.utxoTracking.setReleaseIsProcessingOnArgon(candidateRecord, {
        releaseToDestinationAddress: request.toScriptPubkeyHex,
        releaseBitcoinNetworkFee: request.bitcoinNetworkFee,
      });
      record = candidateRecord;

      const txInfo = await this.transactionTracker.submitAndWatch({
        tx,
        txSigner: await this.walletKeys.getLiquidLockingKeypair(),
        extrinsicType: ExtrinsicType.BitcoinOrphanedUtxoRelease,
        metadata: {
          releaseKind: 'Orphan',
          utxoId: lock.utxoId,
          utxoRecordId: candidateRecord.id,
          utxoRef: request.utxoRef,
        },
      });

      void this.continueAfterArgonInclusion(
        lock,
        record,
        {
          toScriptPubkey: request.toScriptPubkeyHex,
          bitcoinNetworkFee: request.bitcoinNetworkFee,
          vaultSignature,
        },
        txInfo,
      );

      return txInfo;
    } catch (error) {
      if (record) await this.bitcoinLocks.utxoTracking.setReleaseError(record, String(error));
      throw error;
    }
  }

  private async requestOrphanReturnUnqueued(args: {
    lock: IBitcoinLockRecord;
    record: IBitcoinUtxoRecord;
    toScriptPubkey: string;
    bitcoinNetworkFee?: bigint;
    feeRatePerSatVb?: bigint;
  }): Promise<TransactionInfo | undefined> {
    const { lock } = args;
    const record =
      this.bitcoinLocks.utxoTracking
        .getUtxosForLock(lock)
        .find(record => record.txid === args.record.txid && record.vout === args.record.vout) ?? args.record;
    if (!lock.utxoId || record.lockUtxoId !== lock.utxoId) {
      throw new Error('This orphan does not belong to the selected Bitcoin lock.');
    }
    if (this.bitcoinLocks.utxoTracking.isReleaseStatus(record.status)) {
      return this.getTransactionInfo(lock.utxoId, record);
    }
    if (record.status !== BitcoinUtxoStatus.Orphaned) {
      throw new Error('This orphan return is not currently available.');
    }

    const client = await getMainchainClient(false);
    let releaseStarted = false;

    try {
      const request = await this.createRequest({
        lock,
        record,
        toScriptPubkey: args.toScriptPubkey,
        bitcoinNetworkFee: args.bitcoinNetworkFee,
        feeRatePerSatVb: args.feeRatePerSatVb,
      });
      const tx = await this.buildOrphanReturnRequestTx(client, request);
      const txSigner = await this.walletKeys.getLiquidLockingKeypair();
      const affordability = await new TxSubmitter(client, tx, txSigner).canAfford();
      if (!affordability.canAfford) {
        throw new Error('The Internal App Wallet does not have enough ARGON to cover the transaction fee.');
      }

      await this.bitcoinLocks.utxoTracking.setReleaseIsProcessingOnArgon(record, {
        releaseToDestinationAddress: request.toScriptPubkeyHex,
        releaseBitcoinNetworkFee: request.bitcoinNetworkFee,
      });
      releaseStarted = true;
      await this.syncCosignCounterSubscriptions(client).catch(error => {
        console.warn('[BitcoinOrphanReleases] Unable to watch return counter', error);
      });

      const txInfo = await this.transactionTracker.submitAndWatch({
        tx,
        txSigner,
        extrinsicType: ExtrinsicType.BitcoinOrphanedUtxoRelease,
        metadata: {
          releaseKind: 'Orphan',
          utxoId: lock.utxoId,
          utxoRecordId: record.id,
          utxoRef: request.utxoRef,
        },
      });

      void this.onRequestedReleaseInBlock(record, txInfo).catch(error => {
        console.warn(`[BitcoinOrphanReleases] Unable to process return request #${txInfo.tx.id}`, error);
      });

      return txInfo;
    } catch (error) {
      if (releaseStarted) await this.bitcoinLocks.utxoTracking.setReleaseError(record, String(error));
      throw error;
    }
  }

  private async createRequest(args: {
    lock: IBitcoinLockRecord;
    record: IBitcoinUtxoRecord;
    toScriptPubkey: string;
    bitcoinNetworkFee?: bigint;
    feeRatePerSatVb?: bigint;
  }): Promise<{ utxoRef: { txid: string; vout: number }; toScriptPubkeyHex: string; bitcoinNetworkFee: bigint }> {
    const toScriptPubkeyHex = addressBytesHex(args.toScriptPubkey, this.bitcoinLocks.bitcoinNetwork);
    const bitcoinNetworkFee =
      args.bitcoinNetworkFee ??
      (await this.bitcoinLocks.calculateBitcoinNetworkFee(args.lock, args.feeRatePerSatVb ?? 5n, args.toScriptPubkey));

    return {
      utxoRef: { txid: args.record.txid, vout: args.record.vout },
      toScriptPubkeyHex,
      bitcoinNetworkFee,
    };
  }

  private async buildCandidateReturnTx(args: {
    client: ArgonClient;
    lock: IBitcoinLockRecord;
    request: { utxoRef: { txid: string; vout: number }; toScriptPubkeyHex: string; bitcoinNetworkFee: bigint };
    vaultSignature: Uint8Array;
  }): Promise<SubmittableExtrinsic> {
    if (!args.lock.lockDetails.ownerAccount) {
      throw new Error('Missing lock owner account needed for orphan release.');
    }

    const txs: SubmittableExtrinsic[] = [];
    const candidateRefs = await args.client.query.bitcoinUtxos.candidateUtxoRefsByUtxoId(args.lock.utxoId!);
    const candidateStillOnChain = [...candidateRefs.entries()].some(([utxoRef]) => {
      return (
        utxoRef.txid.toHex() === args.request.utxoRef.txid &&
        utxoRef.outputIndex.toNumber() === args.request.utxoRef.vout
      );
    });
    if (candidateStillOnChain) {
      txs.push(
        args.client.tx.bitcoinUtxos.rejectUtxoCandidate(args.lock.utxoId!, {
          txid: args.request.utxoRef.txid,
          outputIndex: args.request.utxoRef.vout,
        }),
      );
    }

    const requestTx = await BitcoinLock.createOrphanedUtxoReleaseRequestTx({
      client: args.client,
      utxoRef: { txid: args.request.utxoRef.txid, outputIndex: args.request.utxoRef.vout },
      releaseRequest: {
        toScriptPubkey: args.request.toScriptPubkeyHex,
        bitcoinNetworkFee: args.request.bitcoinNetworkFee,
      },
    });
    if (!requestTx) throw new Error('Orphan release is not supported on this chain.');

    const cosignTx = await BitcoinLock.createOrphanedUtxoCosignTx({
      client: args.client,
      orphanOwner: args.lock.lockDetails.ownerAccount,
      utxoRef: { txid: args.request.utxoRef.txid, outputIndex: args.request.utxoRef.vout },
      vaultSignature: args.vaultSignature,
    });
    if (!cosignTx) throw new Error('Orphan release is not supported on this chain.');

    txs.push(requestTx, cosignTx);
    return args.client.tx.utility.batchAll(txs);
  }

  private async buildOrphanReturnRequestTx(
    client: ArgonClient,
    request: { utxoRef: { txid: string; vout: number }; toScriptPubkeyHex: string; bitcoinNetworkFee: bigint },
  ): Promise<SubmittableExtrinsic> {
    const tx = await BitcoinLock.createOrphanedUtxoReleaseRequestTx({
      client,
      utxoRef: { txid: request.utxoRef.txid, outputIndex: request.utxoRef.vout },
      releaseRequest: {
        toScriptPubkey: request.toScriptPubkeyHex,
        bitcoinNetworkFee: request.bitcoinNetworkFee,
      },
    });
    if (!tx) throw new Error('Orphan release is not supported on this chain.');
    return tx;
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
    if (record.requestedReleaseAtTick != null) return;
    if (!record.releaseToDestinationAddress || record.releaseBitcoinNetworkFee == null) return;

    const blockHash = txInfo.tx.blockHash ?? (await txInfo.txResult.waitForInFirstBlock);
    const client = await getMainchainClient(false);
    const api = await client.at(blockHash);
    const requestedReleaseAtTick = await api.query.ticks.currentTick().then(x => x.toNumber());

    await this.bitcoinLocks.utxoTracking.setReleaseIsProcessingOnArgon(record, {
      requestedReleaseAtTick,
      releaseToDestinationAddress: record.releaseToDestinationAddress,
      releaseBitcoinNetworkFee: record.releaseBitcoinNetworkFee,
    });
  }

  private async syncReleaseRequestFromChain(lock: IBitcoinLockRecord, record: IBitcoinUtxoRecord): Promise<boolean> {
    if (record.requestedReleaseAtTick != null) return true;

    const client = await getMainchainClient(true);
    const orphanMaybe = await client.query.bitcoinLocks.orphanedUtxosByAccount(lock.lockDetails.ownerAccount, {
      txid: record.txid,
      outputIndex: record.vout,
    });
    if (!orphanMaybe.isSome) return false;

    const orphan = orphanMaybe.unwrap();
    if (orphan.utxoId.toNumber() !== lock.utxoId || orphan.cosignRequest.isNone) return false;

    const request = orphan.cosignRequest.unwrap();
    const blockHash = await client.rpc.chain.getBlockHash(request.createdAtArgonBlockNumber.toNumber());
    const apiAt = await client.at(blockHash);
    const requestedReleaseAtTick = await apiAt.query.ticks.currentTick().then(x => x.toNumber());

    await this.bitcoinLocks.utxoTracking.setReleaseIsProcessingOnArgon(record, {
      requestedReleaseAtTick,
      releaseToDestinationAddress: u8aToHex(request.toScriptPubkey, undefined, false),
      releaseBitcoinNetworkFee: request.bitcoinNetworkFee.toBigInt(),
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
      const cosign = new CosignScript({ ...lock.lockDetails, utxoSatoshis: record.satoshis }, bitcoinNetwork);
      const tx = cosign.cosignAndGenerateTx({
        releaseRequest: {
          toScriptPubkey: args.toScriptPubkey,
          bitcoinNetworkFee: args.bitcoinNetworkFee,
        },
        vaultCosignature: vaultSignature,
        utxoRef: { txid: record.txid, vout: record.vout },
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
