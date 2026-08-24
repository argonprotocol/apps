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
    vi.spyOn(botClient, 'signBitcoinLockFeeCoupon').mockImplementation(async request => ({
      feeDiscount: request.feeDiscountMicrogons,
      securitizationSpaceToUnreserve: 0n,
      expiresAtFrame: 1_000n,
      nonce: request.feeCouponNonce ?? 1n,
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

    const first = await service.authorizeInitialization(created.coupon.offerCode, {
      requestId: 'lock-1',
      requestedSatoshis: 10_000n,
      feeCreditMicrogons: 400n,
      ownerAccountId: 'member-account',
      ownerBitcoinPubkey: '0x1234',
      microgonsAtTargetPerBtc: 75_000_000n,
    });
    expect(first.status).toMatchObject({
      status: 'Prepared',
      pendingFeeCreditMicrogons: 400n,
      remainingFeeCreditMicrogons: 600n,
    });

    db.bitcoinLockCouponsTable.recordUse(first.use.requestId, { status: 'Finalized' });
    const afterFirst = await service.getByOfferCode(created.coupon.offerCode);
    expect(afterFirst).toMatchObject({
      status: 'Open',
      usedFeeCreditMicrogons: 400n,
      remainingFeeCreditMicrogons: 600n,
    });
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
