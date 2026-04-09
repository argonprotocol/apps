import { MiningFrames } from '@argonprotocol/apps-core';
import { BitcoinLockCoupons } from './BitcoinLockCoupons.ts';
import type { Db } from './Db.ts';
import { RouterError } from './RouterError.ts';
import type { IBitcoinLockCouponRecord } from './db/BitcoinLockCouponsTable.ts';
import type { IUserInviteRecord } from './db/UserInvitesTable.ts';
import type {
  IBitcoinLockRelayJobRequest,
  IBitcoinLockRelayRequest,
  ITreasuryUserMember,
  ITreasuryUserInvite,
  ITreasuryUserInviteCreateRequest,
  ITreasuryUserInviteSummary,
} from './interfaces/index.ts';

const TREASURY_USER_INVITE_TYPE = 'treasury_user' as const;

export class TreasuryInviteService {
  constructor(
    private readonly db: Db,
    private readonly vaultOperatorAddress: string,
  ) {}

  public createInvite(args: ITreasuryUserInviteCreateRequest): ITreasuryUserInvite {
    const name = args.name.trim();
    const inviteCode = args.inviteCode.trim();
    const offerCode = args.offerCode.trim();

    if (args.expiresAfterTicks <= 0) {
      throw new RouterError('Invite expiry must be greater than zero.');
    }
    if (!args.offerToken) {
      throw new RouterError('A frontend-signed bitcoin lock coupon is required.');
    }

    const parsed = this.verifyOfferToken(args.offerToken);
    if (
      parsed.payload.code !== offerCode ||
      parsed.payload.maxSatoshis !== args.maxSatoshis ||
      parsed.payload.expiresAfterTicks !== args.expiresAfterTicks
    ) {
      throw new RouterError('The signed bitcoin lock coupon does not match the invite details.');
    }

    const invite = this.db.userInvitesTable.insertInvite({
      inviteType: TREASURY_USER_INVITE_TYPE,
      name,
      inviteCode,
    });
    const coupon = this.db.bitcoinLockCouponsTable.insertCoupon({
      inviteId: invite.id,
      offerCode,
      offerToken: args.offerToken,
      vaultId: parsed.payload.vaultId,
      maxSatoshis: args.maxSatoshis,
      expiresAfterTicks: args.expiresAfterTicks,
    });

    return toTreasuryInvite(invite, coupon);
  }

  public openInvite(inviteCode: string, accountAddress: string): ITreasuryUserInvite | null {
    const trimmedInviteCode = inviteCode.trim();
    const trimmedAccountAddress = accountAddress.trim();

    if (!trimmedAccountAddress) {
      throw new RouterError('An account address is required.');
    }

    const invite = this.db.userInvitesTable.fetchByCode(trimmedInviteCode, TREASURY_USER_INVITE_TYPE);
    if (!invite) {
      return null;
    }
    if (invite.accountAddress && invite.accountAddress !== trimmedAccountAddress) {
      throw new RouterError('This invite is already claimed by a different account.', 409);
    }

    const openedInvite = this.db.userInvitesTable.openInvite(invite.id, trimmedAccountAddress);
    if (!openedInvite) {
      return null;
    }

    let coupon = this.requireCouponByInviteId(openedInvite.id);
    if (coupon.expirationTick == null) {
      const parsed = this.verifyOfferToken(coupon.offerToken);
      if (parsed.payload.vaultId !== coupon.vaultId) {
        throw new RouterError('The stored bitcoin lock coupon no longer matches this invite.');
      }

      const currentTick = MiningFrames.calculateCurrentTickFromSystemTime();
      const expirationTick = currentTick + coupon.expiresAfterTicks;
      const expiresAt = MiningFrames.getTickDate(expirationTick);

      coupon = this.db.bitcoinLockCouponsTable.setIssuedCoupon(coupon.id, expirationTick, expiresAt) ?? coupon;
    }

    return toTreasuryInvite(openedInvite, coupon);
  }

  public listInvites(): ITreasuryUserInviteSummary[] {
    const invites = this.db.userInvitesTable.fetchByType(TREASURY_USER_INVITE_TYPE);
    const couponsByInviteId = this.db.bitcoinLockCouponsTable.fetchLatestByInviteIds(invites.map(x => x.id));

    return invites.flatMap(invite => {
      const coupon = couponsByInviteId.get(invite.id);
      if (!coupon) return [];

      return [
        {
          id: invite.id,
          name: invite.name,
          inviteCode: invite.inviteCode,
          offerCode: coupon.offerCode,
          maxSatoshis: coupon.maxSatoshis,
          expiresAt: coupon.expiresAt,
          lastClickedAt: invite.lastClickedAt,
        },
      ];
    });
  }

