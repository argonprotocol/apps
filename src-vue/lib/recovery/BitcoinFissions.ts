import {
  type BlockWatch,
  type Currency,
  JsonExt,
  type IBitcoinFission,
  type IBlockHeaderInfo,
  type RuntimeSystemEventRecord,
} from '@argonprotocol/apps-core';
import type { HistoricalEvent } from '@argonprotocol/runtime-client/events';

import type { IBitcoinFissionRecord, IBitcoinFissionRatchet } from '../../interfaces/IBitcoinFissionRecord.ts';
import type { Db } from '../Db.ts';
import type { IHistoricalBitcoinLockRecord } from './BitcoinLockReplay.ts';
type FissionRecoveryEventRecord = RuntimeSystemEventRecord;
type NamedFissionRecoveryEventRecord = RuntimeSystemEventRecord & { event: HistoricalEvent };

type DeferredFissionEvent = {
  block: IBlockHeaderInfo;
  record: NamedFissionRecoveryEventRecord;
  transactionFee?: bigint;
};

type FissionHistoryReplay = {
  recordsByFissionId: Map<number, IBitcoinFissionRecord>;
  deferredEvents: DeferredFissionEvent[];
  finalizedBlocks: Array<{
    block: IBlockHeaderInfo;
    records: readonly FissionRecoveryEventRecord[];
  }>;
  failed: boolean;
};

export class BitcoinFissionRecovery {
  private replay?: FissionHistoryReplay;
  private historyWrite = Promise.resolve();

  constructor(
    private readonly dbPromise: Promise<Db>,
    private readonly ownerAccount: string,
    private readonly getActiveFissions: () => readonly IBitcoinFission[] = () => [],
    private readonly historicalRates?: {
      blockWatch: Pick<BlockWatch, 'getApi'>;
      currency: Pick<Currency, 'fetchMainchainRatesAtBlock'>;
    },
    private readonly onHistoryRecovered?: (records: readonly IBitcoinFissionRecord[]) => void,
  ) {}

  public async beginHistoryReplay({ replace = false }: { replace?: boolean } = {}): Promise<void> {
    await this.queueHistoryWrite(async () => {
      if (this.replay) throw new Error('Bitcoin Fission history replay is already running');

      const records = replace ? [] : await this.getTable().then(table => table.fetchAll(this.ownerAccount));
      this.replay = {
        recordsByFissionId: new Map(records.map(record => [record.fissionId, cloneRecord(record)])),
        deferredEvents: [],
        finalizedBlocks: [],
        failed: false,
      };
    });
  }

  public markHistoryReplayFailure(): void {
    if (this.replay) this.replay.failed = true;
  }

  public async recoverBlock(
    block: IBlockHeaderInfo,
    rawEventRecords: readonly FissionRecoveryEventRecord[],
  ): Promise<void> {
    await this.applyBlock(this.requireReplay(), block, rawEventRecords);
  }

  public async recordFinalizedBlock(
    block: IBlockHeaderInfo,
    rawEventRecords: readonly FissionRecoveryEventRecord[],
  ): Promise<IBitcoinFissionRecord[]> {
    return await this.queueHistoryWrite(async () => {
      const table = await this.getTable();
      const records = await table.fetchAll(this.ownerAccount);
      const finalized: FissionHistoryReplay = {
        recordsByFissionId: new Map(records.map(record => [record.fissionId, cloneRecord(record)])),
        deferredEvents: [],
        finalizedBlocks: [],
        failed: false,
      };
      for (const { event } of rawEventRecords as readonly NamedFissionRecoveryEventRecord[]) {
        if (!this.replay) continue;
        if (event.section === 'bitcoinFissions') {
          if (event.data.accountId !== this.ownerAccount) continue;
        } else if (event.section === 'mint' && event.method === 'BitcoinMint') {
          if (event.data.accountId !== this.ownerAccount) continue;
        } else {
          continue;
        }
        const fissionId = readFissionId(event);
        const backfilled = fissionId === undefined ? undefined : this.replay.recordsByFissionId.get(fissionId);
        if (backfilled && !finalized.recordsByFissionId.has(backfilled.fissionId)) {
          finalized.recordsByFissionId.set(backfilled.fissionId, cloneRecord(backfilled));
        }
      }
      await this.applyBlock(finalized, block, rawEventRecords);

      if (finalized.deferredEvents.length) {
        const fissionIds = [
          ...new Set(
            finalized.deferredEvents.flatMap(({ record }) => {
              const fissionId = readFissionId(record.event);
              return fissionId === undefined ? [] : [fissionId];
            }),
          ),
        ];
        throw new Error(`Finalized Bitcoin Fission history is missing creation for ${fissionIds.join(', ')}`);
      }

      const published = [...finalized.recordsByFissionId.values()].sort(
        (left, right) => left.fissionId - right.fissionId,
      );
      await table.upsertRecoveredHistory(published);

      // Apply live finalized blocks after the older replay finishes so backfill
      // cannot overwrite them. Mint consumption is not idempotent, so each block
      // must enter the replay exactly once.
      if (this.replay) {
        this.replay.finalizedBlocks.push({ block, records: rawEventRecords });
      }
      return published;
    });
  }

