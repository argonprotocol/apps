import type { KeyringPair } from '@argonprotocol/mainchain';
import { hexToU8a, u8aToHex } from '@argonprotocol/mainchain';
import { Buffer } from 'buffer';
import { stringToU8a } from '@polkadot/util';
import { blake2AsU8a, signatureVerify } from '@polkadot/util-crypto';

export interface IBitcoinLockCouponPayload {
  version: 'v1';
  vaultId: number;
  maxSatoshis: bigint;
  expiresAfterTicks: number;
  code: string;
}

export interface IParsedBitcoinLockCoupon {
  payload: IBitcoinLockCouponPayload;
  token: string;
  signatureHex: string;
}

export class BitcoinLockCoupons {
  public static createToken(payload: Omit<IBitcoinLockCouponPayload, 'version'>, signer: KeyringPair): string {
    const normalized: IBitcoinLockCouponPayload = { version: 'v1', ...payload };
    const message = this.createMessage(normalized);
    const signature = signer.sign(blake2AsU8a(stringToU8a(message), 256));

    return [
      normalized.version,
      this.toBase64Url(message),
      this.toBase64Url(signature),
    ].join('.');
  }

  public static parseToken(token: string): IParsedBitcoinLockCoupon {
    const [version, encodedMessage, encodedSignature] = token.split('.');
    if (version !== 'v1' || !encodedMessage || !encodedSignature) {
      throw new Error('Invalid bitcoin lock coupon token.');
    }

    const message = Buffer.from(this.fromBase64Url(encodedMessage)).toString('utf8');
    const [vaultId, maxSatoshis, expiresAfterTicks, code] = message.split('|');
    if (!vaultId || !maxSatoshis || !expiresAfterTicks || !code) {
      throw new Error('Malformed bitcoin lock coupon token.');
    }

    const signatureHex = u8aToHex(this.fromBase64Url(encodedSignature));

    return {
      token,
      signatureHex,
      payload: {
        version: 'v1',
        vaultId: Number(vaultId),
        maxSatoshis: BigInt(maxSatoshis),
        expiresAfterTicks: Number(expiresAfterTicks),
        code,
      },
    };
  }

  public static verifyToken(token: string, signerAddress: string): IParsedBitcoinLockCoupon {
    const parsed = this.parseToken(token);
    const message = this.createMessage(parsed.payload);
    const signature = hexToU8a(parsed.signatureHex);
    const messageHash = blake2AsU8a(stringToU8a(message), 256);
    const verification = signatureVerify(messageHash, signature, signerAddress);
    if (!verification.isValid) {
      throw new Error('Invalid bitcoin lock coupon signature.');
    }
    return parsed;
  }

  public static createMessage(payload: IBitcoinLockCouponPayload): string {
    return [payload.vaultId, payload.maxSatoshis.toString(), payload.expiresAfterTicks, payload.code].join('|');
  }

  private static toBase64Url(value: string | Uint8Array): string {
    const buffer = typeof value === 'string' ? Buffer.from(value, 'utf8') : Buffer.from(value);
    return buffer
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/g, '');
  }

  private static fromBase64Url(value: string): Uint8Array {
    const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
    const padding = (4 - (base64.length % 4 || 4)) % 4;
    return Uint8Array.from(Buffer.from(`${base64}${'='.repeat(padding)}`, 'base64'));
  }
}
