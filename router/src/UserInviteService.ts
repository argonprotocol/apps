import { InviteCodes } from '@argonprotocol/apps-core';
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

  public openInvite(role: Role, inviteCode: string, accountId: string, inviteSignature: string): IUserInviteRecord | null {
    const trimmedInviteCode = inviteCode.trim();
    const trimmedAccountId = accountId.trim();
    const trimmedInviteSignature = inviteSignature.trim();

    if (!trimmedAccountId) {
      throw new RouterError('An account id is required.');
    }
    if (!trimmedInviteSignature) {
      throw new RouterError('An invite signature is required.');
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

    return this.db.userInvitesTable.openInvite(invite.id, trimmedAccountId);
  }

  public deleteInvitedUser(userId: number): void {
    this.db.transaction(() => {
      this.db.userInvitesTable.deleteByUserId(userId);
      this.db.usersTable.deleteById(userId);
    });
  }
}
