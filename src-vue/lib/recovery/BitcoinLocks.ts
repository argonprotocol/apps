import {
  BitcoinLock,
  u8aEq,
  type ApiDecoration,
  type FrameSystemEventRecord,
  type GenericEvent,
} from '@argonprotocol/mainchain';
import { bigIntMax, bigIntMin, type BlockWatch, type Currency, type IBlockHeaderInfo } from '@argonprotocol/apps-core';
import { BitcoinLocksTable, BitcoinLockStatus, type IBitcoinLockRecord } from '../db/BitcoinLocksTable.ts';
import type BitcoinUtxoTracking from '../BitcoinUtxoTracking.ts';
import type { deriveBitcoinLockHdKey, WalletKeys } from '../WalletKeys.ts';
import { readRequiredEventBigInt, readRequiredEventField } from './index.ts';

export class BitcoinLockRecovery {
  private readonly walletKeys: WalletKeys;
  private readonly blockWatch: BlockWatch;
  private readonly currency: Pick<Currency, 'fetchMainchainRatesAtBlock'>;
  private readonly locksByUtxoId: Record<number, IBitcoinLockRecord>;
  private readonly pendingLocks: IBitcoinLockRecord[];
  private readonly waitForLockIdle: (lock: IBitcoinLockRecord) => Promise<void>;
  private readonly onHistoryRecoveryComplete: (locks: IBitcoinLockRecord[]) => void;
  private readonly utxoTracking: Pick<
    BitcoinUtxoTracking,
    'getAcceptedFundingRecordForLock' | 'setAcceptedFundingRecordForLock' | 'setReleaseRequest' | 'upsertUtxoRecord'
  >;
  private historyReplayLocksByUtxoId?: Record<number, IBitcoinLockRecord>;
  private readonly historyRecoveryPendingUtxoIds = new Set<number>();
  private readonly insertPending: (
    details: Pick<IBitcoinLockRecord, 'uuid' | 'satoshis' | 'vaultId' | 'hdPath'>,
  ) => Promise<IBitcoinLockRecord>;
  private readonly getTable: () => Promise<BitcoinLocksTable>;
  private readonly getDerivedPubkey: (vaultId: number, index: number) => ReturnType<typeof deriveBitcoinLockHdKey>;
  private readonly trackDerivedBitcoinLockKey: (
    vaultId: number,
    derivedPubkey: Awaited<ReturnType<typeof deriveBitcoinLockHdKey>>,
  ) => Promise<void>;

  constructor(args: {
    walletKeys: WalletKeys;
    blockWatch: BlockWatch;
    currency: Pick<Currency, 'fetchMainchainRatesAtBlock'>;
    locksByUtxoId: Record<number, IBitcoinLockRecord>;
    pendingLocks: IBitcoinLockRecord[];
    waitForLockIdle: BitcoinLockRecovery['waitForLockIdle'];
    onHistoryRecoveryComplete: BitcoinLockRecovery['onHistoryRecoveryComplete'];
    utxoTracking: BitcoinLockRecovery['utxoTracking'];
    insertPending: BitcoinLockRecovery['insertPending'];
    getTable: () => Promise<BitcoinLocksTable>;
    getDerivedPubkey: BitcoinLockRecovery['getDerivedPubkey'];
    trackDerivedBitcoinLockKey: BitcoinLockRecovery['trackDerivedBitcoinLockKey'];
  }) {
    this.walletKeys = args.walletKeys;
    this.blockWatch = args.blockWatch;
    this.currency = args.currency;
    this.locksByUtxoId = args.locksByUtxoId;
    this.pendingLocks = args.pendingLocks;
    this.waitForLockIdle = args.waitForLockIdle;
    this.onHistoryRecoveryComplete = args.onHistoryRecoveryComplete;
    this.utxoTracking = args.utxoTracking;
    this.insertPending = args.insertPending;
    this.getTable = args.getTable;
    this.getDerivedPubkey = args.getDerivedPubkey;
    this.trackDerivedBitcoinLockKey = args.trackDerivedBitcoinLockKey;
  }

  public beginHistoryReplay(): void {
    if (this.historyReplayLocksByUtxoId) throw new Error('Bitcoin lock history replay is already running');

    this.historyReplayLocksByUtxoId = {};
    for (const lock of Object.values(this.locksByUtxoId)) {
      if (lock.isHistoryRecoveryPending && lock.utxoId !== undefined) {
        this.historyRecoveryPendingUtxoIds.add(lock.utxoId);
      }
    }
  }

