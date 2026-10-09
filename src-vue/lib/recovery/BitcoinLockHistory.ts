import { toRuntimeEvent, type HistoricalQueryRecord } from '@argonprotocol/runtime-client';
import { hexToU8a, u8aToHex } from '@polkadot/util';
import {
  BitcoinFission,
  BitcoinLock,
  type ArgonApi,
  type IBitcoinLock,
  type IBitcoinLockDetails,
  type IBitcoinLockFundingUtxo,
  type RuntimeSystemEventRecord,
} from '@argonprotocol/apps-core';

type HistoricalBitcoinLock = NonNullable<HistoricalQueryRecord<'bitcoinLocks', 'locksByUtxoId'>>;

// Historical runtimes through spec 158 enforced this window without exposing it as a constant.
const LEGACY_PENDING_CONFIRMATION_BLOCKS = 144;

export type IHistoricalBitcoinLock = Omit<IBitcoinLockDetails, 'lockId' | 'fundingUtxos'> &
  Partial<Pick<IBitcoinLock, 'microgonsAtTargetPerBtc' | 'securitizationCoverageMicrogons' | 'securitizationTick'>> & {
    utxoId: number;
    lockedTargetPrice: bigint;
    liquidityPromised: bigint;
  };

export interface IHistoricalBitcoinReleaseRequest {
  releaseNumber?: number;
  toScriptPubkey: string;
  bitcoinNetworkFee: bigint;
  destinationSatoshis?: bigint;
  changeSatoshis?: bigint;
  cosignDueFrame?: number;
  expectedTransactionId?: string;
  securitizationAtRisk?: bigint;
  liquidRedemptionAmount?: bigint;
}

export function toBitcoinLockDetails(lock: IHistoricalBitcoinLock): IBitcoinLockDetails {
  const {
    utxoId,
    lockedTargetPrice: _lockedTargetPrice,
    liquidityPromised: _liquidityPromised,
    securitizationCoverageMicrogons: _securitizationCoverageMicrogons,
    ...lockDetails
  } = lock;
  return {
    ...lockDetails,
    lockId: utxoId,
    fundingUtxos: [],
  };
}

export async function getHistoricalBitcoinLock(
  client: ArgonApi,
  utxoId: number,
): Promise<IHistoricalBitcoinLock | undefined> {
  if (!('locksById' in client.query.bitcoinLocks) && !('locksByUtxoId' in client.query.bitcoinLocks)) {
    throw new Error('Bitcoin lock storage is unavailable at this historical block.');
  }

  const currentLock = await BitcoinLock.get(client, utxoId);
  if (currentLock) {
    return {
      ...currentLock,
      utxoId,
      lockedTargetPrice: currentLock.microgonsAtTargetPerBtc,
      liquidityPromised: 0n,
    };
  }

  const lock: HistoricalBitcoinLock | null = await client.query.bitcoinLocks.locksByUtxoId(utxoId);
  if (!lock) return;

  const securitizedSatoshis = lock.satoshis;
  let fundedSatoshis = lock.utxoSatoshis ?? 0n;
  // Before actual funding amounts were stored, verification required the exact requested amount.
  if (lock.utxoSatoshis === undefined && (lock.isFunded ?? lock.isVerified)) fundedSatoshis = securitizedSatoshis;
  const lockedTargetPrice = lock.lockedTargetPrice ?? lock.lockedMarketRate ?? lock.peggedPrice ?? lock.lockPrice;
  if (securitizedSatoshis === undefined || lockedTargetPrice === undefined) {
    throw new Error(`Bitcoin lock ${utxoId} does not contain securitization economics`);
  }

  const wscriptHash = lock.utxoScriptPubkey.value.wscriptHash.replace('0x', '');
  const [fingerprint, cosignHdIndex, claimHdIndex] = lock.vaultXpubSources;
  const createdAtHeight = lock.createdAtHeight;

  return {
    utxoId,
    p2wshScriptHashHex: `0x0020${wscriptHash}`,
    vaultId: lock.vaultId,
    lockedTargetPrice,
    liquidityPromised: lock.liquidityPromised ?? 0n,
    ownerAccount: lock.ownerAccount,
    securitizationRatio: lock.securitizationRatio?.toNumber() ?? 1,
    securitizedSatoshis,
    fundedSatoshis,
    vaultPubkey: lock.vaultPubkey,
    vaultClaimPubkey: lock.vaultClaimPubkey,
    ownerPubkey: lock.ownerPubkey,
    vaultXpubSources: {
      parentFingerprint: hexToU8a(fingerprint),
      cosignHdIndex,
      claimHdIndex,
    },
    vaultClaimHeight: lock.vaultClaimHeight,
    openClaimHeight: lock.openClaimHeight,
    createdAtHeight,
    securitizationHoldExpirationBitcoinHeight: createdAtHeight + LEGACY_PENDING_CONFIRMATION_BLOCKS + 1,
    securityFees: lock.securityFees ?? 0n,
    isFlexible: lock.isFlexible ?? lock.isBackfill ?? false,
    couponFeesPaid: lock.couponPaidFees ?? 0n,
    fundHoldExtensionsByBitcoinExpirationHeight: Object.fromEntries(
      Object.entries(lock.fundHoldExtensions ?? {}).map(([height, amount]) => [Number(height), amount]),
    ),
    createdAtArgonBlock: lock.createdAtArgonBlock ?? 0,
  };
}

