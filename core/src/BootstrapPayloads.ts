import { getOfflineRegistry, hexToU8a, type KeyringPair, u8aToHex } from '@argonprotocol/mainchain';
import { stringToU8a, u8aConcat } from '@polkadot/util';
import { blake2AsU8a, ed25519PairFromSeed } from '@polkadot/util-crypto';
import { JsonExt } from './JsonExt.js';

const ENDPOINT_AAD = stringToU8a('argon-bootstrap-endpoint-v1');
const RECOVERY_AAD = stringToU8a('argon-bootstrap-recovery-v1');
const RECOVERY_PROOF_MESSAGE_KEY = stringToU8a('bootstrap_recovery');
const NONCE_BYTES = 12;
const MAX_ENCRYPTED_PAYLOAD_BYTES = 256;

export type IBootstrapEndpointPayload = {
  version: 1;
  host: string;
  port: number;
  sequence: number;
};

export type IBootstrapRecoveryPayload = {
  version: 1;
  endpointSecret: string;
  endpointIndex?: number;
  ssh?: {
    user: string;
    port: number;
  };
};

export function getBootstrapEndpointPubkey(endpointSecret: string): Uint8Array {
  return ed25519PairFromSeed(hexToU8a(endpointSecret)).publicKey;
}

export function createBootstrapEndpointUpdate(
  currentEndpoint: IBootstrapEndpointPayload | undefined,
  host: string,
  port: number,
): IBootstrapEndpointPayload | undefined {
  if (currentEndpoint?.host === host && currentEndpoint.port === port) return;

  return {
    version: 1,
    host,
    port,
    sequence: (currentEndpoint?.sequence ?? 0) + 1,
  };
}

export async function encryptBootstrapEndpoint(
  endpoint: IBootstrapEndpointPayload,
  endpointSecret: string,
): Promise<Uint8Array> {
  return await encryptPayload(endpoint, endpointSecret, ENDPOINT_AAD);
}

export async function decryptBootstrapEndpoint(
  encryptedEndpoint: Uint8Array,
  endpointSecret: string,
): Promise<IBootstrapEndpointPayload> {
  const endpoint = await decryptPayload<IBootstrapEndpointPayload>(encryptedEndpoint, endpointSecret, ENDPOINT_AAD);
  if (
    endpoint.version !== 1 ||
    !endpoint.host ||
    !Number.isInteger(endpoint.port) ||
    endpoint.port < 1 ||
    endpoint.port > 65_535 ||
    !Number.isSafeInteger(endpoint.sequence) ||
    endpoint.sequence < 1
  ) {
    throw new Error('The bootstrap endpoint payload is invalid.');
  }

  return endpoint;
}

export async function encryptBootstrapRecovery(
  recovery: IBootstrapRecoveryPayload,
  recoverySeed: string,
): Promise<Uint8Array> {
  return await encryptPayload(recovery, recoverySeed, RECOVERY_AAD);
}

export async function decryptBootstrapRecovery(
  encryptedRecovery: Uint8Array,
  recoverySeed: string,
): Promise<IBootstrapRecoveryPayload> {
  const recovery = await decryptPayload<IBootstrapRecoveryPayload>(encryptedRecovery, recoverySeed, RECOVERY_AAD);
  if (
    recovery.version !== 1 ||
    hexToU8a(recovery.endpointSecret).length !== 32 ||
    (recovery.endpointIndex !== undefined &&
      (!Number.isSafeInteger(recovery.endpointIndex) || recovery.endpointIndex < 0)) ||
    (recovery.ssh &&
      (!recovery.ssh.user ||
        !Number.isInteger(recovery.ssh.port) ||
        recovery.ssh.port < 1 ||
        recovery.ssh.port > 65_535))
  ) {
    throw new Error('The bootstrap recovery payload is invalid.');
  }

  return recovery;
}

export function createBootstrapRecoveryProof(
  recoveryKeypair: KeyringPair,
  writerAccountId: string,
  encryptedRecovery: Uint8Array,
): { signature: Uint8Array } {
  const encryptedPayloadHash = blake2AsU8a(encryptedRecovery, 256);
  // Mirrors the runtime tuple: (&[u8], AccountId, RecoveryPubkey, [u8; 32]).
  const payload = getOfflineRegistry()
    .createType('(Bytes,AccountId,[u8;32],[u8;32])', [
      u8aToHex(RECOVERY_PROOF_MESSAGE_KEY),
      writerAccountId,
      recoveryKeypair.publicKey,
      encryptedPayloadHash,
    ])
    .toU8a();

  return {
    signature: recoveryKeypair.sign(blake2AsU8a(payload, 256), { withType: false }),
  };
}

async function encryptPayload(payload: object, secret: string, aad: Uint8Array): Promise<Uint8Array> {
  const nonce = crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
  const key = await getEncryptionKey(secret, aad, ['encrypt']);
  const plaintext = new TextEncoder().encode(JsonExt.stringify(payload));
  const encrypted = new Uint8Array(
    await crypto.subtle.encrypt(
      {
        name: 'AES-GCM',
        iv: nonce.slice().buffer,
        additionalData: aad.slice().buffer,
      },
      key,
      plaintext,
    ),
  );
  const result = u8aConcat(nonce, encrypted);
  if (result.length > MAX_ENCRYPTED_PAYLOAD_BYTES) {
    throw new Error(`The encrypted bootstrap payload exceeds ${MAX_ENCRYPTED_PAYLOAD_BYTES} bytes.`);
  }

  return result;
}

async function decryptPayload<T>(encrypted: Uint8Array, secret: string, aad: Uint8Array): Promise<T> {
  if (encrypted.length <= NONCE_BYTES || encrypted.length > MAX_ENCRYPTED_PAYLOAD_BYTES) {
    throw new Error('The encrypted bootstrap payload is invalid.');
  }

  try {
    const key = await getEncryptionKey(secret, aad, ['decrypt']);
    const plaintext = await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: encrypted.slice(0, NONCE_BYTES).buffer,
        additionalData: aad.slice().buffer,
      },
      key,
      encrypted.slice(NONCE_BYTES).buffer,
    );
    return JsonExt.parse<T>(new TextDecoder().decode(plaintext));
  } catch {
    throw new Error('The encrypted bootstrap payload is invalid.');
  }
}

async function getEncryptionKey(secret: string, context: Uint8Array, keyUsages: ('encrypt' | 'decrypt')[]) {
  const keyBytes = blake2AsU8a(u8aConcat(context, hexToU8a(secret)), 256);
  return await crypto.subtle.importKey('raw', keyBytes.slice().buffer, { name: 'AES-GCM' }, false, keyUsages);
}