  public async commitHistoryReplay(isComplete = true): Promise<void> {
    const stagedLocks = this.historyReplayLocksByUtxoId;
    if (!stagedLocks) return;

    if (!isComplete) {
      this.historyReplayLocksByUtxoId = undefined;
      for (const recovered of Object.values(stagedLocks)) this.applyRecoveredRecord(recovered);
      return;
    }

    const recoveredLocks = [...this.historyRecoveryPendingUtxoIds]
      .map(utxoId => stagedLocks[utxoId] ?? this.locksByUtxoId[utxoId])
      .filter(lock => !!lock);
    const table = await this.getTable();
    await Promise.all(recoveredLocks.map(lock => table.setHistoryRecoveryPending(lock.uuid, false)));

    this.historyReplayLocksByUtxoId = undefined;
    for (const recovered of Object.values(stagedLocks)) this.applyRecoveredRecord(recovered);
    const completedLocks: IBitcoinLockRecord[] = [];
    for (const lock of recoveredLocks) {
      const liveLock = this.locksByUtxoId[lock.utxoId!];
      if (!liveLock) continue;

      const pendingIndex = this.pendingLocks.findIndex(pending => pending.uuid === liveLock.uuid);
      if (pendingIndex >= 0) this.pendingLocks.splice(pendingIndex, 1);
      delete liveLock.isHistoryRecoveryPending;
      completedLocks.push(liveLock);
    }
    this.historyRecoveryPendingUtxoIds.clear();
    this.onHistoryRecoveryComplete(completedLocks);
  }

  public cancelHistoryReplay(): void {
    this.historyReplayLocksByUtxoId = undefined;
  }