  private async applyBlock(
    replay: FissionHistoryReplay,
    block: IBlockHeaderInfo,
    rawEventRecords: readonly FissionRecoveryEventRecord[],
  ): Promise<void> {
    const eventRecords = rawEventRecords as readonly NamedFissionRecoveryEventRecord[];

    for (const record of eventRecords) {
      const { event } = record;
      if (event.section === 'bitcoinFissions') {
        if (event.data.accountId !== this.ownerAccount) continue;
        const transactionFee = readTransactionFee(eventRecords, record, this.ownerAccount);

        if (event.method === 'FissionCreated') {
          this.applyCreation(replay, block, record, transactionFee);
          continue;
        }

        const fissionId = Number(event.data.fissionId);
        if (!replay.recordsByFissionId.has(fissionId)) {
          replay.deferredEvents.push({ block, record, transactionFee });
          continue;
        }
        await this.applyEvent(replay, block, record, transactionFee);
        continue;
      }

      if (event.section !== 'mint' || event.method !== 'BitcoinMint') continue;
      if (event.data.accountId !== this.ownerAccount) continue;
      const fissionId = event.data.fissionId === undefined ? undefined : Number(event.data.fissionId);
      if (fissionId === undefined) continue;

      if (!replay.recordsByFissionId.has(fissionId)) {
        replay.deferredEvents.push({ block, record });
        continue;
      }
      this.applyMint(replay, fissionId, event.data.amount);
    }
  }

  public async commitHistoryReplay(
    migratedLocks: readonly IHistoricalBitcoinLockRecord[] = [],
  ): Promise<IBitcoinFissionRecord[]> {
    return await this.queueHistoryWrite(async () => {
      const replay = this.requireReplay();
      if (replay.failed) throw new Error('Bitcoin Fission history replay has failed and cannot be committed');
      const activeFissions = this.getActiveFissions();
      for (const deferred of replay.deferredEvents) {
        const fissionId = readFissionId(deferred.record.event);
        if (fissionId === undefined) continue;

        if (!replay.recordsByFissionId.has(fissionId)) {
          const activeFission = activeFissions.find(fission => fission.fissionId === fissionId);
          const lock = migratedLocks.find(lock => lock.utxoId === fissionId);
          const migrated = lock
            ? this.createMigratedRecord(lock, deferred.block.blockNumber, activeFission)
            : undefined;
          if (!migrated) {
            throw new Error(`Bitcoin Fission ${fissionId} history is missing its creation event`);
          }
          replay.recordsByFissionId.set(fissionId, migrated);
        }
        await this.applyEvent(replay, deferred.block, deferred.record, deferred.transactionFee);
      }
      for (const { block, records } of replay.finalizedBlocks) {
        await this.applyBlock(replay, block, records);
      }
      for (const fission of replay.recordsByFissionId.values()) {
        fission.ratchets.sort((left, right) => {
          return (
            left.blockNumber - right.blockNumber ||
            (left.extrinsicIndex ?? -1) - (right.extrinsicIndex ?? -1) ||
            left.sourceRatchetIndex - right.sourceRatchetIndex
          );
        });
      }
      for (const activeFission of activeFissions) {
        const existing = replay.recordsByFissionId.get(activeFission.fissionId);
        if (existing) {
          this.assertActiveStateMatchesHistory(existing, activeFission);
          continue;
        }

        const lock = migratedLocks.find(lock => lock.utxoId === activeFission.fissionId);
        const migrated = lock ? this.createMigratedRecord(lock, Number.MAX_SAFE_INTEGER, activeFission) : undefined;
        if (!migrated) {
          throw new Error(`Active Bitcoin Fission ${activeFission.fissionId} is missing its creation history`);
        }
        replay.recordsByFissionId.set(activeFission.fissionId, migrated);
      }
      for (const lock of migratedLocks) {
        if (lock.utxoId === undefined || replay.recordsByFissionId.has(lock.utxoId)) continue;
        const migrated = this.createMigratedRecord(lock);
        if (migrated) replay.recordsByFissionId.set(migrated.fissionId, migrated);
      }
      const records = [...replay.recordsByFissionId.values()].sort((left, right) => left.fissionId - right.fissionId);
      await this.getTable().then(table => table.upsertRecoveredHistory(records));
      this.onHistoryRecovered?.(records);

      this.replay = undefined;
      return records;
    });
  }

