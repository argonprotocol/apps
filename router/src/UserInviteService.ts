import { InviteCodes, type IRouterAuthAccountBinding, verifyRouterAuthAccountBinding } from '@argonprotocol/apps-core';
import type { Db } from './Db.ts';
import { RouterError } from './RouterError.ts';
import type { IUserInviteRecord } from './db/UserInvitesTable.ts';
import type { Role } from './db/UsersTable.ts';

export class UserInviteService {
  constructor(private readonly db: Db) {}

  public createInvite(role: Role, args: { name: string; fromName: string; inviteCode: string }): IUserInviteRecord {
    const name = args.name.trim();
    const fromName = args.fromName.trim();
    const inviteCode = args.inviteCode.trim();

    if (!name) {
      throw new RouterError('A name is required to create an invite.');
    }
    if (!fromName) {
      throw new RouterError('A sender name is required to create an invite.');
    }
    if (!inviteCode) {
      throw new RouterError('An invite code is required.');
    }

    return this.db.transaction(() => {
      if (this.db.userInvitesTable.fetchByCode(inviteCode)) {
        throw new RouterError('This invite code is already in use.', 409);
      }

      const user = this.db.usersTable.insertUser({
        role,
        name,
      });

      return this.db.userInvitesTable.insertInvite(user.id, inviteCode, fromName);
    });
  }

  public regenerateInvite(role: Role, args: { inviteCode: string; newInviteCode: string }): IUserInviteRecord {
    const inviteCode = args.inviteCode.trim();
    const newInviteCode = args.newInviteCode.trim();

    if (!inviteCode) {
      throw new RouterError('An invite code is required.');
    }
    if (!newInviteCode) {
      throw new RouterError('A new invite code is required.');
    }

    return this.db.transaction(() => {
      const invite = this.db.userInvitesTable.fetchByCode(inviteCode, role);
      if (!invite) {
        throw new RouterError('Invite not found', 404);
      }
      if (invite.lastClickedAt || invite.accountId || invite.authAccountId) {
        throw new RouterError('This invite link has already been opened.', 409);
      }
      if (this.db.userInvitesTable.fetchByCode(newInviteCode)) {
        throw new RouterError('This invite code is already in use.', 409);
      }

      const updatedInvite = this.db.userInvitesTable.updateInviteCode(invite.id, newInviteCode);
      if (!updatedInvite) {
        throw new RouterError('Invite not found', 404);
      }
      return updatedInvite;
    });
  }

  public claimInvite(args: {
    role: Role;
    inviteCode: string;
    accountId: string;
    inviteSignature: string;
    authBinding: IRouterAuthAccountBinding;
    authBindingSignature: string;
  }): IUserInviteRecord | null {
    const { role } = args;
    const { authBinding } = args;
    const trimmedAuthAccountId = authBinding.authAccountId.trim();
    const trimmedInviteCode = args.inviteCode.trim();
    const trimmedAccountId = args.accountId.trim();
    const trimmedInviteSignature = args.inviteSignature.trim();
    const trimmedAuthBindingSignature = args.authBindingSignature.trim();

    if (!trimmedAccountId) {
      throw new RouterError('An account id is required.');
    }
    if (!trimmedAuthAccountId) {
      throw new RouterError('An auth account id is required.');
    }
    if (!trimmedInviteSignature) {
      throw new RouterError('An invite signature is required.');
    }
    if (!trimmedAuthBindingSignature) {
      throw new RouterError('An auth binding signature is required.');
    }
    if (authBinding.expiresAt <= Date.now()) {
      throw new RouterError('The auth binding signature has expired.', 403);
    }
    if (
      authBinding.role !== role ||
      authBinding.inviteCode !== trimmedInviteCode ||
      authBinding.accountId !== trimmedAccountId ||
      authBinding.authAccountId !== trimmedAuthAccountId
    ) {
      throw new RouterError('The auth binding does not match this invite.', 403);
    }

    const invite = this.db.userInvitesTable.fetchByCode(trimmedInviteCode, role);
    if (!invite) {
      return null;
    }
    if (
      !InviteCodes.verifyOpen({
        inviteCode: trimmedInviteCode,
        role,
        accountId: trimmedAccountId,
        signature: trimmedInviteSignature,
      })
    ) {
      throw new RouterError('The invite signature is invalid.', 403);
    }
    if (invite.accountId && invite.accountId !== trimmedAccountId) {
      throw new RouterError('This invite is already claimed by a different account.', 409);
    }
    if (!verifyRouterAuthAccountBinding(authBinding, trimmedAuthBindingSignature)) {
      throw new RouterError('The auth binding signature is invalid.', 403);
    }

    return this.db.userInvitesTable.claimInvite(invite.id, trimmedAccountId, trimmedAuthAccountId);
  }

  public deleteInvitedUser(userId: number): void {
    this.db.transaction(() => {
      this.db.userInvitesTable.deleteByUserId(userId);
      this.db.usersTable.deleteById(userId);
    });
  }
}