  public async recoverBlock(
    block: IBlockHeaderInfo,
    eventRecords: readonly BitcoinRecoveryEventRecord[],
    options: { lockQueueOwnerUuid?: string } = {},
  ): Promise<void> {
    const api = await this.blockWatch.getApi(block);
    const table = await this.getTable();

    for (let eventIndex = 0; eventIndex < eventRecords.length; eventIndex += 1) {
      const { event } = eventRecords[eventIndex];
      const isBitcoinMint = event.section === 'mint' && event.method === 'BitcoinMint';
      if (event.section !== 'bitcoinLocks' && !isBitcoinMint) continue;
      if (event.section === 'bitcoinLocks' && !bitcoinRecoveryEventMethods.has(event.method)) {
        continue;
      }

      const utxoId = this.readUtxoId(event, block);
      if (isBitcoinMint && utxoId === undefined) {
        if (readRequiredEventField(event, 'accountId', block).toString() !== this.walletKeys.defaultArgonAddress)
          continue;

        const candidateIds = new Set([
          ...Object.keys(this.locksByUtxoId).map(Number),
          ...Object.keys(this.historyReplayLocksByUtxoId ?? {}).map(Number),
        ]);
        for (const recoveryId of candidateIds) {
          const record = this.getRecoveryLock(recoveryId);
          if (record) await this.reconcilePendingMint(record, api, table, options.lockQueueOwnerUuid);
        }
        continue;
      }
      if (utxoId === undefined) continue;
      if (
        (isBitcoinMint || event.method === 'BitcoinLockCreated' || event.method === 'BitcoinLockRatcheted') &&
        readRequiredEventField(event, 'accountId', block).toString() !== this.walletKeys.defaultArgonAddress
      ) {
        continue;
      }

      const liveRecord = this.locksByUtxoId[utxoId];
      if (liveRecord) await this.prepareHistoryRecoveryLock(liveRecord, options.lockQueueOwnerUuid);

      if (event.method === 'BitcoinLockCreated') {
        const chainLock = await BitcoinLock.get(api, utxoId);
        if (!chainLock) throw new Error(`Bitcoin lock ${utxoId} is unavailable at its creation block`);
        chainLock.couponFeesPaid = bigIntMax(chainLock.couponFeesPaid, this.readUnchargedSecurityFee(event, block));

        // Restart replay from durable state rather than a stale in-memory observation.
        const persistedRecord = await table.getByUtxoId(utxoId);
        if (persistedRecord) await this.prepareHistoryRecoveryLock(persistedRecord, options.lockQueueOwnerUuid);
        const existing = persistedRecord ? this.applyRecoveredRecord(persistedRecord) : this.getRecoveryLock(utxoId);
        if (existing) {
          if (existing.ratchets.length) {
            const creationRatchetIndex = existing.ratchets.findIndex(
              ratchet => ratchet.blockHeight === block.blockNumber,
            );
            const creationRatchet = existing.ratchets[creationRatchetIndex];
            if (!creationRatchet) {
              throw new Error(`Bitcoin lock ${utxoId} is missing its creation ratchet`);
            }

            const creationLiquidity = readRequiredEventBigInt(event, ['liquidityPromised'], block);
            const creationTargetPrice = readRequiredEventBigInt(
              event,
              ['lockedTargetPrice', 'lockedMarketRate', 'peggedPrice', 'lockPrice'],
              block,
            );
            if (
              creationRatchet.mintAmount !== creationLiquidity ||
              creationRatchet.lockedTargetPrice !== creationTargetPrice
            ) {
              throw new Error(`Bitcoin lock ${utxoId} has invalid creation ratchet economics`);
            }

            const extrinsicIndex = eventRecords[eventIndex].phase.isApplyExtrinsic
              ? eventRecords[eventIndex].phase.asApplyExtrinsic.toNumber()
              : undefined;
            if (
              creationRatchet.mintPending !== creationRatchet.mintAmount ||
              creationRatchet.extrinsicIndex !== extrinsicIndex ||
              existing.createdAt.getTime() !== block.blockTime ||
              (existing.lockDetails?.couponFeesPaid ?? 0n) !== chainLock.couponFeesPaid
            ) {
              const recovered = this.createDetachedRecord(existing);
              recovered.ratchets[creationRatchetIndex].mintPending = creationRatchet.mintAmount;
              recovered.ratchets[creationRatchetIndex].extrinsicIndex = extrinsicIndex;
              recovered.lockDetails = chainLock;
              await table.saveRecoveredHistory(recovered, new Date(block.blockTime));
              this.applyRecoveredRecord(recovered);
            }
            continue;
          }
        }

        const transactionFee = this.readTransactionFee(eventRecords, eventIndex, block) ?? 0n;
        const record = await this.recoverLock({
          lock: chainLock,
          createdAtArgonBlockHeight: block.blockNumber,
          finalFee: transactionFee,
          lockQueueOwnerUuid: options.lockQueueOwnerUuid,
        });
        const recovered = this.createDetachedRecord(record);
        recovered.status = BitcoinLockStatus.LockPendingFunding;
        recovered.satoshis = chainLock.satoshis;
        recovered.liquidityPromised = chainLock.liquidityPromised;
        recovered.lockedTargetPrice = chainLock.lockedTargetPrice;
        recovered.lockDetails = chainLock;
        recovered.ratchets = [
          {
            mintAmount: chainLock.liquidityPromised,
            mintPending: chainLock.liquidityPromised,
            lockedTargetPrice: chainLock.lockedTargetPrice,
            blockHeight: block.blockNumber,
            burned: 0n,
            securityFee: chainLock.securityFees,
            txFee: transactionFee,
            oracleBitcoinBlockHeight: chainLock.createdAtHeight,
            extrinsicIndex: eventRecords[eventIndex].phase.isApplyExtrinsic
              ? eventRecords[eventIndex].phase.asApplyExtrinsic.toNumber()
              : undefined,
          },
        ];
        this.assertSafePendingMint(recovered);
        await table.saveRecoveredHistory(recovered, new Date(block.blockTime));
        this.applyRecoveredRecord(recovered);
        continue;
      }

      const persistedRecord = this.getRecoveryLock(utxoId) ? undefined : await table.getByUtxoId(utxoId);
      if (persistedRecord) await this.prepareHistoryRecoveryLock(persistedRecord, options.lockQueueOwnerUuid);
      const record = persistedRecord ? this.applyRecoveredRecord(persistedRecord) : this.getRecoveryLock(utxoId);
      if (!record) {
        // Release events only identify a UTXO, and the indexer returns the full block selected for this account.
        // An unrelated account's release can therefore appear beside owned activity without an ownership field.
        if (!isBitcoinMint && event.method !== 'BitcoinLockRatcheted') continue;
        throw new Error(`Bitcoin lock ${utxoId} history is missing its creation record`);
      }
      if (event.method === 'BitcoinLockRatcheted') {
        await this.importRatchet(record, block, eventRecords, eventIndex, api, table);
      } else if (isBitcoinMint) {
        await this.applyScopedMint(record, readRequiredEventBigInt(event, ['amount'], block), api, table);
      } else if (event.method === 'BitcoinUtxoCosignRequested') {
        const releaseRequest = await new BitcoinLock(record.lockDetails).getReleaseRequest(api);
        if (!releaseRequest) {
          throw new Error(`Bitcoin lock ${utxoId} release request is unavailable at block ${block.blockNumber}`);
        }
        const recovered = this.createDetachedRecord(record);
        await table.recordReleaseRequest(recovered, {
          releaseRedemptionMicrogons: releaseRequest.redemptionAmount,
          releaseArgonTxFeeMicrogons: this.readTransactionFee(eventRecords, eventIndex, block),
        });
        let fundingRecord = this.utxoTracking.getAcceptedFundingRecordForLock(recovered);
        if (!fundingRecord) {
          const utxoRef = await new BitcoinLock(recovered.lockDetails).getFundingUtxoRef(api);
          if (utxoRef) {
            fundingRecord = await this.utxoTracking.upsertUtxoRecord(
              recovered,
              { txid: utxoRef.txid, vout: utxoRef.vout, satoshis: recovered.satoshis },
              { markFundingUtxo: true },
            );
            await this.utxoTracking.setAcceptedFundingRecordForLock(recovered, fundingRecord);
          }
        }
        if (fundingRecord) {
          await this.utxoTracking.setReleaseRequest(fundingRecord, {
            requestedReleaseAtTick: await api.query.ticks.currentTick().then(tick => tick.toNumber()),
            releaseToDestinationAddress: releaseRequest.toScriptPubkey,
            releaseBitcoinNetworkFee: releaseRequest.bitcoinNetworkFee,
          });
        }
        this.applyRecoveredRecord(recovered);
      } else if (event.method === 'BitcoinUtxoCosigned') {
        if (record.status === BitcoinLockStatus.Released && !record.removalReason) {
          const recovered = this.createDetachedRecord(record);
          const rates = await this.currency.fetchMainchainRatesAtBlock({ api, block });
          const phase = eventRecords[eventIndex].phase;
          await table.recordRemoval(recovered, BitcoinLockStatus.Released, {
            removalBlockNumber: block.blockNumber,
            removalBlockHash: block.blockHash,
            removalBlockTime: new Date(block.blockTime),
            removalExtrinsicIndex: phase.isApplyExtrinsic ? phase.asApplyExtrinsic.toNumber() : undefined,
            removalReason: 'released',
            btcPriceAtRemovalMicrogons: rates.BTC,
          });
          this.applyRecoveredRecord(recovered);
        } else if (record.status !== BitcoinLockStatus.Releasing && record.status !== BitcoinLockStatus.Released) {
          const recovered = this.createDetachedRecord(record);
          await table.setStatus(recovered, BitcoinLockStatus.Releasing);
          this.applyRecoveredRecord(recovered);
        }
      } else if (event.method === 'BitcoinCosignPastDue') {
        const recovered = this.createDetachedRecord(record);
        await table.recordReleaseCompensation(recovered, readRequiredEventBigInt(event, ['compensationAmount'], block));
        this.applyRecoveredRecord(recovered);
      } else if (event.method === 'BitcoinSpentAfterRelease' || event.method === 'BitcoinLockBurned') {
        let removalReason: NonNullable<IBitcoinLockRecord['removalReason']> = 'released';
        let status = BitcoinLockStatus.Released;
        if (event.method === 'BitcoinLockBurned') {
          const wasUtxoSpent = readRequiredEventField(event, 'wasUtxoSpent', block).toString().toLowerCase() === 'true';
          removalReason = wasUtxoSpent ? 'spent' : 'expired';
          if (!wasUtxoSpent) status = BitcoinLockStatus.Releasing;
        }

        const recovered = this.createDetachedRecord(record);
        const rates = await this.currency.fetchMainchainRatesAtBlock({ api, block });
        const phase = eventRecords[eventIndex].phase;
        await table.recordRemoval(recovered, status, {
          removalBlockNumber: block.blockNumber,
          removalBlockHash: block.blockHash,
          removalBlockTime: new Date(block.blockTime),
          removalExtrinsicIndex: phase.isApplyExtrinsic ? phase.asApplyExtrinsic.toNumber() : undefined,
          removalReason,
          btcPriceAtRemovalMicrogons: rates.BTC,
        });
        this.applyRecoveredRecord(recovered);
      }
    }
  }

