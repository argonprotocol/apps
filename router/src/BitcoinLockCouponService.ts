import { existsSync } from 'node:fs';
import { DatabaseSync, type SQLOutputValue } from 'node:sqlite';
import {
  bigIntMax,
  convertFromSqliteFields,
  type ArgonClient,
  MiningFrames,
  type IBitcoinLockCouponRecord,
  type IBitcoinLockCouponStatus,
  type IBitcoinLockCouponUseRecord,
  type IBitcoinLockRelayJobRequest,
  type IBitcoinLockRelayRecord,
  type IBitcoinLockRelayRequest,
  type ICreateBitcoinLockCouponRequest,
  percentOf,
} from '@argonprotocol/apps-core';
import { BitcoinLock, PriceIndex } from '@argonprotocol/mainchain';
import { nanoid } from 'nanoid';
import type { BotUpstreamClient } from './BotUpstreamClient.ts';
import type { Db } from './Db.ts';
import { RouterError } from './RouterError.ts';
import type { IBitcoinLockCouponRow } from './db/BitcoinLockCouponsTable.ts';
import { BITCOIN_FEE_COUPON_MINIMUM_DESKTOP_VERSION } from './interfaces/IRouterApi.ts';

type SqlRow = Record<string, SQLOutputValue>;

export class BitcoinLockCouponService {
  private legacyImportPromise?: Promise<void>;
  private remoteStateRefreshPromise?: Promise<void>;

  private readonly db: Db;
  private readonly botClient: BotUpstreamClient;
  private readonly getMainchainClient: () => Promise<ArgonClient>;
  private readonly legacyBotDbPath?: string;

  constructor(options: {
    db: Db;
    botClient: BotUpstreamClient;
    getMainchainClient: () => Promise<ArgonClient>;
    legacyBotDbPath?: string;
  }) {
    this.db = options.db;
    this.botClient = options.botClient;
    this.getMainchainClient = options.getMainchainClient;
    this.legacyBotDbPath = options.legacyBotDbPath;
  }

  public async reconcile(): Promise<void> {
    await this.ensureLegacyCouponsImported();
    await this.refreshRemoteState();
  }

  public async create(request: ICreateBitcoinLockCouponRequest): Promise<IBitcoinLockCouponStatus> {
    await this.ensureLegacyCouponsImported();

    if (!Number.isFinite(request.estimatedGiftUsd) || request.estimatedGiftUsd < 0) {
      throw new RouterError('Estimated gift USD must be a valid non-negative number.', 400);
    }
    const btcPctFee = request.btcPctFee ?? 0;
    if (!Number.isFinite(btcPctFee) || btcPctFee < 0) {
      throw new RouterError('BTC percent fee must be a valid non-negative number.', 400);
    }
    if (request.feeCreditMicrogons != null && request.feeCreditMicrogons <= 0n) {
      throw new RouterError('Bitcoin fee credit must be positive.', 400);
    }
    if (!Number.isSafeInteger(request.expiresAfterTicks) || request.expiresAfterTicks <= 0) {
      throw new RouterError('Invite expiry must be greater than zero.', 400);
    }

    return this.getStatus(
      this.db.bitcoinLockCouponsTable.insert({
        ...request,
        btcPctFee,
        offerCode: nanoid(10),
      }),
    );
  }

  public async activateLatest(userId: number, accountId: string): Promise<IBitcoinLockCouponStatus> {
    await this.ensureLegacyCouponsImported();

    const coupon = this.db.bitcoinLockCouponsTable.fetchLatestByUserId(userId);
    if (!coupon) throw new RouterError('Bitcoin lock coupon not found.', 404);
    if (coupon.accountId && coupon.accountId !== accountId) {
      throw new RouterError('This invite is already claimed by a different account.', 409);
    }

    const expirationTick =
      coupon.expirationTick ?? MiningFrames.calculateCurrentTickFromSystemTime() + coupon.expiresAfterTicks;
    return this.getStatus(this.db.bitcoinLockCouponsTable.activate(coupon.id, accountId, expirationTick));
  }

