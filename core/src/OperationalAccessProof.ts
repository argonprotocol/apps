import type { KeyringPair } from '@argonprotocol/mainchain';
import { getOfflineRegistry, hexToU8a, u8aToHex } from '@argonprotocol/mainchain';
import { stringToU8a } from '@polkadot/util';
import { blake2AsU8a, signatureVerify } from '@polkadot/util-crypto';

const OPERATIONAL_ACCESS_PROOF_MESSAGE_KEY = 'operational_access_proof';

export interface IOperationalAccessProof {
  upstreamAccount: string;
  signature: string;
}

export function createOperationalAccessProof(
  upstreamAccount: KeyringPair,
  downstreamOperationalAccount: string,
): IOperationalAccessProof {
  return {
    upstreamAccount: upstreamAccount.address,
    signature: u8aToHex(
      upstreamAccount.sign(
        getOperationalAccessProofPayloadHash(upstreamAccount.address, downstreamOperationalAccount),
        { withType: true },
      ),
    ),
  };
}

export function verifyOperationalAccessProof(
  accessProof: IOperationalAccessProof,
  downstreamOperationalAccount: string,
): boolean {
  try {
    return signatureVerify(
      getOperationalAccessProofPayloadHash(accessProof.upstreamAccount, downstreamOperationalAccount),
      hexToU8a(accessProof.signature),
      accessProof.upstreamAccount,
    ).isValid;
  } catch {
    return false;
  }
}

function getOperationalAccessProofPayloadHash(
  upstreamAccount: string,
  downstreamOperationalAccount: string,
): Uint8Array {
  const messageKey = stringToU8a(OPERATIONAL_ACCESS_PROOF_MESSAGE_KEY);
  // Mirrors the runtime's SCALE payload tuple: (Bytes, AccountId, AccountId).
  const payload = getOfflineRegistry()
    .createType('(Bytes,AccountId,AccountId)', [u8aToHex(messageKey), upstreamAccount, downstreamOperationalAccount])
    .toU8a();

  return blake2AsU8a(payload, 256);
}