  public async recoverLock(args: {
    lock: BitcoinLock;
    createdAtArgonBlockHeight: number;
    finalFee: bigint;
    lockQueueOwnerUuid?: string;
  }): Promise<IBitcoinLockRecord> {
    const liveRecord = this.locksByUtxoId[args.lock.utxoId];
    if (this.historyReplayLocksByUtxoId && liveRecord) {
      await this.prepareHistoryRecoveryLock(liveRecord, args.lockQueueOwnerUuid);
    }

    const table = await this.getTable();
    const existing = await table.getByUtxoId(args.lock.utxoId);
    if (existing) {
      await this.prepareHistoryRecoveryLock(existing, args.lockQueueOwnerUuid);
      return this.applyRecoveredRecord(existing);
    }

    const derivedPubkey = await this.findDerivedPubkeyForOwner(args.lock.vaultId, args.lock.ownerPubkey);
    if (!derivedPubkey) throw new Error(`Unable to recover the HD path for Bitcoin lock ${args.lock.utxoId}`);

    let record = await table.findLockByHdPath(derivedPubkey.hdPath);
    if (!record) {
      record = await this.insertPending({
        uuid: BitcoinLocksTable.createUuid(),
        vaultId: args.lock.vaultId,
        satoshis: args.lock.satoshis,
        hdPath: derivedPubkey.hdPath,
      });
    }
    if (record.status === BitcoinLockStatus.LockIsProcessingOnArgon) {
      record = await table.finalizePending({
        uuid: record.uuid,
        lock: args.lock,
        createdAtArgonBlockHeight: args.createdAtArgonBlockHeight,
        finalFee: args.finalFee,
      });
    }
    await this.prepareHistoryRecoveryLock(record, args.lockQueueOwnerUuid);
    return this.applyRecoveredRecord(record);
  }