  public async restore(coupon: Omit<IBitcoinLockCouponRow, 'id'> & { id?: number }): Promise<IBitcoinLockCouponRow> {
    await this.ensureLegacyCouponsImported();
    return this.db.bitcoinLockCouponsTable.restore(coupon);
  }

  public async getByOfferCode(offerCode: string): Promise<IBitcoinLockCouponStatus> {
    await this.ensureLegacyCouponsImported();

    const coupon = this.db.bitcoinLockCouponsTable.fetchByOfferCode(offerCode);
    if (!coupon) throw new RouterError('Bitcoin lock coupon not found.', 404);
    void this.refreshRemoteState();
    return this.getStatus(coupon);
  }

  public async getByUserId(userId: number): Promise<IBitcoinLockCouponStatus[]> {
    await this.ensureLegacyCouponsImported();
    void this.refreshRemoteState();
    const coupons = this.db.bitcoinLockCouponsTable.fetchByUserId(userId);
    return coupons.map(coupon => this.getStatus(coupon));
  }

  public async getAll(): Promise<IBitcoinLockCouponStatus[]> {
    await this.ensureLegacyCouponsImported();
    void this.refreshRemoteState();
    return this.db.bitcoinLockCouponsTable.fetchAll().map(coupon => this.getStatus(coupon));
  }

  public async getLatestByUserId(): Promise<Map<number, IBitcoinLockCouponStatus>> {
    const coupons = new Map<number, IBitcoinLockCouponStatus>();
    for (const status of await this.getAll()) {
      if (!coupons.has(status.coupon.userId)) coupons.set(status.coupon.userId, status);
    }
    return coupons;
  }

  public async initialize(offerCode: string, request: IBitcoinLockRelayRequest): Promise<IBitcoinLockCouponStatus> {
    await this.ensureLegacyCouponsImported();

    let coupon = this.db.bitcoinLockCouponsTable.fetchByOfferCode(offerCode);
    if (!coupon) throw new RouterError('Bitcoin lock coupon not found.', 404);
    if (!coupon.accountId) throw new RouterError('This invite has not been accepted yet.', 400);
    if (coupon.accountId !== request.ownerAccountId) {
      throw new RouterError('This invite is claimed by a different account.', 409);
    }
    if (request.requestedSatoshis > coupon.maxSatoshis) {
      throw new RouterError('Requested satoshis exceed this offer limit.', 400);
    }
    if (coupon.expirationTick != null && MiningFrames.calculateCurrentTickFromSystemTime() >= coupon.expirationTick) {
      throw new RouterError('This bitcoin lock coupon has expired.', 400);
    }
    const microgonsAtTargetPerBtc = request.microgonsAtTargetPerBtc;
    if (microgonsAtTargetPerBtc == null || microgonsAtTargetPerBtc <= 0n) {
      throw new RouterError('A current bitcoin price quote is required to initialize this bitcoin lock.', 400);
    }
    if (coupon.relay?.status === 'Failed' && coupon.feeCreditMicrogons) {
      throw new RouterError(
        `This failed delegated initialization can be retried with Argon Desktop ${BITCOIN_FEE_COUPON_MINIMUM_DESKTOP_VERSION} or newer. Update Argon Desktop and try again. Your Bitcoin fee waiver remains available.`,
        426,
        'DESKTOP_UPGRADE_REQUIRED',
        BITCOIN_FEE_COUPON_MINIMUM_DESKTOP_VERSION,
      );
    }
    if (coupon.relay) {
      this.assertMatchingRelay(coupon.relay, request);
      return this.getStatus(coupon);
    }

    const client = await this.getMainchainClient();
    if (!BitcoinLock.supportsInitializeFor(client)) {
      throw new RouterError(
        `This upstream requires Argon Desktop ${BITCOIN_FEE_COUPON_MINIMUM_DESKTOP_VERSION} or newer to initialize a Bitcoin lock on the current network. Update Argon Desktop and try again. Your Bitcoin fee gift remains available.`,
        426,
        'DESKTOP_UPGRADE_REQUIRED',
        BITCOIN_FEE_COUPON_MINIMUM_DESKTOP_VERSION,
      );
    }
    if (this.db.bitcoinLockCouponsTable.fetchUsesByCouponId(coupon.id).some(use => use.status !== 'Failed')) {
      throw new RouterError('This Bitcoin gift is already being used through fee coupons.', 409);
    }

    coupon = this.db.bitcoinLockCouponsTable.assignRelayRequest(coupon.id, coupon.relayRequestId ?? nanoid());
    const relayRequest: IBitcoinLockRelayJobRequest = {
      ...request,
      requestId: coupon.relayRequestId!,
      vaultId: coupon.vaultId,
      microgonsAtTargetPerBtc,
    };
    const relay = await this.botClient.initializeBitcoinLock(relayRequest);
    return this.getStatus(this.db.bitcoinLockCouponsTable.recordRelay(coupon.id, relay));
  }

