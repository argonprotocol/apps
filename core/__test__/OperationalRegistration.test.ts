import { beforeAll, expect, it, vi } from 'vitest';
import { Metadata, TypeRegistry } from '@polkadot/types';
import { decorateConstants } from '@polkadot/types/metadata/decorate';
import { getBundledMetadata } from '@argonprotocol/runtime-client';
import type { PalletOperationalAccountsRegistration } from '@polkadot/types/lookup';
import { getOfflineRegistry, Keyring } from '@argonprotocol/mainchain';
import { compactAddLength, stringToU8a, u8aConcat, u8aToHex } from '@polkadot/util';
import { blake2AsU8a, cryptoWaitReady, decodeAddress, signatureVerify } from '@polkadot/util-crypto';
import type { ArgonClient } from '../src/MainchainClients.js';
import { buildOperationalRegistration } from '../src/OperationalRegistration.js';
import { createOperationalAccessProof } from '../src/OperationalAccessProof.js';
import { TxSigner } from '../src/TxSigner.js';

beforeAll(cryptoWaitReady);

it.each([false, true])('signs the exact chain and registration, with invite = %s', withInvite => {
  const keyring = new Keyring({ type: 'sr25519' });
  const operational = keyring.addFromSeed(new Uint8Array(32).fill(11));
  const vault = keyring.addFromSeed(new Uint8Array(32).fill(12));
  const mining = keyring.addFromSeed(new Uint8Array(32).fill(13));
  const upstream = keyring.addFromSeed(new Uint8Array(32).fill(14));
  const registry = getOfflineRegistry();
  const genesis = new Uint8Array(32).fill(15);
  const encryption = new Uint8Array(32).fill(16);
  const register = vi.fn();
  const client = {
    registry,
    genesisHash: genesis,
    raw: { consts: { operationalAccounts: { registrationProofVersion: registry.createType('u8', 2) } } },
    tx: { operationalAccounts: { register } },
  } as unknown as ArgonClient;
  const accessProof = withInvite ? createOperationalAccessProof(upstream, operational.address) : null;
  buildOperationalRegistration({
    client,
    operationalAccount: new TxSigner(operational),
    vaultAccount: new TxSigner(vault),
    miningAccount: new TxSigner(mining),
    encryptionPubkey: encryption,
    accessProof,
  });
  const registration = registry.createType<PalletOperationalAccountsRegistration>(
    'PalletOperationalAccountsRegistration',
    register.mock.calls[0][0],
  ).asV1;

  // Independent SCALE bytes, rather than the producer's tuple encoder.
  const domain = compactAddLength(stringToU8a('argon/operational-registration/v2'));
  const upstreamBytes = withInvite ? u8aConcat(new Uint8Array([1]), upstream.publicKey) : new Uint8Array([0]);
  const payload = u8aConcat(
    domain,
    genesis,
    operational.publicKey,
    vault.publicKey,
    mining.publicKey,
    encryption,
    upstreamBytes,
  );
  const digest = blake2AsU8a(payload, 256);
  const signature = registration.operationalAccountProof.signature.toU8a();
  expect(signatureVerify(digest, signature, operational.publicKey).isValid).toBe(true);
  expect(registration.operationalAccount.toString()).toBe(operational.address);
  expect(registration.vaultAccount.toString()).toBe(vault.address);
  expect(registration.miningAccount.toString()).toBe(mining.address);
  expect(registration.encryptionPubkey.toU8a()).toEqual(encryption);
  expect(registration.accessProof.isSome).toBe(withInvite);

  for (const offset of [
    domain.length,
    domain.length + 32,
    domain.length + 64,
    domain.length + 96,
    domain.length + 128,
    payload.length - 1,
  ]) {
    const substituted = payload.slice();
    substituted[offset] ^= 1;
    expect(signatureVerify(blake2AsU8a(substituted, 256), signature, operational.publicKey).isValid).toBe(false);
  }
  const oldOwnerPayload = registry
    .createType('(Bytes,AccountId,AccountId)', [
      u8aToHex(stringToU8a('operational_primary_account')),
      operational.address,
      operational.address,
    ])
    .toU8a();
  expect(signatureVerify(blake2AsU8a(oldOwnerPayload, 256), signature, operational.publicKey).isValid).toBe(false);

  for (const [account, proof, role] of [
    [vault, registration.vaultAccountProof, 'operational_vault_account'],
    [mining, registration.miningAccountProof, 'operational_mining_account'],
  ] as const) {
    const rolePayload = u8aConcat(
      compactAddLength(stringToU8a(role)),
      decodeAddress(operational.address),
      account.publicKey,
    );
    expect(signatureVerify(blake2AsU8a(rolePayload, 256), proof.signature.toU8a(), account.publicKey).isValid).toBe(
      true,
    );
  }
});

