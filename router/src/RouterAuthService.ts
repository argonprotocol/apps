import type { NextFunction, Request, Response } from 'express';
import { nanoid } from 'nanoid';
import {
  type IRouterAuthChallenge,
  type RouterAuthRole,
  UserRole,
  verifyRouterAuthChallenge,
} from '@argonprotocol/apps-core';
import type { Db } from './Db.ts';
import type { IUserRecord } from './db/UsersTable.ts';
import { RouterError } from './RouterError.ts';
import type { IRouterAuthSessionRequest, IRouterAuthSessionResponse } from './interfaces/index.ts';

export interface IRouterAuthServiceOptions {
  db?: Db;
  adminOperatorAccountId?: string;
  sessionTtlSeconds?: number;
  challengeTtlMs?: number;
}

const DEFAULT_CHALLENGE_TTL_MS = 5 * 60 * 1000;
const DEFAULT_SESSION_TTL_SECONDS = 12 * 60 * 60;

export class RouterAuthService {
  private readonly challengesByNonce = new Map<string, IRouterAuthChallenge>();
  private readonly db?: Db;
  private readonly adminOperatorAccountId?: string;
  private readonly sessionCookieName: string;
  private readonly sessionTtlSeconds: number;
  private readonly challengeTtlMs: number;

  constructor(options: IRouterAuthServiceOptions = {}) {
    this.db = options.db;
    this.adminOperatorAccountId = options.adminOperatorAccountId?.trim() || undefined;
    this.sessionCookieName = `argon_session_${this.adminOperatorAccountId}`;

    this.sessionTtlSeconds = options.sessionTtlSeconds ?? DEFAULT_SESSION_TTL_SECONDS;
    this.challengeTtlMs = options.challengeTtlMs ?? DEFAULT_CHALLENGE_TTL_MS;
    this.ensureAdminOperatorUser();
  }

  public get isEnabled(): boolean {
    return !!this.adminOperatorAccountId && !!this.db;
  }

  public pruneInactiveSessions(): void {
    this.db?.sessionsTable.deleteInactiveSessions();
  }

  public createChallenge(authAccountId: string, role: RouterAuthRole = UserRole.AdminOperator): IRouterAuthChallenge {
    this.assertEnabled();

    const trimmedAuthAccountId = authAccountId.trim();
    this.getUserForAuth(trimmedAuthAccountId, role);
    this.pruneExpiredChallenges();

    const challenge = {
      role,
      authAccountId: trimmedAuthAccountId,
      nonce: nanoid(),
      expiresAt: Date.now() + this.challengeTtlMs,
    };

    this.challengesByNonce.set(challenge.nonce, challenge);
    return challenge;
  }

  public createSession(request: IRouterAuthSessionRequest): IRouterAuthSessionResponse & { sessionId: string } {
    this.assertEnabled();

    const challenge = this.challengesByNonce.get(request.nonce);
    this.challengesByNonce.delete(request.nonce);

    if (!challenge || challenge.expiresAt <= Date.now()) {
      throw new RouterError('Login challenge expired. Please try again.', 401);
    }
    if (challenge.expiresAt !== request.expiresAt) {
      throw new RouterError('Login challenge does not match this request.', 401);
    }
    if (challenge.authAccountId !== request.authAccountId) {
      throw new RouterError('Login challenge does not match this auth account.', 401);
    }

    if (!verifyRouterAuthChallenge(challenge, request.signature)) {
      throw new RouterError('Login signature is invalid.', 403);
    }
    const user = this.getUserForAuth(challenge.authAccountId, challenge.role);

    const sessionId = nanoid();
    this.db!.sessionsTable.deleteInactiveSessions();

    const session = this.db!.sessionsTable.insertSession({
      sessionId,
      userId: user.id,
      expiresAt: new Date(Date.now() + this.sessionTtlSeconds * 1000),
    });

    return {
      sessionId,
      expiresAt: session.expiresAt.toISOString(),
      accountId: user.accountId!,
      role: user.role,
    };
  }

  public requireAdminOperator() {
    return (req: Request, res: Response, next: NextFunction) => {
      if (!this.isEnabled) {
        next();
        return;
      }

      const user = this.getRequestUser(req);
      if (!user) {
        sendAuthError(res);
        return;
      }
      if (user.role !== UserRole.AdminOperator || user.accountId !== this.adminOperatorAccountId) {
        res.status(403).send('Forbidden');
        return;
      }

      res.locals.authUserId = user.accountId;
      next();
    };
  }