  public async authorizeInitialization(
    offerCode: string,
    request: IBitcoinLockRelayRequest,
  ): Promise<{ status: IBitcoinLockCouponStatus; use: IBitcoinLockCouponUseRecord }> {
    await this.ensureLegacyCouponsImported();

    const coupon = this.db.bitcoinLockCouponsTable.fetchByOfferCode(offerCode);
    if (!coupon) throw new RouterError('Bitcoin lock coupon not found.', 404);
    if (!coupon.accountId) throw new RouterError('This invite has not been accepted yet.', 400);
    if (coupon.accountId !== request.ownerAccountId) {
      throw new RouterError('This invite is claimed by a different account.', 409);
    }
    if (coupon.expirationTick != null && MiningFrames.calculateCurrentTickFromSystemTime() >= coupon.expirationTick) {
      throw new RouterError('This bitcoin lock coupon has expired.', 400);
    }
    const microgonsAtTargetPerBtc = request.microgonsAtTargetPerBtc;
    if (microgonsAtTargetPerBtc == null || microgonsAtTargetPerBtc <= 0n) {
      throw new RouterError('A current bitcoin price quote is required to initialize this bitcoin lock.', 400);
    }
    if (coupon.relay && coupon.relay.status !== 'Failed') {
      throw new RouterError('This older Bitcoin gift is already being used through delegated initialization.', 409);
    }
    if (!coupon.feeCreditMicrogons) {
      throw new RouterError('This older Bitcoin gift must use delegated initialization.', 409);
    }
    const feeCreditMicrogons = request.feeCreditMicrogons;
    if (!feeCreditMicrogons || feeCreditMicrogons <= 0n) {
      throw new RouterError('A positive Bitcoin fee credit amount is required.', 400);
    }

    await this.refreshRemoteState();

    const currentCoupon = this.db.bitcoinLockCouponsTable.fetchById(coupon.id);
    if (!currentCoupon) throw new RouterError('Bitcoin lock coupon not found.', 404);
    if (
      currentCoupon.expirationTick != null &&
      MiningFrames.calculateCurrentTickFromSystemTime() >= currentCoupon.expirationTick
    ) {
      throw new RouterError('This bitcoin lock coupon has expired.', 400);
    }

    let use: IBitcoinLockCouponUseRecord;
    if (request.feeCouponNonce != null) {
      const recoveredUse = this.db.bitcoinLockCouponsTable
        .fetchNonTerminalUses(coupon.id)
        .find(candidate => candidate.feeCoupon?.nonce === request.feeCouponNonce);
      if (!recoveredUse) throw new RouterError('This Bitcoin fee coupon nonce is no longer available.', 409);
      use = recoveredUse;
    } else {
      const requestId = request.requestId;
      if (!requestId) throw new RouterError('A Bitcoin lock request id is required.', 400);
      use = this.db.bitcoinLockCouponsTable.insertUse({
        couponId: coupon.id,
        requestId,
        feeCreditMicrogons,
        requestedSatoshis: request.requestedSatoshis,
        ownerAccountId: request.ownerAccountId,
        ownerBitcoinPubkey: request.ownerBitcoinPubkey,
        microgonsAtTargetPerBtc,
      });
    }
    if (use.couponId !== coupon.id || use.ownerAccountId !== request.ownerAccountId) {
      throw new RouterError('This Bitcoin fee credit request conflicts with an existing use.', 409);
    }
    if (use.status === 'Failed') {
      throw new RouterError('This Bitcoin fee credit request already failed. Start a new Bitcoin lock request.', 409);
    }
    if (use.status !== 'Prepared') {
      throw new RouterError('This Bitcoin lock initialization can no longer be changed.', 409);
    }
    const authorizationChanged =
      use.requestedSatoshis !== request.requestedSatoshis ||
      use.microgonsAtTargetPerBtc !== microgonsAtTargetPerBtc ||
      use.feeCoupon?.feeDiscount !== feeCreditMicrogons;
    if (!use.feeCoupon || authorizationChanged) {
      const hadSignedCoupon = !!use.feeCoupon;
      try {
        const currentTick = MiningFrames.calculateCurrentTickFromSystemTime();
        const expiresAfterTicks =
          currentCoupon.expirationTick != null
            ? currentCoupon.expirationTick - currentTick
            : currentCoupon.expiresAfterTicks;
        if (expiresAfterTicks <= 0) throw new RouterError('This bitcoin lock coupon has expired.', 400);

        const feeCoupon = await this.botClient.signBitcoinLockFeeCoupon({
          vaultId: coupon.vaultId,
          beneficiary: request.ownerAccountId,
          feeCouponNonce: use.feeCoupon?.nonce,
          requestedSatoshis: request.requestedSatoshis,
          microgonsAtTargetPerBtc,
          feeDiscountMicrogons: feeCreditMicrogons,
          expiresAfterTicks,
        });
        use = this.db.bitcoinLockCouponsTable.recordInitializationAuthorization(use.requestId, {
          feeCreditMicrogons,
          requestedSatoshis: request.requestedSatoshis,
          microgonsAtTargetPerBtc,
          feeCoupon,
        });
      } catch (error) {
        if (!hadSignedCoupon) this.db.bitcoinLockCouponsTable.recordUse(use.requestId, { status: 'Failed' });
        throw error;
      }
    }

    return { status: this.getStatus(coupon), use };
  }

