import type { IBitcoinLockDetails } from '@argonprotocol/apps-core';
import { BitcoinLocksTable, BitcoinLockStatus, type IBitcoinLockRecord } from '../db/BitcoinLocksTable.ts';
import {
  BitcoinUtxoRole,
  BitcoinUtxoStatus,
  isBitcoinUtxoReleaseStatus,
  type IBitcoinUtxoRecord,
} from '../db/BitcoinUtxosTable.ts';
import type BitcoinUtxoTracking from '../BitcoinUtxoTracking.ts';
import type { Db } from '../Db.ts';
import type { IBitcoinSecuritizationTerm } from '../../interfaces/IBitcoinSecuritizationTerm.ts';

export type BitcoinRecoveryUtxoTracking = Pick<
  BitcoinUtxoTracking,
  | 'getAcceptedFundingRecordForLock'
  | 'getAllOrphanLifecycleUtxos'
  | 'getObservedStatusForUpsert'
  | 'getUtxoRecord'
  | 'getUtxosForLock'
  | 'isReleaseCompleteStatus'
  | 'isReleaseStatus'
  | 'load'
  | 'setAcceptedFundingRecordForLock'
  | 'setReleaseCosign'
  | 'setReleaseIsProcessingOnArgon'
  | 'setReleaseRequest'
  | 'shouldUpdateObservedStatus'
  | 'upsertUtxoRecord'
>;

export type BitcoinHistoryReplayLockScope = 'all' | 'encountered' | 'pending';

export interface IHistoricalBitcoinLockRatchet {
  /** Gross liquidity submitted to the mint queue by this ratchet. */
  mintAmount: bigint;
  mintPending: bigint;
  /** Post-ratchet liquidity promised by the lock. Older records predate this field. */
  liquidityPromised?: bigint;
  lockedTargetPrice: bigint;
  securityFee: bigint;
  txFee: bigint;
  burned: bigint;
  blockHeight: number;
  tick?: number;
  extrinsicIndex?: number;
  oracleBitcoinBlockHeight: number;
}

export type IHistoricalBitcoinLockRecord = IBitcoinLockRecord & {
  removalTick?: number;
  satoshis: bigint;
  lockedTargetPrice: bigint;
  liquidityPromised: bigint;
  ratchets: IHistoricalBitcoinLockRatchet[];
  lockDetails: IBitcoinLockDetails;
};

export function createHistoricalBitcoinLockRecord(
  record: IBitcoinLockRecord | IHistoricalBitcoinLockRecord,
): IHistoricalBitcoinLockRecord {
  if ('lockDetails' in record) {
    return {
      ...record,
      ratchets: record.ratchets.map(ratchet => ({ ...ratchet })),
      utxos: [...record.utxos],
    };
  }
  if (record.utxoId === undefined || !record.ownerAccount || !record.scriptDetails) {
    throw new Error(`Bitcoin lock ${record.uuid} does not have enough chain state for historical replay`);
  }

  return {
    ...record,
    utxos: [...record.utxos],
    satoshis: record.fundedSatoshis || record.securitizedSatoshis,
    lockedTargetPrice: 0n,
    liquidityPromised: 0n,
    ratchets: [],
    lockDetails: {
      utxoId: record.utxoId,
      vaultId: record.vaultId,
      securitizedSatoshis: record.securitizedSatoshis,
      fundedSatoshis: record.fundedSatoshis,
      ownerAccount: record.ownerAccount,
      securitizationRatio: record.securitizationRatio ?? 0,
      securityFees: record.securityFees,
      couponFeesPaid: record.couponFeesPaid,
      ...record.scriptDetails,
      fundingExpirationHeight: record.fundingExpirationHeight ?? 0,
      isFlexible: record.isFlexible ?? false,
      fundHoldExtensionsByBitcoinExpirationHeight: record.fundHoldExtensionsByBitcoinExpirationHeight,
      createdAtArgonBlock: record.createdAtArgonBlock ?? 0,
    },
  };
}