  public cancelHistoryReplay(): void {
    this.replay = undefined;
  }

  private applyCreation(
    replay: FissionHistoryReplay,
    block: IBlockHeaderInfo,
    record: NamedFissionRecoveryEventRecord,
    transactionFee?: bigint,
  ): void {
    const { event } = record;
    if (event.section !== 'bitcoinFissions' || event.method !== 'FissionCreated') return;

    const fissionId = Number(event.data.fissionId);
    const existing = replay.recordsByFissionId.get(fissionId);
    if (existing?.origin === 'lock-migration') {
      throw new Error(`Bitcoin Fission ${fissionId} has both migration and creation origins`);
    }

    const blockTime = new Date(block.blockTime);
    const extrinsicIndex = readExtrinsicIndex(record);
    const liquidityPromised = event.data.liquidityPromised;
    replay.recordsByFissionId.set(fissionId, {
      origin: 'created',
      ownerAccount: this.ownerAccount,
      fissionId,
      liquidId: Number(event.data.liquidId),
      utxoId: event.data.utxoId,
      satoshis: event.data.satoshis,
      microgonsAtTargetPerBtc: event.data.microgonsAtTargetPerBtc,
      liquidityPromised,
      createdAtArgonBlock: block.blockNumber,
      ratchetNumber: 0,
      lastUpdatedArgonBlock: block.blockNumber,
      createdAtTick: block.tick,
      ratchets: [
        {
          source: 'fission',
          sourceRatchetIndex: 0,
          ratchetNumber: 0,
          microgonsAtTargetPerBtc: event.data.microgonsAtTargetPerBtc,
          liquidityPromised,
          amountMinted: liquidityPromised,
          amountBurned: 0n,
          mintPending: liquidityPromised,
          txFee: transactionFee,
          blockNumber: block.blockNumber,
          tick: block.tick,
          blockHash: block.blockHash,
          blockTime,
          extrinsicIndex,
        },
      ],
      createdBlockHash: block.blockHash,
      createdBlockTime: blockTime,
      createdExtrinsicIndex: extrinsicIndex,
      createdAt: blockTime,
      updatedAt: blockTime,
    });
  }