  public async reportFeeCouponUse(requestId: string, accountId: string): Promise<IBitcoinLockCouponStatus> {
    const use = this.db.bitcoinLockCouponsTable.fetchUseByRequestId(requestId);
    if (!use || use.ownerAccountId !== accountId) {
      throw new RouterError('Bitcoin fee credit use not found.', 404);
    }

    await this.refreshFeeCouponUses(use.couponId);
    const coupon = this.db.bitcoinLockCouponsTable.fetchById(use.couponId);
    if (!coupon) throw new RouterError('Bitcoin lock coupon not found.', 404);
    return this.getStatus(coupon);
  }

  public async updateExpiration(offerCode: string, expiresAfterTicks: number): Promise<IBitcoinLockCouponStatus> {
    await this.ensureLegacyCouponsImported();
    if (!Number.isSafeInteger(expiresAfterTicks) || expiresAfterTicks < 0) {
      throw new RouterError('A non-negative coupon expiration is required.', 400);
    }

    const coupon = this.db.bitcoinLockCouponsTable.fetchByOfferCode(offerCode);
    if (!coupon) throw new RouterError('Bitcoin lock coupon not found.', 404);
    if (this.getStatus(coupon).status === 'Used') {
      throw new RouterError('A fully used Bitcoin fee credit cannot be extended.', 409);
    }
    const currentTick = MiningFrames.calculateCurrentTickFromSystemTime();
    const expirationTick = currentTick + expiresAfterTicks;
    const updatedCoupon = this.db.bitcoinLockCouponsTable.updateExpiration(coupon.id, expirationTick);
    if (expiresAfterTicks === 0) {
      for (const use of this.db.bitcoinLockCouponsTable.fetchNonTerminalUses(coupon.id)) {
        if (use.status === 'Prepared' && !use.feeCoupon) {
          this.db.bitcoinLockCouponsTable.recordUse(use.requestId, { status: 'Failed' });
        }
      }
    }
    return this.getStatus(updatedCoupon);
  }