  public async findMissingActiveLockIds(api: ApiDecoration<'promise'>): Promise<number[]> {
    const chainLocks = await api.query.bitcoinLocks.locksByUtxoId.entries();
    const missing: number[] = [];

    for (const [storageKey, lockOption] of chainLocks) {
      if (lockOption.isNone || lockOption.unwrap().ownerAccount.toString() !== this.walletKeys.defaultArgonAddress)
        continue;

      const utxoId = storageKey.args[0].toNumber();
      const record = this.getRecoveryLock(utxoId);
      const chainLock = lockOption.unwrap();
      if (
        !record ||
        !this.hasCompleteRatchetEconomics(
          record,
          chainLock.liquidityPromised.toBigInt(),
          chainLock.lockedTargetPrice.toBigInt(),
        )
      ) {
        missing.push(utxoId);
      }
    }

    return missing;
  }

  private async importRatchet(
    record: IBitcoinLockRecord,
    block: IBlockHeaderInfo,
    eventRecords: readonly BitcoinRecoveryEventRecord[],
    eventIndex: number,
    api: ApiDecoration<'promise'>,
    table: BitcoinLocksTable,
  ): Promise<void> {
    const phase = eventRecords[eventIndex].phase;
    if (!phase.isApplyExtrinsic) {
      throw new Error(`Bitcoin ratchet at block ${block.blockNumber.toLocaleString()} has no extrinsic identity`);
    }
    const extrinsicIndex = phase.asApplyExtrinsic.toNumber();
    const event = eventRecords[eventIndex].event;
    const cumulativeLiquidity = readRequiredEventBigInt(event, ['liquidityPromised'], block);
    const oldTargetPrice = readRequiredEventBigInt(
      event,
      [
        'oldTargetPrice',
        'oldLockedMarketRate',
        'originalMarketRate',
        'oldPeggedPrice',
        'originalPeggedPrice',
        'oldLockPrice',
        'originalLockPrice',
      ],
      block,
    );
    const lockedTargetPrice = readRequiredEventBigInt(
      event,
      ['newTargetPrice', 'newLockedMarketRate', 'newPeggedPrice', 'newLockPrice'],
      block,
    );
    const chainLock = await BitcoinLock.get(api, record.utxoId!);
    if (!chainLock) throw new Error(`Bitcoin lock ${record.utxoId} is unavailable after ratchet`);

    const recovered = this.createDetachedRecord(record);
    let ratchetIndex = recovered.ratchets.findIndex(ratchet => {
      return ratchet.blockHeight === block.blockNumber && ratchet.extrinsicIndex === extrinsicIndex;
    });
    if (ratchetIndex === -1) {
      ratchetIndex = recovered.ratchets.findIndex(ratchet => {
        return (
          ratchet.blockHeight === block.blockNumber &&
          ratchet.extrinsicIndex === undefined &&
          ratchet.lockedTargetPrice === lockedTargetPrice
        );
      });
    }
    const isExistingRatchet = ratchetIndex !== -1;
    if (!isExistingRatchet) {
      ratchetIndex = recovered.ratchets.findIndex(ratchet => {
        if (ratchet.blockHeight !== block.blockNumber) return ratchet.blockHeight > block.blockNumber;
        return (ratchet.extrinsicIndex ?? -1) > extrinsicIndex;
      });
      if (ratchetIndex === -1) ratchetIndex = recovered.ratchets.length;
    }

    const previousRatchet = recovered.ratchets[ratchetIndex - 1];
    if (!previousRatchet) throw new Error(`Bitcoin lock ${record.utxoId} ratchet history is missing its prior state`);

    const previousLiquidity = this.getRatchetLiquidity(recovered.ratchets, ratchetIndex - 1);
    if (previousRatchet.lockedTargetPrice !== oldTargetPrice) {
      throw new Error(`Bitcoin lock ${record.utxoId} ratchet history has the wrong prior target price`);
    }

    const isUpRatchet = lockedTargetPrice > oldTargetPrice;
    if (isUpRatchet && cumulativeLiquidity < previousLiquidity) {
      throw new Error(`Bitcoin lock ${record.utxoId} up-ratchet reduced its promised liquidity`);
    }
    const mintAmount = isUpRatchet ? cumulativeLiquidity - previousLiquidity : cumulativeLiquidity;
    const burned = readRequiredEventBigInt(event, ['amountBurned'], block);
    if (recovered.status !== BitcoinLockStatus.Released && recovered.status !== BitcoinLockStatus.Releasing) {
      recovered.status = BitcoinLockStatus.LockedAndIsMinting;
    }

    const ratchet = {
      mintAmount,
      mintPending: mintAmount,
      liquidityPromised: cumulativeLiquidity,
      lockedTargetPrice,
      securityFee: readRequiredEventBigInt(event, ['securityFee'], block),
      txFee: this.readTransactionFee(eventRecords, eventIndex, block) ?? 0n,
      burned,
      blockHeight: block.blockNumber,
      extrinsicIndex,
      oracleBitcoinBlockHeight: await api.query.bitcoinUtxos
        .confirmedBitcoinBlockTip()
        .then(tip => (tip.isSome ? tip.unwrap().blockHeight.toNumber() : 0)),
    };
    if (isExistingRatchet) {
      recovered.ratchets.splice(ratchetIndex, 1, ratchet);
    } else {
      recovered.ratchets.splice(ratchetIndex, 0, ratchet);
    }

    const followsCurrentState =
      record.liquidityPromised === previousLiquidity && record.lockedTargetPrice === oldTargetPrice;
    const matchesCurrentState =
      record.liquidityPromised === cumulativeLiquidity && record.lockedTargetPrice === lockedTargetPrice;
    if (followsCurrentState || matchesCurrentState) {
      recovered.lockedTargetPrice = lockedTargetPrice;
      recovered.liquidityPromised = cumulativeLiquidity;
      chainLock.couponFeesPaid = bigIntMax(
        chainLock.couponFeesPaid,
        (record.lockDetails?.couponFeesPaid ?? 0n) + this.readUnchargedSecurityFee(event, block),
      );
      recovered.lockDetails = chainLock;
    }
    this.assertSafePendingMint(recovered);
    await table.saveRecoveredHistory(recovered);
    this.applyRecoveredRecord(recovered);
  }