export type BitcoinHistoryReplaySession = {
  commitStarted: boolean;
  currentLockUtxoId?: number;
  locksByUtxoId: Record<number, IHistoricalBitcoinLockRecord>;
  originalLocksByUtxoId: Record<number, IHistoricalBitcoinLockRecord>;
  utxos: BitcoinHistoryUtxoProjection;
  lockScope: BitcoinHistoryReplayLockScope;
  hdKeys: Map<string, Parameters<Db['walletHdKeysTable']['upsert']>[0]>;
  dirtyLockUtxoIds: Set<number>;
  failedLockUtxoIds: Set<number>;
  hasUnscopedFailure: boolean;
  recoveredThroughBlock: number;
  securitizationTermsByUtxoId: Map<number, IBitcoinSecuritizationTerm[]>;
};

export const bitcoinRecoveryEventPolicies: Readonly<Record<string, 'replay' | 'preserve' | 'ignore'>> = {
  BitcoinCosignPastDue: 'replay',
  BitcoinLockBackfillChanged: 'replay',
  BitcoinLockFlexibleChanged: 'replay',
  BitcoinLockBurned: 'replay',
  BitcoinLockCreated: 'replay',
  BitcoinLockRatcheted: 'replay',
  BitcoinLockResecuritized: 'replay',
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

export function resolveRecoveredLock(
  durable: IBitcoinLockRecord,
  recovered: IHistoricalBitcoinLockRecord,
  useRecoveredStatus: boolean,
): IBitcoinLockRecord {
  const recoveredFinishedRelease =
    durable.status === BitcoinLockStatus.Releasing && recovered.status === BitcoinLockStatus.Released;
  const status = useRecoveredStatus || recoveredFinishedRelease ? recovered.status : durable.status;
  const createdAt = durable.createdAt < recovered.createdAt ? durable.createdAt : recovered.createdAt;

  assignIfUnset(durable, recovered, [
    'utxoId',
    'fundingUtxo',
    'releaseRedemptionMicrogons',
    'releaseArgonTxFeeMicrogons',
    'releaseCompensationMicrogons',
    'removalBlockNumber',
    'removalBlockHash',
    'removalBlockTime',
    'removalExtrinsicIndex',
    'removalReason',
    'btcPriceAtRemovalMicrogons',
  ]);
  Object.assign(durable, {
    securitizedSatoshis: recovered.securitizedSatoshis,
    ownerAccount: recovered.ownerAccount,
    microgonsAtTargetPerBtc: recovered.microgonsAtTargetPerBtc ?? durable.microgonsAtTargetPerBtc,
    securitizationCoverageMicrogons:
      recovered.securitizationCoverageMicrogons ?? durable.securitizationCoverageMicrogons,
    securitizationTick: recovered.securitizationTick ?? durable.securitizationTick,
    fissionedSatoshis: recovered.fissionedSatoshis ?? durable.fissionedSatoshis,
    securitizationRatio: recovered.securitizationRatio,
    securityFees: recovered.securityFees,
    couponFeesPaid: recovered.couponFeesPaid,
    scriptDetails: recovered.scriptDetails,
    fundingExpirationHeight: recovered.fundingExpirationHeight,
    isFlexible: recovered.isFlexible,
    fundHoldExtensionsByBitcoinExpirationHeight: recovered.fundHoldExtensionsByBitcoinExpirationHeight,
    createdAtArgonBlock: recovered.createdAtArgonBlock,
    createdAt,
    status,
  });
  return durable;
}

export function resolveRecoveredUtxo(durable: IBitcoinUtxoRecord, recovered: IBitcoinUtxoRecord): IBitcoinUtxoRecord {
  const durableIsRelease = isBitcoinUtxoReleaseStatus(durable.status);
  const recoveredIsRelease = isBitcoinUtxoReleaseStatus(recovered.status);
  const durableReleaseIsComplete =
    durable.status === BitcoinUtxoStatus.ReleaseComplete ||
    durable.status === BitcoinUtxoStatus.ReleaseCompleteAcknowledged;
  const recoveredReleaseIsComplete =
    recovered.status === BitcoinUtxoStatus.ReleaseComplete ||
    recovered.status === BitcoinUtxoStatus.ReleaseCompleteAcknowledged;
  let status = recovered.status;
  if (durableIsRelease || durable.status === BitcoinUtxoStatus.FundingUtxo) status = durable.status;
  if (recoveredReleaseIsComplete && !durableReleaseIsComplete) status = recovered.status;
  let statusError = recovered.statusError ?? durable.statusError;
  if (recoveredReleaseIsComplete && !durableReleaseIsComplete) statusError = recovered.statusError;
  else if (durableIsRelease) statusError = durable.statusError;
  else if (recoveredIsRelease) statusError = recovered.statusError;
  const firstSeenAt = durable.firstSeenAt < recovered.firstSeenAt ? durable.firstSeenAt : recovered.firstSeenAt;

  assignIfUnset(durable, recovered, [
    'mempoolObservation',
    'role',
    'firstSeenOnArgonAt',
    'firstSeenOracleHeight',
    'lastConfirmationCheckAt',
    'lastConfirmationCheckOracleHeight',
    'requestedReleaseAtTick',
    'releaseBitcoinNetworkFee',
    'releaseToDestinationAddress',
    'releaseCosignVaultSignature',
    'releaseCosignHeight',
    'releaseTxid',
    'releaseFirstSeenAt',
    'releaseFirstSeenBitcoinHeight',
    'releaseFirstSeenOracleHeight',
    'releaseLastConfirmationCheckAt',
    'releaseLastConfirmationCheckOracleHeight',
    'releasedAtBitcoinHeight',
  ]);
  Object.assign(durable, {
    status,
    statusError,
    firstSeenAt,
    firstSeenBitcoinHeight: Math.max(durable.firstSeenBitcoinHeight, recovered.firstSeenBitcoinHeight),
  });
  return durable;
}

export function assignIfUnset<T extends object, K extends keyof T>(
  target: T,
  source: Pick<T, K>,
  fields: readonly K[],
): void {
  for (const field of fields) target[field] = target[field] ?? source[field];
}

export class BitcoinHistoryUtxoProjection {
  private readonly recordsByKey = new Map<string, IBitcoinUtxoRecord>();
  private readonly recordsById = new Map<number, IBitcoinUtxoRecord>();
  private nextId = -1;

  constructor(
    private readonly live: BitcoinRecoveryUtxoTracking,
    private readonly dbPromise: Promise<Db>,
  ) {}

  public get records(): readonly IBitcoinUtxoRecord[] {
    return [...this.recordsById.values()];
  }

  public getUtxoRecord(lockUtxoId: number, txid: string, vout: number): IBitcoinUtxoRecord | undefined {
    const key = this.getKey(lockUtxoId, txid, vout);
    return this.recordsByKey.get(key) ?? this.live.getUtxoRecord(lockUtxoId, txid, vout);
  }

  public getAcceptedFundingRecordForLock(lock: IBitcoinLockRecord): IBitcoinUtxoRecord | undefined {
    return this.live.getAcceptedFundingRecordForLock(lock, {
      getForLock: () => this.getUtxosForLock(lock),
    });
  }

  public async upsertUtxoRecord(
    ...[lock, candidate, options]: Parameters<BitcoinRecoveryUtxoTracking['upsertUtxoRecord']>
  ): Promise<IBitcoinUtxoRecord> {
    if (!lock.utxoId) throw new Error('Lock has no utxoId for UTXO tracking.');

    const key = this.getKey(lock.utxoId, candidate.txid, candidate.vout);
    const observedStatus = this.live.getObservedStatusForUpsert(options);
    let observedRole: BitcoinUtxoRole | undefined;
    if (options?.markFundingUtxo) observedRole = BitcoinUtxoRole.Funding;
    else if (options?.markOrphaned) observedRole = BitcoinUtxoRole.Orphan;
    const wasSeenOnArgon = !!(options?.markOrphaned || options?.markFundingUtxo);
    const seenOnArgonAt = wasSeenOnArgon ? new Date() : undefined;
    let record = this.getUtxoRecord(lock.utxoId, candidate.txid, candidate.vout);
    if (!record) {
      const now = new Date();
      record = {
        id: this.nextId,
        lockUtxoId: lock.utxoId,
        txid: candidate.txid,
        vout: candidate.vout,
        satoshis: candidate.satoshis,
        network: lock.network,
        role: observedRole,
        status: observedStatus ?? BitcoinUtxoStatus.SeenOnMempool,
        mempoolObservation: options?.mempoolObservation,
        firstSeenAt: now,
        firstSeenOnArgonAt: seenOnArgonAt,
        firstSeenBitcoinHeight: options?.mempoolObservation?.transactionBlockHeight ?? 0,
        createdAt: now,
        updatedAt: now,
      };
      this.nextId -= 1;
      this.recordsByKey.set(key, record);
      this.recordsById.set(record.id, record);
    } else {
      record = this.getWritableRecord(record);
      if (this.live.shouldUpdateObservedStatus(record, observedStatus)) {
        record.status = observedStatus;
      }
      record.satoshis = candidate.satoshis;
      if (observedRole) record.role = observedRole;
      if (seenOnArgonAt && !record.firstSeenOnArgonAt) record.firstSeenOnArgonAt = seenOnArgonAt;
      if (options?.mempoolObservation) record.mempoolObservation = options.mempoolObservation;
    }
    if (options?.markFundingUtxo) {
      lock.fundingUtxo = record;
      lock.fundedSatoshis = record.satoshis;
    }
    return record;
  }

  public async setAcceptedFundingRecordForLock(lock: IBitcoinLockRecord, record: IBitcoinUtxoRecord): Promise<void> {
    record = this.getWritableRecord(record);
    if (!lock.utxoId || record.lockUtxoId !== lock.utxoId) {
      throw new Error('Funding record does not belong to this lock.');
    }

    const observedAt = new Date();
    record.role = BitcoinUtxoRole.Funding;
    record.status = BitcoinUtxoStatus.FundingUtxo;
    record.firstSeenOnArgonAt ??= observedAt;
    const siblings = this.getUtxosForLock(lock)
      .filter(sibling => sibling.status === BitcoinUtxoStatus.SeenOnMempool)
      .map(sibling => this.getWritableRecord(sibling));
    for (const sibling of siblings) {
      sibling.role = BitcoinUtxoRole.Orphan;
      sibling.status = BitcoinUtxoStatus.Orphaned;
      sibling.firstSeenOnArgonAt ??= observedAt;
    }
    lock.fundingUtxo = record;
    lock.fundedSatoshis = record.satoshis;
  }

  public async setReleaseRequest(
    record: IBitcoinUtxoRecord,
    args: Parameters<BitcoinRecoveryUtxoTracking['setReleaseRequest']>[1],
  ): Promise<void> {
    const table = (await this.dbPromise).bitcoinUtxosTable;
    await table.setReleaseRequest(this.getWritableRecord(record), args, false);
  }

  public async setReleaseIsProcessingOnArgon(
    record: IBitcoinUtxoRecord,
    args: Parameters<BitcoinRecoveryUtxoTracking['setReleaseIsProcessingOnArgon']>[1],
  ): Promise<void> {
    const table = (await this.dbPromise).bitcoinUtxosTable;
    await table.setReleaseIsProcessingOnArgon(this.getWritableRecord(record), args, false);
  }

  public async setReleaseCosign(
    record: IBitcoinUtxoRecord,
    args: Parameters<BitcoinRecoveryUtxoTracking['setReleaseCosign']>[1],
  ): Promise<void> {
    const table = (await this.dbPromise).bitcoinUtxosTable;
    await table.setReleaseCosign(this.getWritableRecord(record), args, false);
  }

  public getAllOrphanLifecycleUtxos(): IBitcoinUtxoRecord[] {
    const recordsByKey = new Map(
      this.live
        .getAllOrphanLifecycleUtxos()
        .map(record => [this.getKey(record.lockUtxoId, record.txid, record.vout), record]),
    );
    for (const [key, record] of this.recordsByKey) recordsByKey.set(key, record);
    return [...recordsByKey.values()].filter(record => record.role === BitcoinUtxoRole.Orphan);
  }

  private getUtxosForLock(lock: IBitcoinLockRecord): IBitcoinUtxoRecord[] {
    if (!lock.utxoId) return [];
    const recordsByKey = new Map(
      this.live.getUtxosForLock(lock).map(record => [this.getKey(record.lockUtxoId, record.txid, record.vout), record]),
    );
    for (const [key, record] of this.recordsByKey) {
      if (record.lockUtxoId === lock.utxoId) recordsByKey.set(key, record);
    }
    return [...recordsByKey.values()];
  }

  private getWritableRecord(record: IBitcoinUtxoRecord): IBitcoinUtxoRecord {
    const existing = this.recordsById.get(record.id);
    if (existing) return existing;

    const projected = { ...record };
    this.recordsById.set(projected.id, projected);
    this.recordsByKey.set(this.getKey(projected.lockUtxoId, projected.txid, projected.vout), projected);
    return projected;
  }

  private getKey(lockUtxoId: number, txid: string, vout: number): string {
    return `${lockUtxoId}:${txid}:${vout}`;
  }
}
