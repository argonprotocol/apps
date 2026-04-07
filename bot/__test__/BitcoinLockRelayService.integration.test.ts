import * as fs from 'node:fs';
import os from 'node:os';
import Path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { sudo } from '@argonprotocol/testing';
import {
  type BlockWatch,
  type IBitcoinLockRelayRecord,
  type IBitcoinLockRelayJobRequest,
  type IBlockHeaderInfo,
  type IDeferred,
  type MainchainClients,
  NetworkConfig,
  TransactionEvents,
  createDeferred,
} from '@argonprotocol/apps-core';
import { waitFor } from '@argonprotocol/apps-core/__test__/helpers/waitFor.ts';
import { BitcoinLock } from '@argonprotocol/mainchain';
import type { ISubmittableResult } from '@polkadot/types/types/extrinsic';
import { Db } from '../src/Db.ts';

NetworkConfig.setNetwork('dev-docker');

const { BitcoinLockRelayService } = await import('../src/BitcoinLockRelayService.ts');
type RelayServiceInstance = InstanceType<typeof BitcoinLockRelayService>;

afterEach(() => {
  vi.restoreAllMocks();
});

describe.sequential('BitcoinLockRelayService integration', () => {
  it('marks a queued relay failed when submission throws and clears reservations', async () => {
    const harness = await createRelayServiceHarness();
    const service = getTestService(harness.service);

    try {
      vi.spyOn(service, 'startInternal').mockImplementation(async () => {
        service.vaultId = 1;
      });
      vi.spyOn(service, 'checkRelayCapacity').mockImplementation(async () => ({
        canSubmit: true,
        client: {} as any,
        vault: { vaultId: 1 } as any,
        reservedLiquidityMicrogons: 44n,
      }));
      vi.spyOn(service, 'submitRelay').mockRejectedValue(new Error('submission exploded'));

      const relay = await harness.service.queueRelay(createRelayRequest());

      const failedRelay = await waitFor(5e3, 'queued relay failure', () => {
        const record = harness.db.bitcoinLockRelaysTable.fetchById(relay.id);
        if (record?.status !== 'Failed') return;
        return record;
      });

      expect(failedRelay.error).toBe('submission exploded');
      expect(failedRelay.reservedSatoshis).toBe(0n);
      expect(failedRelay.reservedLiquidityMicrogons).toBe(0n);
    } finally {
      await harness.cleanup();
    }
  });

  it('fails a submitted relay when reconciliation cannot find it before the retry window expires', async () => {
    const harness = await createRelayServiceHarness({ bestBlockNumber: 25, finalizedBlockNumber: 25 });
    const service = getTestService(harness.service);

    try {
      const relay = harness.db.bitcoinLockRelaysTable.insertQueuedRelay({
        ...createRelayRequest(),
        vaultId: 1,
        status: 'Queued',
        queueReason: null,
      });
      harness.db.bitcoinLockRelaysTable.update(relay.id, {
        status: 'Submitted',
        extrinsicHash: '0xdeadbeef',
        submittedAtBlockHeight: 1,
        reservedSatoshis: relay.requestedSatoshis,
        reservedLiquidityMicrogons: 99n,
      });

      vi.spyOn(TransactionEvents, 'findByExtrinsicHash').mockResolvedValue(null as any);

      await service.reconcileNonTerminalRelays();

      const failedRelay = harness.db.bitcoinLockRelaysTable.fetchById(relay.id);
      expect(failedRelay?.status).toBe('Failed');
      expect(failedRelay?.error).toContain('not observed in a block');
      expect(failedRelay?.reservedSatoshis).toBe(0n);
      expect(failedRelay?.reservedLiquidityMicrogons).toBe(0n);
    } finally {
      await harness.cleanup();
    }
  });

  it('updates a submitted relay to in-block during reconciliation when the extrinsic is found', async () => {
    const harness = await createRelayServiceHarness({ bestBlockNumber: 14, finalizedBlockNumber: 10 });
    const service = getTestService(harness.service);

    try {
      const relay = harness.db.bitcoinLockRelaysTable.insertQueuedRelay({
        ...createRelayRequest(),
        vaultId: 1,
        status: 'Queued',
        queueReason: null,
      });
      harness.db.bitcoinLockRelaysTable.update(relay.id, {
        status: 'Submitted',
        extrinsicHash: '0xinblock',
        submittedAtBlockHeight: 8,
        reservedSatoshis: relay.requestedSatoshis,
        reservedLiquidityMicrogons: 99n,
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
      expect(inBlockRelay?.createdLock?.ownerAccountAddress).toBe(relay.ownerAccountAddress);
    } finally {
      await harness.cleanup();
    }
  });

  it('fails an in-block submission update when the extrinsic itself errors', async () => {
    const harness = await createRelayServiceHarness();
    const service = getTestService(harness.service);

    try {
      const relay = harness.db.bitcoinLockRelaysTable.insertQueuedRelay({
        ...createRelayRequest(),
        vaultId: 1,
        status: 'Queued',
        queueReason: null,
      });
      harness.db.bitcoinLockRelaysTable.update(relay.id, {
        status: 'Submitted',
        extrinsicHash: '0xerr',
        submittedAtBlockHeight: 7,
      });

      vi.spyOn(service, 'getRelayEventData').mockImplementation(async () => ({
        inBlockHeight: 8,
        blockHashHex: '0xblock',
        txFeePlusTip: 3n,
        txTip: 1n,
        extrinsicError: new Error('extrinsic failed'),
      }));

      const submissionDeferred = createDeferred<void>(false);
      const submissionResult = createSubmissionResult({
        isInBlock: true,
        blockHash: '0xblock',
      });

      await service.handleSubmissionUpdate(relay.id, {} as any, submissionResult, submissionDeferred);
      await expect(submissionDeferred.promise).rejects.toThrow('extrinsic failed');

      const failedRelay = harness.db.bitcoinLockRelaysTable.fetchById(relay.id);
      expect(failedRelay?.status).toBe('Failed');
      expect(failedRelay?.error).toBe('extrinsic failed');
    } finally {
      await harness.cleanup();
    }
  });

  it('finalizes an in-block relay and clears reservations after the lock is found on chain', async () => {
    const harness = await createRelayServiceHarness({ finalizedBlockNumber: 88 });
    const service = getTestService(harness.service);

    try {
      const relay = harness.db.bitcoinLockRelaysTable.insertQueuedRelay({
        ...createRelayRequest(),
        vaultId: 1,
        status: 'Queued',
        queueReason: null,
      });
      harness.db.bitcoinLockRelaysTable.update(relay.id, {
        status: 'InBlock',
        inBlockHeight: 77,
        utxoId: 42,
        reservedSatoshis: relay.requestedSatoshis,
        reservedLiquidityMicrogons: 123n,
      });

      const finalizedLock = {
        vaultId: 1,
        ownerAccount: relay.ownerAccountAddress,
        satoshis: relay.requestedSatoshis,
        liquidityPromised: 555n,
        lockedMarketRate: relay.microgonsPerBtc,
        securityFees: 9n,
        createdAtHeight: 77,
      };

      vi.spyOn(harness.clients, 'get').mockResolvedValue({} as any);
      vi.spyOn(BitcoinLock, 'get').mockResolvedValue(finalizedLock as any);

      await service.tryFinalizeRelay(relay.id);

      const record = harness.db.bitcoinLockRelaysTable.fetchById(relay.id);
      expect(record?.status).toBe('Finalized');
      expect(record?.finalizedHeight).toBe(88);
      expect(record?.createdLock?.utxoId).toBe(42);
      expect(record?.createdLock?.ownerAccountAddress).toBe(relay.ownerAccountAddress);
      expect(record?.createdLock?.lockDetailsJson).toEqual(finalizedLock);
      expect(record?.reservedSatoshis).toBe(0n);
      expect(record?.reservedLiquidityMicrogons).toBe(0n);
    } finally {
      await harness.cleanup();
    }
  });
});

type RelayServiceHarness = {
  db: Db;
  clients: MainchainClients;
  service: RelayServiceInstance;
  cleanup(): Promise<void>;
};

type TestableRelayService = {
  vaultId?: number;
  startInternal(): Promise<void>;
  checkRelayCapacity(relay: IBitcoinLockRelayRecord): Promise<unknown>;
  submitRelay(relay: IBitcoinLockRelayRecord, client: unknown, vault: unknown): Promise<void>;
  reconcileNonTerminalRelays(): Promise<void>;
  tryFinalizeRelay(relayId: number): Promise<void>;
  getRelayEventData(
    client: unknown,
    result: ISubmittableResult,
    blockHashHex: string,
  ): Promise<{
    txFeePlusTip: bigint;
    txTip: bigint;
    extrinsicError?: Error;
    inBlockHeight: number;
    blockHashHex: string;
    createdLock?: {
      utxoId: number;
      liquidityPromised: bigint;
      lockedMarketRate: bigint;
      securityFees: bigint;
      ownerAccountAddress: string;
    };
  }>;
  handleSubmissionUpdate(
    relayId: number,
    client: unknown,
    result: ISubmittableResult,
    submissionDeferred: IDeferred<void>,
  ): Promise<void>;
};

async function createRelayServiceHarness(args?: {
  bestBlockNumber?: number;
  finalizedBlockNumber?: number;
}): Promise<RelayServiceHarness> {
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

function getTestService(service: RelayServiceInstance): TestableRelayService {
  return service as unknown as TestableRelayService;
}

function createRelayRequest(): IBitcoinLockRelayJobRequest {
  return {
    routerInviteId: 1,
    offerCode: 'offer-code',
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
  const bestBlockHeader = { blockNumber: args?.bestBlockNumber ?? 1 } as IBlockHeaderInfo;
  const finalizedBlockHeader = { blockNumber: args?.finalizedBlockNumber ?? 1 } as IBlockHeaderInfo;

  return {
    start: vi.fn(async () => undefined),
    stop: vi.fn(),
    bestBlockHeader,
    finalizedBlockHeader,
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

function createSubmissionResult(args: {
  isInBlock?: boolean;
  isFinalized?: boolean;
  blockHash: string;
}): ISubmittableResult {
  return {
    status: {
      isRetracted: false,
      isUsurped: false,
      isDropped: false,
      isInvalid: false,
      isInBlock: args.isInBlock ?? false,
      isFinalized: args.isFinalized ?? false,
      asInBlock: {
        toHex: () => args.blockHash,
      },
    },
  } as ISubmittableResult;
}
