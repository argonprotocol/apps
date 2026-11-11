import { afterEach, expect, it, vi } from 'vitest';
import { Keyring } from '@argonprotocol/mainchain';
import { getBundledMetadata } from '@argonprotocol/runtime-client';
import { HttpProvider } from '@polkadot/rpc-provider';
import { Metadata, TypeRegistry } from '@polkadot/types';
import { GenericExtrinsicSignatureV4 } from '@polkadot/types/extrinsic/v4';
import type { Signer, SignerPayloadJSON } from '@polkadot/types/types';
import { sr25519Verify } from '@polkadot/util-crypto';
import { SubmittableResult } from '@polkadot/api';
import { getMainchainClient } from '../src/MainchainRpcProvider.ts';
import { createArgonClient, type ArgonClient } from '../src/MainchainClients.ts';
import { TxSubmitter, type ISubmittableOptions } from '../src/TxSubmitter.ts';
import { TxSigner } from '../src/TxSigner.ts';
import { TxResult } from '../src/TxResult.ts';
import { readFileSync } from 'node:fs';
import type { RawSourceMap } from 'source-map-js';
import type { HexString } from '@polkadot/util/types';

const sourceMap: RawSourceMap = JSON.parse(
  readFileSync(new URL('index.js.map', import.meta.resolve('@argonprotocol/mainchain')), 'utf8'),
);
const metadataIndex = sourceMap.sources.findIndex(source => source.endsWith('/metadata.json'));
const currentMetadata: HexString = JSON.parse((sourceMap.sourcesContent ?? [])[metadataIndex]).result;

afterEach(() => vi.restoreAllMocks());

it.each([160, 161])('recovers inclusion when subscription event retrieval fails on runtime %s', async spec => {
  const registry = new TypeRegistry();
  const metadata =
    Object.entries(getBundledMetadata()).find(([key]) => key.endsWith(`-${spec}`))?.[1] ?? currentMetadata;
  registry.setMetadata(new Metadata(registry, metadata));
  const call = registry.createType('Call', { callIndex: Uint8Array.of(0, 0), args: ['0x'] });
  const tx = registry.createType('Extrinsic', { method: call });
  const otherCall = registry.createType('Call', { callIndex: Uint8Array.of(0, 0), args: ['0x01'] });
  const otherTx = registry.createType('Extrinsic', { method: otherCall });
  const block = registry.createType('SignedBlock', { block: { header: { number: 11 }, extrinsics: [otherTx, tx] } });
  const client = {
    registry,
    rpc: { chain: { getBlock: vi.fn(async () => block) } },
    at: vi.fn(async () => ({
      query: {
        system: {
          events: async () => [
            {
              phase: { type: 'ApplyExtrinsic', value: 0 },
              event: {
                section: 'transactionPayment',
                method: 'TransactionFeePaid',
                data: { who: 'other-sender', actualFee: 99n, tip: 0n },
              },
            },
            {
              phase: { type: 'ApplyExtrinsic', value: 1 },
              event: {
                section: 'transactionPayment',
                method: 'TransactionFeePaid',
                data: { who: 'sender', actualFee: 35n, tip: 5n },
              },
            },
          ],
        },
      },
    })),
  } as unknown as ArgonClient;
  const result = new TxResult({
    signedHash: tx.hash.toHex(),
    accountAddress: 'sender',
    nonce: 0,
    method: {},
    submittedTime: new Date('2026-11-08T12:00:00Z'),
    submittedAtBlockNumber: 10,
  });

  // Polkadot.js preserves the status but omits the index/events when its event lookup fails.
  result.onSubscriptionResult(
    client,
    new SubmittableResult({
      status: registry.createType('ExtrinsicStatus', { InBlock: block.block.header.hash }),
      txHash: tx.hash,
      internalError: new Error('Historical state temporarily unavailable'),
    }),
  );

  await vi.waitFor(() => expect(result.blockNumber).toBe(11));
  await expect(result.waitForInFirstBlock).resolves.toEqual(block.block.header.hash.toU8a());
  expect(result.extrinsicIndex).toBe(1);
  expect(result.finalFee).toBe(35n);
  expect(result.finalFeeTip).toBe(5n);
  expect(result.events).toHaveLength(1);
  expect(result.submissionError).toBeUndefined();

  result.onSubscriptionResult(
    client,
    new SubmittableResult({
      status: registry.createType('ExtrinsicStatus', { Finalized: block.block.header.hash }),
      txHash: tx.hash,
      internalError: new Error('Historical state temporarily unavailable'),
    }),
  );

  await expect(result.waitForFinalizedBlock).resolves.toEqual(block.block.header.hash.toU8a());
  expect(result.isFinalized).toBe(true);

  const missingHash = registry.createType('Hash', `0x${'55'.repeat(32)}`);
  const missing = new TxResult({ ...result.extrinsic, signedHash: missingHash.toHex() });
  missing.onSubscriptionResult(
    client,
    new SubmittableResult({
      status: registry.createType('ExtrinsicStatus', { Finalized: block.block.header.hash }),
      txHash: missingHash,
    }),
  );
  await expect(missing.waitForFinalizedBlock).rejects.toThrow('not found in its reported block');
  expect(missing.isFinalized).toBe(false);
});

