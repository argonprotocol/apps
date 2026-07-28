import { beforeAll, describe, expect, it } from 'vitest';
import {
  createBootstrapRecoveryProof,
  encryptBootstrapEndpoint,
  encryptBootstrapRecovery,
  getBootstrapEndpointPubkey,
  type IBootstrapEndpointPayload,
  type IBootstrapRecoveryPayload,
} from '@argonprotocol/apps-core';
import { getOfflineRegistry, hexToU8a, Keyring, type ArgonClient, u8aToHex } from '@argonprotocol/mainchain';
import { stringToU8a } from '@polkadot/util';
import { blake2AsU8a, cryptoWaitReady, signatureVerify } from '@polkadot/util-crypto';
import { BootstrapRecovery, BootstrapRecoveryContext } from '../lib/BootstrapRecovery.ts';
import type { MemoryWalletKeys } from '../lib/MemoryWalletKeys.ts';
import { createMockWalletKeys } from './helpers/wallet.ts';

beforeAll(async () => {
  await cryptoWaitReady();
});

describe('BootstrapRecovery', () => {
  it('signs the exact runtime recovery proof payload', async () => {
    const wallet = createMockWalletKeys('//RecoveryProof');
    const writer = await wallet.getDefaultArgonKeypair();
    const recoverySeed = await wallet.getUpstreamEndpointRecoverySeed();
    const recoveryKeypair = new Keyring({ type: 'ed25519' }).addFromSeed(hexToU8a(recoverySeed));
    const encryptedRecovery = new Uint8Array([1, 2, 3, 4]);
    const proof = createBootstrapRecoveryProof(recoveryKeypair, writer.address, encryptedRecovery);
    const payload = getOfflineRegistry()
      .createType('(Bytes,AccountId,[u8;32],[u8;32])', [
        u8aToHex(stringToU8a('bootstrap_recovery')),
        writer.address,
        recoveryKeypair.publicKey,
        blake2AsU8a(encryptedRecovery, 256),
      ])
      .toU8a();

    expect(signatureVerify(blake2AsU8a(payload, 256), proof.signature, recoveryKeypair.publicKey).isValid).toBe(true);
  });

  it('recovers upstream and own-server endpoints with separate recovery contexts', async () => {
    const downstream = createMockWalletKeys('//Downstream');
    const upstream = createMockWalletKeys('//Upstream');
    const endpointSecret = await upstream.getOwnServerBootstrapEndpointSecret();
    const bootstrapClient = await createBootstrapClient({
      wallet: downstream,
      context: BootstrapRecoveryContext.Upstream,
      endpointSecret,
      endpointOwner: upstream.operationalAddress,
      endpoint: {
        version: 1,
        host: 'router.example',
        port: 443,
        sequence: 3,
      },
    });

    const recovery = new BootstrapRecovery(downstream);
    await expect(
      recovery.recoverEndpoint(bootstrapClient, BootstrapRecoveryContext.Upstream, upstream.operationalAddress, 2),
    ).resolves.toMatchObject({
      host: 'router.example',
      port: 443,
      sequence: 3,
      bootstrapEndpointSecret: endpointSecret,
      ownerAccountId: upstream.operationalAddress,
    });

    await expect(
      recovery.recoverEndpoint(bootstrapClient, BootstrapRecoveryContext.OwnServer, upstream.operationalAddress),
    ).resolves.toBeUndefined();

    const ownServerEndpointIndex = 2;
    const ownServerEndpointSecret = await downstream.getOwnServerBootstrapEndpointSecret(ownServerEndpointIndex);
    const ownServerClient = await createBootstrapClient({
      wallet: downstream,
      context: BootstrapRecoveryContext.OwnServer,
      endpointSecret: ownServerEndpointSecret,
      endpointOwner: downstream.operationalAddress,
      endpointIndex: ownServerEndpointIndex,
      recovery: {
        ssh: {
          user: 'ubuntu',
          port: 2222,
        },
      },
    });
    await expect(
      recovery.recoverEndpoint(ownServerClient, BootstrapRecoveryContext.OwnServer, downstream.operationalAddress),
    ).resolves.toMatchObject({
      host: 'router.example',
      port: 443,
      bootstrapEndpointSecret: ownServerEndpointSecret,
      bootstrapEndpointIndex: ownServerEndpointIndex,
      ssh: {
        user: 'ubuntu',
        port: 2222,
      },
    });
  });

  it('rejects owner mismatches, stale endpoints, and malformed encrypted payloads', async () => {
    const downstream = createMockWalletKeys('//DownstreamValidation');
    const upstream = createMockWalletKeys('//UpstreamValidation');
    const endpointSecret = await upstream.getOwnServerBootstrapEndpointSecret();
    const bootstrapClient = await createBootstrapClient({
      wallet: downstream,
      context: BootstrapRecoveryContext.Upstream,
      endpointSecret,
      endpointOwner: upstream.operationalAddress,
      endpoint: {
        version: 1,
        host: 'router.example',
        port: 443,
        sequence: 1,
      },
    });
    const recovery = new BootstrapRecovery(downstream);

    await expect(
      recovery.recoverEndpoint(bootstrapClient, BootstrapRecoveryContext.Upstream, downstream.operationalAddress),
    ).rejects.toThrow('owned by a different account');
    await expect(
      recovery.recoverEndpoint(bootstrapClient, BootstrapRecoveryContext.Upstream, upstream.operationalAddress, 2),
    ).rejects.toThrow('older than the cached endpoint');

    const malformedClient = await createBootstrapClient({
      wallet: downstream,
      context: BootstrapRecoveryContext.Upstream,
      endpointSecret,
      endpointOwner: upstream.operationalAddress,
      encryptedEndpoint: new Uint8Array([1, 2, 3]),
    });
    await expect(
      recovery.recoverEndpoint(malformedClient, BootstrapRecoveryContext.Upstream, upstream.operationalAddress),
    ).rejects.toThrow('encrypted bootstrap payload is invalid');
  });
});