  public listMembers(): ITreasuryUserMember[] {
    const invites = this.db.userInvitesTable.fetchOpenedByType(TREASURY_USER_INVITE_TYPE);
    const couponsByInviteId = this.db.bitcoinLockCouponsTable.fetchLatestByInviteIds(invites.map(x => x.id));

    return invites.flatMap(invite => {
      const coupon = couponsByInviteId.get(invite.id);
      if (!coupon) return [];

      return [
        {
          id: invite.id,
          name: invite.name,
          offerCode: coupon.offerCode,
          maxSatoshis: coupon.maxSatoshis,
          expiresAt: coupon.expiresAt,
          lastClickedAt: invite.lastClickedAt,
        },
      ];
    });
  }

  public createRelayRequest(offerCode: string, request: IBitcoinLockRelayRequest): IBitcoinLockRelayJobRequest {
    const coupon = this.db.bitcoinLockCouponsTable.fetchByOfferCode(offerCode.trim());
    if (!coupon) {
      throw new RouterError('Bitcoin lock coupon not found.', 404);
    }

    const invite = this.db.userInvitesTable.fetchById(coupon.inviteId);
    if (!invite || invite.inviteType !== TREASURY_USER_INVITE_TYPE) {
      throw new RouterError('Invite not found.', 404);
    }
    if (coupon.expirationTick == null) {
      throw new RouterError('This invite has not been accepted yet.');
    }

    const ownerAccountAddress = request.ownerAccountAddress?.trim();
    if (!ownerAccountAddress) {
      throw new RouterError('An owner account address is required for this bitcoin lock.');
    }
    if (!request.ownerBitcoinPubkey?.trim()) {
      throw new RouterError('An owner bitcoin pubkey is required for this bitcoin lock.');
    }
    if (request.requestedSatoshis <= 1000n) {
      throw new RouterError('Requested satoshis must be greater than minimum satoshis.');
    }
    if (request.offerToken !== coupon.offerToken) {
      throw new RouterError(`Offer token mismatch for coupon ${offerCode}.`);
    }
    if (request.microgonsPerBtc == null || request.microgonsPerBtc <= 0n) {
      throw new RouterError('A current bitcoin price quote is required to initialize this bitcoin lock.');
    }
    if (!invite.accountAddress) {
      throw new RouterError('This invite has not been claimed by an account yet.');
    }
    if (ownerAccountAddress !== invite.accountAddress) {
      throw new RouterError('This invite is claimed by a different account.', 409);
    }
    if (request.requestedSatoshis > coupon.maxSatoshis) {
      throw new RouterError('Requested satoshis exceed this offer limit.');
    }

    return {
      offerCode: coupon.offerCode,
      maxSatoshis: coupon.maxSatoshis,
      expirationTick: coupon.expirationTick,
      requestedSatoshis: request.requestedSatoshis,
      ownerAccountAddress,
      ownerBitcoinPubkey: request.ownerBitcoinPubkey.trim(),
      microgonsPerBtc: request.microgonsPerBtc,
    };
  }

  private requireCouponByInviteId(inviteId: number) {
    const coupon = this.db.bitcoinLockCouponsTable.fetchLatestByInviteId(inviteId);
    if (!coupon) {
      throw new RouterError('Invite is missing its bitcoin lock coupon token.');
    }
    return coupon;
  }

  private verifyOfferToken(offerToken: string) {
    try {
      return BitcoinLockCoupons.verifyToken(offerToken, this.vaultOperatorAddress);
    } catch (error) {
      throw new RouterError(error instanceof Error ? error.message : 'Invalid bitcoin lock coupon token.');
    }
  }
}

function toTreasuryInvite(invite: IUserInviteRecord, coupon: IBitcoinLockCouponRecord): ITreasuryUserInvite {
  return {
    id: invite.id,
    name: invite.name,
    inviteCode: invite.inviteCode,
    offerCode: coupon.offerCode,
    vaultId: coupon.vaultId,
    maxSatoshis: coupon.maxSatoshis,
    expiresAfterTicks: coupon.expiresAfterTicks,
    offerToken: coupon.offerToken,
    expirationTick: coupon.expirationTick,
    expiresAt: coupon.expiresAt,
    firstClickedAt: invite.firstClickedAt,
    lastClickedAt: invite.lastClickedAt,
    accountAddress: invite.accountAddress,
    createdAt: invite.createdAt,
  };
}