it.each(['resolves', 'rejects'])(
  'keeps the replacement inclusion when an earlier subscription lookup %s after retraction',
  async outcome => {
    const registry = new TypeRegistry();
    registry.setMetadata(new Metadata(registry, currentMetadata));
    const call = registry.createType('Call', { callIndex: Uint8Array.of(0, 0), args: ['0x'] });
    const tx = registry.createType('Extrinsic', { method: call });
    const original = registry.createType('SignedBlock', { block: { header: { number: 11 }, extrinsics: [tx] } });
    const replacement = registry.createType('Header', { number: 12 });
    let releaseBlock!: (block: typeof original) => void;
    let rejectBlock!: (error: Error) => void;
    const pendingBlock = new Promise<typeof original>((resolve, reject) => {
      releaseBlock = resolve;
      rejectBlock = reject;
    });
    const client = {
      registry,
      rpc: {
        chain: {
          getBlock: async () => pendingBlock,
          getHeader: vi.fn().mockRejectedValue(new Error('Unable to retrieve header and parent from supplied hash')),
        },
      },
      at: async () => ({ query: { system: { events: async () => [] } } }),
    } as unknown as ArgonClient;
    const result = new TxResult({
      signedHash: tx.hash.toHex(),
      accountAddress: 'sender',
      nonce: 0,
      method: {},
      submittedTime: new Date('2026-11-08T12:00:00Z'),
      submittedAtBlockNumber: 10,
    });

    result.onSubscriptionResult(
      client,
      new SubmittableResult({
        status: registry.createType('ExtrinsicStatus', { InBlock: original.block.header.hash }),
        txHash: tx.hash,
        internalError: new Error('Historical state temporarily unavailable'),
      }),
    );
    result.onSubscriptionResult(
      client,
      new SubmittableResult({
        status: registry.createType('ExtrinsicStatus', { Retracted: original.block.header.hash }),
        txHash: tx.hash,
      }),
    );
    result.onSubscriptionResult(
      client,
      new SubmittableResult({
        status: registry.createType('ExtrinsicStatus', { InBlock: replacement.hash }),
        txHash: tx.hash,
        txIndex: 0,
        blockNumber: replacement.number.unwrap(),
      }),
    );
    await vi.waitFor(() => expect(result.blockNumber).toBe(12));
    await expect(result.waitForInFirstBlock).resolves.toEqual(replacement.hash.toU8a());

    if (outcome === 'rejects') rejectBlock(new Error('Historical state temporarily unavailable'));
    else releaseBlock(original);
    await new Promise(resolve => setImmediate(resolve));

    expect(result.blockNumber).toBe(12);
    expect(result.blockHash).toEqual(replacement.hash.toU8a());
    expect(result.submissionError).toBeUndefined();

    result.onSubscriptionResult(
      client,
      new SubmittableResult({
        status: registry.createType('ExtrinsicStatus', { Finalized: replacement.hash }),
        txHash: tx.hash,
        txIndex: 0,
        blockNumber: replacement.number.unwrap(),
      }),
    );
    await expect(result.waitForFinalizedBlock).resolves.toEqual(replacement.hash.toU8a());
  },
);

it.each(['resolves', 'rejects', 'rejects before independent publication'])(
  'finalizes an independently recorded inclusion when duplicate receipt hydration %s',
  async outcome => {
    const registry = new TypeRegistry();
    registry.setMetadata(new Metadata(registry, currentMetadata));
    const call = registry.createType('Call', { callIndex: Uint8Array.of(0, 0), args: ['0x'] });
    const tx = registry.createType('Extrinsic', { method: call });
    const block = registry.createType('SignedBlock', { block: { header: { number: 11 }, extrinsics: [tx] } });
    let releaseBlock!: (value: typeof block) => void;
    let rejectBlock!: (error: Error) => void;
    const pendingBlock = new Promise<typeof block>((resolve, reject) => {
      releaseBlock = resolve;
      rejectBlock = reject;
    });
    const client = {
      registry,
      rpc: { chain: { getBlock: async () => pendingBlock } },
      at: async () => ({ query: { system: { events: async () => [] } } }),
    } as unknown as ArgonClient;
    const result = new TxResult({
      signedHash: tx.hash.toHex(),
      accountAddress: 'sender',
      nonce: 0,
      method: {},
      submittedTime: new Date('2026-11-08T12:00:00Z'),
      submittedAtBlockNumber: 10,
    });
    const inclusion = {
      blockHash: block.block.header.hash.toU8a(),
      blockNumber: 11,
      extrinsicIndex: 0,
      events: [],
    };
    if (outcome === 'rejects before independent publication') {
      pendingBlock.catch(async () => {
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
        await result.setSeenInBlock(client, inclusion);
      });
    }

    result.onSubscriptionResult(
      client,
      new SubmittableResult({
        status: registry.createType('ExtrinsicStatus', { Finalized: block.block.header.hash }),
        txHash: tx.hash,
        internalError: new Error('Historical state temporarily unavailable'),
      }),
    );
    if (outcome === 'rejects before independent publication') {
      rejectBlock(new Error('Historical state temporarily unavailable'));
    } else {
      await result.setSeenInBlock(client, inclusion);
      if (outcome === 'rejects') rejectBlock(new Error('Historical state temporarily unavailable'));
      else releaseBlock(block);
    }

    await vi.waitFor(() => expect(result.isFinalized).toBe(true));
    await expect(result.waitForFinalizedBlock).resolves.toEqual(block.block.header.hash.toU8a());
    expect(result.submissionError).toBeUndefined();
  },
);

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
  const metadata =
    Object.entries(getBundledMetadata()).find(([key]) => key.endsWith(`-${spec}`))?.[1] ?? currentMetadata;
  registry.setMetadata(new Metadata(registry, metadata));
  const version = registry.metadata.pallets
    .find(pallet => pallet.name.eq('System'))!
    .constants.find(constant => constant.name.eq('Version'))!;
  const runtimeVersion = registry.createType('RuntimeVersion', version.value);
  expect(runtimeVersion.specVersion.toNumber()).toBe(spec);
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
    let accountSigner = new TxSigner(account);
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
      accountSigner = new TxSigner({
        address: account.address,
        signer: externalSigner,
      });
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
