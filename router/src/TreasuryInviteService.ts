import { MiningFrames } from '@argonprotocol/apps-core';
import { BitcoinLockCoupons } from './BitcoinLockCoupons.ts';
import type { Db } from './Db.ts';
import { RouterError } from './RouterError.ts';
import type { ITreasuryUserInviteCreate } from './db/TreasuryUserInvitesTable.ts';
import type { IBitcoinLockRelayJobRequest, IBitcoinLockRelayRequest } from './interfaces/index.ts';

export class TreasuryInviteService {
  constructor(
    private readonly db: Db,
    private readonly vaultOperatorAddress: string,
  ) {}

  public async createInvite(args: ITreasuryUserInviteCreate) {
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

    return this.db.treasuryUserInvitesTable.insertInvite({
      ...args,
      name,
      inviteCode,
      offerCode,
      vaultId: parsed.payload.vaultId,
    });
  }

  public async openInvite(inviteCode: string, accountAddress: string) {
    const trimmedInviteCode = inviteCode.trim();
    const trimmedAccountAddress = accountAddress.trim();

    if (!trimmedAccountAddress) {
      throw new RouterError('An account address is required.');
    }

    const invite = this.db.treasuryUserInvitesTable.fetchInviteByCode(trimmedInviteCode);
    if (!invite) {
      return null;
    }
    if (invite.accountAddress && invite.accountAddress !== trimmedAccountAddress) {
      throw new RouterError('This invite is already claimed by a different account.', 409);
    }

    const openedInvite = this.db.treasuryUserInvitesTable.openInvite(invite.id, trimmedAccountAddress);
    if (!openedInvite) {
      return null;
    }

    if (!openedInvite.offerToken) {
      throw new RouterError('Invite is missing its bitcoin lock coupon token.');
    }
    if (openedInvite.expirationTick) {
      return openedInvite;
    }

    const parsed = this.verifyOfferToken(openedInvite.offerToken);
    if (parsed.payload.vaultId !== openedInvite.vaultId) {
      throw new RouterError('The stored bitcoin lock coupon no longer matches this invite.');
    }

    const currentTick = MiningFrames.calculateCurrentTickFromSystemTime();
    const expirationTick = currentTick + openedInvite.expiresAfterTicks;
    const expiresAt = MiningFrames.getTickDate(expirationTick);

    return this.db.treasuryUserInvitesTable.setIssuedOffer({
      id: openedInvite.id,
      offerToken: openedInvite.offerToken,
      expirationTick,
      expiresAt,
    });
  }

  public async createRelayRequest(
    inviteCode: string,
    request: IBitcoinLockRelayRequest,
  ): Promise<IBitcoinLockRelayJobRequest> {
    const invite = this.db.treasuryUserInvitesTable.fetchInviteByCode(inviteCode);
    if (!invite) {
      throw new RouterError('Invite not found.', 404);
    }
    if (!invite.offerToken || invite.expirationTick == null) {
      throw new RouterError('This invite has not been accepted yet.');
    }
    const ownerAccountAddress = request.ownerAccountAddress?.trim();
    if (!ownerAccountAddress) {
      throw new RouterError('An owner account address is required for this bitcoin lock.');
    }
    if (!request.ownerBitcoinPubkey?.trim()) {
      throw new RouterError('An owner bitcoin pubkey is required for this bitcoin lock.');
    }
    if (request.requestedSatoshis <= 0n) {
      throw new RouterError('Requested satoshis must be greater than zero.');
    }
    if (request.offerToken !== invite.offerToken) {
      throw new RouterError(`Offer token mismatch for invite ${inviteCode}.`);
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

    const parsed = this.verifyOfferToken(invite.offerToken);
    if (
      parsed.payload.vaultId !== invite.vaultId ||
      parsed.payload.code !== invite.offerCode ||
      parsed.payload.maxSatoshis !== invite.maxSatoshis ||
      parsed.payload.expiresAfterTicks !== invite.expiresAfterTicks
    ) {
      throw new RouterError('The stored bitcoin lock coupon no longer matches this invite.');
    }
    if (request.requestedSatoshis > parsed.payload.maxSatoshis) {
      throw new RouterError('Requested satoshis exceed this offer limit.');
    }

    return {
      routerInviteId: invite.id,
      offerCode: invite.offerCode,
      maxSatoshis: invite.maxSatoshis,
      expirationTick: invite.expirationTick,
      requestedSatoshis: request.requestedSatoshis,
      ownerAccountAddress,
      ownerBitcoinPubkey: request.ownerBitcoinPubkey.trim(),
      microgonsPerBtc: request.microgonsPerBtc,
    };
  }

  private verifyOfferToken(offerToken: string) {
    try {
      return BitcoinLockCoupons.verifyToken(offerToken, this.vaultOperatorAddress);
    } catch (error) {
      throw new RouterError(error instanceof Error ? error.message : 'Invalid bitcoin lock coupon token.');
    }
  }
}
