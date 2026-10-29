import { afterEach, expect, it, vi } from 'vitest';
import { Keyring } from '@argonprotocol/mainchain';
import { getBundledMetadata } from '@argonprotocol/runtime-client';
import { HttpProvider } from '@polkadot/rpc-provider';
import { Metadata, TypeRegistry } from '@polkadot/types';
import { GenericExtrinsicSignatureV4 } from '@polkadot/types/extrinsic/v4';
import type { Signer, SignerPayloadJSON } from '@polkadot/types/types';
import { sr25519Verify } from '@polkadot/util-crypto';
import { getMainchainClient } from '../src/MainchainRpcProvider.ts';
import { createArgonClient } from '../src/MainchainClients.ts';
import { TxSubmitter, type ISubmittableOptions, type TxSigningAccount } from '../src/TxSubmitter.ts';

afterEach(() => vi.restoreAllMocks());

it.each([
  { scenario: 'keeps the default signature valid after a fork', spec: 160, signer: 'local', era: undefined },
  { scenario: 'preserves external signer metadata and 64 blocks after best', spec: 161, signer: 'external', era: 64 },
  {
    scenario: 'accepts an external signer returning a complete signed transaction',
    spec: 161,
    signer: 'external-full',
    era: 64,
  },
  { scenario: 'caps automatic mortality at 4096 blocks', spec: 161, signer: 'local', era: 8192 },
  {
    scenario: 'preserves a caller-supplied checkpoint and era',
    spec: 161,
    signer: 'local',
    era: { current: 238, period: 16 },
  },
  { scenario: 'preserves immortal signing', spec: 161, signer: 'local', era: 0 },
  {
    scenario: 'adds lag when finality is more than the requested lifetime behind',
    spec: 161,
    signer: 'local',
    era: 64,
    bestNumber: 310,
  },
  {
    scenario: 'rejects when finality lag exhausts the capped era',
    spec: 161,
    signer: 'local',
    era: 64,
    bestNumber: 5000,
    expectedError: /Finality.*mortality/,
  },
])('$scenario on runtime $spec', async ({ spec, signer, era, bestNumber = 246, expectedError }) => {
  const registry = new TypeRegistry();
  const metadata = Object.entries(getBundledMetadata()).find(([key]) => key.endsWith(`-${spec}`))![1];
  registry.setMetadata(new Metadata(registry, metadata));
  const version = registry.metadata.pallets
    .find(pallet => pallet.name.eq('System'))!
    .constants.find(constant => constant.name.eq('Version'))!;
  const runtimeVersion = registry.createType('RuntimeVersion', version.value);
  const genesisHash = `0x${'11'.repeat(32)}`;
  const ancestor = registry.createType('Header', { number: 238, parentHash: genesisHash });
  const finalized = registry.createType('Header', { number: 239, parentHash: ancestor.hash });
  const common = registry.createType('Header', { number: bestNumber - 2, parentHash: `0x${'22'.repeat(32)}` });
  const oldParent = registry.createType('Header', {
    number: bestNumber - 1,
    parentHash: common.hash,
    stateRoot: `0x${'33'.repeat(32)}`,
  });
  const replacement = registry.createType('Header', {
    number: bestNumber - 1,
    parentHash: common.hash,
    stateRoot: `0x${'44'.repeat(32)}`,
  });
  const best = registry.createType('Header', { number: bestNumber, parentHash: oldParent.hash });
  const headers = [ancestor, finalized, common, oldParent, replacement, best];
  const canonical = new Map(
    [ancestor, finalized, common, replacement].map(header => [header.number.toNumber(), header.hash]),
  );

  const responses: Record<string, (params: unknown[]) => unknown> = {
    chain_getBlockHash: ([number]) => (Number(number) === 0 ? genesisHash : canonical.get(Number(number))?.toHex()),
    chain_getHeader: ([hash]) => (hash ? headers.find(header => header.hash.eq(String(hash))) : best)?.toJSON(),
    chain_getFinalizedHead: () => finalized.hash.toHex(),
    state_getRuntimeVersion: () => runtimeVersion.toJSON(),
    state_getMetadata: () => metadata,
    system_chain: () => 'Argon Development',
    system_name: () => 'signing-test',
    system_version: () => '1.0.0',
    system_properties: () => ({ ss58Format: 42, tokenDecimals: 6, tokenSymbol: 'ARGN' }),
    system_accountNextIndex: () => 8,
    rpc_methods: () => ({ methods: Object.keys(responses) }),
  };
  vi.spyOn(HttpProvider.prototype, 'send').mockImplementation(async (method, params) => {
    if (!responses[method]) throw new Error(`Unexpected signing RPC ${method}`);
    return responses[method](params);
  });
  const client = createArgonClient(await getMainchainClient('http://127.0.0.1:9944'));
  try {
    const account = new Keyring({ type: 'sr25519' }).addFromUri('//Alice');
    const tx = client.tx.system.remark('fork regression');
    let externalBlockNumber: string | undefined;
    let accountSigner: TxSigningAccount = account;
    if (signer.startsWith('external')) {
      const externalSigner: Signer = {
        async signPayload(payload: SignerPayloadJSON) {
          expect(this).toBe(externalSigner);
          externalBlockNumber = payload.blockNumber;
          const result = client.registry
            .createType('ExtrinsicPayload', payload, { version: payload.version })
            .sign(account);
          if (signer === 'external-full') {
            const signedTransaction = client.registry.createType('Extrinsic', tx.toU8a());
            signedTransaction.addSignature(payload.address, result.signature, payload);
            return { id: 1, ...result, signedTransaction: signedTransaction.toHex() };
          }
          return { id: 1, ...result };
        },
      };
      accountSigner = {
        address: account.address,
        signer: externalSigner,
      };
    }
    const options: ISubmittableOptions = {
      useLatestNonce: true,
      tip: 7n,
    };
    if (signer === 'external-full') options.withSignedTransaction = true;
    if (typeof era === 'object') {
      options.era = client.registry.createType('ExtrinsicEra', era);
      options.blockHash = ancestor.hash.toHex();
    } else if (era !== undefined) {
      options.era = era;
    }
    const signing = new TxSubmitter(client, tx, accountSigner).sign(options);
    if (expectedError) {
      await expect(signing).rejects.toThrow(expectedError);
      return;
    }
    const signed = await signing;
    const encoded = client.registry.createType('Extrinsic', signed.toU8a());
    const birth = encoded.era.isMortalEra ? encoded.era.asMortalEra.birth(bestNumber + 2) : 0;
    const checkpoint = birth === 0 ? genesisHash : canonical.get(birth)!;
    const call = client.registry.createType('Call', encoded.method.toU8a());
    const payload = new GenericExtrinsicSignatureV4(client.registry).createPayload(call, {
      era: encoded.era,
      nonce: encoded.nonce.toNumber(),
      tip: encoded.tip.toBigInt(),
      mode: 0,
      genesisHash: client.genesisHash,
      blockHash: checkpoint,
      runtimeVersion: client.runtimeVersion,
    });
    expect(sr25519Verify(payload.toU8a({ method: true }), encoded.signature, account.publicKey)).toBe(true);
    expect(encoded.nonce.toNumber()).toBe(8);
    expect(encoded.tip.toBigInt()).toBe(7n);
    if (era === 0) {
      expect(encoded.era.isImmortalEra).toBe(true);
    } else {
      expect(birth).toBeLessThanOrEqual(finalized.number.toNumber());
      expect(encoded.era.asMortalEra.period.toNumber()).toBeLessThanOrEqual(4096);
      if (typeof era === 'number' && era <= 4096) {
        expect(encoded.era.asMortalEra.death(bestNumber) - bestNumber).toBeGreaterThanOrEqual(era);
      }
      if (typeof era === 'object') {
        expect(birth).toBe(era.current);
        expect(encoded.era.asMortalEra.period.toNumber()).toBe(era.period);
      }
      if (signer.startsWith('external')) expect(Number(externalBlockNumber)).toBe(birth);
    }
  } finally {
    await client.disconnect();
  }
});
