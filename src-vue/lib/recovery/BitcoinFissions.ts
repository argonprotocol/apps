import {
  BitcoinFission,
  type BlockWatch,
  type Currency,
  JsonExt,
  type IBitcoinFission,
  type IBlockHeaderInfo,
  type RuntimeSystemEventRecord,
} from '@argonprotocol/apps-core';
import type { HistoricalEvent } from '@argonprotocol/runtime-client/events';

import type { IBitcoinFissionRecord, IBitcoinFissionRatchetRecord } from '../../interfaces/IBitcoinFissionRecord.ts';
import { BitcoinLockStatus } from '../../interfaces/IBitcoinLockRecord.ts';
import type { Db } from '../Db.ts';
import type { IHistoricalBitcoinLockRecord } from './BitcoinLockReplay.ts';

type FissionRecoveryEventRecord = RuntimeSystemEventRecord;
type NamedFissionRecoveryEventRecord = RuntimeSystemEventRecord & { event: HistoricalEvent };

type DeferredFissionEvent = {
  fissionId: number;
  lockId: number | undefined;
  block: IBlockHeaderInfo;
  record: NamedFissionRecoveryEventRecord;
  transactionFee?: bigint;
};

type FissionHistoryReplay = {
  recordsByFissionId: Map<number, IBitcoinFissionRecord>;
  deferredEvents: DeferredFissionEvent[];
  currentFissionId?: number;
  currentFissionLockId?: number;
  failureByFissionId: Map<number, { message: string; lockId: number }>;
  unscopedFailure?: string;
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
  ) {}

  public async beginHistoryReplay({ replace = false }: { replace?: boolean } = {}): Promise<void> {
    await this.queueHistoryWrite(async () => {
      if (this.replay) throw new Error('Bitcoin Fission history replay is already running');

      const records = replace ? [] : await this.getTable().then(table => table.fetchAll(this.ownerAccount));
      this.replay = {
        recordsByFissionId: new Map(records.map(record => [record.fissionId, cloneRecord(record)])),
        deferredEvents: [],
        failureByFissionId: new Map(),
      };
    });
  }

  public markHistoryReplayFailure(error?: unknown): void {
    if (!this.replay) return;
    if (!this.recordReplayFailure(this.replay, error)) {
      this.replay.unscopedFailure = readErrorMessage(error, 'Bitcoin Fission history replay failed');
    }
    this.replay.currentFissionId = undefined;
    this.replay.currentFissionLockId = undefined;
  }

  public async recoverBlock(
    block: IBlockHeaderInfo,
    rawEventRecords: readonly FissionRecoveryEventRecord[],
  ): Promise<void> {
    await this.applyBlock(this.requireReplay(), block, rawEventRecords, true);
  }

  private async applyBlock(
    replay: FissionHistoryReplay,
    block: IBlockHeaderInfo,
    rawEventRecords: readonly FissionRecoveryEventRecord[],
    isolateFailures = false,
  ): Promise<void> {
    const eventRecords = rawEventRecords as readonly NamedFissionRecoveryEventRecord[];

    for (const record of eventRecords) {
      try {
        const { event } = record;
        if (!BitcoinFission.isOwnedEvent(event, this.ownerAccount)) continue;
        const fissionId = event.data.fissionId;
        const lockId =
          event.section === 'bitcoinFissions' &&
          (event.method === 'FissionCreated' || event.method === 'FissionClosedByLock')
            ? event.data.lockId
            : undefined;
        replay.currentFissionId = fissionId;
        replay.currentFissionLockId =
          lockId ??
          replay.recordsByFissionId.get(fissionId)?.lockId ??
          this.getActiveFissions().find(fission => fission.fissionId === fissionId)?.lockId;
        if (replay.failureByFissionId.has(fissionId)) continue;

        const transactionFee = readTransactionFee(eventRecords, record, this.ownerAccount);
        if (event.method !== 'FissionCreated' && !replay.recordsByFissionId.has(fissionId)) {
          replay.deferredEvents.push({ fissionId, lockId, block, record, transactionFee });
          continue;
        }
        await this.applyEvent(replay, block, record, transactionFee);
      } catch (error) {
        if (!isolateFailures || !this.recordReplayFailure(replay, error)) throw error;
      } finally {
        replay.currentFissionId = undefined;
        replay.currentFissionLockId = undefined;
      }
    }
  }

  public async prepareHistoryReplay(
    migratedLocks: readonly IHistoricalBitcoinLockRecord[] = [],
    lockIdByHistoricalUtxoId: ReadonlyMap<number, number> = new Map(),
    historicalLiquidRedemptionByUtxoId: ReadonlyMap<number, bigint> = new Map(),
  ): Promise<{ records: IBitcoinFissionRecord[]; failuresByLockId: Map<number, string> }> {
    return await this.queueHistoryWrite(async () => {
      const replay = this.requireReplay();
      if (replay.unscopedFailure) throw new Error(replay.unscopedFailure);
      const activeFissions = this.getActiveFissions();
      for (const deferred of replay.deferredEvents) {
        const { fissionId } = deferred;
        if (replay.failureByFissionId.has(fissionId)) continue;
        const activeFission = activeFissions.find(fission => fission.fissionId === fissionId);
        const knownRecord = replay.recordsByFissionId.get(fissionId);
        const lockId = knownRecord?.lockId ?? deferred.lockId ?? activeFission?.lockId;

        try {
          if (!replay.recordsByFissionId.has(fissionId)) {
            const lock = migratedLocks.find(lock => {
              return (lockIdByHistoricalUtxoId.get(lock.utxoId) ?? lock.utxoId) === lockId;
            });
            const migrated = lock
              ? this.createMigratedRecord(
                  lock,
                  lockIdByHistoricalUtxoId.get(lock.utxoId) ?? lock.utxoId,
                  historicalLiquidRedemptionByUtxoId.get(lock.utxoId),
                  deferred.block.blockNumber,
                  activeFission,
                )
              : undefined;
            if (!migrated) throw new Error(`Bitcoin Fission ${fissionId} history is missing its creation event`);
            replay.recordsByFissionId.set(fissionId, migrated);
          }
          await this.applyEvent(replay, deferred.block, deferred.record, deferred.transactionFee);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (lockId === undefined) replay.unscopedFailure = message;
          else {
            replay.failureByFissionId.set(fissionId, { message, lockId });
          }
        }
      }
      if (replay.unscopedFailure) throw new Error(replay.unscopedFailure);
      for (const fission of replay.recordsByFissionId.values()) {
        fission.ratchets = fission.ratchets.toSorted((left, right) => {
          return (
            left.blockNumber - right.blockNumber ||
            (left.extrinsicIndex ?? -1) - (right.extrinsicIndex ?? -1) ||
            left.sourceRatchetIndex - right.sourceRatchetIndex
          );
        });
      }
      for (const activeFission of activeFissions) {
        if (replay.failureByFissionId.has(activeFission.fissionId)) continue;
        const existing = replay.recordsByFissionId.get(activeFission.fissionId);
        if (existing) {
          try {
            this.assertActiveStateMatchesHistory(existing, activeFission);
          } catch (error) {
            replay.failureByFissionId.set(activeFission.fissionId, {
              message: error instanceof Error ? error.message : String(error),
              lockId: activeFission.lockId,
            });
          }
          continue;
        }

        const lock = migratedLocks.find(lock => {
          return (lockIdByHistoricalUtxoId.get(lock.utxoId) ?? lock.utxoId) === activeFission.lockId;
        });
        const migrated = lock
          ? this.createMigratedRecord(
              lock,
              lockIdByHistoricalUtxoId.get(lock.utxoId) ?? lock.utxoId,
              historicalLiquidRedemptionByUtxoId.get(lock.utxoId),
              Number.MAX_SAFE_INTEGER,
              activeFission,
            )
          : undefined;
        if (!migrated) {
          replay.failureByFissionId.set(activeFission.fissionId, {
            message: `Active Bitcoin Fission ${activeFission.fissionId} is missing its creation history`,
            lockId: activeFission.lockId,
          });
          continue;
        }
        replay.recordsByFissionId.set(activeFission.fissionId, migrated);
      }
      const failedLockIds = new Set([...replay.failureByFissionId.values()].map(failure => failure.lockId));
      const recoveredLockIds = new Set([...replay.recordsByFissionId.values()].map(record => record.lockId));
      for (const lock of migratedLocks) {
        const lockId = lockIdByHistoricalUtxoId.get(lock.utxoId) ?? lock.utxoId;
        if (failedLockIds.has(lockId) || recoveredLockIds.has(lockId)) continue;
        const migrated = this.createMigratedRecord(lock, lockId, historicalLiquidRedemptionByUtxoId.get(lock.utxoId));
        if (migrated) replay.recordsByFissionId.set(migrated.fissionId, migrated);
      }
      const failuresByLockId = new Map<number, string>();
      for (const failure of replay.failureByFissionId.values()) {
        failuresByLockId.set(failure.lockId, failure.message);
      }
      const records = [...replay.recordsByFissionId.values()]
        .filter(record => !replay.failureByFissionId.has(record.fissionId))
        .sort((left, right) => left.fissionId - right.fissionId);

      return { records, failuresByLockId };
    });
  }

  public async finishHistoryReplay(): Promise<void> {
    await this.queueHistoryWrite(async () => {
      this.requireReplay();
      this.replay = undefined;
    });
  }

  public cancelHistoryReplay(): void {
    this.replay = undefined;
  }

  private async applyEvent(
    replay: FissionHistoryReplay,
    block: IBlockHeaderInfo,
    record: NamedFissionRecoveryEventRecord,
    transactionFee?: bigint,
  ): Promise<void> {
    const { event } = record;
    if (!BitcoinFission.isOwnedEvent(event, this.ownerAccount)) return;
    const fissionId = event.data.fissionId;
    const existing = replay.recordsByFissionId.get(fissionId);
    if (event.section === 'bitcoinFissions' && event.method === 'FissionCreated') {
      if (existing?.origin === 'lock-migration') {
        throw new Error(`Bitcoin Fission ${fissionId} has both migration and creation origins`);
      }
      replay.recordsByFissionId.set(
        fissionId,
        BitcoinFission.createRecordFromEvent({
          block,
          event,
          extrinsicIndex: readExtrinsicIndex(record),
          transactionFee,
        }),
      );
      return;
    }
    if (!existing) throw new Error(`Bitcoin Fission ${fissionId} history is missing its creation event`);

    let btcPriceAtCloseMicrogons: bigint | undefined;
    if (
      this.historicalRates &&
      event.section === 'bitcoinFissions' &&
      (event.method === 'FissionClosed' || event.method === 'FissionClosedByLock')
    ) {
      const api = await this.historicalRates.blockWatch.getApi(block);
      const rates = await this.historicalRates.currency.fetchMainchainRatesAtBlock({ api, block });
      btcPriceAtCloseMicrogons = rates.BTC;
    }
    replay.recordsByFissionId.set(
      fissionId,
      BitcoinFission.applyEventToRecord({
        record: existing,
        block,
        event,
        extrinsicIndex: readExtrinsicIndex(record),
        transactionFee,
        btcPriceAtCloseMicrogons,
      }),
    );
  }

  private createMigratedRecord(
    lock: IHistoricalBitcoinLockRecord,
    lockId: number,
    redemptionAmount?: bigint,
    observedAtBlock?: number,
    activeFission?: IBitcoinFission,
  ): IBitcoinFissionRecord | undefined {
    const fissionId = lock.utxoId;
    if (lock.status === BitcoinLockStatus.LockFailedAcknowledged && lock.fundedSatoshis === 0n) return;
    if (!lock.ratchets.some(ratchet => ratchet.mintAmount > 0n)) return;
    if (observedAtBlock !== undefined && lock.removalBlockNumber != null && lock.removalBlockNumber < observedAtBlock) {
      return;
    }
    if (activeFission && !matchesMigratedFission(lock, lockId, activeFission)) return;

    const ratchets = lock.ratchets.map<IBitcoinFissionRatchetRecord>((ratchet, sourceRatchetIndex) => ({
      source: 'lock',
      sourceRatchetIndex,
      microgonsAtTargetPerBtc: ratchet.lockedTargetPrice,
      liquidityPromised: ratchet.liquidityPromised,
      amountMinted: ratchet.mintAmount,
      amountBurned: ratchet.burned,
      mintPending: ratchet.mintPending,
      securityFee: ratchet.securityFee,
      securityFeeCoupon: ratchet.securityFeeCoupon,
      txFee: ratchet.txFee,
      blockNumber: ratchet.blockHeight,
      tick: ratchet.tick,
      extrinsicIndex: ratchet.extrinsicIndex,
    }));
    const lastUpdatedArgonBlock = ratchets.at(-1)?.blockNumber ?? lock.createdAtArgonBlock ?? 0;
    const wasReleased = lock.removalReason === 'released';
    const wasSpent = lock.removalReason === 'spent';
    const feeHistoryCompleteThroughBlock =
      ratchets.length && ratchets.every(ratchet => ratchet.txFee !== undefined) ? lastUpdatedArgonBlock : undefined;
    return {
      origin: 'lock-migration',
      ownerAccount: this.ownerAccount,
      fissionId,
      liquidId: fissionId,
      lockId,
      satoshis: lock.satoshis,
      microgonsAtTargetPerBtc: lock.lockedTargetPrice,
      liquidityPromised: lock.liquidityPromised,
      createdAtArgonBlock: lock.createdAtArgonBlock ?? 0,
      ratchetNumber: 0,
      lastUpdatedArgonBlock,
      feeHistoryCompleteThroughBlock,
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
            redemptionAmount,
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
      history.lockId !== active.lockId ||
      history.satoshis !== active.satoshis ||
      history.createdAtArgonBlock !== active.createdAtArgonBlock ||
      history.microgonsAtTargetPerBtc !== active.microgonsAtTargetPerBtc ||
      history.liquidityPromised !== active.liquidityPromised ||
      history.lastUpdatedArgonBlock !== active.lastUpdatedArgonBlock
    ) {
      throw new Error(`Active Bitcoin Fission ${active.fissionId} does not match recovered history`);
    }
  }

  private requireReplay(): FissionHistoryReplay {
    if (!this.replay) throw new Error('Bitcoin Fission history replay is not running');
    return this.replay;
  }

  private recordReplayFailure(replay: FissionHistoryReplay, error?: unknown): boolean {
    if (replay.currentFissionId === undefined || replay.currentFissionLockId === undefined) return false;
    replay.failureByFissionId.set(replay.currentFissionId, {
      message: readErrorMessage(error, 'Bitcoin Fission history replay failed'),
      lockId: replay.currentFissionLockId,
    });
    return true;
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

function readErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : String(error ?? fallback);
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

function matchesMigratedFission(lock: IHistoricalBitcoinLockRecord, lockId: number, fission: IBitcoinFission): boolean {
  return (
    lock.utxoId === fission.fissionId &&
    fission.liquidId === fission.fissionId &&
    fission.lockId === lockId &&
    fission.createdAtArgonBlock === lock.createdAtArgonBlock
  );
}

function cloneRecord(record: IBitcoinFissionRecord): IBitcoinFissionRecord {
  return JsonExt.parse(JsonExt.stringify(record));
}
