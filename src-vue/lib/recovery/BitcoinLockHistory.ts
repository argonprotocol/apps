import type { HistoricalQueryRecord } from '@argonprotocol/runtime-client';
import { hexToU8a, u8aToHex } from '@polkadot/util';
import {
  BitcoinFission,
  type ArgonQueryClient,
  type IBitcoinLockDetails,
  type IReleaseRequestDetails,
} from '@argonprotocol/apps-core';

type HistoricalBitcoinLock = NonNullable<HistoricalQueryRecord<'bitcoinLocks', 'locksByUtxoId'>>;

export interface IHistoricalBitcoinLock extends IBitcoinLockDetails {
  lockedTargetPrice: bigint;
  liquidityPromised: bigint;
  securitizationCoverageMicrogons?: bigint;
}

export function toBitcoinLockDetails(lock: IHistoricalBitcoinLock): IBitcoinLockDetails {
  const {
    lockedTargetPrice: _lockedTargetPrice,
    liquidityPromised: _liquidityPromised,
    securitizationCoverageMicrogons: _securitizationCoverageMicrogons,
    ...lockDetails
  } = lock;
  return lockDetails;
}

export async function getHistoricalBitcoinLock(
  client: ArgonQueryClient,
  utxoId: number,
): Promise<IHistoricalBitcoinLock | undefined> {
  const lock: HistoricalBitcoinLock | null = await client.query.bitcoinLocks.locksByUtxoId(utxoId);
  if (!lock) return;

  const securitizedSatoshis = lock.satoshis ?? lock.securitizedSatoshis;
  const lockedTargetPrice =
    lock.lockedTargetPrice ??
    lock.lockedMarketRate ??
    lock.peggedPrice ??
    lock.lockPrice ??
    lock.microgonsAtTargetPerBtc;
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
    securitizationCoverageMicrogons: lock.securitizationCoverageMicrogons,
    fundedSatoshis: lock.utxoSatoshis ?? lock.fundedSatoshis ?? 0n,
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
    fundingExpirationHeight:
      (lock.fundingExpirationHeight === undefined ? undefined : Number(lock.fundingExpirationHeight)) ??
      createdAtHeight + client.consts.bitcoinLocks.maxPendingConfirmationBlocks.toNumber(),
    securityFees: lock.securityFees ?? 0n,
    isFlexible: lock.isFlexible ?? lock.isBackfill ?? false,
    couponFeesPaid: lock.couponPaidFees ?? 0n,
    fundHoldExtensionsByBitcoinExpirationHeight: Object.fromEntries(
      Object.entries(lock.fundHoldExtensions ?? {}).map(([height, amount]) => [Number(height), amount]),
    ),
    createdAtArgonBlock: lock.createdAtArgonBlock ?? 0,
  };
}

export async function getHistoricalBitcoinFundingUtxoRef(
  client: ArgonQueryClient,
  utxoId: number,
): Promise<{ txid: string; vout: number } | undefined> {
  const ref =
    'utxoIdToFundingUtxoRef' in client.query.bitcoinUtxos
      ? await client.query.bitcoinUtxos.utxoIdToFundingUtxoRef(utxoId)
      : await client.query.bitcoinLocks.utxoIdToFundingUtxoRef(BigInt(utxoId));
  if (!ref) return;
  return {
    txid: ref.txid,
    vout: ref.outputIndex,
  };
}

export async function getHistoricalBitcoinPendingMints(client: ArgonQueryClient, utxoId: number): Promise<bigint[]> {
  return (await BitcoinFission.pendingMintsForLock(client, utxoId)).map(mint => mint.remainingAmount);
}

export async function getHistoricalBitcoinReleaseRequest(
  client: ArgonQueryClient,
  utxoId: number,
): Promise<IReleaseRequestDetails | undefined> {
  const request = await client.query.bitcoinLocks.lockReleaseRequestsByUtxoId(utxoId);
  if (!request) return;

  const redemptionAmount =
    ('securitizationAtRisk' in request ? request.securitizationAtRisk : undefined) ??
    ('redemptionAmount' in request ? request.redemptionAmount : undefined) ??
    ('redemptionPrice' in request ? request.redemptionPrice : undefined);
  if (redemptionAmount === undefined) {
    throw new Error(`Bitcoin lock ${utxoId} release request does not contain a redemption amount`);
  }

  return {
    toScriptPubkey: u8aToHex(request.toScriptPubkey),
    bitcoinNetworkFee: request.bitcoinNetworkFee,
    redemptionAmount,
  };
}
