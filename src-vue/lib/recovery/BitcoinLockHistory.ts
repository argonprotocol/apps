import { BitcoinLock } from '@argonprotocol/apps-core';
import {
  FIXED_U128_DECIMALS,
  fromFixedNumber,
  getBigIntFallback,
  type ApiDecoration,
  type bool,
} from '@argonprotocol/mainchain';

// Mirrors BitcoinLock.get for archived storage, including fields that changed names before the current client.
export async function getHistoricalBitcoinLock(
  client: ApiDecoration<'promise'>,
  utxoId: number,
): Promise<BitcoinLock | undefined> {
  const rawLock = await client.query.bitcoinLocks.locksByUtxoId(utxoId);
  if (!rawLock.isSome) return;

  const lock = rawLock.unwrap();
  const wscriptHash = lock.utxoScriptPubkey.asP2wsh.wscriptHash.toHex().replace('0x', '');
  const [fingerprint, cosignHdIndex, claimHdIndex] = lock.vaultXpubSources;
  const securitizationRatio = lock.securitizationRatio?.toBigInt();

  return new BitcoinLock({
    utxoId,
    p2wshScriptHashHex: `0x0020${wscriptHash}`,
    vaultId: lock.vaultId.toNumber(),
    lockedTargetPrice: getBigIntFallback(lock.lockedTargetPrice, lock, ['lockedMarketRate', 'peggedPrice']),
    liquidityPromised: lock.liquidityPromised.toBigInt(),
    ownerAccount: lock.ownerAccount.toHuman(),
    securitizationRatio:
      securitizationRatio == null ? 1 : fromFixedNumber(securitizationRatio, FIXED_U128_DECIMALS).toNumber(),
    satoshis: lock.satoshis.toBigInt(),
    utxoSatoshis: lock.utxoSatoshis?.isSome ? lock.utxoSatoshis.value.toBigInt() : undefined,
    vaultPubkey: lock.vaultPubkey.toHex(),
    vaultClaimPubkey: lock.vaultClaimPubkey.toHex(),
    ownerPubkey: lock.ownerPubkey.toHex(),
    vaultXpubSources: {
      parentFingerprint: new Uint8Array(fingerprint),
      cosignHdIndex: cosignHdIndex.toNumber(),
      claimHdIndex: claimHdIndex.toNumber(),
    },
    vaultClaimHeight: lock.vaultClaimHeight.toNumber(),
    openClaimHeight: lock.openClaimHeight.toNumber(),
    createdAtHeight: lock.createdAtHeight.toNumber(),
    securityFees: lock.securityFees.toBigInt(),
    isFunded: lock.isFunded?.isTrue ?? lock.getT<bool>('isVerified')?.isTrue ?? false,
    isFlexible: lock.isFlexible?.isTrue ?? lock.getT<bool>('isBackfill')?.isTrue ?? false,
    couponFeesPaid: lock.couponPaidFees?.toBigInt() ?? 0n,
    fundHoldExtensionsByBitcoinExpirationHeight: Object.fromEntries(
      [...lock.fundHoldExtensions.entries()].map(([height, amount]) => [height.toNumber(), amount.toBigInt()]),
    ),
    createdAtArgonBlock: lock.createdAtArgonBlock?.toNumber() ?? 0,
  });
}