  private getStatus(coupon: IBitcoinLockCouponRow): IBitcoinLockCouponStatus {
    const uses = this.db.bitcoinLockCouponsTable.fetchUsesByCouponId(coupon.id);
    const originalFeeCreditMicrogons = coupon.feeCreditMicrogons;
    let usedFeeCreditMicrogons = uses
      .filter(use => use.status === 'Finalized')
      .reduce((total, use) => total + use.feeCreditMicrogons, 0n);
    const activeUses = uses.filter(
      use => use.status === 'Prepared' || use.status === 'Submitted' || use.status === 'InBlock',
    );
    let pendingFeeCreditMicrogons = activeUses.reduce((total, use) => total + use.feeCreditMicrogons, 0n);

    if (originalFeeCreditMicrogons != null && coupon.relay?.status === 'Finalized') {
      usedFeeCreditMicrogons = originalFeeCreditMicrogons;
    } else if (
      originalFeeCreditMicrogons != null &&
      (coupon.relay?.status === 'Submitted' || coupon.relay?.status === 'InBlock')
    ) {
      pendingFeeCreditMicrogons = originalFeeCreditMicrogons;
    }

    const activeUse = activeUses[0];
    const remainingFeeCreditMicrogons =
      originalFeeCreditMicrogons == null
        ? undefined
        : bigIntMax(originalFeeCreditMicrogons - usedFeeCreditMicrogons - pendingFeeCreditMicrogons, 0n);

    let status: IBitcoinLockCouponStatus['status'] = 'Open';
    if (coupon.relay?.status === 'Finalized') {
      status = 'Used';
    } else if (coupon.relay?.status === 'Failed' && originalFeeCreditMicrogons == null) {
      status = 'Failed';
    } else if (coupon.relay?.status === 'Submitted' || coupon.relay?.status === 'InBlock') {
      status = coupon.relay.status;
    } else if (activeUse) {
      status = activeUse.status;
    } else if (originalFeeCreditMicrogons != null && usedFeeCreditMicrogons >= originalFeeCreditMicrogons) {
      status = 'Used';
    } else if (
      coupon.expirationTick != null &&
      MiningFrames.calculateCurrentTickFromSystemTime() >= coupon.expirationTick
    ) {
      status = 'Expired';
    }

    const { relayRequestId: _relayRequestId, relay, ...publicCoupon } = coupon;
    return {
      coupon: publicCoupon,
      relay,
      ...(uses.length ? { uses } : {}),
      ...(originalFeeCreditMicrogons != null
        ? {
            originalFeeCreditMicrogons,
            usedFeeCreditMicrogons,
            pendingFeeCreditMicrogons,
            remainingFeeCreditMicrogons,
          }
        : {}),
      status,
      ...(coupon.expirationTick != null ? { expiresAt: MiningFrames.getTickDate(coupon.expirationTick) } : {}),
    };
  }

