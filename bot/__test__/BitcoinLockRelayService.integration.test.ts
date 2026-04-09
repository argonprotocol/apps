import * as fs from 'node:fs';
import os from 'node:os';
import Path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { sudo } from '@argonprotocol/testing';
import {
  type BlockWatch,
  type IBitcoinLockCouponStatus,
  type IBitcoinLockRelayJobRequest,
  type IBlockHeaderInfo,
  type MainchainClients,
  NetworkConfig,
  TransactionEvents,
} from '@argonprotocol/apps-core';
import type { ISubmittableResult } from '@polkadot/types/types/extrinsic';
import { Db } from '../src/Db.ts';

NetworkConfig.setNetwork('dev-docker');

const { BitcoinLockRelayService } = await import('../src/BitcoinLockRelayService.ts');
type TestRelayService = {
  vaultId?: number;
  startInternal(): Promise<void>;
  submitNewRelay(request: IBitcoinLockRelayJobRequest): Promise<IBitcoinLockCouponStatus>;
  checkRelayCapacity(request: IBitcoinLockRelayJobRequest): Promise<unknown>;
  handleSubmissionUpdate(relayId: number, client: unknown, result: ISubmittableResult): Promise<void>;
  reconcileNonTerminalRelays(): Promise<void>;
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe.sequential('BitcoinLockRelayService integration', () => {
  it('returns the same active relay when the same invite is submitted twice', async () => {
    const harness = await createRelayServiceHarness();
    const service = harness.service as unknown as TestRelayService;

    try {
      vi.spyOn(service, 'startInternal').mockImplementation(async () => {
        service.vaultId = 1;
      });
      const submitSpy = vi.spyOn(service, 'submitNewRelay').mockImplementation(async request => {
        return harness.db.bitcoinLockRelaysTable.insertRelay({
          ...request,
          vaultId: 1,
          status: 'Submitted',
        });
      });

      const first = await harness.service.queueRelay(createRelayRequest());
      const second = await harness.service.queueRelay(createRelayRequest());

      expect(second).toEqual(first);
      expect(harness.db.bitcoinLockRelaysTable.fetchByOfferCode(first.offerCode)?.status).toBe('Submitted');
      expect(submitSpy).toHaveBeenCalledTimes(1);
    } finally {
      await harness.cleanup();
    }
  });

  it('coalesces concurrent initialize requests for the same invite', async () => {
    const harness = await createRelayServiceHarness();
    const service = harness.service as unknown as TestRelayService;

    try {
      vi.spyOn(service, 'startInternal').mockImplementation(async () => {
        service.vaultId = 1;
      });

      let resolveRelay!: (value: any) => void;
      const relayPromise = new Promise(resolve => {
        resolveRelay = resolve;
      });
      const submitSpy = vi
        .spyOn(service, 'submitNewRelay')
        .mockReturnValue(relayPromise as Promise<IBitcoinLockCouponStatus>);

      const firstPromise = harness.service.queueRelay(createRelayRequest());
      const secondPromise = harness.service.queueRelay(createRelayRequest());

      await new Promise(resolve => setTimeout(resolve, 0));
      expect(submitSpy).toHaveBeenCalledTimes(1);

      resolveRelay(
        harness.db.bitcoinLockRelaysTable.insertRelay({
          ...createRelayRequest(),
          vaultId: 1,
          status: 'Submitted',
        }),
      );

      const [first, second] = await Promise.all([firstPromise, secondPromise]);
      expect(second).toEqual(first);
    } finally {
      await harness.cleanup();
    }
  });

  it('rejects a preflight failure without creating a relay row', async () => {
    const harness = await createRelayServiceHarness();
    const service = harness.service as unknown as TestRelayService;

    try {
      vi.spyOn(service, 'startInternal').mockImplementation(async () => {
        service.vaultId = 1;
      });
      vi.spyOn(service, 'checkRelayCapacity').mockResolvedValue({
        canSubmit: false,
        reason: 'Vault securitization is currently exhausted for this lock request.',
        statusCode: 409,
      });

      await expect(harness.service.queueRelay(createRelayRequest())).rejects.toThrow('Vault securitization');
      expect(harness.db.bitcoinLockRelaysTable.fetchByOfferCode('offer-code')).toBeNull();
    } finally {
      await harness.cleanup();
    }
  });

  it('marks pre-inclusion watch failures as failed', async () => {
    const harness = await createRelayServiceHarness();
    const service = harness.service as unknown as TestRelayService;

    try {
      const failures: Array<{
        kind: 'Retracted' | 'Dropped' | 'Invalid' | 'Usurped';
        errorMatcher: string;
      }> = [
        { kind: 'Retracted', errorMatcher: 'Relay was retracted before it was included in a block.' },
        { kind: 'Dropped', errorMatcher: 'Relay was dropped before it was included in a block.' },
        { kind: 'Invalid', errorMatcher: 'Relay was rejected as invalid by the node.' },
        { kind: 'Usurped', errorMatcher: 'usurped' },
      ];

      for (const [index, { kind, errorMatcher }] of failures.entries()) {
        const request = createRelayRequest();
        request.offerCode = `offer-code-${index}`;

        const relay = harness.db.bitcoinLockRelaysTable.insertRelay({
          ...request,
          vaultId: 1,
          status: 'Submitted',
        });

        await service.handleSubmissionUpdate(relay.id, {} as any, createSubmissionResult({ blockHash: '0x1', kind }));

        const failedRelay = harness.db.bitcoinLockRelaysTable.fetchById(relay.id);
        expect(failedRelay?.status).toBe('Failed');
        if (kind === 'Usurped') {
          expect(failedRelay?.error).toContain(errorMatcher);
        } else {
          expect(failedRelay?.error).toBe(errorMatcher);
        }
      }
    } finally {
      await harness.cleanup();
    }
  });

  it('stores in-block fees when the extrinsic fails in block', async () => {
    const harness = await createRelayServiceHarness();
    const service = harness.service as unknown as TestRelayService;

    try {
      const relay = harness.db.bitcoinLockRelaysTable.insertRelay({
        ...createRelayRequest(),
        vaultId: 1,
        status: 'Submitted',
      });

      vi.spyOn(service as any, 'getRelayEventData').mockResolvedValue({
        inBlockHeight: 12,
        blockHashHex: '0xblock',
        txFeePlusTip: 14n,
        txTip: 2n,
        extrinsicError: new Error('Dispatch error'),
      });

      await service.handleSubmissionUpdate(
        relay.id,
        {} as any,
        {
          status: {
            isRetracted: false,
            isUsurped: false,
            isDropped: false,
            isInvalid: false,
            isInBlock: true,
            isFinalized: false,
            asInBlock: {
              toHex: () => '0xblock',
            },
          },
        } as unknown as ISubmittableResult,
      );

      const failedRelay = harness.db.bitcoinLockRelaysTable.fetchById(relay.id);
      expect(failedRelay?.status).toBe('Failed');
      expect(failedRelay?.error).toBe('Dispatch error');
      expect(failedRelay?.inBlockHeight).toBe(12);
      expect(failedRelay?.inBlockHash).toBe('0xblock');
      expect(failedRelay?.txFeePlusTip).toBe(14n);
      expect(failedRelay?.txTip).toBe(2n);
    } finally {
      await harness.cleanup();
    }
  });

  it('fails a submitted relay when it expires without ever reaching a block', async () => {
    const harness = await createRelayServiceHarness({ bestBlockNumber: 20, finalizedBlockNumber: 20 });
    const service = harness.service as unknown as TestRelayService;

    try {
      const relay = harness.db.bitcoinLockRelaysTable.insertRelay({
        ...createRelayRequest(),
        vaultId: 1,
        status: 'Submitted',
      });
      harness.db.bitcoinLockRelaysTable.update(relay.id, {
        extrinsicHash: '0xdeadbeef',
        submittedAtBlockHeight: 12,
        expiresAtBlockHeight: 20,
      });

      vi.spyOn(TransactionEvents, 'findByExtrinsicHash').mockResolvedValue(null as any);

      await service.reconcileNonTerminalRelays();

      const failedRelay = harness.db.bitcoinLockRelaysTable.fetchById(relay.id);
      expect(failedRelay?.status).toBe('Failed');
      expect(failedRelay?.error).toContain('expired before it was included');
    } finally {
      await harness.cleanup();
    }
  });

  it('recovers a submitted relay into in-block when it is found in chain history', async () => {
    const harness = await createRelayServiceHarness({ bestBlockNumber: 14, finalizedBlockNumber: 10 });
    const service = harness.service as unknown as TestRelayService;

    try {
      const relay = harness.db.bitcoinLockRelaysTable.insertRelay({
        ...createRelayRequest(),
        vaultId: 1,
        status: 'Submitted',
      });
      harness.db.bitcoinLockRelaysTable.update(relay.id, {
        extrinsicHash: '0xinblock',
        submittedAtBlockHeight: 8,
        expiresAtBlockHeight: 16,
      });

      vi.spyOn(TransactionEvents, 'findByExtrinsicHash').mockResolvedValue({
        blockNumber: 12,
        blockHash: '0xblock',
        fee: 12n,
        tip: 2n,
        extrinsicEvents: [
          {
            data: {
              utxoId: { toNumber: () => 42 },
              liquidityPromised: { toBigInt: () => 555n },
              lockedMarketRate: { toBigInt: () => relay.microgonsPerBtc },
              accountId: { toString: () => relay.ownerAccountAddress },
              securityFee: { toBigInt: () => 9n },
            },
          },
        ],
      } as any);

      await service.reconcileNonTerminalRelays();

      const inBlockRelay = harness.db.bitcoinLockRelaysTable.fetchById(relay.id);
      expect(inBlockRelay?.status).toBe('InBlock');
      expect(inBlockRelay?.inBlockHeight).toBe(12);
      expect(inBlockRelay?.txFeePlusTip).toBe(14n);
      expect(inBlockRelay?.utxoId).toBe(42);
    } finally {
      await harness.cleanup();
    }
  });

  it('finalizes an in-block relay during reconciliation once finality is deep enough', async () => {
    const harness = await createRelayServiceHarness({ bestBlockNumber: 90, finalizedBlockNumber: 90 });
    const service = harness.service as unknown as TestRelayService;

    try {
      const relay = harness.db.bitcoinLockRelaysTable.insertRelay({
        ...createRelayRequest(),
        vaultId: 1,
        status: 'InBlock',
      });
      harness.db.bitcoinLockRelaysTable.update(relay.id, {
        inBlockHeight: 82,
        inBlockHash: '0xnew-block',
        utxoId: 42,
      });

      await service.reconcileNonTerminalRelays();

      const finalizedRelay = harness.db.bitcoinLockRelaysTable.fetchById(relay.id);
      expect(finalizedRelay?.status).toBe('Finalized');
      expect(finalizedRelay?.finalizedHeight).toBe(90);
      expect(finalizedRelay?.utxoId).toBe(42);
    } finally {
      await harness.cleanup();
    }
  });

  it('moves an in-block relay back to submitted when its block is reorged out', async () => {
    const harness = await createRelayServiceHarness({ bestBlockNumber: 90, finalizedBlockNumber: 84 });
    const service = harness.service as unknown as TestRelayService;

    try {
      const relay = harness.db.bitcoinLockRelaysTable.insertRelay({
        ...createRelayRequest(),
        vaultId: 1,
        status: 'InBlock',
      });
      harness.db.bitcoinLockRelaysTable.update(relay.id, {
        inBlockHeight: 82,
        inBlockHash: '0xold-block',
        txFeePlusTip: 14n,
        txTip: 2n,
        utxoId: 42,
      });

      await service.reconcileNonTerminalRelays();

      const updatedRelay = harness.db.bitcoinLockRelaysTable.fetchById(relay.id);
      expect(updatedRelay?.status).toBe('Submitted');
      expect(updatedRelay?.inBlockHeight).toBeNull();
      expect(updatedRelay?.inBlockHash).toBeNull();
      expect(updatedRelay?.txFeePlusTip).toBeNull();
      expect(updatedRelay?.txTip).toBeNull();
      expect(updatedRelay?.utxoId).toBeNull();
    } finally {
      await harness.cleanup();
    }
  });
});

async function createRelayServiceHarness(args?: { bestBlockNumber?: number; finalizedBlockNumber?: number }) {
  const datadir = fs.mkdtempSync(Path.join(os.tmpdir(), 'bitcoin-lock-relay-service-'));
  const db = new Db(datadir);
  db.migrate();

  const blockWatch = createFakeBlockWatch(args);
  const clients = {
    get: vi.fn(async () => ({})),
  } as unknown as MainchainClients;
  const service = new BitcoinLockRelayService(db, clients, blockWatch, sudo().address, sudo());

  return {
    db,
    clients,
    service,
    cleanup: async () => {
      await service.shutdown().catch(() => undefined);
      db.close();
      await fs.promises.rm(datadir, { recursive: true, force: true });
    },
  };
}

function createRelayRequest(offerCode = 'offer-code'): IBitcoinLockRelayJobRequest {
  return {
    offerCode,
    maxSatoshis: 50_000n,
    expirationTick: 999_999,
    requestedSatoshis: 25_000n,
    ownerAccountAddress: sudo().address,
    ownerBitcoinPubkey: '0x1234',
    microgonsPerBtc: 75_000_000n,
  };
}

function createFakeBlockWatch(args?: { bestBlockNumber?: number; finalizedBlockNumber?: number }): BlockWatch {
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  const bestBlockHeader = {
    blockNumber: args?.bestBlockNumber ?? 1,
    tick: 1,
    blockHash: '0xbest',
    blockTime: Date.now(),
    parentHash: '0xparent',
    author: sudo().address,
    isFinalized: false,
  } as IBlockHeaderInfo;
  const finalizedBlockHeader = {
    blockNumber: args?.finalizedBlockNumber ?? 1,
    tick: 1,
    blockHash: '0xfinal',
    blockTime: Date.now(),
    parentHash: '0xparent',
    author: sudo().address,
    isFinalized: true,
  } as IBlockHeaderInfo;

  return {
    start: vi.fn(async () => undefined),
    stop: vi.fn(),
    bestBlockHeader,
    finalizedBlockHeader,
    getHeader: vi.fn(async (blockNumber: number) => ({
      blockNumber,
      tick: 1,
      blockHash: blockNumber === 82 ? '0xnew-block' : `0x${blockNumber.toString(16)}`,
      blockTime: Date.now(),
      parentHash: '0xparent',
      author: sudo().address,
      isFinalized: blockNumber <= finalizedBlockHeader.blockNumber,
    })),
    getRpcClient: vi.fn(async () => ({
      events: {
        bitcoinLocks: {
          BitcoinLockCreated: {
            is: () => true,
          },
        },
      },
    })),
    events: {
      on(event: string, listener: (...args: unknown[]) => void) {
        let handlers = listeners.get(event);
        if (!handlers) {
          handlers = new Set();
          listeners.set(event, handlers);
        }
        handlers.add(listener);

        return () => {
          handlers?.delete(listener);
        };
      },
    },
  } as unknown as BlockWatch;
}

function createSubmissionResult(args: { blockHash: string; kind: 'Dropped' | 'Invalid' | 'Retracted' | 'Usurped' }) {
  return {
    status: {
      isRetracted: args.kind === 'Retracted',
      isUsurped: args.kind === 'Usurped',
      isDropped: args.kind === 'Dropped',
      isInvalid: args.kind === 'Invalid',
      isInBlock: false,
      isFinalized: false,
      asUsurped: {
        toHex: () => '0xusurped',
      },
      asInBlock: {
        toHex: () => args.blockHash,
      },
    },
  } as unknown as ISubmittableResult;
}
