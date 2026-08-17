import * as fs from 'node:fs';
import os from 'node:os';
import Path from 'node:path';
import BigNumber from 'bignumber.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getOfflineRegistry, TxSubmitter, Vault } from '@argonprotocol/mainchain';
import { sudo } from '@argonprotocol/testing';
import { stringToU8a, u8aToHex } from '@polkadot/util';
import { blake2AsU8a, signatureVerify } from '@polkadot/util-crypto';
import {
  type BlockWatch,
  type IBitcoinLockRelayJobRequest,
  type IBitcoinLockRelayRecord,
  type IBlockHeaderInfo,
  type MainchainClients,
  NetworkConfig,
  TransactionEvents,
} from '@argonprotocol/apps-core';
import type { ISubmittableResult } from '@polkadot/types/types/extrinsic';
import { Db } from '../src/Db.ts';
import { DelegateSubmitLane } from '../src/DelegateSubmitLane.ts';

NetworkConfig.setNetwork('dev-docker');

const { BitcoinLockRelayService } = await import('../src/BitcoinLockRelayService.ts');
type TestRelayService = {
  vaultId?: number;
  latestVault?: Vault;
  startInternal(): Promise<void>;
  submitNewRelay(request: IBitcoinLockRelayJobRequest): Promise<IBitcoinLockRelayRecord>;
  checkRelayCapacity(request: IBitcoinLockRelayJobRequest): Promise<unknown>;
  handleSubmissionUpdate(relayId: number, client: unknown, result: ISubmittableResult): Promise<void>;
  reconcileNonTerminalRelays(): Promise<void>;
  relayWatchUnsubscribes: Map<number, () => void>;
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe.sequential('BitcoinLockRelayService integration', () => {
  it('signs the requested lock amount and price with the next coupon nonce', async () => {
    const harness = await createRelayServiceHarness();
    const service = harness.service as unknown as TestRelayService;

    try {
      vi.spyOn(harness.service, 'start').mockResolvedValue();
      service.vaultId = 1;
      service.latestVault = Object.assign(Object.create(Vault.prototype), {
        vaultId: 1,
        delegateAccountId: harness.service.delegateAddress,
      });
      vi.spyOn(harness.clients, 'get').mockResolvedValue({
        genesisHash: { toHex: () => `0x${'12'.repeat(32)}` },
        tx: { bitcoinLocks: {} },
        query: {
          miningSlot: {
            nextFrameId: async () => ({ toBigInt: () => 11n }),
          },
          bitcoinLocks: {
            lastFeeCouponNonceByVaultAndAccount: async () => ({
              isSome: true,
              unwrap: () => ({ toBigInt: () => 4n }),
            }),
          },
        },
      } as never);

      const request = {
        vaultId: 1,
        beneficiary: sudo().address,
        requestedSatoshis: 25_000n,
        microgonsAtTargetPerBtc: 75_000_000n,
        feeDiscountMicrogons: 400n,
        expiresAfterTicks: 60,
      };
      await expect(harness.service.signFeeCoupon({ ...request, feeCouponNonce: 4n })).rejects.toThrow(
        'nonce is no longer available',
      );
      const coupon = await harness.service.signFeeCoupon({ ...request, feeCouponNonce: 5n });
      const message = getOfflineRegistry()
        .createType('(Bytes,H256,u32,AccountId,u64,u128,u128,u128,u64,u64)', [
          u8aToHex(stringToU8a('bitcoin_lock_fee_coupon')),
          `0x${'12'.repeat(32)}`,
          request.vaultId,
          request.beneficiary,
          request.requestedSatoshis,
          request.microgonsAtTargetPerBtc,
          request.feeDiscountMicrogons,
          coupon.securitizationSpaceToUnreserve,
          coupon.expiresAtFrame,
          coupon.nonce,
        ])
        .toU8a();

      expect(coupon).toMatchObject({ feeDiscount: 400n, nonce: 5n });
      expect(coupon).not.toHaveProperty('requestedSatoshis');
      expect(coupon).not.toHaveProperty('microgonsAtTargetPerBtc');
      expect(
        signatureVerify(blake2AsU8a(message, 256), coupon.signature as string, harness.service.delegateAddress),
      ).toMatchObject({ isValid: true });
    } finally {
      await harness.cleanup();
    }
  });

  it('retries startup after an initial failure', async () => {
    const harness = await createRelayServiceHarness();
    const service = harness.service as unknown as TestRelayService;
    let attempts = 0;

    try {
      vi.spyOn(service, 'startInternal').mockImplementation(async () => {
        attempts += 1;
        if (attempts === 1) {
          throw new Error('Pruned client is not ready');
        }
      });

      await expect(harness.service.start()).rejects.toThrow('Pruned client is not ready');
      await expect(harness.service.start()).resolves.toBeUndefined();

      expect(attempts).toBe(2);
    } finally {
      await harness.cleanup();
    }
  });

  it('returns the same active relay when the same request is submitted twice', async () => {
    const harness = await createRelayServiceHarness();
    const service = harness.service as unknown as TestRelayService;

    try {
      vi.spyOn(service, 'startInternal').mockImplementation(async () => {
        service.vaultId = 1;
      });
      const submitSpy = vi.spyOn(service, 'submitNewRelay').mockImplementation(async request => {
        return upsertRelayState(harness.db, request, 'Submitted');
      });

      const first = await harness.service.relayBitcoinLock(createRelayRequest());
      const second = await harness.service.relayBitcoinLock(createRelayRequest());

      expect(second).toEqual(first);
      expect(harness.db.bitcoinLockRelaysTable.fetchByRequestId(first.requestId)?.status).toBe('Submitted');
      expect(submitSpy).toHaveBeenCalledTimes(1);
    } finally {
      await harness.cleanup();
    }
  });

  it('coalesces concurrent submissions for the same request id', async () => {
    const harness = await createRelayServiceHarness();
    const service = harness.service as unknown as TestRelayService;

    try {
      vi.spyOn(service, 'startInternal').mockImplementation(async () => {
        service.vaultId = 1;
      });
      let resolveRelay!: (value: IBitcoinLockRelayRecord) => void;
      const relayPromise = new Promise<IBitcoinLockRelayRecord>(resolve => {
        resolveRelay = resolve;
      });
      const submitSpy = vi.spyOn(service, 'submitNewRelay').mockReturnValue(relayPromise);

      const firstPromise = harness.service.relayBitcoinLock(createRelayRequest());
      const secondPromise = harness.service.relayBitcoinLock(createRelayRequest());

      await new Promise(resolve => setTimeout(resolve, 0));
      expect(submitSpy).toHaveBeenCalledTimes(1);

      resolveRelay(upsertRelayState(harness.db, createRelayRequest(), 'Submitted'));

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
      harness.laneClient.tx = { bitcoinLocks: { initializeFor: vi.fn() } };

      await expect(harness.service.relayBitcoinLock(createRelayRequest())).rejects.toThrow('Vault securitization');
      expect(harness.db.bitcoinLockRelaysTable.fetchAll()).toEqual([]);
    } finally {
      await harness.cleanup();
    }
  });

  it('submits the deployed-runtime initializeFor with the vault delegate', async () => {
    const harness = await createRelayServiceHarness();
    const service = harness.service as unknown as TestRelayService;

    try {
      const request = createRelayRequest();
      service.vaultId = request.vaultId;
      service.latestVault = Object.assign(Object.create(Vault.prototype), {
        vaultId: request.vaultId,
        operatorAccountId: 'operator',
      });
      vi.spyOn(service, 'checkRelayCapacity').mockResolvedValue({
        canSubmit: true,
        securitizationUsedMicrogons: 1_000n,
      });

      const signedTx = {
        hash: { toHex: () => '0xinitialize-for' },
        method: { toHuman: () => ({ method: 'initializeFor' }) },
        send: vi.fn(async () => () => undefined),
      };
      const signAsync = vi.fn(async (_signer: { address: string }, _options: unknown) => signedTx);
      const initializeFor = vi.fn(() => ({ signAsync }));
      harness.laneClient.tx = { bitcoinLocks: { initializeFor } };
      vi.spyOn(TxSubmitter.prototype, 'canAfford').mockResolvedValue({
        canAfford: true,
        availableBalance: 0n,
        txFee: 0n,
      });

      const status = await service.submitNewRelay(request);

      expect(status.status).toBe('Submitted');
      expect(initializeFor).toHaveBeenCalledWith(
        request.ownerAccountId,
        request.vaultId,
        request.requestedSatoshis,
        expect.any(Uint8Array),
        { V1: { microgonsAtTargetPerBtc: request.microgonsAtTargetPerBtc } },
        0n,
      );
      expect(signAsync.mock.calls[0]?.[0].address).toBe(sudo().address);
    } finally {
      await harness.cleanup();
    }
  });

  it('does not sign owner-runtime initialize with the vault delegate', async () => {
    const harness = await createRelayServiceHarness();
    const service = harness.service as unknown as TestRelayService;

    try {
      const request = createRelayRequest();
      service.vaultId = request.vaultId;
      vi.spyOn(service, 'checkRelayCapacity').mockResolvedValue({
        canSubmit: true,
        securitizationUsedMicrogons: 1_000n,
      });

      const initialize = vi.fn();
      harness.laneClient.tx = { bitcoinLocks: { initialize } };

      await expect(service.submitNewRelay(request)).rejects.toMatchObject({
        message:
          'This runtime no longer supports delegated Bitcoin lock initialization. Update Argon Desktop to use the fee coupon directly.',
        status: 409,
      });
      expect(initialize).not.toHaveBeenCalled();
      expect(harness.db.bitcoinLockRelaysTable.fetchByRequestId(request.requestId)).toBeNull();
    } finally {
      await harness.cleanup();
    }
  });

  it('uses redemption liquidity for securitization preflight and logs the compared values', async () => {
    const harness = await createRelayServiceHarness();
    const service = harness.service as unknown as TestRelayService;

    try {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      service.vaultId = 1;
      service.latestVault = Object.assign(Object.create(Vault.prototype), {
        vaultId: 1,
        delegateAccountId: sudo().address,
        availableSecuritizationSpace: () => 1_020_000n,
        securitizationRatioBN: () => new BigNumber(1),
      });
      harness.clients.get = vi.fn(async () => ({
        query: {
          priceIndex: {
            current: vi.fn(async () => ({
              isSome: true,
              unwrap: () => ({
                btcUsdPrice: { toBigInt: () => 1_000_000_000_000_000_000n },
                argonotUsdPrice: { toBigInt: () => 1_000_000_000_000_000_000n },
                argonUsdPrice: { toBigInt: () => 800_000_000_000_000_000n },
                argonUsdTargetPrice: { toBigInt: () => 1_000_000_000_000_000_000n },
                argonTimeWeightedAverageLiquidity: { toBigInt: () => 1_000_000_000_000_000_000n },
                tick: { toNumber: () => 1 },
              }),
            })),
          },
        },
      })) as any;

      const preflight = (await service.checkRelayCapacity({
        ...createRelayRequest(),
        requestedSatoshis: 25_000n,
        microgonsAtTargetPerBtc: 4_000_000_000n,
      })) as {
        canSubmit: boolean;
        reason?: string;
        statusCode?: number;
      };

      expect(preflight).toEqual({
        canSubmit: false,
        reason: 'Vault securitization is currently exhausted for this lock request.',
        statusCode: 409,
      });
      expect(warnSpy).toHaveBeenCalledWith(
        '[BitcoinLockRelayService] Vault securitization is currently exhausted for this lock request.',
        expect.objectContaining({
          vaultId: 1,
          requiredLiquidityMicrogons: '1054800',
          requiredSecuritizationMicrogons: '1054800',
          availableSecuritizationMicrogons: '1020000',
          totalRequiredSecuritizationMicrogons: '1054800',
        }),
      );
    } finally {
      await harness.cleanup();
    }
  });

  it('rejects invalid relay inputs without creating a relay row', async () => {
    const harness = await createRelayServiceHarness();
    const service = harness.service as unknown as TestRelayService;

    try {
      vi.spyOn(service, 'startInternal').mockImplementation(async () => {
        service.vaultId = 1;
      });

      const cases: Array<{
        requestId: string;
        patch: Partial<IBitcoinLockRelayJobRequest>;
        errorMatcher: string;
      }> = [
        {
          requestId: 'missing-account-id',
          patch: { ownerAccountId: '   ' },
          errorMatcher: 'owner account id',
        },
        {
          requestId: 'missing-pubkey',
          patch: { ownerBitcoinPubkey: '   ' },
          errorMatcher: 'owner bitcoin pubkey',
        },
        {
          requestId: 'below-minimum-sats',
          patch: { requestedSatoshis: 1000n },
          errorMatcher: 'greater than minimum satoshis',
        },
        {
          requestId: 'missing-price-quote',
          patch: { microgonsAtTargetPerBtc: 0n },
          errorMatcher: 'current bitcoin price quote',
        },
      ];

      for (const { requestId, patch, errorMatcher } of cases) {
        await expect(
          harness.service.relayBitcoinLock({
            ...createRelayRequest(requestId),
            ...patch,
          }),
        ).rejects.toThrow(errorMatcher);

        expect(harness.db.bitcoinLockRelaysTable.fetchByRequestId(requestId)).toBeNull();
      }
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
        const request = createRelayRequest(`request-${index}`);
        const relay = upsertRelayState(harness.db, request, 'Submitted');

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
      const request = createRelayRequest();
      const relay = upsertRelayState(harness.db, request, 'Submitted');

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
      expect(failedRelay?.txInBlockHeight).toBe(12);
      expect(failedRelay?.txInBlockHash).toBe('0xblock');
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
      const request = createRelayRequest();
      const relay = upsertRelayState(harness.db, request, 'Submitted');
      patchRelayRow(harness.db, relay.id, {
        extrinsicHash: '0xdeadbeef',
        txSubmittedAtBlockHeight: 12,
        txExpiresAtBlockHeight: 20,
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
      const request = createRelayRequest();
      const relay = upsertRelayState(harness.db, request, 'Submitted');
      patchRelayRow(harness.db, relay.id, {
        extrinsicHash: '0xinblock',
        txSubmittedAtBlockHeight: 8,
        txExpiresAtBlockHeight: 16,
      });
      service.relayWatchUnsubscribes.set(relay.id, () => undefined);

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
              lockedTargetPrice: { toBigInt: () => relay.microgonsAtTargetPerBtc },
              accountId: { toString: () => relay.ownerAccountId },
              securityFee: { toBigInt: () => 9n },
            },
          },
        ],
      } as any);

      await service.reconcileNonTerminalRelays();

      const inBlockRelay = harness.db.bitcoinLockRelaysTable.fetchById(relay.id);
      expect(inBlockRelay?.status).toBe('InBlock');
      expect(inBlockRelay?.txInBlockHeight).toBe(12);
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
      const request = createRelayRequest();
      const relay = upsertRelayState(harness.db, request, 'InBlock');
      patchRelayRow(harness.db, relay.id, {
        txInBlockHeight: 82,
        txInBlockHash: '0xnew-block',
        utxoId: 42,
      });
      service.relayWatchUnsubscribes.set(relay.id, () => undefined);

      await service.reconcileNonTerminalRelays();

      const finalizedRelay = harness.db.bitcoinLockRelaysTable.fetchById(relay.id);
      expect(finalizedRelay?.status).toBe('Finalized');
      expect(finalizedRelay?.txFinalizedHeight).toBe(90);
      expect(finalizedRelay?.utxoId).toBe(42);
    } finally {
      await harness.cleanup();
    }
  });

  it('moves an in-block relay back to submitted when its block is reorged out', async () => {
    const harness = await createRelayServiceHarness({ bestBlockNumber: 90, finalizedBlockNumber: 84 });
    const service = harness.service as unknown as TestRelayService;

    try {
      const request = createRelayRequest();
      const relay = upsertRelayState(harness.db, request, 'InBlock');
      patchRelayRow(harness.db, relay.id, {
        txInBlockHeight: 82,
        txInBlockHash: '0xold-block',
        txFeePlusTip: 14n,
        txTip: 2n,
        utxoId: 42,
      });

      await service.reconcileNonTerminalRelays();

      const updatedRelay = harness.db.bitcoinLockRelaysTable.fetchById(relay.id);
      expect(updatedRelay?.status).toBe('Submitted');
      expect(updatedRelay?.txInBlockHeight).toBeNull();
      expect(updatedRelay?.txInBlockHash).toBeNull();
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
  const laneClient = {
    at: vi.fn(async () => ({
      query: {
        system: {
          account: vi.fn(async () => ({
            nonce: { toNumber: () => 1 },
          })),
        },
      },
    })),
    rpc: {
      chain: {
        getHeader: vi.fn(async () => ({
          number: { toNumber: () => 100 },
        })),
        getBlockHash: vi.fn(async () => '0xstable'),
      },
      system: {
        accountNextIndex: vi.fn(async () => ({
          toNumber: () => 1,
        })),
      },
    },
  } as any;
  const submitLane = new DelegateSubmitLane(sudo());
  submitLane.client = laneClient;
  const service = new BitcoinLockRelayService(db, clients, blockWatch, sudo().address, submitLane);

  return {
    db,
    blockWatch,
    clients,
    laneClient,
    service,
    cleanup: async () => {
      await service.shutdown().catch(() => undefined);
      db.close();
      await fs.promises.rm(datadir, { recursive: true, force: true });
    },
  };
}

function createRelayRequest(requestId = 'request-id'): IBitcoinLockRelayJobRequest {
  return {
    requestId,
    vaultId: 1,
    requestedSatoshis: 25_000n,
    ownerAccountId: sudo().address,
    ownerBitcoinPubkey: `02${'33'.repeat(32)}`,
    microgonsAtTargetPerBtc: 75_000_000n,
  };
}

function upsertRelayState(db: Db, request: IBitcoinLockRelayJobRequest, status: 'Submitted' | 'InBlock') {
  let relay = db.bitcoinLockRelaysTable.fetchByRequestId(request.requestId);
  if (!relay) {
    relay = db.bitcoinLockRelaysTable.insertRelay({
      requestId: request.requestId,
      requestedSatoshis: request.requestedSatoshis,
      securitizationUsedMicrogons: 0n,
      ownerAccountId: request.ownerAccountId,
      ownerBitcoinPubkey: request.ownerBitcoinPubkey,
      microgonsAtTargetPerBtc: request.microgonsAtTargetPerBtc,
      delegateAddress: sudo().address,
      extrinsicHash: `0x${request.requestId}`,
      extrinsicMethodJson: {},
      txNonce: 1,
      txSubmittedAtBlockHeight: 8,
      txSubmittedAtTime: new Date(),
      txExpiresAtBlockHeight: 16,
    });
  }
  if (status === 'InBlock') {
    relay = db.bitcoinLockRelaysTable.setInBlock(relay.id, {
      txInBlockHeight: relay.txInBlockHeight ?? 12,
      txInBlockHash: relay.txInBlockHash ?? '0xblock',
      txFeePlusTip: relay.txFeePlusTip ?? 14n,
      txTip: relay.txTip ?? 2n,
      utxoId: relay.utxoId ?? 42,
    });
  }
  return relay;
}

function patchRelayRow(
  db: Db,
  relayId: number,
  patch: Partial<Record<keyof IBitcoinLockRelayRecord, unknown>>,
): IBitcoinLockRelayRecord {
  const updates = Object.keys(patch);
  if (updates.length === 0) {
    return db.bitcoinLockRelaysTable.fetchById(relayId)!;
  }

  db.sql
    .prepare(
      `
        UPDATE BitcoinLockRelays
        SET ${updates.map(key => `${key} = $${key}`).join(', ')}, updatedAt = CURRENT_TIMESTAMP
        WHERE id = $id
      `,
    )
    .run({
      $id: relayId,
      ...Object.fromEntries(updates.map(key => [`$${key}`, patch[key as keyof typeof patch] ?? null])),
    });

  return db.bitcoinLockRelaysTable.fetchById(relayId)!;
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