  private async refreshRelays(): Promise<void> {
    const couponsByRequestId = new Map(
      this.db.bitcoinLockCouponsTable
        .fetchAll()
        .flatMap(coupon => (coupon.relayRequestId ? [[coupon.relayRequestId, coupon] as const] : [])),
    );
    if (!couponsByRequestId.size) return;

    let relays: IBitcoinLockRelayRecord[];
    try {
      relays = await this.botClient.listBitcoinLockRelays();
    } catch {
      return;
    }

    for (const relay of relays) {
      const coupon = couponsByRequestId.get(relay.requestId);
      if (coupon) this.db.bitcoinLockCouponsTable.recordRelay(coupon.id, relay);
    }
  }

  private async refreshFeeCouponUses(couponId?: number): Promise<void> {
    const uses = this.db.bitcoinLockCouponsTable.fetchNonTerminalUses(couponId).filter(use => use.feeCoupon);
    if (!uses.length) return;

    try {
      const client = await this.getMainchainClient();
      const finalizedClient = await client.at(await client.rpc.chain.getFinalizedHead());

      for (const use of uses) {
        const feeCoupon = use.feeCoupon;
        if (!feeCoupon) continue;
        const coupon = this.db.bitcoinLockCouponsTable.fetchById(use.couponId);
        if (!coupon) continue;

        try {
          const [lastNonce, nextFrameId] = await Promise.all([
            finalizedClient.query.bitcoinLocks.lastFeeCouponNonceByVaultAndAccount(coupon.vaultId, use.ownerAccountId),
            finalizedClient.query.miningSlot.nextFrameId(),
          ]);
          const consumedNonce = lastNonce.isSome ? lastNonce.unwrap().toBigInt() : 0n;
          const currentFrameId = nextFrameId.toBigInt() - 1n;

          if (consumedNonce >= feeCoupon.nonce) {
            this.db.bitcoinLockCouponsTable.recordUse(use.requestId, { status: 'Finalized' });
          } else if (currentFrameId > feeCoupon.expiresAtFrame) {
            this.db.bitcoinLockCouponsTable.recordUse(use.requestId, { status: 'Failed' });
          }
        } catch {
          // Other signed uses can still reconcile if one query is temporarily unavailable.
        }
      }
    } catch {
      // Durable coupon status remains readable while mainchain is temporarily unavailable.
    }
  }

  private refreshRemoteState(): Promise<void> {
    this.remoteStateRefreshPromise ??= Promise.all([
      this.refreshRelays(),
      this.refreshFeeCouponUses(),
      this.backfillLegacyFeeCredits(),
    ])
      .then(() => undefined)
      .finally(() => {
        this.remoteStateRefreshPromise = undefined;
      });
    return this.remoteStateRefreshPromise;
  }

  private async backfillLegacyFeeCredits(): Promise<void> {
    const coupons = this.db.bitcoinLockCouponsTable.fetchAll().filter(coupon => coupon.feeCreditMicrogons == null);
    if (!coupons.length) return;

    let client: ArgonClient;
    try {
      client = await this.getMainchainClient();
    } catch {
      // The legacy coupon remains readable and can be upgraded on a later client poll.
      return;
    }

    const unusedCoupons = coupons.filter(coupon => {
      return (!coupon.relayRequestId && !coupon.relay) || coupon.relay?.status === 'Failed';
    });
    if (unusedCoupons.length) {
      try {
        const priceIndex = await new PriceIndex().load(client);
        for (const coupon of unusedCoupons) {
          const maximumLockValue = BitcoinLock.calculateRedemptionAmountFromSatoshis(priceIndex, coupon.maxSatoshis);
          const feeCreditMicrogons = percentOf(maximumLockValue, coupon.btcPctFee, true);
          this.db.bitcoinLockCouponsTable.setFeeCredit(coupon.id, feeCreditMicrogons);
        }
      } catch {
        // Unused legacy coupons can be upgraded from a later price index.
      }
    }

    for (const coupon of coupons) {
      const relay = coupon.relay;
      if (relay?.status !== 'Finalized' || relay.utxoId == null || !relay.txInBlockHash) continue;

      try {
        const historicalClient = await client.at(relay.txInBlockHash);
        const lock = await BitcoinLock.get(historicalClient, relay.utxoId);
        if (lock) this.db.bitcoinLockCouponsTable.setFeeCredit(coupon.id, lock.couponFeesPaid);
      } catch {
        // A finalized coupon can retry its archived lock read on a later client poll.
      }
    }
  }