  private createDetachedRecord(record: IBitcoinLockRecord): IBitcoinLockRecord {
    return {
      ...record,
      ratchets: record.ratchets.map(ratchet => ({ ...ratchet })),
    };
  }

  private applyRecoveredRecord(recovered: IBitcoinLockRecord): IBitcoinLockRecord {
    const utxoId = recovered.utxoId!;
    const stagedLocks = this.historyReplayLocksByUtxoId;
    if (stagedLocks) {
      recovered.isHistoryRecoveryPending = true;
      this.historyRecoveryPendingUtxoIds.add(utxoId);
    }
    const liveRecord = this.locksByUtxoId[utxoId];
    const current =
      stagedLocks?.[utxoId] ?? (stagedLocks && liveRecord ? this.createDetachedRecord(liveRecord) : liveRecord);
    if (current) {
      recovered.fundingUtxoRecord ??= current.fundingUtxoRecord;
      Object.assign(current, recovered);
      if (stagedLocks) stagedLocks[utxoId] = current;
      return current;
    }

    if (stagedLocks) stagedLocks[utxoId] = recovered;
    else this.locksByUtxoId[utxoId] = recovered;
    return recovered;
  }

  private getRecoveryLock(utxoId: number): IBitcoinLockRecord | undefined {
    return this.historyReplayLocksByUtxoId?.[utxoId] ?? this.locksByUtxoId[utxoId];
  }

  private async prepareHistoryRecoveryLock(lock: IBitcoinLockRecord, lockQueueOwnerUuid?: string): Promise<void> {
    if (!this.historyReplayLocksByUtxoId) return;

    const utxoId = lock.utxoId;
    if (utxoId === undefined || this.historyRecoveryPendingUtxoIds.has(utxoId)) return;

    const table = await this.getTable();
    await table.setHistoryRecoveryPending(lock.uuid, true);

    lock.isHistoryRecoveryPending = true;
    const pendingLock = this.pendingLocks.find(record => record.uuid === lock.uuid);
    if (pendingLock) pendingLock.isHistoryRecoveryPending = true;
    this.historyRecoveryPendingUtxoIds.add(utxoId);
    if (lock.uuid !== lockQueueOwnerUuid) await this.waitForLockIdle(lock);
  }

