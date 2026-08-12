import fs from 'node:fs';
import os from 'node:os';
import Path from 'node:path';
import { expect, it, vi } from 'vitest';
import {
  encodeAddress,
  getOfflineRegistry,
  type ArgonClient,
  type FrameSystemEventRecord,
  type GenericEvent,
} from '@argonprotocol/mainchain';
import { BlockWatch, type IBlockHeaderInfo } from '@argonprotocol/apps-core';
import type { ApiDecoration } from '@polkadot/api/types';
import { AccountActivityIndexer } from '../src/AccountActivityIndexer.ts';
import { IndexerDb } from '../src/IndexerDb.ts';
import { numberCodec } from './helpers/codecs.ts';
import { createHistoricalEventData } from './helpers/historicalEvents.ts';

it('stops before activity without complete named metadata instead of advancing coverage', async () => {
  const directory = fs.mkdtempSync(Path.join(os.tmpdir(), 'activity-gap-'));
  const db = new IndexerDb(Path.join(directory, 'test.db'));
  const data = createHistoricalEventData(156, 'balances', 'Transfer', {
    from: encodeAddress(new Uint8Array(32).fill(1)),
    to: encodeAddress(new Uint8Array(32).fill(2)),
    amount: 1_000,
  });
  data.names!.pop();
  const event = { section: 'balances', method: 'Transfer', data } as GenericEvent;
  const events = new Map([['0x01', [appliedEvent(event, 0)]]]);
  const runtime = eventApi(156, events, ['0x01']);
  const runtimeClient = activityClient({
    latestBlock: 1,
    specVersions: new Map([['0x01', 156]]),
    apis: new Map([['0x01', runtime.api]]),
  });
  const readHeader = vi.spyOn(BlockWatch, 'readHeader').mockReturnValue(header(1));
  const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const indexer = new AccountActivityIndexer(db);

  try {
    await indexer.start(runtimeClient.client);
    await indexer.close({ drain: true });

    expect(db.latestSyncedBlock).toBe(0);
    expect(indexer.coverageGap).toMatchObject({
      fromBlock: 1,
      toBlock: 1,
      reason: expect.stringContaining('does not expose complete named metadata'),
    });
  } finally {
    consoleError.mockRestore();
    readHeader.mockRestore();
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

it('keeps draining after a transient sync error', async () => {
  const directory = fs.mkdtempSync(Path.join(os.tmpdir(), 'activity-retry-'));
  const db = new IndexerDb(Path.join(directory, 'test.db'));
  const runtime = eventApi(156, new Map([['0x01', []]]), ['0x01']);
  const runtimeClient = activityClient({
    latestBlock: 1,
    specVersions: new Map([['0x01', 156]]),
    apis: new Map([['0x01', runtime.api]]),
  });
  const getStorage = vi.mocked(runtimeClient.client.rpc.state.getStorage);
  getStorage.mockRejectedValueOnce(new Error('temporary RPC failure'));
  const readHeader = vi.spyOn(BlockWatch, 'readHeader').mockReturnValue(header(1));
  const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const indexer = new AccountActivityIndexer(db);

  try {
    await indexer.start(runtimeClient.client);
    await indexer.close({ drain: true });

    expect(getStorage).toHaveBeenCalledTimes(2);
    expect(db.latestSyncedBlock).toBe(1);
  } finally {
    consoleError.mockRestore();
    readHeader.mockRestore();
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

it('starts syncing when the first finalized block arrives after genesis startup', async () => {
  const directory = fs.mkdtempSync(Path.join(os.tmpdir(), 'activity-genesis-start-'));
  const db = new IndexerDb(Path.join(directory, 'test.db'));
  const runtime = eventApi(156, new Map([['0x01', []]]), ['0x01']);
  const runtimeClient = activityClient({
    latestBlock: 0,
    specVersions: new Map([['0x01', 156]]),
    apis: new Map([['0x01', runtime.api]]),
  });
  const readHeader = vi.spyOn(BlockWatch, 'readHeader').mockReturnValueOnce(header(0)).mockReturnValueOnce(header(1));
  const indexer = new AccountActivityIndexer(db);

  try {
    await indexer.start(runtimeClient.client);
    const finalizedHeadListener = vi.mocked(runtimeClient.client.rpc.chain.subscribeFinalizedHeads).mock.calls[0][0];
    finalizedHeadListener({} as never);
    await indexer.close({ drain: true });

    expect(db.latestSyncedBlock).toBe(1);
  } finally {
    readHeader.mockRestore();
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

it('attributes council votes to the signed source account without loading unrelated block bodies', async () => {
  const directory = fs.mkdtempSync(Path.join(os.tmpdir(), 'activity-gateway-source-'));
  const db = new IndexerDb(Path.join(directory, 'test.db'));
  const councilMember = encodeAddress(new Uint8Array(32).fill(3));
  const councilApproval = {
    section: 'crosschainTransfer',
    method: 'QueueEntryApprovalRecorded',
    data: createHistoricalEventData(157, 'crosschainTransfer', 'QueueEntryApprovalRecorded', {
      destinationChain: 'Ethereum',
      target: { GlobalIssuanceCouncilRotation: `0x${'44'.repeat(32)}` },
      approvalQueueNonce: 1,
    }),
  } as GenericEvent;
  const events = new Map<string, FrameSystemEventRecord[]>([
    ['0x01', []],
    ['0x02', [appliedEvent(councilApproval, 0)]],
  ]);
  const runtime = eventApi(157, events, ['0x01', '0x02']);
  const runtimeClient = activityClient({
    latestBlock: 2,
    specVersions: new Map([
      ['0x01', 157],
      ['0x02', 157],
    ]),
    apis: new Map([
      ['0x01', runtime.api],
      ['0x02', runtime.api],
    ]),
    sourceAccounts: new Map([['0x02', [councilMember]]]),
  });
  const readHeader = vi.spyOn(BlockWatch, 'readHeader').mockReturnValue(header(2));
  const indexer = new AccountActivityIndexer(db);

  try {
    await indexer.start(runtimeClient.client);
    await indexer.close({ drain: true });

    expect(db.findAddressActivity(councilMember)).toMatchObject([{ blockNumber: 2, activityMask: 1 << 13 }]);
  } finally {
    readHeader.mockRestore();
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function appliedEvent(event: GenericEvent, extrinsicIndex: number): FrameSystemEventRecord {
  return {
    event,
    phase: getOfflineRegistry().createType('Phase', { ApplyExtrinsic: extrinsicIndex }),
  } as FrameSystemEventRecord;
}

function eventApi(
  specVersion: number,
  events: ReadonlyMap<string, FrameSystemEventRecord[]>,
  allowedRawEvents: string[],
): { api: ApiDecoration<'promise'>; createType: ReturnType<typeof vi.fn> } {
  const createType = vi.fn((_type: string, rawEvents: string) => {
    if (!allowedRawEvents.includes(rawEvents)) throw new Error(`Spec ${specVersion} cannot decode ${rawEvents}`);
    return events.get(rawEvents) ?? [];
  });
  const api = {
    runtimeVersion: { specVersion: numberCodec(specVersion) },
    registry: { createType },
  } as unknown as ApiDecoration<'promise'>;
  return { api, createType };
}

function activityClient(args: {
  latestBlock: number;
  specVersions: ReadonlyMap<string, number>;
  apis: ReadonlyMap<string, ApiDecoration<'promise'>>;
  sourceAccounts?: ReadonlyMap<string, string[]>;
}): { client: ArgonClient; at: ReturnType<typeof vi.fn> } {
  const blockHash = (blockNumber: number) => ({
    toHex: () => `0x0${blockNumber}`,
  });
  const at = vi.fn(async (hash: { toHex(): string }) => {
    const api = args.apis.get(hash.toHex());
    if (!api) throw new Error(`No event API for ${hash.toHex()}`);
    return api;
  });
  const getBlock = vi.fn(async (hash: string) => {
    const sourceAccounts = args.sourceAccounts?.get(hash);
    if (!sourceAccounts) throw new Error(`Unexpected block-body request for ${hash}`);

    return {
      block: {
        extrinsics: sourceAccounts.map(sourceAccount => ({
          isSigned: true,
          signer: { toString: () => sourceAccount },
        })),
      },
    };
  });
  const client = {
    at,
    query: { system: { events: { key: () => '0xevents' } } },
    rpc: {
      chain: {
        getBlock,
        getBlockHash: vi.fn(async blockNumber => blockHash(Number(blockNumber))),
        getFinalizedHead: vi.fn(async () => blockHash(args.latestBlock)),
        getHeader: vi.fn(async () => ({})),
        subscribeFinalizedHeads: vi.fn(async () => vi.fn()),
      },
      state: {
        getRuntimeVersion: vi.fn(async (hash: string) => ({
          specVersion: numberCodec(args.specVersions.get(hash) ?? 0),
        })),
        getStorage: vi.fn(async (_key: unknown, hash: string) => ({ toHex: () => hash })),
      },
    },
  } as unknown as ArgonClient;
  return { client, at };
}

function header(blockNumber: number): IBlockHeaderInfo {
  return {
    blockNumber,
    blockHash: `0x0${blockNumber}`,
    parentHash: `0x0${blockNumber - 1}`,
    blockTime: 0,
    author: '5author',
    tick: 0,
    isFinalized: true,
  };
}
