import type { BitcoinLocksLocksByIdResultSpec159, HistoricalQueryRecord } from '@argonprotocol/runtime-client';
import { hexToU8a, u8aToHex } from '@polkadot/util';
import { BitcoinFission, type ArgonApi, type IBitcoinLockDetails } from '@argonprotocol/apps-core';

type HistoricalBitcoinLock = NonNullable<HistoricalQueryRecord<'bitcoinLocks', 'locksByUtxoId'>>;
type CurrentBitcoinLock = NonNullable<BitcoinLocksLocksByIdResultSpec159>;

// Historical runtimes through spec 158 enforced this window without exposing it as a constant.
const LEGACY_PENDING_CONFIRMATION_BLOCKS = 144;

export type IHistoricalBitcoinLock = NonNullable<Awaited<ReturnType<typeof getHistoricalBitcoinLock>>>;

export interface IHistoricalBitcoinReleaseRequest {
  toScriptPubkey: string;
  bitcoinNetworkFee: bigint;
  liquidRedemptionAmount: bigint;
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

export async function getHistoricalBitcoinLock(client: ArgonApi, utxoId: number) {
  const currentLock: CurrentBitcoinLock | null = await client.query.bitcoinLocks.locksById(utxoId);
  const historicalLock: HistoricalBitcoinLock | null = currentLock
    ? null
    : await client.query.bitcoinLocks.locksByUtxoId(utxoId);
  const lock = currentLock ?? historicalLock;
  if (!lock) return;

  const securitizedSatoshis = currentLock ? currentLock.securitizationBasis.satoshis : historicalLock!.satoshis;
  const lockedTargetPrice = currentLock
    ? currentLock.securitizationBasis.microgonsAtTargetPerBtc
    : (historicalLock!.lockedTargetPrice ??
      historicalLock!.lockedMarketRate ??
      historicalLock!.peggedPrice ??
      historicalLock!.lockPrice);
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
    liquidityPromised: historicalLock?.liquidityPromised ?? 0n,
    ...(currentLock ? { securitizationCoverageMicrogons: currentLock.securitizationCoverageMicrogons } : {}),
    ownerAccount: lock.ownerAccount,
    securitizationRatio: lock.securitizationRatio?.toNumber() ?? 1,
    securitizedSatoshis,
    fundedSatoshis: currentLock?.fundedSatoshis ?? historicalLock?.utxoSatoshis ?? 0n,
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
    securitizationHoldExpirationBitcoinHeight:
      currentLock?.securitizationHoldExpirationBitcoinHeight ??
      createdAtHeight + LEGACY_PENDING_CONFIRMATION_BLOCKS + 1,
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
  client: ArgonApi,
  utxoId: number,
): Promise<{ txid: string; vout: number } | undefined> {
  const ref =
    (await client.query.bitcoinUtxos.utxoIdToRef?.(utxoId)) ??
    (await client.query.bitcoinUtxos.utxoIdToFundingUtxoRef?.(utxoId));
  if (!ref) return;
  return {
    txid: ref.txid,
    vout: ref.outputIndex,
  };
}

export async function getHistoricalBitcoinPendingMints(client: ArgonApi, utxoId: number): Promise<bigint[]> {
  return (await BitcoinFission.pendingMintsForLock(client, utxoId)).map(mint => mint.remainingAmount);
}

export async function getHistoricalBitcoinReleaseRequest(
  client: ArgonApi,
  utxoId: number,
): Promise<IHistoricalBitcoinReleaseRequest | undefined> {
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