async function createBootstrapClient(args: {
  wallet: MemoryWalletKeys;
  context: BootstrapRecoveryContext;
  endpointSecret: string;
  endpointOwner: string;
  endpointIndex?: number;
  endpoint?: IBootstrapEndpointPayload;
  recovery?: Pick<IBootstrapRecoveryPayload, 'ssh'>;
  encryptedEndpoint?: Uint8Array;
}): Promise<ArgonClient> {
  const recoverySeed =
    args.context === BootstrapRecoveryContext.Upstream
      ? await args.wallet.getUpstreamEndpointRecoverySeed()
      : await args.wallet.getOwnServerEndpointRecoverySeed();
  const recoveryPubkey = new Keyring({ type: 'ed25519' }).addFromSeed(hexToU8a(recoverySeed)).publicKey;
  const endpointPubkey = getBootstrapEndpointPubkey(args.endpointSecret);
  const encryptedRecovery = await encryptBootstrapRecovery(
    {
      version: 1,
      endpointSecret: args.endpointSecret,
      ...(args.context === BootstrapRecoveryContext.OwnServer ? { endpointIndex: args.endpointIndex ?? 0 } : {}),
      ...args.recovery,
    },
    recoverySeed,
  );
  const encryptedEndpoint =
    args.encryptedEndpoint ??
    (await encryptBootstrapEndpoint(
      args.endpoint ?? {
        version: 1,
        host: 'router.example',
        port: 443,
        sequence: 3,
      },
      args.endpointSecret,
    ));
  const registry = getOfflineRegistry();
  const optionBytes = (value?: Uint8Array) => {
    return registry.createType('Option<Bytes>', value ? u8aToHex(value) : null);
  };

  return {
    query: {
      bootstrap: {
        encryptedRecoveryPayloadByPubkey: (pubkey: Uint8Array) => {
          return Promise.resolve(
            optionBytes(u8aToHex(pubkey) === u8aToHex(recoveryPubkey) ? encryptedRecovery : undefined),
          );
        },
        encryptedEndpointByPubkey: (pubkey: Uint8Array) => {
          return Promise.resolve(
            optionBytes(u8aToHex(pubkey) === u8aToHex(endpointPubkey) ? encryptedEndpoint : undefined),
          );
        },
        endpointOwnerByPubkey: (pubkey: Uint8Array) => {
          return Promise.resolve(
            registry.createType(
              'Option<AccountId>',
              u8aToHex(pubkey) === u8aToHex(endpointPubkey) ? args.endpointOwner : null,
            ),
          );
        },
      },
    },
    tx: {
      bootstrap: {
        setRecoveryPayload: () => undefined,
        setEndpoint: () => undefined,
      },
    },
  } as unknown as ArgonClient;
}
