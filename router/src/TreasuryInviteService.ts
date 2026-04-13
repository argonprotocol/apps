import type { Db } from './Db.ts';
import { RouterError } from './RouterError.ts';
import type { IUserInviteRecord } from './db/UserInvitesTable.ts';
import type { ITreasuryUserInviteCreateRequest } from './interfaces/index.ts';

const TREASURY_USER_ROLE = 'treasury_user' as const;

export class TreasuryInviteService {
  constructor(private readonly db: Db) {}

  public createInvite(args: ITreasuryUserInviteCreateRequest): IUserInviteRecord {
    if (typeof args.fromName !== 'string') {
      throw new RouterError('A vault name is required to create an invite.');
    }

    const name = args.name.trim();
    const fromName = args.fromName.trim();
    const inviteCode = args.inviteCode.trim();

    if (args.expiresAfterTicks <= 0) {
      throw new RouterError('Invite expiry must be greater than zero.');
    }
    if (args.vaultId <= 0) {
      throw new RouterError('A vault is required to create an invite.');
    }
    if (!fromName) {
      throw new RouterError('A vault name is required to create an invite.');
    }

    return this.db.transaction(() => {
      if (this.db.userInvitesTable.fetchByCode(inviteCode)) {
        throw new RouterError('This invite code is already in use.', 409);
      }

      const user = this.db.usersTable.insertUser({
        role: TREASURY_USER_ROLE,
        name,
      });

      return this.db.userInvitesTable.insertInvite(user.id, inviteCode, fromName);
    });
  }

  public openInvite(inviteCode: string, accountId: string): IUserInviteRecord | null {
    const trimmedInviteCode = inviteCode.trim();
    const trimmedAccountId = accountId.trim();

    if (!trimmedAccountId) {
      throw new RouterError('An account id is required.');
    }

    const invite = this.db.userInvitesTable.fetchByCode(trimmedInviteCode, TREASURY_USER_ROLE);
    if (!invite) {
      return null;
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