export async function getHistoricalBitcoinFundingUtxos(
  client: ArgonApi,
  lockId: number,
  historicalSatoshis: bigint,
): Promise<IBitcoinLockFundingUtxo[]> {
  const currentLock = await BitcoinLock.get(client, lockId);
  if (currentLock) {
    return currentLock.fundingUtxos;
  }

  const ref =
    (await client.query.bitcoinUtxos.utxoIdToRef?.(lockId)) ??
    (await client.query.bitcoinUtxos.utxoIdToFundingUtxoRef?.(lockId));
  if (!ref) return [];
  return [{ utxoRef: { txid: ref.txid, vout: ref.outputIndex }, satoshis: historicalSatoshis }];
}

// Summarize events for one lock in one Argon block, across historical event names.
// Cooperative returns use creation to verify the supplied block, and funding/compensation to reject unsafe removals.
export function summarizeBitcoinLockBlockEvents(blockEvents: RuntimeSystemEventRecord[], lockId: number) {
  const summary = { lockWasCreated: false, fundingWasAccepted: false, compensationWasPaid: false };
  for (const { event } of blockEvents) {
    const runtimeEvent = toRuntimeEvent(event);
    if (!runtimeEvent) continue;

    if (runtimeEvent.section === 'bitcoinLocks') {
      switch (runtimeEvent.method) {
        case 'BitcoinLockCreated':
          if ((runtimeEvent.data.lockId ?? runtimeEvent.data.utxoId) === lockId) summary.lockWasCreated = true;
          break;
        case 'UtxoFundedFromCandidate':
          if (runtimeEvent.data.utxoId === lockId) summary.fundingWasAccepted = true;
          break;
        case 'BitcoinCosignPastDue':
          if ((runtimeEvent.data.lockId ?? runtimeEvent.data.utxoId) !== lockId) break;
          if (runtimeEvent.data.compensationAmount > 0n) summary.compensationWasPaid = true;
          break;
      }
      continue;
    }

    if (runtimeEvent.section === 'bitcoinUtxos') {
      switch (runtimeEvent.method) {
        case 'UtxoDetected':
          if (runtimeEvent.data.lockId === lockId) summary.fundingWasAccepted = true;
          break;
        case 'UtxoVerified':
          if (runtimeEvent.data.utxoId === lockId) summary.fundingWasAccepted = true;
          break;
      }
    }
  }
  return summary;
}

export async function getHistoricalBitcoinPendingMints(client: ArgonApi, utxoId: number): Promise<bigint[]> {
  return (await BitcoinFission.pendingMintsForLock(client, utxoId)).map(mint => mint.remainingAmount);
}

export async function getHistoricalBitcoinReleaseRequest(
  client: ArgonApi,
  utxoId: number,
): Promise<IHistoricalBitcoinReleaseRequest | undefined> {
  if (client.runtimeVersion.specVersion.toNumber() >= 159) {
    return await BitcoinLock.getReleaseRequest(client, utxoId);
  }

  const request = await client.query.bitcoinLocks.lockReleaseRequestsByUtxoId(utxoId);
  if (!request) return;

  const liquidRedemptionAmount = request.redemptionAmount ?? request.redemptionPrice;
  if (liquidRedemptionAmount === undefined) {
    throw new Error(`Bitcoin lock ${utxoId} release request does not contain its redemption amount`);
  }

  return {
    toScriptPubkey: u8aToHex(request.toScriptPubkey),
    bitcoinNetworkFee: request.bitcoinNetworkFee,
    liquidRedemptionAmount,
  };
}