  public requireTreasuryUserSession(req: Request, accountId: string): void {
    if (!this.isEnabled) return;

    const user = this.getRequestUser(req);
    if (!user) {
      throw new RouterError('Unauthorized', 401);
    }
    if (user.role !== UserRole.TreasuryUser || user.accountId !== accountId) {
      throw new RouterError('Forbidden', 403);
    }
  }

  public handleVerify(req: Request, res: Response, allowedRoles: readonly RouterAuthRole[]): void {
    if (!this.isEnabled) {
      res.status(503).send('Router auth is not configured.');
      return;
    }

    const user = this.getRequestUser(req);
    if (!user) {
      sendAuthError(res);
      return;
    }
    if (!allowedRoles.includes(user.role)) {
      res.status(403).send('Forbidden');
      return;
    }
    if (user.role === UserRole.AdminOperator && user.accountId !== this.adminOperatorAccountId) {
      res.status(403).send('Forbidden');
      return;
    }

    res.setHeader('X-User-Id', user.accountId!);
    res.setHeader('X-User-Role', user.role);
    res.sendStatus(204);
  }

  public setSessionCookie(res: Response, session: { sessionId: string }): void {
    const sessionId = encodeURIComponent(session.sessionId);

    res.setHeader(
      'Set-Cookie',
      `${this.sessionCookieName}=${sessionId}; HttpOnly; Secure; SameSite=None; Path=/; Max-Age=${this.sessionTtlSeconds}`,
    );
  }

  private getRequestUser(req: Request): IUserRecord | null {
    const sessionId = getCookie(req, this.sessionCookieName);
    if (!sessionId) return null;

    const session = this.db!.sessionsTable.fetchBySessionId(sessionId);
    if (!session) return null;
    if (session.revokedAt || session.expiresAt <= new Date()) {
      this.db!.sessionsTable.deleteInactiveSessions();
      return null;
    }

    this.db!.sessionsTable.touchLastSeen(session.id);
    return this.db!.usersTable.fetchById(session.userId);
  }

  private getUserForAuth(authAccountId: string, role: RouterAuthRole): IUserRecord {
    if (role !== UserRole.AdminOperator && !isInviteRole(role)) {
      throw new RouterError('This router auth role is not supported.', 400);
    }
    if (!authAccountId) {
      throw new RouterError('An auth account id is required.', 400);
    }
    if (role === UserRole.AdminOperator && authAccountId !== this.adminOperatorAccountId) {
      throw new RouterError('This account is not allowed to manage the router.', 403);
    }

    const user = this.db!.usersTable.fetchByAuthAccountId(authAccountId, role);
    if (!user) {
      throw new RouterError('This auth account is not allowed to access the router.', 403);
    }
    if (!user.accountId) {
      throw new RouterError('This auth account is not linked to a user account.', 403);
    }

    return user;
  }

  private ensureAdminOperatorUser(): void {
    if (!this.isEnabled) return;

    let user = this.db!.usersTable.fetchByAccountId(this.adminOperatorAccountId!, UserRole.AdminOperator);
    if (user?.authAccountId === this.adminOperatorAccountId) return;

    if (user?.authAccountId && user.authAccountId !== this.adminOperatorAccountId) {
      throw new RouterError('Admin operator auth account is misconfigured.', 500);
    }

    if (!user) {
      user = this.db!.usersTable.insertUser({
        role: UserRole.AdminOperator,
        name: 'Admin Operator',
      });
    }

    const updatedUser = this.db!.usersTable.claimAccount(
      user.id,
      this.adminOperatorAccountId!,
      this.adminOperatorAccountId!,
    );
    if (updatedUser?.authAccountId === this.adminOperatorAccountId) return;

    throw new RouterError('Unable to create the admin operator user.', 500);
  }

  private assertEnabled(): void {
    if (!this.isEnabled) {
      throw new RouterError('Router auth is not configured.', 503);
    }
  }

  private pruneExpiredChallenges(): void {
    const now = Date.now();
    for (const [nonce, challenge] of this.challengesByNonce) {
      if (challenge.expiresAt <= now) {
        this.challengesByNonce.delete(nonce);
      }
    }
  }
}

function getCookie(req: Request, name: string): string | null {
  const cookieHeader = req.headers.cookie;
  if (!cookieHeader) return null;

  for (const part of cookieHeader.split(';')) {
    const [key, ...valueParts] = part.trim().split('=');
    if (key === name) {
      return decodeURIComponent(valueParts.join('='));
    }
  }

  return null;
}

function sendAuthError(res: Response): void {
  res.status(401).send('Unauthorized');
}

function isInviteRole(role: unknown): role is UserRole {
  return role === UserRole.TreasuryUser || role === UserRole.OperationalPartner;
}
