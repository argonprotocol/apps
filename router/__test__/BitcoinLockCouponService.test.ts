import * as Fs from 'node:fs';
import os from 'node:os';
import Path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type ArgonClient, MiningFrames, NetworkConfig, UserRole } from '@argonprotocol/apps-core';
import { BitcoinLockCouponService } from '../src/BitcoinLockCouponService.ts';
import { BotUpstreamClient } from '../src/BotUpstreamClient.ts';
import { Db } from '../src/Db.ts';

NetworkConfig.setNetwork('dev-docker');

describe('BitcoinLockCouponService', () => {
  const tempDirs: string[] = [];
  const databases: Db[] = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    databases.splice(0).forEach(db => db.close());
    await Promise.all(tempDirs.splice(0).map(dir => Fs.promises.rm(dir, { recursive: true, force: true })));
  });

  it('starts expiration when the coupon is accepted', async () => {
    const tempDir = Fs.mkdtempSync(Path.join(os.tmpdir(), 'router-coupon-expiration-'));
    tempDirs.push(tempDir);
    const db = new Db(Path.join(tempDir, 'router.sqlite'));
    db.migrate();
    databases.push(db);

    const member = db.usersTable.insertUser({ role: UserRole.Member, name: 'Casey' });
    const service = new BitcoinLockCouponService({
      db,
      botClient: new BotUpstreamClient('http://127.0.0.1:1'),
      getMainchainClient: unavailableMainchainClient,
    });
    const currentTick = vi.spyOn(MiningFrames, 'calculateCurrentTickFromSystemTime').mockReturnValue(120);
    const created = await service.create({
      userId: member.id,
      vaultId: 12,
      maxSatoshis: 25_000n,
      estimatedGiftUsd: 16.25,
      feeCreditMicrogons: 1_000n,
      expiresAfterTicks: 60,
    });

    expect(created.coupon.expirationTick).toBeNull();
    const activated = await service.activateLatest(member.id, 'member-account');
    expect(activated.coupon.expirationTick).toBe(180);

    currentTick.mockReturnValue(180);
    await expect(service.getByOfferCode(created.coupon.offerCode)).resolves.toMatchObject({ status: 'Expired' });
  });

  it('tracks reusable fee credit through signed coupon uses', async () => {
    const tempDir = Fs.mkdtempSync(Path.join(os.tmpdir(), 'router-coupon-uses-'));
    tempDirs.push(tempDir);
    const db = new Db(Path.join(tempDir, 'router.sqlite'));
    db.migrate();
    databases.push(db);

    const member = db.usersTable.insertUser({ role: UserRole.Member, name: 'Casey' });
    const botClient = new BotUpstreamClient('http://127.0.0.1:1');
    vi.spyOn(botClient, 'signBitcoinLockFeeCoupon').mockImplementation(async request => {
      await new Promise(resolve => setTimeout(resolve, 25));
      return {
        feeDiscount: request.feeDiscountMicrogons,
        securitizationSpaceToUnreserve: 0n,
        expiresAtFrame: 1_000n,
        nonce: request.feeCouponNonce ?? 1n,
        signature: '0xsignature',
      };
    });
    vi.spyOn(MiningFrames, 'calculateCurrentTickFromSystemTime').mockReturnValue(100);
    const service = new BitcoinLockCouponService({ db, botClient, getMainchainClient: unavailableMainchainClient });
    const created = await service.create({
      userId: member.id,
      vaultId: 12,
      maxSatoshis: 25_000n,
      estimatedGiftUsd: 16.25,
      feeCreditMicrogons: 1_000n,
      expiresAfterTicks: 60,
    });
    await service.activateLatest(member.id, 'member-account');

    const [first, second] = await Promise.all([
      service.authorizeInitialization(created.coupon.offerCode, {
        requestId: 'lock-1',
        utxoId: 1,
        requestedSatoshis: 10_000n,
        feeCreditMicrogons: 400n,
        ownerAccountId: 'member-account',
        ownerBitcoinPubkey: '0x1234',
        microgonsAtTargetPerBtc: 75_000_000n,
      }),
      service.authorizeInitialization(created.coupon.offerCode, {
        requestId: 'lock-2',
        utxoId: 2,
        requestedSatoshis: 8_000n,
        feeCreditMicrogons: 500n,
        ownerAccountId: 'member-account',
        ownerBitcoinPubkey: '0x5678',
        microgonsAtTargetPerBtc: 75_000_000n,
      }),
    ]);
    expect(first.status).toMatchObject({
      status: 'Prepared',
      pendingFeeCreditMicrogons: 400n,
      remainingFeeCreditMicrogons: 600n,
    });
    expect(second.status).toMatchObject({
      status: 'Prepared',
      pendingFeeCreditMicrogons: 900n,
      remainingFeeCreditMicrogons: 100n,
    });
    expect([first.use.feeCoupon?.nonce, second.use.feeCoupon?.nonce]).toEqual([1n, 2n]);

    db.bitcoinLockCouponsTable.recordUse(first.use.requestId, { status: 'Finalized' });
    const afterFirst = await service.getByOfferCode(created.coupon.offerCode);
    expect(afterFirst).toMatchObject({
      status: 'Prepared',
      usedFeeCreditMicrogons: 400n,
      pendingFeeCreditMicrogons: 500n,
      remainingFeeCreditMicrogons: 100n,
    });

    db.bitcoinLockCouponsTable.recordUse(second.use.requestId, { status: 'Finalized' });
    await expect(service.getByOfferCode(created.coupon.offerCode)).resolves.toMatchObject({
      status: 'Open',
      usedFeeCreditMicrogons: 900n,
      pendingFeeCreditMicrogons: 0n,
      remainingFeeCreditMicrogons: 100n,
    });
  });

  it('binds a resecuritization coupon to its Bitcoin Lock across retry', async () => {
    const tempDir = Fs.mkdtempSync(Path.join(os.tmpdir(), 'router-resecuritization-coupon-'));
    tempDirs.push(tempDir);
    const db = new Db(Path.join(tempDir, 'router.sqlite'));
    db.migrate();
    databases.push(db);

    const member = db.usersTable.insertUser({ role: UserRole.Member, name: 'Casey' });
    const botClient = new BotUpstreamClient('http://127.0.0.1:1');
    const sign = vi.spyOn(botClient, 'signBitcoinLockFeeCoupon').mockImplementation(async request => ({
      feeDiscount: request.feeDiscountMicrogons,
      securitizationSpaceToUnreserve: 0n,
      expiresAtFrame: 1_000n,
      nonce: request.feeCouponNonce ?? 3n,
      signature: '0xsignature',
    }));
    vi.spyOn(MiningFrames, 'calculateCurrentTickFromSystemTime').mockReturnValue(100);
    const service = new BitcoinLockCouponService({ db, botClient, getMainchainClient: unavailableMainchainClient });
    const created = await service.create({
      userId: member.id,
      vaultId: 12,
      maxSatoshis: 25_000n,
      estimatedGiftUsd: 16.25,
      feeCreditMicrogons: 1_000n,
      expiresAfterTicks: 60,
    });
    await service.activateLatest(member.id, 'member-account');

    const request = {
      requestId: 'resecure-7',
      utxoId: 7,
      requestedSatoshis: 12_000n,
      feeCreditMicrogons: 400n,
      ownerAccountId: 'member-account',
      ownerBitcoinPubkey: '0x1234',
      microgonsAtTargetPerBtc: 75_000_000n,
    };
    const authorization = await service.authorizeInitialization(created.coupon.offerCode, request);

    expect(authorization.use.utxoId).toBe(7);
    expect(sign).toHaveBeenCalledWith(expect.objectContaining({ utxoId: 7 }));
    expect(authorization.use.feeCoupon?.securitizationSpaceToUnreserve).toBe(0n);
    await expect(
      service.authorizeInitialization(created.coupon.offerCode, {
        ...request,
        requestId: undefined,
        feeCouponNonce: authorization.use.feeCoupon!.nonce,
        utxoId: 8,
      }),
    ).rejects.toThrow('different Bitcoin Lock');
  });

  it('retires persisted delegated coupons without making their credit reusable', async () => {
    const tempDir = Fs.mkdtempSync(Path.join(os.tmpdir(), 'router-coupon-retirement-'));
    tempDirs.push(tempDir);
    const db = new Db(Path.join(tempDir, 'router.sqlite'));
    db.migrate();
    databases.push(db);

    const member = db.usersTable.insertUser({ role: UserRole.Member, name: 'Casey' });
    const service = new BitcoinLockCouponService({
      db,
      botClient: new BotUpstreamClient('http://127.0.0.1:1'),
      getMainchainClient: unavailableMainchainClient,
    });
    const created = await service.create({
      userId: member.id,
      vaultId: 12,
      maxSatoshis: 25_000n,
      estimatedGiftUsd: 16.25,
      feeCreditMicrogons: 1_000n,
      expiresAfterTicks: 60,
    });
    db.sql
      .prepare('UPDATE BitcoinLockCoupons SET relayRequestId = ?, relayJson = ? WHERE id = ?')
      .run('old-relay', '{}', created.coupon.id);

    const restartedService = new BitcoinLockCouponService({
      db,
      botClient: new BotUpstreamClient('http://127.0.0.1:1'),
      getMainchainClient: unavailableMainchainClient,
    });
    const status = await restartedService.getByOfferCode(created.coupon.offerCode);
    expect(status).toMatchObject({ status: 'Used', originalFeeCreditMicrogons: 0n, remainingFeeCreditMicrogons: 0n });
    expect(
      db.sql.prepare('SELECT relayRequestId, relayJson FROM BitcoinLockCoupons WHERE id = ?').get(created.coupon.id),
    ).toEqual({ relayRequestId: null, relayJson: null });
  });
});

async function unavailableMainchainClient(): Promise<ArgonClient> {
  throw new Error('Mainchain is unavailable');
}