it.each([false, true])('signs the deployed runtime contract, with invite = %s', withInvite => {
  const keyring = new Keyring({ type: 'sr25519' });
  const operational = keyring.addFromSeed(new Uint8Array(32).fill(11));
  const vault = keyring.addFromSeed(new Uint8Array(32).fill(12));
  const mining = keyring.addFromSeed(new Uint8Array(32).fill(13));
  const upstream = keyring.addFromSeed(new Uint8Array(32).fill(14));
  const registry = new TypeRegistry();
  const metadata = new Metadata(
    registry,
    Object.entries(getBundledMetadata()).find(([key]) => key.endsWith('-160'))![1],
  );
  registry.setMetadata(metadata);
  const constants = decorateConstants(registry, metadata.asLatest, metadata.version);
  expect(constants.operationalAccounts.registrationProofVersion).toBeUndefined();
  const register = vi.fn();
  const client = {
    registry,
    genesisHash: new Uint8Array(32).fill(15),
    raw: { consts: constants },
    tx: { operationalAccounts: { register } },
  } as unknown as ArgonClient;
  const accessProof = withInvite ? createOperationalAccessProof(upstream, operational.address) : null;
  buildOperationalRegistration({
    client,
    operationalAccount: new TxSigner(operational),
    vaultAccount: new TxSigner(vault),
    miningAccount: new TxSigner(mining),
    encryptionPubkey: new Uint8Array(32).fill(16),
    accessProof,
  });
  const registration = registry.createType<PalletOperationalAccountsRegistration>(
    'PalletOperationalAccountsRegistration',
    register.mock.calls[0][0],
  ).asV1;
  const payload = u8aConcat(
    compactAddLength(stringToU8a('operational_primary_account')),
    operational.publicKey,
    operational.publicKey,
  );
  expect(
    signatureVerify(
      blake2AsU8a(payload, 256),
      registration.operationalAccountProof.signature.toU8a(),
      operational.publicKey,
    ).isValid,
  ).toBe(true);
  expect(registration.accessProof.isSome).toBe(withInvite);
  for (const [account, proof, domain] of [
    [vault, registration.vaultAccountProof, 'operational_vault_account'],
    [mining, registration.miningAccountProof, 'operational_mining_account'],
  ] as const) {
    const rolePayload = u8aConcat(compactAddLength(stringToU8a(domain)), operational.publicKey, account.publicKey);
    expect(signatureVerify(blake2AsU8a(rolePayload, 256), proof.signature.toU8a(), account.publicKey).isValid).toBe(
      true,
    );
  }
});

it.each([1, 3])('stops unsupported proof version %s before signing or constructing a transaction', version => {
  const registry = getOfflineRegistry();
  const register = vi.fn();
  const client = {
    registry,
    raw: {
      consts: {
        operationalAccounts: { registrationProofVersion: registry.createType('u8', version) },
      },
    },
    tx: { operationalAccounts: { register } },
  } as unknown as ArgonClient;
  const signer = new TxSigner(new Keyring({ type: 'sr25519' }).addFromUri('//RegistrationVersion'));
  expect(() =>
    buildOperationalRegistration({
      client,
      operationalAccount: signer,
      vaultAccount: signer,
      miningAccount: signer,
      encryptionPubkey: new Uint8Array(32),
      accessProof: null,
    }),
  ).toThrow('Update the app');
  expect(register).not.toHaveBeenCalled();
});
