import { nanoid } from 'nanoid';
import {
  UserRole,
  type IOperationalAccessProof,
  type IRouterAuthAccountBinding,
  verifyOperationalAccessProof,
  verifyRouterAuthAccountBinding,
} from '@argonprotocol/apps-core';
import type { ArgonClient } from '@argonprotocol/mainchain';
import type { Db } from './Db.ts';
import { RouterError } from './RouterError.ts';
import type { IUserInviteRecord } from './db/UserInvitesTable.ts';

export interface IUserInviteServiceOptions {
  createInviteCode?: () => string;
}

const MAX_INVITE_CODE_ATTEMPTS = 5;

export class UserInviteService {
  private readonly createInviteCode: () => string;

  constructor(
    private readonly db: Db,
    options: IUserInviteServiceOptions = {},
  ) {
    this.createInviteCode = options.createInviteCode ?? (() => nanoid(10));
  }

  public createInvite(args: { name: string; fromName: string }): IUserInviteRecord {
    const name = args.name.trim();
    const fromName = args.fromName.trim();

    if (!name) {
      throw new RouterError('A name is required to create an invite.');
    }
    if (!fromName) {
      throw new RouterError('A sender name is required to create an invite.');
    }

    return this.db.transaction(() => {
      const inviteCode = this.createUniqueInviteCode();
      const user = this.db.usersTable.insertUser({
        role: UserRole.Member,
        name,
      });

      return this.db.userInvitesTable.insertInvite(user.id, inviteCode, fromName);
    });
  }

  public async regenerateInvite<TCoupon>(args: {
    inviteCode: string;
    createReplacementCoupon: (invite: IUserInviteRecord) => Promise<TCoupon>;
  }): Promise<{ invite: IUserInviteRecord; coupon: TCoupon }> {
    const inviteCode = args.inviteCode.trim();
    const previousInvite = this.db.userInvitesTable.fetchByCode(inviteCode, UserRole.Member);
    if (!previousInvite) {
      throw new RouterError('Invite not found', 404);
    }
    if (previousInvite.defaultAccountId || previousInvite.firstClickedAt) {
      throw new RouterError('Claimed invites cannot be regenerated.', 409);
    }

    const replacementInviteCode = this.createUniqueInviteCode();
    const coupon = await args.createReplacementCoupon(previousInvite);
    const invite = this.db.transaction(() => {
      const replacementInvite = this.db.userInvitesTable.replaceInviteCode({
        id: previousInvite.id,
        currentInviteCode: previousInvite.inviteCode,
        replacementInviteCode,
      });
      if (!replacementInvite) {
        throw new RouterError('This invite can no longer be regenerated.', 409);
      }

      return replacementInvite;
    });

    return { invite, coupon };
  }

  public claimInvite(args: {
    inviteCode: string;
    defaultAccountId: string;
    authBinding: IRouterAuthAccountBinding;
    authBindingSignature: string;
  }): IUserInviteRecord | null {
    const { authBinding } = args;
    const inviteCode = args.inviteCode.trim();
    const defaultAccountId = args.defaultAccountId.trim();
    const authAccountId = authBinding.authAccountId.trim();
    const authBindingSignature = args.authBindingSignature.trim();

    if (!inviteCode) {
      throw new RouterError('An invite code is required.');
    }
    if (!defaultAccountId) {
      throw new RouterError('A default account id is required.');
    }
    if (!authAccountId) {
      throw new RouterError('An auth account id is required.');
    }
    if (!authBindingSignature) {
      throw new RouterError('An auth binding signature is required.');
    }
    if (authBinding.expiresAt <= Date.now()) {
      throw new RouterError('The auth binding signature has expired.', 403);
    }
    if (
      authBinding.inviteCode !== inviteCode ||
      authBinding.accountId !== defaultAccountId ||
      authBinding.authAccountId !== authAccountId
    ) {
      throw new RouterError('The auth binding does not match this invite.', 403);
    }

    const invite = this.db.userInvitesTable.fetchByCode(inviteCode, UserRole.Member);
    if (!invite) {
      return null;
    }
    if (!verifyRouterAuthAccountBinding(authBinding, authBindingSignature)) {
      throw new RouterError('The auth binding signature is invalid.', 403);
    }
    if (invite.defaultAccountId && invite.defaultAccountId !== defaultAccountId) {
      throw new RouterError('This invite is already claimed by a different account.', 409);
    }

    const accountUser = this.db.usersTable.fetchByAccountId(defaultAccountId, UserRole.Member);
    if (accountUser && accountUser.id !== invite.id) {
      throw new RouterError('This account is already linked to a different invite.', 409);
    }

    const authUser = this.db.usersTable.fetchByAuthAccountId(authAccountId, UserRole.Member);
    if (authUser && authUser.id !== invite.id) {
      throw new RouterError('This auth account is already linked to a different invite.', 409);
    }

    return this.db.userInvitesTable.claimInvite(invite.id, defaultAccountId, authAccountId);
  }