  private async ensureLegacyCouponsImported(): Promise<void> {
    this.legacyImportPromise ??= Promise.resolve().then(() => {
      this.importLegacyCoupons();
      this.db.bitcoinLockCouponsTable.failUnsignedPreparedUses();
    });
    try {
      await this.legacyImportPromise;
    } catch (error) {
      this.legacyImportPromise = undefined;
      console.warn('[router] Unable to import legacy Bitcoin lock coupons.', error);
      throw error;
    }
  }

  private importLegacyCoupons(): void {
    if (!this.legacyBotDbPath || !existsSync(this.legacyBotDbPath)) return;

    const legacyDb = new DatabaseSync(this.legacyBotDbPath, { readOnly: true });
    try {
      const hasTable = (name: string) => {
        return !!legacyDb.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1").get(name);
      };
      if (!hasTable('BitcoinLockCoupons')) return;

      const relaysByCouponId = new Map<number, IBitcoinLockRelayRecord>();
      if (hasTable('BitcoinLockRelays')) {
        const relayRows = legacyDb.prepare('SELECT * FROM BitcoinLockRelays ORDER BY id ASC').all() as SqlRow[];
        for (const row of relayRows) {
          // Upgraded bot databases keep this one field only so the router can import their historical coupon relay.
          const couponId = row.legacyCouponId ?? row.couponId;
          if (couponId == null) continue;
          const relay = convertFromSqliteFields<IBitcoinLockRelayRecord>(
            {
              ...row,
              requestId: row.requestId?.toString() ?? `legacy-${String(row.id)}`,
              microgonsAtTargetPerBtc: row.microgonsAtTargetPerBtc ?? row.microgonsPerBtc,
            },
            {
              bigint: [
                'requestedSatoshis',
                'securitizationUsedMicrogons',
                'microgonsAtTargetPerBtc',
                'txFeePlusTip',
                'txTip',
              ],
              json: ['extrinsicMethodJson'],
              date: ['txSubmittedAtTime', 'createdAt', 'updatedAt'],
            },
          );
          relaysByCouponId.set(Number(couponId), relay);
        }
      }

      const couponRows = legacyDb.prepare('SELECT * FROM BitcoinLockCoupons ORDER BY id ASC').all() as SqlRow[];
      for (const row of couponRows) {
        const userId = Number(row.userId);
        if (!this.db.userInvitesTable.fetchById(userId)) continue;

        const relay = relaysByCouponId.get(Number(row.id));
        const coupon = convertFromSqliteFields<IBitcoinLockCouponRecord>(
          {
            ...row,
            sequence: row.sequence ?? 1,
            estimatedGiftUsd: row.estimatedGiftUsd ?? 0,
            btcPctFee: row.btcPctFee ?? 0,
          },
          {
            bigint: ['maxSatoshis'],
            date: ['createdAt', 'updatedAt'],
          },
        );
        this.db.bitcoinLockCouponsTable.restore({
          ...coupon,
          relayRequestId: relay?.requestId,
          relay,
        });
      }
    } finally {
      legacyDb.close();
    }
  }

  private assertMatchingRelay(relay: IBitcoinLockRelayRecord, request: IBitcoinLockRelayRequest): void {
    if (
      relay.requestedSatoshis !== request.requestedSatoshis ||
      relay.ownerAccountId !== request.ownerAccountId ||
      relay.ownerBitcoinPubkey !== request.ownerBitcoinPubkey ||
      relay.microgonsAtTargetPerBtc !== request.microgonsAtTargetPerBtc
    ) {
      throw new RouterError('This invite already has a different relay request in progress.', 409);
    }
  }
}
