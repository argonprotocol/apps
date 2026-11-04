import { CosignScript } from '@argonprotocol/bitcoin';
import type { BitcoinNetwork, HDKey, ICosignScriptLock, Transaction } from '@argonprotocol/bitcoin';

/** Bitcoin signing capability without exposing the private HD key. */
export class BitcoinSigner {
  readonly #key: HDKey;

  constructor(
    key: HDKey,
    private readonly network: BitcoinNetwork,
  ) {
    this.#key = key;
    Object.freeze(this);
  }

  public vaultCosignPsbt(lock: ICosignScriptLock, psbt: Transaction): Transaction {
    const script = new CosignScript(lock, this.network);
    return script.vaultCosignPsbt(psbt, lock, this.#key);
  }

  public cosignAndGenerateTx(
    lock: ICosignScriptLock,
    args: Omit<Parameters<CosignScript['cosignAndGenerateTx']>[0], 'ownerXpriv'>,
  ): Transaction {
    const script = new CosignScript(lock, this.network);
    return script.cosignAndGenerateTx({ ...args, ownerXpriv: this.#key });
  }
}