  private hasCompleteRatchetEconomics(
    record: IBitcoinLockRecord,
    chainLiquidityPromised: bigint,
    chainLockedTargetPrice: bigint,
  ): boolean {
    if (!record.ratchets.length) return false;

    let recoveredLiquidity = 0n;
    let previousTargetPrice: bigint | undefined;
    for (let index = 0; index < record.ratchets.length; index += 1) {
      const ratchet = record.ratchets[index];
      recoveredLiquidity = this.getRatchetLiquidity(record.ratchets, index);
      const expectedMint =
        previousTargetPrice === undefined || ratchet.lockedTargetPrice < previousTargetPrice
          ? recoveredLiquidity
          : recoveredLiquidity - this.getRatchetLiquidity(record.ratchets, index - 1);
      if (expectedMint < 0n || ratchet.mintAmount !== expectedMint) return false;
      if (ratchet.mintPending < 0n || ratchet.mintPending > ratchet.mintAmount) return false;
      previousTargetPrice = ratchet.lockedTargetPrice;
    }

    const latestTargetPrice = record.ratchets.at(-1)!.lockedTargetPrice;
    return (
      record.liquidityPromised === chainLiquidityPromised &&
      recoveredLiquidity === chainLiquidityPromised &&
      latestTargetPrice === record.lockedTargetPrice &&
      record.lockedTargetPrice === chainLockedTargetPrice
    );
  }

  private getRatchetLiquidity(ratchets: readonly IBitcoinLockRecord['ratchets'][number][], index: number): bigint {
    if (index < 0) return 0n;

    let liquidity = 0n;
    for (let currentIndex = 0; currentIndex <= index; currentIndex += 1) {
      const ratchet = ratchets[currentIndex];
      if (ratchet.liquidityPromised !== undefined) {
        liquidity = ratchet.liquidityPromised;
      } else if (currentIndex === 0) {
        liquidity = ratchet.mintAmount;
      } else if (ratchet.mintAmount === 0n && ratchet.burned > 0n) {
        liquidity = ratchet.burned;
      } else {
        liquidity += ratchet.mintAmount;
      }
    }
    return liquidity;
  }

  private assertSafePendingMint(record: IBitcoinLockRecord): void {
    const totalLiquidity = record.ratchets.reduce((sum, ratchet) => sum + ratchet.mintAmount, 0n);
    const pendingMint = record.ratchets.reduce((sum, ratchet) => sum + ratchet.mintPending, 0n);
    if (record.ratchets.some(ratchet => ratchet.mintPending < 0n)) {
      throw new Error(`Bitcoin lock ${record.utxoId} has a negative recovered pending mint`);
    }
    if (record.ratchets.some(ratchet => ratchet.mintPending > ratchet.mintAmount)) {
      throw new Error(`Bitcoin lock ${record.utxoId} pending mint exceeds recovered liquidity`);
    }
    if (pendingMint > totalLiquidity) {
      throw new Error(`Bitcoin lock ${record.utxoId} pending mint exceeds recovered liquidity`);
    }
  }

  private async findDerivedPubkeyForOwner(vaultId: number, ownerPubkey: Parameters<typeof u8aEq>[0], maxTries = 100) {
    for (let index = 0; index < maxTries; index += 1) {
      const derivedPubkey = await this.getDerivedPubkey(vaultId, index);
      if (!u8aEq(ownerPubkey, derivedPubkey.ownerBitcoinPubkey)) continue;

      await this.trackDerivedBitcoinLockKey(vaultId, derivedPubkey);
      return derivedPubkey;
    }
  }

  private readUtxoId(
    event: Pick<GenericEvent, 'data' | 'method' | 'section'>,
    block: IBlockHeaderInfo,
  ): number | undefined {
    const value = readRequiredEventField(event, 'utxoId', block);
    if (value.toHuman() === null) return;

    const utxoId = Number(value.toString().replace(/,/g, ''));
    if (Number.isSafeInteger(utxoId)) return utxoId;
    throw new Error(`Historical ${event.section}.${event.method} has an invalid Bitcoin lock id`);
  }

  private readTransactionFee(
    records: readonly BitcoinRecoveryEventRecord[],
    operationEventIndex: number,
    block: IBlockHeaderInfo,
  ): bigint | undefined {
    const phase = records[operationEventIndex].phase;
    if (!phase.isApplyExtrinsic) return;

    const extrinsicIndex = phase.asApplyExtrinsic.toNumber();
    const feeEvent = records.find(record => {
      return (
        record.phase.isApplyExtrinsic &&
        record.phase.asApplyExtrinsic.toNumber() === extrinsicIndex &&
        record.event.section === 'transactionPayment' &&
        record.event.method === 'TransactionFeePaid'
      );
    })?.event;
    if (!feeEvent) return;

    const payer = readRequiredEventField(feeEvent, 'who', block).toString();
    const ownedAccounts = new Set([
      this.walletKeys.defaultArgonAddress,
      this.walletKeys.miningBotAddress,
      this.walletKeys.operationalAddress,
    ]);
    return ownedAccounts.has(payer) ? readRequiredEventBigInt(feeEvent, ['actualFee'], block) : 0n;
  }