  public requestOperationsUpgrade(args: {
    defaultAccountId: string;
    authBinding: IRouterAuthAccountBinding;
    authBindingSignature: string;
  }): IUserInviteRecord {
    const { authBinding } = args;
    const defaultAccountId = args.defaultAccountId.trim();
    const operationalAccountId = authBinding.operationalAccountId?.trim();
    const authAccountId = authBinding.authAccountId.trim();
    const authBindingSignature = args.authBindingSignature.trim();

    if (!defaultAccountId) {
      throw new RouterError('A default account id is required.');
    }
    if (!operationalAccountId) {
      throw new RouterError('An operational account id is required.');
    }
    if (!authAccountId) {
      throw new RouterError('An auth account id is required.');
    }
    if (!authBindingSignature) {
      throw new RouterError('An auth binding signature is required.');
    }
    if (authBinding.expiresAt <= Date.now()) {
      throw new RouterError('The auth binding signature has expired.', 403);
    }

    const invite = this.db.userInvitesTable.fetchByDefaultAccountId(defaultAccountId, UserRole.Member);
    if (!invite) {
      throw new RouterError('Invite not found', 404);
    }
    if (
      authBinding.accountId !== defaultAccountId ||
      authBinding.authAccountId !== invite.authAccountId
    ) {
      throw new RouterError('The auth binding does not match this invite.', 403);
    }
    if (!verifyRouterAuthAccountBinding(authBinding, authBindingSignature)) {
      throw new RouterError('The auth binding signature is invalid.', 403);
    }
    if (invite.operationsUpgradedAt) {
      return invite;
    }
    if (invite.operationalAccountId && invite.operationalAccountId !== operationalAccountId) {
      throw new RouterError('This operational account is already linked to a different invite.', 409);
    }

    try {
      return this.db.transaction(() => {
        this.db.usersTable.setOperationalAccountId(invite.id, operationalAccountId);
        const requestedInvite = this.db.userInvitesTable.requestOperationsUpgrade(invite.id);
        if (!requestedInvite) {
          throw new RouterError('Invite not found', 404);
        }

        return requestedInvite;
      });
    } catch (error) {
      if (error instanceof Error && error.message.includes('UNIQUE constraint failed: Users.operationalAccountId')) {
        const requestedInvite = this.db.userInvitesTable.fetchById(invite.id);
        if (
          requestedInvite?.defaultAccountId === defaultAccountId &&
          requestedInvite.operationalAccountId === operationalAccountId
        ) {
          return requestedInvite;
        }

        throw new RouterError('This operational account is already linked to a different invite.', 409);
      }

      throw error;
    }
  }

