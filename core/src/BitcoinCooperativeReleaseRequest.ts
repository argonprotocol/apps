import type { KeyringPair } from '@argonprotocol/mainchain';
import { hexToU8a, stringToU8a, u8aToHex } from '@polkadot/util';
import { blake2AsU8a, signatureVerify } from '@polkadot/util-crypto';
import { z } from 'zod';
import type { IBitcoinLock, IReleaseRequest, IReleaseRequestDetails } from './BitcoinLock.js';
import type { BitcoinUtxosUtxoRefsByLockIdResult } from '@argonprotocol/runtime-client';

export type IBitcoinCooperativeReleaseRequest = IReleaseRequest &
  Pick<IBitcoinLock, 'ownerAccount' | 'vaultId' | 'lockId' | 'createdAtArgonBlock'> &
  Pick<IReleaseRequestDetails, 'expectedTransactionId'> & {
    version: 1;
    releaseId: string;
    utxoRef: BitcoinUtxosUtxoRefsByLockIdResult[number];
    satoshis: bigint;
    feeRatePerSatVb: bigint;
    // Bounded verification evidence; it does not change the owner-approved Bitcoin transaction.
    removalBlockNumber?: number;
    requestSignature: string;
  };

export interface IBitcoinCooperativeReleaseMailboxRecord {
  request: IBitcoinCooperativeReleaseRequest;
  vaultSignatureHex?: string;
  // A terminal rejection returned to the owner.
  operatorError?: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface IBitcoinCooperativeReleaseMailboxPage {
  requests: IBitcoinCooperativeReleaseMailboxRecord[];
  nextCursor?: string;
}

export type IBitcoinCooperativeReleaseResponse = { vaultSignatureHex: string } | { error: string };

const hash = z.string().regex(/^0x[0-9a-f]{64}$/);
const amount = z.bigint().positive().max(2_100_000_000_000_000n);
export const bitcoinCooperativeReleaseRequestSchema: z.ZodType<IBitcoinCooperativeReleaseRequest> = z
  .object({
    version: z.literal(1),
    releaseId: z
      .string()
      .min(1)
      .max(100)
      .regex(/^[a-zA-Z0-9_-]+$/),
    ownerAccount: z.string().min(1).max(64),
    vaultId: z.number().int().positive(),
    lockId: z.number().int().positive(),
    createdAtArgonBlock: z.number().int().positive(),
    utxoRef: z.object({ txid: hash, outputIndex: z.number().int().nonnegative().max(0xffffffff) }).strict(),
    satoshis: amount,
    toScriptPubkey: z.string().regex(/^0x[0-9a-f]{4,84}$/),
    destinationSatoshis: amount,
    changeSatoshis: z.bigint().refine(value => value === 0n),
    bitcoinNetworkFee: amount,
    feeRatePerSatVb: z.bigint().positive().max(1_000n),
    removalBlockNumber: z.number().int().positive().optional(),
    expectedTransactionId: hash,
    requestSignature: z.string().regex(/^0x[0-9a-f]{128,132}$/),
  })
  .strict();

export function signBitcoinCooperativeReleaseRequest(
  account: KeyringPair,
  request: Omit<IBitcoinCooperativeReleaseRequest, 'requestSignature'>,
): string {
  return u8aToHex(account.sign(getBitcoinCooperativeReleaseRequestHash(request), { withType: true }));
}

export function verifyBitcoinCooperativeReleaseRequest(request: IBitcoinCooperativeReleaseRequest): boolean {
  try {
    return signatureVerify(
      getBitcoinCooperativeReleaseRequestHash(request),
      hexToU8a(request.requestSignature),
      request.ownerAccount,
    ).isValid;
  } catch {
    return false;
  }
}

function getBitcoinCooperativeReleaseRequestHash(
  request: Omit<IBitcoinCooperativeReleaseRequest, 'requestSignature'>,
): Uint8Array {
  const {
    version,
    releaseId,
    ownerAccount,
    vaultId,
    lockId,
    createdAtArgonBlock,
    utxoRef,
    satoshis,
    toScriptPubkey,
    destinationSatoshis,
    changeSatoshis,
    bitcoinNetworkFee,
    feeRatePerSatVb,
    expectedTransactionId,
  } = request;
  return blake2AsU8a(
    stringToU8a(
      `argon_bitcoin_cooperative_release_request_v1:${JSON.stringify([
        version,
        releaseId,
        ownerAccount,
        vaultId,
        lockId,
        createdAtArgonBlock,
        utxoRef.txid,
        utxoRef.outputIndex,
        satoshis.toString(),
        toScriptPubkey,
        destinationSatoshis.toString(),
        changeSatoshis.toString(),
        bitcoinNetworkFee.toString(),
        feeRatePerSatVb.toString(),
        expectedTransactionId,
      ])}`,
    ),
    256,
  );
}