  private async applyEvent(
    replay: FissionHistoryReplay,
    block: IBlockHeaderInfo,
    record: NamedFissionRecoveryEventRecord,
    transactionFee?: bigint,
  ): Promise<void> {
    const { event } = record;
    if (event.section === 'mint' && event.method === 'BitcoinMint') {
      const fissionId = event.data.fissionId === undefined ? undefined : Number(event.data.fissionId);
      if (fissionId !== undefined) this.applyMint(replay, fissionId, event.data.amount);
      return;
    }
    if (event.section !== 'bitcoinFissions') return;

    const fissionId = Number(event.data.fissionId);
    const fission = replay.recordsByFissionId.get(fissionId);
    if (!fission) throw new Error(`Bitcoin Fission ${fissionId} history is missing its creation event`);

    if (event.method === 'FissionRatcheted') {
      const ratchetNumber = Number(event.data.ratchetNumber);
      const ratchet: IBitcoinFissionRatchet = {
        source: 'fission',
        sourceRatchetIndex: ratchetNumber,
        ratchetNumber,
        microgonsAtTargetPerBtc: event.data.microgonsAtTargetPerBtc,
        liquidityPromised: event.data.liquidityPromised,
        amountMinted: event.data.amountMinted,
        amountBurned: event.data.amountBurned,
        mintPending: event.data.amountMinted,
        txFee: transactionFee,
        blockNumber: block.blockNumber,
        tick: block.tick,
        blockHash: block.blockHash,
        blockTime: new Date(block.blockTime),
        extrinsicIndex: readExtrinsicIndex(record),
      };
      const existingIndex = fission.ratchets.findIndex(candidate => {
        return candidate.source === 'fission' && candidate.ratchetNumber === ratchetNumber;
      });
      if (existingIndex === -1) fission.ratchets.push(ratchet);
      else fission.ratchets.splice(existingIndex, 1, ratchet);
      fission.microgonsAtTargetPerBtc = ratchet.microgonsAtTargetPerBtc;
      fission.liquidityPromised = ratchet.liquidityPromised!;
      fission.ratchetNumber = ratchetNumber;
      fission.lastUpdatedArgonBlock = block.blockNumber;
      fission.updatedAt = ratchet.blockTime!;
      return;
    }

    if (event.method !== 'FissionClosed' && event.method !== 'FissionClosedByLock') {
      throw new Error(`Unsupported Bitcoin Fission history event ${event.method}`);
    }

    const close = {
      closedAtArgonBlock: block.blockNumber,
      closedAtTick: block.tick,
      closedBlockHash: block.blockHash,
      closedBlockTime: new Date(block.blockTime),
      closedExtrinsicIndex: readExtrinsicIndex(record),
      closeReason: event.method === 'FissionClosed' ? ('closed' as const) : ('lock-spent' as const),
    };
    if (this.historicalRates) {
      const api = await this.historicalRates.blockWatch.getApi(block);
      const rates = await this.historicalRates.currency.fetchMainchainRatesAtBlock({ api, block });
      fission.btcPriceAtCloseMicrogons = rates.BTC;
    }
    fission.closeTxFee = transactionFee;
    Object.assign(fission, close);
    if (event.method === 'FissionClosed') fission.redemptionAmount = event.data.redemptionAmount;
    fission.updatedAt = close.closedBlockTime;
  }

  private applyMint(replay: FissionHistoryReplay, fissionId: number, amount: bigint): void {
    const fission = replay.recordsByFissionId.get(fissionId);
    if (!fission) throw new Error(`Bitcoin Fission ${fissionId} history is missing its creation event`);

    let remaining = amount;
    for (const ratchet of fission.ratchets) {
      const applied = remaining < ratchet.mintPending ? remaining : ratchet.mintPending;
      ratchet.mintPending -= applied;
      remaining -= applied;
      if (remaining === 0n) break;
    }
    if (remaining > 0n) {
      throw new Error(`Bitcoin Fission ${fissionId} minted more than its recovered entitlement`);
    }
  }

  private createMigratedRecord(
    lock: IHistoricalBitcoinLockRecord,
    observedAtBlock?: number,
    activeFission?: IBitcoinFission,
  ): IBitcoinFissionRecord | undefined {
    const fissionId = lock.utxoId;
    if (fissionId === undefined) return;
    if (!lock.ratchets.some(ratchet => ratchet.mintAmount > 0n)) return;
    if (observedAtBlock !== undefined && lock.removalBlockNumber != null && lock.removalBlockNumber < observedAtBlock) {
      return;
    }
    if (activeFission && !matchesMigratedFission(lock, activeFission)) return;

    const ratchets = lock.ratchets.map<IBitcoinFissionRatchet>((ratchet, sourceRatchetIndex) => ({
      source: 'lock',
      sourceRatchetIndex,
      microgonsAtTargetPerBtc: ratchet.lockedTargetPrice,
      liquidityPromised: ratchet.liquidityPromised,
      amountMinted: ratchet.mintAmount,
      amountBurned: ratchet.burned,
      mintPending: ratchet.mintPending,
      securityFee: ratchet.securityFee,
      txFee: ratchet.txFee,
      blockNumber: ratchet.blockHeight,
      tick: ratchet.tick,
      extrinsicIndex: ratchet.extrinsicIndex,
    }));
    const lastUpdatedArgonBlock = ratchets.at(-1)?.blockNumber ?? lock.lockDetails.createdAtArgonBlock;
    const wasReleased = lock.removalReason === 'released';
    const wasSpent = lock.removalReason === 'spent';
    return {
      origin: 'lock-migration',
      ownerAccount: this.ownerAccount,
      fissionId,
      liquidId: fissionId,
      utxoId: fissionId,
      satoshis: lock.satoshis,
      microgonsAtTargetPerBtc: lock.lockedTargetPrice,
      liquidityPromised: lock.liquidityPromised,
      createdAtArgonBlock: lock.lockDetails.createdAtArgonBlock,
      ratchetNumber: 0,
      lastUpdatedArgonBlock,
      ratchets,
      createdAtTick: ratchets[0]?.tick,
      ...(wasReleased || wasSpent
        ? {
            closedAtArgonBlock: lock.removalBlockNumber,
            closedAtTick: lock.removalTick,
            closedBlockHash: lock.removalBlockHash,
            closedBlockTime: lock.removalBlockTime,
            closedExtrinsicIndex: lock.removalExtrinsicIndex,
            closeReason: wasReleased ? ('closed' as const) : ('lock-spent' as const),
            redemptionAmount: wasReleased ? lock.releaseRedemptionMicrogons : undefined,
            btcPriceAtCloseMicrogons: lock.btcPriceAtRemovalMicrogons,
          }
        : {}),
      createdAt: lock.createdAt,
      updatedAt: lock.updatedAt,
    };
  }