  public markOperationsUpgraded(args: {
    inviteCode: string;
    accessProof: IOperationalAccessProof;
    accessCodeCapacity: {
      availableAccessCodes: number;
      registeredOperationalAccountIds: Set<string>;
    };
  }): IUserInviteRecord | null {
    const { accessProof, accessCodeCapacity } = args;
    const trimmedInviteCode = args.inviteCode.trim();
    if (!trimmedInviteCode) {
      throw new RouterError('An invite code is required.');
    }
    if (!accessProof.upstreamAccount.trim()) {
      throw new RouterError('An upstream account is required.');
    }
    if (!accessProof.signature.trim()) {
      throw new RouterError('An access proof signature is required.');
    }

    return this.db.transaction(() => {
      const invite = this.db.userInvitesTable.fetchByCode(trimmedInviteCode, UserRole.Member);
      if (!invite) {
        return invite;
      }
      if (!invite.operationsUpgradeRequestedAt || !invite.operationalAccountId) {
        throw new RouterError('This invite has not requested an operations upgrade.', 409);
      }
      if (
        invite.operationsAccessProofSignature &&
        invite.operationsAccessProofSignature !== accessProof.signature.trim()
      ) {
        throw new RouterError('This invite already has a different operations access proof.', 409);
      }
      if (!verifyOperationalAccessProof(accessProof, invite.operationalAccountId)) {
        throw new RouterError('The operations access proof signature is invalid.', 403);
      }
      if (invite.operationsUpgradedAt) {
        return invite;
      }

      const outstandingAccessProofCount = this.db.userInvitesTable.fetchByRole(UserRole.Member).filter(member => {
        return (
          !!member.operationsAccessProofSignature &&
          !!member.operationalAccountId &&
          !accessCodeCapacity.registeredOperationalAccountIds.has(member.operationalAccountId)
        );
      }).length;
      if (outstandingAccessProofCount >= accessCodeCapacity.availableAccessCodes) {
        throw new RouterError('No operations access codes are available.', 409);
      }

      return this.db.userInvitesTable.markOperationsUpgraded(invite.id, accessProof.signature.trim());
    });
  }

  public reassignOperationsUpgradeCode(args: {
    inviteCode: string;
    isOperationalAccountRegistered: boolean;
  }): IUserInviteRecord | null {
    const inviteCode = args.inviteCode.trim();
    if (!inviteCode) {
      throw new RouterError('An invite code is required.');
    }

    return this.db.transaction(() => {
      const invite = this.db.userInvitesTable.fetchByCode(inviteCode, UserRole.Member);
      if (!invite) {
        return invite;
      }
      if (args.isOperationalAccountRegistered) {
        throw new RouterError('An operations upgrade code cannot be reassigned after the account is registered.', 409);
      }

      return this.db.userInvitesTable.reassignOperationsUpgradeCode(invite.id);
    });
  }

  public getInviteAccessProof(
    invite: IUserInviteRecord,
    upstreamAccountId?: string,
  ): IOperationalAccessProof | undefined {
    if (!upstreamAccountId || !invite.operationsAccessProofSignature) {
      return;
    }

    return {
      upstreamAccount: upstreamAccountId,
      signature: invite.operationsAccessProofSignature,
    };
  }

  public deleteInvitedUser(userId: number): void {
    this.db.transaction(() => {
      this.db.userInvitesTable.deleteByUserId(userId);
      this.db.usersTable.deleteById(userId);
    });
  }

  public async migrateMissingOperationalAccountIds(client: ArgonClient): Promise<void> {
    const invites = this.db.userInvitesTable.fetchByRole(UserRole.Member);
    const invitesMissingOperationalAccountId = invites.filter(invite => !invite.operationalAccountId && invite.defaultAccountId);
    if (!invitesMissingOperationalAccountId.length) {
      return;
    }

    try {
      const operationalAccounts = await client.query.operationalAccounts.operationalAccountBySubAccount.multi(
        invitesMissingOperationalAccountId.map(invite => invite.defaultAccountId!),
      );

      invitesMissingOperationalAccountId.forEach((invite, index) => {
        const operationalAccountId = operationalAccounts[index];
        if (!operationalAccountId?.isSome) {
          return;
        }

        this.db.usersTable.setOperationalAccountId(invite.id, operationalAccountId.unwrap().toString());
      });
    } catch (error) {
      console.warn('[router] Unable to heal missing operational account ids.', error);
    }
  }

  private createUniqueInviteCode(): string {
    for (let attempt = 0; attempt < MAX_INVITE_CODE_ATTEMPTS; attempt += 1) {
      const inviteCode = this.createInviteCode().trim();
      if (inviteCode && !this.db.userInvitesTable.fetchByCode(inviteCode)) {
        return inviteCode;
      }
    }

    throw new RouterError('Unable to generate a unique invite code.', 500);
  }
}
