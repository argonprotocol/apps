import { BitcoinLockStatus, type IBitcoinLockRecord } from '../db/BitcoinLocksTable.ts';
import { BitcoinUtxoSpendStatus, BitcoinUtxoStatus, type IBitcoinUtxoRecord } from '../db/BitcoinUtxosTable.ts';
import type { IBitcoinReleaseRecord } from '../../interfaces/IBitcoinReleaseRecord.ts';
import type { IBitcoinFissionRecord } from '../../interfaces/IBitcoinFissionRecord.ts';
import type { IBitcoinSecuritizationTerm } from '../../interfaces/IBitcoinSecuritizationTerm.ts';
import type { Db } from '../Db.ts';

export class BitcoinHistoryUtxoState {
  readonly #recordsByOutpoint = new Map<string, IBitcoinUtxoRecord>();
  readonly #recordsById = new Map<number, IBitcoinUtxoRecord>();
  #nextTemporaryId = -1;

  public get records(): readonly IBitcoinUtxoRecord[] {
    return [...this.#recordsById.values()];
  }

  public add(record: IBitcoinUtxoRecord): IBitcoinUtxoRecord {
    const detached = { ...record };
    this.#recordsById.set(detached.id, detached);
    this.#recordsByOutpoint.set(this.getKey(detached.lockId, detached.txid, detached.vout), detached);
    return detached;
  }

  public getById(id: number): IBitcoinUtxoRecord | undefined {
    return this.#recordsById.get(id);
  }

  public getByOutpoint(lockId: number, txid: string, vout: number): IBitcoinUtxoRecord | undefined {
    return this.#recordsByOutpoint.get(this.getKey(lockId, txid, vout));
  }

  public getForLock(lockId: number): IBitcoinUtxoRecord[] {
    return this.records.filter(record => record.lockId === lockId);
  }

  public upsert(
    lock: Pick<IBitcoinLockRecord, 'lockId' | 'network'>,
    candidate: Pick<IBitcoinUtxoRecord, 'txid' | 'vout' | 'satoshis'>,
    markOrphaned = false,
  ): IBitcoinUtxoRecord {
    if (lock.lockId === undefined) throw new Error('Historical UTXO does not have a canonical Lock ID');

    let record = this.getByOutpoint(lock.lockId, candidate.txid, candidate.vout);
    if (!record) {
      const now = new Date();
      record = this.add({
        id: this.#nextTemporaryId--,
        lockId: lock.lockId,
        ...candidate,
        network: lock.network,
        status: BitcoinUtxoStatus.SeenOnMempool,
        spendStatus: BitcoinUtxoSpendStatus.Unspent,
        firstSeenAt: now,
        firstSeenBitcoinHeight: 0,
        createdAt: now,
        updatedAt: now,
      });
    }
    record.satoshis = candidate.satoshis;
    if (markOrphaned) {
      record.status = BitcoinUtxoStatus.Orphaned;
      record.firstSeenOnArgonAt ??= new Date();
    }
    return record;
  }

  private getKey(lockId: number, txid: string, vout: number): string {
    return `${lockId}:${txid}:${vout}`;
  }
}

export type BitcoinHistoryReplayLockScope = 'all' | 'encountered' | 'pending';

export interface IHistoricalBitcoinLockRatchet {
  /** Gross liquidity submitted to the mint queue by this ratchet. */
  mintAmount: bigint;
  mintPending: bigint;
  /** Post-ratchet liquidity promised by the lock. Older records predate this field. */
  liquidityPromised?: bigint;
  lockedTargetPrice: bigint;
  securityFee: bigint;
  securityFeeCoupon?: bigint;
  txFee?: bigint;
  burned: bigint;
  blockHeight: number;
  tick?: number;
  blockHash?: string;
  blockTime?: Date;
  extrinsicIndex?: number;
  oracleBitcoinBlockHeight: number;
}

export type IHistoricalBitcoinLockRecord = Omit<IBitcoinLockRecord, 'lockId'> & {
  /** The identifier used by the deployed pre-159 runtime and its historical events. */
  utxoId: number;
  removalTick?: number;
  satoshis: bigint;
  lockedTargetPrice: bigint;
  liquidityPromised: bigint;
  ratchets: IHistoricalBitcoinLockRatchet[];
};

export type IHistoricalBitcoinLiquidClose = Pick<IBitcoinFissionRecord, 'redemptionAmount' | 'closeTxFee'>;

export function createHistoricalBitcoinLockRecord(
  record: IBitcoinLockRecord | IHistoricalBitcoinLockRecord,
): IHistoricalBitcoinLockRecord {
  if ('utxoId' in record) {
    return {
      ...record,
      fundingUtxoIds: [...record.fundingUtxoIds],
      ratchets: record.ratchets.map(ratchet => ({ ...ratchet })),
    };
  }
  if (record.lockId == null || !record.ownerAccount || !record.scriptDetails) {
    throw new Error(`Bitcoin lock ${record.uuid} does not have enough chain state for historical replay`);
  }
  const { lockId, ...durable } = record;
  return {
    ...durable,
    fundingUtxoIds: [...record.fundingUtxoIds],
    utxoId: lockId,
    satoshis: record.fundedSatoshis || record.securitizedSatoshis,
    lockedTargetPrice: 0n,
    liquidityPromised: 0n,
    ratchets: [],
  };
}

export type BitcoinHistoryReplaySession = {
  purpose: 'financial-backfill' | 'operational-repair';
  ownedVaultId?: number;
  activeLockIds: Set<number>;
  currentHistoricalUtxoId?: number;
  lockIdByHistoricalUtxoId: Map<number, number>;
  locksByLockId: Record<number, IHistoricalBitcoinLockRecord>;
  utxos: BitcoinHistoryUtxoState;
  releasesById: Record<string, IBitcoinReleaseRecord>;
  historicalLiquidCloseByUtxoId: Map<number, IHistoricalBitcoinLiquidClose>;
  lockScope: BitcoinHistoryReplayLockScope;
  hdKeys: Map<string, Parameters<Db['walletHdKeysTable']['upsert']>[0]>;
  dirtyLockIds: Set<number>;
  failedLockIds: Set<number>;
  hasUnscopedFailure: boolean;
  recoveredThroughBlock: number;
  securitizationTermsByLockId: Map<number, IBitcoinSecuritizationTerm[]>;
};

export const bitcoinRecoveryEventPolicies: Readonly<Record<string, 'replay' | 'preserve' | 'ignore'>> = {
  BitcoinCosignPastDue: 'replay',
  BitcoinLockBackfillChanged: 'replay',
  BitcoinLockFlexibleChanged: 'replay',
  BitcoinLockBurned: 'replay',
  BitcoinLockCreated: 'replay',
  BitcoinLockRatcheted: 'replay',
  BitcoinLockResecuritized: 'replay',
  BitcoinLockTerminated: 'replay',
  BitcoinSpentAfterRelease: 'replay',
  BitcoinUtxoCosignRequested: 'replay',
  BitcoinUtxoCosigned: 'replay',
  CosignOverdueError: 'ignore',
  LockExpirationError: 'ignore',
  OrphanedUtxoCleanupScheduleOverflow: 'ignore',
  OrphanedUtxoCosigned: 'replay',
  OrphanedUtxoExpirationError: 'ignore',
  OrphanedUtxoReceived: 'replay',
  OrphanedUtxoReleaseRequested: 'replay',
  SecuritizationIncreased: 'replay',
  UtxoFundedFromCandidate: 'replay',
};
