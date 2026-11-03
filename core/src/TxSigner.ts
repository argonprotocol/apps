import { decodeAddress } from '@polkadot/util-crypto';
import type { IKeyringPair, Signer } from '@polkadot/types/types';

/** Public signing capability without key export, derivation, or lock controls. */
export class TxSigner implements IKeyringPair {
  public readonly address: string;
  public readonly externalSigner?: Signer;
  readonly #sign?: IKeyringPair['sign'];

  constructor(account: IKeyringPair | { address: string; signer: Signer }) {
    this.address = account.address;
    if ('signer' in account) this.externalSigner = account.signer;
    else this.#sign = account.sign;
    // Immutable capabilities stay out of Vue proxies; the signing callback is private.
    Object.freeze(this);
  }

  public get publicKey(): Uint8Array {
    return decodeAddress(this.address);
  }

  public get addressRaw(): Uint8Array {
    return this.publicKey;
  }

  public sign(...args: Parameters<IKeyringPair['sign']>): Uint8Array {
    if (!this.#sign) throw new Error('This signer requires external transaction approval.');
    return this.#sign(...args);
  }
}