  private assertActiveStateMatchesHistory(history: IBitcoinFissionRecord, active: IBitcoinFission): void {
    if (history.closedAtArgonBlock != null) {
      throw new Error(`Closed Bitcoin Fission ${active.fissionId} is still active on the current runtime`);
    }
    if (
      history.liquidId !== active.liquidId ||
      history.utxoId !== active.utxoId ||
      history.satoshis !== active.satoshis ||
      history.microgonsAtTargetPerBtc !== active.microgonsAtTargetPerBtc ||
      history.liquidityPromised !== active.liquidityPromised ||
      history.ratchetNumber !== active.ratchetNumber
    ) {
      throw new Error(`Active Bitcoin Fission ${active.fissionId} does not match recovered history`);
    }
  }

  private requireReplay(): FissionHistoryReplay {
    if (!this.replay) throw new Error('Bitcoin Fission history replay is not running');
    return this.replay;
  }

  private async getTable() {
    return await this.dbPromise.then(db => db.bitcoinFissionsTable);
  }

  private async queueHistoryWrite<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.historyWrite.then(operation);
    this.historyWrite = result.then(
      () => undefined,
      () => undefined,
    );
    return await result;
  }
}

function readFissionId(event: HistoricalEvent): number | undefined {
  if (event.section === 'bitcoinFissions') return Number(event.data.fissionId);
  if (event.section === 'mint' && event.method === 'BitcoinMint') {
    return event.data.fissionId === undefined ? undefined : Number(event.data.fissionId);
  }
}

function readExtrinsicIndex(record: NamedFissionRecoveryEventRecord): number | undefined {
  return record.phase.type === 'ApplyExtrinsic' ? record.phase.value : undefined;
}

function readTransactionFee(
  records: readonly NamedFissionRecoveryEventRecord[],
  operation: NamedFissionRecoveryEventRecord,
  ownerAccount: string,
): bigint | undefined {
  const extrinsicIndex = readExtrinsicIndex(operation);
  if (extrinsicIndex === undefined) return;

  const feeRecord = records.find(
    (
      record,
    ): record is NamedFissionRecoveryEventRecord & {
      event: Extract<HistoricalEvent, { section: 'transactionPayment'; method: 'TransactionFeePaid' }>;
    } => {
      return (
        readExtrinsicIndex(record) === extrinsicIndex &&
        record.event.section === 'transactionPayment' &&
        record.event.method === 'TransactionFeePaid'
      );
    },
  );
  if (!feeRecord) return;
  return feeRecord.event.data.who === ownerAccount ? feeRecord.event.data.actualFee : 0n;
}

function matchesMigratedFission(lock: IHistoricalBitcoinLockRecord, fission: IBitcoinFission): boolean {
  return (
    lock.utxoId === fission.fissionId &&
    fission.liquidId === fission.fissionId &&
    fission.utxoId === fission.fissionId &&
    fission.createdAtArgonBlock === lock.lockDetails.createdAtArgonBlock
  );
}

function cloneRecord(record: IBitcoinFissionRecord): IBitcoinFissionRecord {
  return JsonExt.parse(JsonExt.stringify(record));
}
