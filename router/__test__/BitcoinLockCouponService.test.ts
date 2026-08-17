import * as Fs from 'node:fs';
import os from 'node:os';
import Path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type ArgonClient, createDeferred, MiningFrames, NetworkConfig, UserRole } from '@argonprotocol/apps-core';
import { BitcoinLock, type BitcoinLockFeeCoupon, PriceIndex } from '@argonprotocol/mainchain';
import { BitcoinLockCouponService } from '../src/BitcoinLockCouponService.ts';
import { BotUpstreamClient } from '../src/BotUpstreamClient.ts';
import { Db } from '../src/Db.ts';

NetworkConfig.setNetwork('dev-docker');

describe('BitcoinLockCouponService', () => {
  const tempDirs: string[] = [];
  const databases: Array<{ close(): void }> = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    databases.splice(0).forEach(db => db.close());
    await Promise.all(tempDirs.splice(0).map(dir => Fs.promises.rm(dir, { recursive: true, force: true })));
  });

  it('starts the configured expiration when the coupon is accepted', async () => {
    const tempDir = Fs.mkdtempSync(Path.join(os.tmpdir(), 'router-coupon-expiration-'));
    tempDirs.push(tempDir);

    const routerDb = new Db(Path.join(tempDir, 'router.sqlite'));
    routerDb.migrate();
    databases.push(routerDb);

    const member = routerDb.usersTable.insertUser({ role: UserRole.Member, name: 'Casey' });
    const service = new BitcoinLockCouponService({
      db: routerDb,
      botClient: new BotUpstreamClient('http://127.0.0.1:1'),
      getMainchainClient: unavailableMainchainClient,
    });
    const currentTickSpy = vi.spyOn(MiningFrames, 'calculateCurrentTickFromSystemTime').mockReturnValue(120);

    const created = await service.create({
      userId: member.id,
      vaultId: 12,
      maxSatoshis: 25_000n,
      estimatedGiftUsd: 16.25,
      btcPctFee: 2.5,
      expiresAfterTicks: 60,
    });

    expect(created.coupon.expirationTick).toBeNull();
    expect(created.expiresAt).toBeUndefined();

    const activated = await service.activateLatest(member.id, 'member-account');
    expect(activated.coupon.expirationTick).toBe(180);
    expect(activated.expiresAt).toEqual(MiningFrames.getTickDate(180));

    currentTickSpy.mockReturnValue(180);
    await expect(service.getByOfferCode(created.coupon.offerCode)).resolves.toMatchObject({ status: 'Expired' });
  });

  it('expires an active coupon without publishing an authorization still being signed', async () => {
    const tempDir = Fs.mkdtempSync(Path.join(os.tmpdir(), 'router-coupon-clear-expiration-'));
    tempDirs.push(tempDir);

    const routerDb = new Db(Path.join(tempDir, 'router.sqlite'));
    routerDb.migrate();
    databases.push(routerDb);

    const member = routerDb.usersTable.insertUser({ role: UserRole.Member, name: 'Casey' });
    const botClient = new BotUpstreamClient('http://127.0.0.1:1');
    const signingStarted = createDeferred();
    const signedCoupon = createDeferred<BitcoinLockFeeCoupon>();
    vi.spyOn(botClient, 'signBitcoinLockFeeCoupon').mockImplementation(async () => {
      signingStarted.resolve();
      return signedCoupon.promise;
    });
    const service = new BitcoinLockCouponService({
      db: routerDb,
      botClient,
      getMainchainClient: unavailableMainchainClient,
    });
    vi.spyOn(MiningFrames, 'calculateCurrentTickFromSystemTime').mockReturnValue(0);

    const created = await service.create({
      userId: member.id,
      vaultId: 12,
      maxSatoshis: 25_000n,
      estimatedGiftUsd: 16.25,
      btcPctFee: 2.5,
      feeCreditMicrogons: 1_000n,
      expiresAfterTicks: 60,
    });
    await service.activateLatest(member.id, 'member-account');

    const authorization = service.authorizeInitialization(created.coupon.offerCode, {
      requestId: 'cleared-lock',
      execution: 'FeeCoupon',
      requestedSatoshis: 10_000n,
      feeCreditMicrogons: 400n,
      ownerAccountId: 'member-account',
      ownerBitcoinPubkey: '0x1234',
      microgonsAtTargetPerBtc: 75_000_000n,
    });
    await signingStarted.promise;

    const cleared = await service.updateExpiration(created.coupon.offerCode, 0);

    expect(cleared.coupon.expirationTick).toBe(0);
    expect(cleared.expiresAt).toEqual(MiningFrames.getTickDate(0));
    expect(cleared.status).toBe('Expired');

    signedCoupon.resolve({
      vaultId: 12,
      genesisHash: `0x${'12'.repeat(32)}`,
      beneficiary: 'member-account',
      feeDiscount: 400n,
      securitizationSpaceToUnreserve: 0n,
      expiresAtFrame: 1_000n,
      nonce: 1n,
      signature: '0xsignature',
    });
    await expect(authorization).rejects.toThrow('This bitcoin lock coupon has expired.');

    expect(routerDb.bitcoinLockCouponsTable.fetchUseByRequestId('cleared-lock')).toMatchObject({
      status: 'Failed',
      feeCoupon: undefined,
    });
    await expect(service.getByOfferCode(created.coupon.offerCode)).resolves.toMatchObject({ status: 'Expired' });
  });

  it('backfills an unused legacy coupon without changing its offer code', async () => {
    const tempDir = Fs.mkdtempSync(Path.join(os.tmpdir(), 'router-coupon-backfill-'));
    tempDirs.push(tempDir);

    const routerDb = new Db(Path.join(tempDir, 'router.sqlite'));
    routerDb.migrate();
    databases.push(routerDb);

    const member = routerDb.usersTable.insertUser({ role: UserRole.Member, name: 'Casey' });
    routerDb.userInvitesTable.insertInvite(member.id, 'invite-code', 'Operator One');
    routerDb.bitcoinLockCouponsTable.restore({
      userId: member.id,
      sequence: 1,
      offerCode: 'legacy-offer',
      vaultId: 12,
      maxSatoshis: 25_000n,
      estimatedGiftUsd: 16.25,
      btcPctFee: 2.5,
      expiresAfterTicks: 60,
      accountId: 'member-account',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const priceIndex = new PriceIndex();
    vi.spyOn(PriceIndex.prototype, 'load').mockResolvedValue(priceIndex);
    vi.spyOn(BitcoinLock, 'calculateRedemptionAmountFromSatoshis').mockReturnValue(4_000_000n);
    const botClient = new BotUpstreamClient('http://127.0.0.1:1');
    const service = new BitcoinLockCouponService({
      db: routerDb,
      botClient,
      getMainchainClient: async () => ({}) as ArgonClient,
    });

    await service.reconcile();

    await expect(service.getByOfferCode('legacy-offer')).resolves.toMatchObject({
      coupon: { offerCode: 'legacy-offer', feeCreditMicrogons: 100_000n },
      originalFeeCreditMicrogons: 100_000n,
      remainingFeeCreditMicrogons: 100_000n,
      status: 'Open',
    });
  });

  it('imports an existing bot coupon with its relay once', async () => {
    const tempDir = Fs.mkdtempSync(Path.join(os.tmpdir(), 'router-coupon-import-'));
    tempDirs.push(tempDir);

    const routerDb = new Db(Path.join(tempDir, 'router.sqlite'));
    routerDb.migrate();
    databases.push(routerDb);

    const member = routerDb.usersTable.insertUser({ role: UserRole.Member, name: 'Casey' });
    routerDb.userInvitesTable.insertInvite(member.id, 'invite-code', 'Operator One');

    const botDir = Path.join(tempDir, 'bot');
    const botDbPath = Path.join(botDir, 'vault.sqlite');
    Fs.mkdirSync(botDir);
    const botDb = new DatabaseSync(botDbPath);
    botDb.exec(`
      CREATE TABLE BitcoinLockCoupons (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        userId INTEGER NOT NULL,
        sequence INTEGER NOT NULL,
        offerCode TEXT NOT NULL UNIQUE,
        vaultId INTEGER NOT NULL,
        maxSatoshis TEXT NOT NULL,
        estimatedGiftUsd REAL NOT NULL,
        btcPctFee REAL NOT NULL,
        expiresAfterTicks INTEGER NOT NULL,
        expirationTick INTEGER,
        accountId TEXT,
        createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updatedAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE BitcoinLockRelays (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        requestId TEXT NOT NULL UNIQUE,
        legacyCouponId INTEGER,
        status TEXT NOT NULL,
        requestedSatoshis TEXT NOT NULL,
        securitizationUsedMicrogons TEXT NOT NULL,
        ownerAccountId TEXT NOT NULL,
        ownerBitcoinPubkey TEXT NOT NULL,
        microgonsAtTargetPerBtc TEXT NOT NULL,
        error TEXT,
        delegateAddress TEXT,
        extrinsicHash TEXT,
        extrinsicMethodJson TEXT,
        txNonce INTEGER,
        txSubmittedAtBlockHeight INTEGER,
        txSubmittedAtTime TEXT,
        txExpiresAtBlockHeight INTEGER,
        txInBlockHeight INTEGER,
        txInBlockHash TEXT,
        txFinalizedHeight INTEGER,
        txFeePlusTip TEXT,
        txTip TEXT,
        utxoId INTEGER,
        createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updatedAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `);
    botDb
      .prepare(
        `
        INSERT INTO BitcoinLockCoupons (
          id, userId, sequence, offerCode, vaultId, maxSatoshis, estimatedGiftUsd,
          btcPctFee, expiresAfterTicks, expirationTick, accountId
        ) VALUES (1, $userId, 1, 'offer-code', 12, '25000', 16.25, 2.5, 60, 1000, 'member-account')
      `,
      )
      .run({ $userId: member.id });
    botDb
      .prepare(
        `
        INSERT INTO BitcoinLockRelays (
          id, requestId, legacyCouponId, status, requestedSatoshis, securitizationUsedMicrogons,
          ownerAccountId, ownerBitcoinPubkey, microgonsAtTargetPerBtc,
          delegateAddress, extrinsicHash, extrinsicMethodJson, txNonce,
          txSubmittedAtBlockHeight, txSubmittedAtTime, txExpiresAtBlockHeight,
          txInBlockHeight, txInBlockHash, txFeePlusTip, txTip, utxoId
        ) VALUES (
          1, 'legacy-1', 1, 'InBlock', '25000', '100', 'member-account', '0x1234', '75000000',
          'delegate-account', '0xrelay', '{}', 1, 8, CURRENT_TIMESTAMP, 16,
          12, '0xblock', '14', '2', 42
        )
      `,
      )
      .run();
    botDb.close();

    const botClient = new BotUpstreamClient('http://127.0.0.1:1');
    vi.spyOn(botClient, 'getBitcoinLockRelay').mockRejectedValue(new Error('Bot is offline'));
    const service = new BitcoinLockCouponService({
      db: routerDb,
      botClient,
      getMainchainClient: unavailableMainchainClient,
      legacyBotDbPath: botDbPath,
    });

    const imported = await service.getByOfferCode('offer-code');
    expect(imported).toMatchObject({
      status: 'InBlock',
      relay: {
        requestId: 'legacy-1',
        status: 'InBlock',
        utxoId: 42,
      },
    });

    await service.getByOfferCode('offer-code');
    expect(routerDb.bitcoinLockCouponsTable.fetchAll()).toHaveLength(1);
  });

  it('reports expired coupons and one-lock relay credit states', async () => {
    const tempDir = Fs.mkdtempSync(Path.join(os.tmpdir(), 'router-coupon-status-'));
    tempDirs.push(tempDir);

    const routerDb = new Db(Path.join(tempDir, 'router.sqlite'));
    routerDb.migrate();
    databases.push(routerDb);

    const member = routerDb.usersTable.insertUser({ role: UserRole.Member, name: 'Casey' });
    routerDb.userInvitesTable.insertInvite(member.id, 'invite-code', 'Operator One');

    const now = new Date();
    const botClient = new BotUpstreamClient('http://127.0.0.1:1');
    const service = new BitcoinLockCouponService({
      db: routerDb,
      botClient,
      getMainchainClient: unavailableMainchainClient,
    });
    await service.restore({
      userId: member.id,
      sequence: 1,
      offerCode: 'expired-offer',
      vaultId: 12,
      maxSatoshis: 25_000n,
      estimatedGiftUsd: 16.25,
      btcPctFee: 2.5,
      expiresAfterTicks: 60,
      expirationTick: 1,
      accountId: 'member-account',
      createdAt: now,
      updatedAt: now,
    });
    const delegatedRelay = {
      id: 1,
      requestId: 'relay-1',
      status: 'InBlock' as const,
      requestedSatoshis: 25_000n,
      securitizationUsedMicrogons: 100n,
      ownerAccountId: 'member-account',
      ownerBitcoinPubkey: '0x1234',
      microgonsAtTargetPerBtc: 75_000_000n,
      error: null,
      delegateAddress: 'delegate-account',
      extrinsicHash: '0xrelay',
      extrinsicMethodJson: {},
      txNonce: 1,
      txSubmittedAtBlockHeight: 8,
      txSubmittedAtTime: now,
      txExpiresAtBlockHeight: 16,
      txInBlockHeight: 12,
      txInBlockHash: '0xblock',
      txFinalizedHeight: null,
      txFeePlusTip: 14n,
      txTip: 2n,
      utxoId: 42,
      createdAt: now,
      updatedAt: now,
    };
    const delegatedCoupon = await service.restore({
      userId: member.id,
      sequence: 2,
      offerCode: 'used-offer',
      vaultId: 12,
      maxSatoshis: 25_000n,
      estimatedGiftUsd: 16.25,
      btcPctFee: 2.5,
      feeCreditMicrogons: 1_000n,
      expiresAfterTicks: 60,
      expirationTick: 10_000_000,
      accountId: 'member-account',
      createdAt: now,
      updatedAt: now,
      relay: delegatedRelay,
    });

    await expect(service.getByOfferCode('expired-offer')).resolves.toMatchObject({ status: 'Expired' });
    await expect(service.getByOfferCode('used-offer')).resolves.toMatchObject({
      status: 'InBlock',
      usedFeeCreditMicrogons: 0n,
      pendingFeeCreditMicrogons: 1_000n,
      remainingFeeCreditMicrogons: 0n,
    });

    routerDb.bitcoinLockCouponsTable.recordRelay(delegatedCoupon.id, {
      ...delegatedRelay,
      status: 'Finalized',
      txFinalizedHeight: 14,
    });
    await expect(service.getByOfferCode('used-offer')).resolves.toMatchObject({
      status: 'Used',
      usedFeeCreditMicrogons: 1_000n,
      pendingFeeCreditMicrogons: 0n,
      remainingFeeCreditMicrogons: 0n,
    });
    await expect(
      service.initialize('expired-offer', {
        requestedSatoshis: 25_000n,
        ownerAccountId: 'member-account',
        ownerBitcoinPubkey: '0x1234',
        microgonsAtTargetPerBtc: 75_000_000n,
      }),
    ).rejects.toThrow('This bitcoin lock coupon has expired.');

    vi.spyOn(MiningFrames, 'calculateCurrentTickFromSystemTime').mockReturnValue(100);
    const reopened = await service.updateExpiration('expired-offer', 2 * NetworkConfig.rewardTicksPerFrame);
    expect(reopened).toMatchObject({ status: 'Open' });
    expect(reopened.coupon.expirationTick).toBe(100 + 2 * NetworkConfig.rewardTicksPerFrame);
  });

  it('tracks reusable fee credit across finalized locks and updates its expiration', async () => {
    const tempDir = Fs.mkdtempSync(Path.join(os.tmpdir(), 'router-reusable-coupon-'));
    tempDirs.push(tempDir);

    const routerDb = new Db(Path.join(tempDir, 'router.sqlite'));
    routerDb.migrate();
    databases.push(routerDb);

    const member = routerDb.usersTable.insertUser({ role: UserRole.Member, name: 'Casey' });
    routerDb.userInvitesTable.insertInvite(member.id, 'invite-code', 'Operator One');

    const botClient = new BotUpstreamClient('http://127.0.0.1:1');
    const signFeeCoupon = vi.spyOn(botClient, 'signBitcoinLockFeeCoupon').mockImplementation(async request => ({
      vaultId: request.vaultId,
      genesisHash: `0x${'12'.repeat(32)}`,
      beneficiary: request.beneficiary,
      feeDiscount: request.feeDiscountMicrogons,
      securitizationSpaceToUnreserve: 0n,
      expiresAtFrame: 1_000n,
      nonce: 1n,
      signature: '0xsignature',
    }));
    let consumedNonce = 0n;
    let currentFrameId = 1n;
    const lastFeeCouponNonceByVaultAndAccount = vi.fn(async () => ({
      isSome: consumedNonce > 0n,
      unwrap: () => ({ toBigInt: () => consumedNonce }),
    }));
    const getMainchainClient = vi.fn(
      async () =>
        ({
          rpc: {
            chain: {
              getFinalizedHead: vi.fn(async () => '0xfinalized'),
            },
          },
          at: vi.fn(async () => ({
            query: {
              bitcoinLocks: {
                lastFeeCouponNonceByVaultAndAccount,
              },
              miningSlot: {
                nextFrameId: vi.fn(async () => ({ toBigInt: () => currentFrameId + 1n })),
              },
            },
          })),
        }) as unknown as ArgonClient,
    );
    const service = new BitcoinLockCouponService({ db: routerDb, botClient, getMainchainClient });
    const created = await service.create({
      userId: member.id,
      vaultId: 12,
      maxSatoshis: 25_000n,
      estimatedGiftUsd: 0,
      feeCreditMicrogons: 1_000n,
      expiresAfterTicks: 600,
    });
    await service.activateLatest(member.id, 'member-account');

    const firstRequest = {
      requestId: 'lock-1',
      execution: 'FeeCoupon' as const,
      requestedSatoshis: 10_000n,
      feeCreditMicrogons: 400n,
      ownerAccountId: 'member-account',
      ownerBitcoinPubkey: '0x1234',
      microgonsAtTargetPerBtc: 75_000_000n,
    };
    await expect(
      service.authorizeInitialization(created.coupon.offerCode, { ...firstRequest, feeCouponNonce: 1n }),
    ).rejects.toThrow('nonce is no longer available');
    expect(routerDb.bitcoinLockCouponsTable.fetchUseByRequestId('lock-1')).toBeNull();

    const firstUse = await service.authorizeInitialization(created.coupon.offerCode, firstRequest);
    expect(firstUse.use.feeCoupon?.feeDiscount).toBe(400n);
    expect(signFeeCoupon).toHaveBeenCalledTimes(1);

    await expect(
      service.authorizeInitialization(created.coupon.offerCode, { ...firstRequest, feeCouponNonce: 2n }),
    ).rejects.toThrow('nonce is no longer available');

    const replacementRequest = {
      ...firstRequest,
      requestId: 'recovered-client-request',
      feeCouponNonce: 1n,
      requestedSatoshis: 8_000n,
      feeCreditMicrogons: 300n,
      ownerBitcoinPubkey: '0x5678',
      microgonsAtTargetPerBtc: 76_000_000n,
    };
    const replacement = await service.authorizeInitialization(created.coupon.offerCode, replacementRequest);
    expect(replacement.use).toMatchObject({
      requestId: 'lock-1',
      requestedSatoshis: 8_000n,
      feeCreditMicrogons: 400n,
      microgonsAtTargetPerBtc: 76_000_000n,
      feeCoupon: { feeDiscount: 300n, nonce: 1n },
    });
    expect(signFeeCoupon).toHaveBeenCalledTimes(2);
    expect(signFeeCoupon).toHaveBeenLastCalledWith(
      expect.objectContaining({
        feeCouponNonce: 1n,
        requestedSatoshis: 8_000n,
        microgonsAtTargetPerBtc: 76_000_000n,
        feeDiscountMicrogons: 300n,
      }),
    );

    await service.authorizeInitialization(created.coupon.offerCode, replacementRequest);
    expect(signFeeCoupon).toHaveBeenCalledTimes(2);

    signFeeCoupon.mockRejectedValueOnce(new Error('Signing is unavailable'));
    await expect(
      service.authorizeInitialization(created.coupon.offerCode, {
        ...replacementRequest,
        requestedSatoshis: 7_000n,
        feeCreditMicrogons: 200n,
        microgonsAtTargetPerBtc: 77_000_000n,
      }),
    ).rejects.toThrow('Signing is unavailable');
    expect(routerDb.bitcoinLockCouponsTable.fetchUseByRequestId('lock-1')).toMatchObject({
      status: 'Prepared',
      requestedSatoshis: 8_000n,
      feeCreditMicrogons: 400n,
      microgonsAtTargetPerBtc: 76_000_000n,
      feeCoupon: { feeDiscount: 300n, nonce: 1n },
    });

    const secondCoupon = await service.create({
      userId: member.id,
      vaultId: 12,
      maxSatoshis: 25_000n,
      estimatedGiftUsd: 0,
      feeCreditMicrogons: 100n,
      expiresAfterTicks: 600,
    });
    await service.activateLatest(member.id, 'member-account');

    const secondRequest = {
      requestId: 'second-coupon-lock',
      execution: 'FeeCoupon' as const,
      requestedSatoshis: 5_000n,
      feeCreditMicrogons: 100n,
      ownerAccountId: 'member-account',
      ownerBitcoinPubkey: '0x9999',
      microgonsAtTargetPerBtc: 75_000_000n,
    };
    await expect(service.authorizeInitialization(secondCoupon.coupon.offerCode, secondRequest)).rejects.toThrow(
      'This member already has a Bitcoin lock in progress.',
    );

    consumedNonce = 1n;
    const afterFirstUse = await service.reportFeeCouponUse('lock-1', 'member-account');
    expect(routerDb.bitcoinLockCouponsTable.fetchUseByRequestId('lock-1')?.status).toBe('Finalized');
    expect(afterFirstUse).toMatchObject({
      originalFeeCreditMicrogons: 1_000n,
      usedFeeCreditMicrogons: 400n,
      pendingFeeCreditMicrogons: 0n,
      remainingFeeCreditMicrogons: 600n,
      status: 'Open',
    });
    expect(lastFeeCouponNonceByVaultAndAccount).toHaveBeenCalledWith(
      created.coupon.vaultId,
      firstRequest.ownerAccountId,
    );

    await service.authorizeInitialization(secondCoupon.coupon.offerCode, secondRequest);
    consumedNonce = 0n;
    currentFrameId = 1_001n;
    await service.reconcile();
    await expect(service.getByOfferCode(secondCoupon.coupon.offerCode)).resolves.toMatchObject({ status: 'Open' });
    expect(routerDb.bitcoinLockCouponsTable.fetchUseByRequestId(secondRequest.requestId)?.status).toBe('Failed');
    await expect(service.authorizeInitialization(secondCoupon.coupon.offerCode, secondRequest)).rejects.toThrow(
      'This Bitcoin fee credit request already failed. Start a new Bitcoin lock request.',
    );

    const currentTick = afterFirstUse.coupon.expirationTick! - 1;
    vi.spyOn(MiningFrames, 'calculateCurrentTickFromSystemTime').mockReturnValue(currentTick);
    const extended = await service.updateExpiration(created.coupon.offerCode, NetworkConfig.rewardTicksPerFrame);
    expect(extended.coupon.expirationTick).toBe(currentTick + NetworkConfig.rewardTicksPerFrame);

    currentFrameId = 50n;
    await service.authorizeInitialization(created.coupon.offerCode, {
      requestId: 'lock-2',
      execution: 'FeeCoupon',
      requestedSatoshis: 15_000n,
      feeCreditMicrogons: 600n,
      ownerAccountId: 'member-account',
      ownerBitcoinPubkey: '0x5678',
      microgonsAtTargetPerBtc: 75_000_000n,
    });
    await expect(service.getByOfferCode(created.coupon.offerCode)).resolves.toMatchObject({
      usedFeeCreditMicrogons: 400n,
      pendingFeeCreditMicrogons: 600n,
      remainingFeeCreditMicrogons: 0n,
      status: 'Prepared',
    });

    consumedNonce = 1n;
    currentFrameId = 50n;
    await service.reconcile();
    await expect(service.getByOfferCode(created.coupon.offerCode)).resolves.toMatchObject({
      usedFeeCreditMicrogons: 1_000n,
      remainingFeeCreditMicrogons: 0n,
      status: 'Used',
    });
    await expect(service.updateExpiration(created.coupon.offerCode, 1)).rejects.toThrow(
      'A fully used Bitcoin fee credit cannot be extended.',
    );

    const interrupted = await service.create({
      userId: member.id,
      vaultId: 12,
      maxSatoshis: 25_000n,
      estimatedGiftUsd: 0,
      feeCreditMicrogons: 200n,
      expiresAfterTicks: 600,
    });
    routerDb.bitcoinLockCouponsTable.insertUse({
      couponId: interrupted.coupon.id,
      requestId: 'interrupted-lock',
      feeCreditMicrogons: 200n,
      requestedSatoshis: 5_000n,
      ownerAccountId: 'member-account',
      ownerBitcoinPubkey: '0x7890',
      microgonsAtTargetPerBtc: 75_000_000n,
    });

    const restartedService = new BitcoinLockCouponService({
      db: routerDb,
      botClient,
      getMainchainClient: unavailableMainchainClient,
    });
    await expect(restartedService.getByOfferCode(interrupted.coupon.offerCode)).resolves.toMatchObject({
      remainingFeeCreditMicrogons: 200n,
      status: 'Open',
    });
    expect(routerDb.bitcoinLockCouponsTable.fetchUseByRequestId('interrupted-lock')?.status).toBe('Failed');
  });
});

async function unavailableMainchainClient(): Promise<ArgonClient> {
  throw new Error('Mainchain is offline');
}