  private readUnchargedSecurityFee(event: BitcoinRecoveryEventRecord['event'], block: IBlockHeaderInfo): bigint {
    const lockAccount = readRequiredEventField(event, 'accountId', block).toString();
    if (lockAccount !== this.walletKeys.defaultArgonAddress) return 0n;

    // The app's default account is its vault operator, so it does not charge itself the lock's security fee.
    return readRequiredEventBigInt(event, ['securityFee'], block);
  }

  private async applyScopedMint(
    record: IBitcoinLockRecord,
    amount: bigint,
    api: ApiDecoration<'promise'>,
    table: BitcoinLocksTable,
  ): Promise<void> {
    const recovered = this.createDetachedRecord(record);
    const pendingMint = recovered.ratchets.reduce((sum, ratchet) => sum + ratchet.mintPending, 0n);
    const chainPendingMints = await new BitcoinLock(recovered.lockDetails).findPendingMints(api);
    const chainPendingMint = chainPendingMints.reduce((sum, pending) => sum + pending, 0n);
    if (chainPendingMint > pendingMint) {
      throw new Error(`Bitcoin lock ${record.utxoId} pending mint exceeds recovered history`);
    }
    this.assertSafePendingMint(recovered);
    if (chainPendingMint === pendingMint) return;

    if (amount > pendingMint) {
      throw new Error(`Bitcoin lock ${record.utxoId} mint exceeds recovered pending liquidity`);
    }
    if (pendingMint - amount < chainPendingMint) {
      throw new Error(`Bitcoin lock ${record.utxoId} scoped mint falls below canonical pending liquidity`);
    }

    let remaining = amount;
    for (const ratchet of recovered.ratchets) {
      if (remaining === 0n) break;

      const fulfilled = bigIntMin(ratchet.mintPending, remaining);
      ratchet.mintPending -= fulfilled;
      remaining -= fulfilled;
    }

    this.assertSafePendingMint(recovered);
    await table.updateMintState(recovered);
    this.applyRecoveredRecord(recovered);
  }

  private async reconcilePendingMint(
    record: IBitcoinLockRecord,
    api: ApiDecoration<'promise'>,
    table: BitcoinLocksTable,
    lockQueueOwnerUuid?: string,
  ): Promise<void> {
    const recovered = this.createDetachedRecord(record);
    const chainPendingMints = await new BitcoinLock(recovered.lockDetails).findPendingMints(api);
    const chainPendingMint = chainPendingMints.reduce((sum, amount) => sum + amount, 0n);
    const recoveredPendingMint = recovered.ratchets.reduce((sum, ratchet) => sum + ratchet.mintPending, 0n);
    if (chainPendingMint > recoveredPendingMint) {
      await this.prepareHistoryRecoveryLock(record, lockQueueOwnerUuid);
      throw new Error(`Bitcoin lock ${record.utxoId} pending mint exceeds recovered history`);
    }
    this.assertSafePendingMint(recovered);
    if (chainPendingMint === recoveredPendingMint) return;

    await this.prepareHistoryRecoveryLock(record, lockQueueOwnerUuid);
    let fulfilled = recoveredPendingMint - chainPendingMint;
    for (const ratchet of recovered.ratchets) {
      if (fulfilled <= 0n) break;
      const fulfilledFromRatchet = bigIntMin(ratchet.mintPending, fulfilled);
      ratchet.mintPending -= fulfilledFromRatchet;
      fulfilled -= fulfilledFromRatchet;
    }
    this.assertSafePendingMint(recovered);
    await table.updateMintState(recovered);
    this.applyRecoveredRecord(recovered);
  }
}

type BitcoinRecoveryEventRecord = {
  event: Pick<GenericEvent, 'data' | 'method' | 'section'>;
  phase: Pick<FrameSystemEventRecord['phase'], 'isApplyExtrinsic'> & {
    asApplyExtrinsic: Pick<FrameSystemEventRecord['phase']['asApplyExtrinsic'], 'toNumber'>;
  };
};

const bitcoinRecoveryEventMethods = new Set([
  'BitcoinCosignPastDue',
  'BitcoinLockBurned',
  'BitcoinLockCreated',
  'BitcoinLockRatcheted',
  'BitcoinSpentAfterRelease',
  'BitcoinUtxoCosignRequested',
  'BitcoinUtxoCosigned',
]);
