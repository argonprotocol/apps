import type { Db } from './Db.ts';
import { RouterError } from './RouterError.ts';
import type { IUserInviteRecord } from './db/UserInvitesTable.ts';
import type { ITreasuryUserInviteCreateRequest } from './interfaces/index.ts';

const TREASURY_USER_ROLE = 'treasury_user' as const;

export class TreasuryInviteService {
  constructor(private readonly db: Db) {}

  public createInvite(args: ITreasuryUserInviteCreateRequest): IUserInviteRecord {
    const name = args.name.trim();
    const inviteCode = args.inviteCode.trim();

    if (args.expiresAfterTicks <= 0) {
      throw new RouterError('Invite expiry must be greater than zero.');
    }
    if (args.vaultId <= 0) {
      throw new RouterError('A vault is required to create an invite.');
    }

    const user = this.db.usersTable.insertUser({
      role: TREASURY_USER_ROLE,
      name,
    });

    return this.db.userInvitesTable.insertInvite(user.id, inviteCode);
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
}
