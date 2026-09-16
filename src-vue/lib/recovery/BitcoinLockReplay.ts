import { BitcoinLockStatus, type IBitcoinLockRecord } from '../db/BitcoinLocksTable.ts';
import { BitcoinUtxoSpendStatus, BitcoinUtxoStatus, type IBitcoinUtxoRecord } from '../db/BitcoinUtxosTable.ts';
import { BitcoinReleaseStatus, type IBitcoinReleaseRecord } from '../../interfaces/IBitcoinReleaseRecord.ts';
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
  currentHistoricalUtxoId?: number;
  lockIdByHistoricalUtxoId: Map<number, number>;
  locksByLockId: Record<number, IHistoricalBitcoinLockRecord>;
  utxos: BitcoinHistoryUtxoState;
  releasesById: Record<string, IBitcoinReleaseRecord>;
  historicalLiquidRedemptionByUtxoId: Map<number, bigint>;
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
  preserveCurrentState = false,
): IBitcoinLockRecord {
  const createdAt = durable.createdAt < recovered.createdAt ? durable.createdAt : recovered.createdAt;
  if (preserveCurrentState) {
    durable.createdAt = createdAt;
    return durable;
  }

  const lifecycleProgress: Partial<Record<BitcoinLockStatus, number>> = {
    [BitcoinLockStatus.LockIsProcessingOnArgon]: 0,
    [BitcoinLockStatus.LockPendingFunding]: 1,
    [BitcoinLockStatus.LockFunded]: 2,
    [BitcoinLockStatus.Releasing]: 3,
    [BitcoinLockStatus.Released]: 4,
  };
  const durableProgress = lifecycleProgress[durable.status];
  const recoveredProgress = lifecycleProgress[recovered.status];
  const status =
    useRecoveredStatus ||
    (durableProgress !== undefined && recoveredProgress !== undefined && recoveredProgress > durableProgress)
      ? recovered.status
      : durable.status;
  const hasDurableFunding = durable.fundingUtxoIds.length > 0 || durable.fundedSatoshis > 0n;

  assignIfUnset(durable, recovered, [
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
    securitizationHoldExpirationBitcoinHeight: recovered.securitizationHoldExpirationBitcoinHeight,
    isFlexible: recovered.isFlexible,
    fundHoldExtensionsByBitcoinExpirationHeight: recovered.fundHoldExtensionsByBitcoinExpirationHeight,
    createdAtArgonBlock: recovered.createdAtArgonBlock,
    createdAt,
    status,
  });
  if (useRecoveredStatus || !hasDurableFunding) {
    durable.fundingUtxoIds = [...recovered.fundingUtxoIds];
    durable.fundedSatoshis = recovered.fundedSatoshis;
  }
  if (status === BitcoinLockStatus.Released) durable.activeReleaseId = undefined;
  else durable.activeReleaseId ??= recovered.activeReleaseId;
  return durable;
}

const releaseProgress: Partial<Record<BitcoinReleaseStatus, number>> = {
  [BitcoinReleaseStatus.SubmittingRequestOnArgon]: 0,
  [BitcoinReleaseStatus.WaitingForVaultCosign]: 1,
  [BitcoinReleaseStatus.ReadyForBitcoinBroadcast]: 2,
  [BitcoinReleaseStatus.ConfirmingOnBitcoin]: 3,
  [BitcoinReleaseStatus.WaitingForArgonRecognition]: 4,
  [BitcoinReleaseStatus.Complete]: 5,
};

export function resolveRecoveredRelease(
  durable: IBitcoinReleaseRecord,
  recovered: IBitcoinReleaseRecord,
): IBitcoinReleaseRecord {
  const durableProgress = releaseProgress[durable.status];
  const recoveredProgress = releaseProgress[recovered.status];
  if (recoveredProgress !== undefined && (durableProgress === undefined || recoveredProgress > durableProgress)) {
    durable.status = recovered.status;
  }

  assignIfUnset(durable, recovered, [
    'requestedReleaseAtTick',
    'insuredMicrogons',
    'argonTxFeeMicrogons',
    'compensationMicrogons',
    'cosignBlockNumber',
    'bitcoinTxid',
    'bitcoinFirstSeenAt',
    'bitcoinFirstSeenHeight',
    'bitcoinFirstSeenOracleHeight',
    'bitcoinLastConfirmationCheckAt',
    'bitcoinLastConfirmationCheckOracleHeight',
    'bitcoinConfirmedHeight',
    'argonCompletionBlockNumber',
    'argonCompletionBlockHash',
    'argonCompletionBlockTime',
    'argonCompletionExtrinsicIndex',
  ]);
  if (!durable.inputUtxoIds.length) durable.inputUtxoIds = [...recovered.inputUtxoIds];
  if (!durable.vaultSignatures.length) durable.vaultSignatures = [...recovered.vaultSignatures];
  if (recovered.createdAt < durable.createdAt) durable.createdAt = recovered.createdAt;
  if (durable.status === BitcoinReleaseStatus.Complete) durable.statusError = undefined;
  else durable.statusError ??= recovered.statusError;
  return durable;
}

export function resolveRecoveredUtxo(durable: IBitcoinUtxoRecord, recovered: IBitcoinUtxoRecord): IBitcoinUtxoRecord {
  const firstSeenAt = durable.firstSeenAt < recovered.firstSeenAt ? durable.firstSeenAt : recovered.firstSeenAt;
  const status =
    durable.status === BitcoinUtxoStatus.FundingUtxo
      ? durable.status
      : recovered.status === BitcoinUtxoStatus.Orphaned
        ? recovered.status
        : durable.status;
  const spendStatus =
    durable.spendStatus === BitcoinUtxoSpendStatus.Spent || recovered.spendStatus === BitcoinUtxoSpendStatus.Spent
      ? BitcoinUtxoSpendStatus.Spent
      : BitcoinUtxoSpendStatus.Unspent;

  assignIfUnset(durable, recovered, [
    'mempoolObservation',
    'firstSeenOnArgonAt',
    'firstSeenOracleHeight',
    'lastConfirmationCheckAt',
    'lastConfirmationCheckOracleHeight',
    'createdByReleaseId',
    'spentByReleaseId',
  ]);
  Object.assign(durable, {
    status,
    spendStatus,
    // A finalized request recovered after a local pre-finalization failure may be the first durable release link.
    // Never replace a current link or restore one after the UTXO has been spent.
    activeReleaseId:
      spendStatus === BitcoinUtxoSpendStatus.Spent ? undefined : (durable.activeReleaseId ?? recovered.activeReleaseId),
    statusError: recovered.statusError ?? durable.statusError,
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
