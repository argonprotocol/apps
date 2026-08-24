import { type ISignBitcoinLockFeeCouponRequest, type MainchainClients, NetworkConfig } from '@argonprotocol/apps-core';
import { type BitcoinLockFeeCoupon, getOfflineRegistry, u8aToHex, Vault } from '@argonprotocol/mainchain';
import { stringToU8a } from '@polkadot/util';
import { blake2AsU8a } from '@polkadot/util-crypto';
import type { DelegateSubmitLane } from './DelegateSubmitLane.ts';
import { HttpError } from './HttpError.ts';

export class BitcoinLockFeeCouponService {
  constructor(
    private readonly clients: MainchainClients,
    private readonly vaultOperatorAddress: string,
    private readonly submitLane: DelegateSubmitLane,
  ) {}

  public async sign(request: ISignBitcoinLockFeeCouponRequest): Promise<BitcoinLockFeeCoupon> {
    const beneficiary = request.beneficiary.trim();
    if (!beneficiary) throw new HttpError('A beneficiary is required for this Bitcoin fee coupon.', 400);
    if (request.feeDiscountMicrogons <= 0n) {
      throw new HttpError('A positive Bitcoin fee discount is required for this coupon.', 400);
    }
    if (request.requestedSatoshis <= 0n) {
      throw new HttpError('A positive Bitcoin lock amount is required for this coupon.', 400);
    }
    if (request.microgonsAtTargetPerBtc <= 0n) {
      throw new HttpError('A positive Bitcoin price is required for this coupon.', 400);
    }
    if (!Number.isSafeInteger(request.expiresAfterTicks) || request.expiresAfterTicks <= 0) {
      throw new HttpError('A positive coupon duration is required.', 400);
    }

    const client = await this.clients.get(false);
    const vaultIdOption = await client.query.vaults.vaultIdByOperator(this.vaultOperatorAddress);
    if (!vaultIdOption.isSome) {
      throw new HttpError(`No vault was found for operator ${this.vaultOperatorAddress}.`, 404);
    }

    const vaultId = vaultIdOption.unwrap().toNumber();
    const vault = await Vault.get(client, vaultId, NetworkConfig.tickMillis);
    if (!vault || vaultId !== request.vaultId) {
      throw new HttpError('This Bitcoin fee coupon does not match the configured vault.', 400);
    }
    if (vault.delegateAccountId !== this.submitLane.address) {
      throw new HttpError('The configured vault delegate is not registered on this vault.', 400);
    }

    const lifetimeFrames = Math.max(1, Math.ceil(request.expiresAfterTicks / NetworkConfig.rewardTicksPerFrame));
    const [nextFrameId, previousNonce] = await Promise.all([
      client.query.miningSlot.nextFrameId(),
      client.query.bitcoinLocks.lastFeeCouponNonceByVaultAndAccount(vaultId, beneficiary),
    ]);
    const currentFrame = nextFrameId.toBigInt() - 1n;
    const nextNonce = previousNonce.isSome ? previousNonce.unwrap().toBigInt() + 1n : 1n;
    if (request.feeCouponNonce != null && request.feeCouponNonce !== nextNonce) {
      throw new HttpError('This Bitcoin fee coupon nonce is no longer available.', 409);
    }

    const feeCoupon: BitcoinLockFeeCoupon = {
      feeDiscount: request.feeDiscountMicrogons,
      securitizationSpaceToUnreserve: 0n,
      expiresAtFrame: currentFrame + BigInt(lifetimeFrames),
      nonce: nextNonce,
      signature: '',
    };
    const message = getOfflineRegistry()
      .createType('(Bytes,H256,u32,AccountId,u64,u128,u128,u128,u64,u64)', [
        u8aToHex(stringToU8a('bitcoin_lock_fee_coupon')),
        client.genesisHash.toHex(),
        vaultId,
        beneficiary,
        request.requestedSatoshis,
        request.microgonsAtTargetPerBtc,
        feeCoupon.feeDiscount,
        feeCoupon.securitizationSpaceToUnreserve,
        feeCoupon.expiresAtFrame,
        feeCoupon.nonce,
      ])
      .toU8a();

    feeCoupon.signature = u8aToHex(this.submitLane.keypair.sign(blake2AsU8a(message, 256), { withType: true }));
    return feeCoupon;
  }
}
