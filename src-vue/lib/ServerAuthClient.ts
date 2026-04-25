import {
  JsonExt,
  type RouterAuthRole as ServerAuthRole,
  signRouterAuthChallenge as signServerAuthChallenge,
  type IRouterAuthChallenge as IServerAuthChallenge,
  UserRole,
} from '@argonprotocol/apps-core';
import type { KeyringPair } from '@argonprotocol/mainchain';
import type { IRouterAuthSessionResponse as IServerAuthSessionResponse } from '@argonprotocol/apps-router';
import type { WalletKeys } from './WalletKeys.ts';

export type ServerAuthOptions = {
  forceVerify?: boolean;
};

type VerifiedServerSession = {
  expiresAt: number;
  verifiedUntil: number;
};

export type ServerAuthWalletKeys = Pick<
  WalletKeys,
  'operationalAddress' | 'getOperationalKeypair' | 'getUpstreamOperatorAuthKeypair'
>;

const failedAuthRetryMs = 60_000;
const verifiedSessionTtlMs = 30_000;
const refreshSessionBeforeExpiryMs = 60_000;

export class ServerAuthClient {
  private failedAuthBySessionKey = new Map<string, { message: string; retryAfter: number }>();
  private sessionPromisesBySessionKey = new Map<string, Promise<void>>();
  private verifiedSessionsBySessionKey = new Map<string, VerifiedServerSession>();

  constructor(private readonly getWalletKeys: () => ServerAuthWalletKeys) {}

  public async ensureAdminOperatorSession(baseUrl: string, options: ServerAuthOptions = {}): Promise<void> {
    const walletKeys = this.getWalletKeys();
    await this.ensureSession(
      baseUrl,
      walletKeys.operationalAddress,
      UserRole.AdminOperator,
      () => walletKeys.getOperationalKeypair(),
      options,
    );
  }

  public async ensureTreasurySession(baseUrl: string, options: ServerAuthOptions = {}): Promise<void> {
    const walletKeys = this.getWalletKeys();
    const authKeypair = await walletKeys.getUpstreamOperatorAuthKeypair();
    await this.ensureSession(
      baseUrl,
      authKeypair.address,
      UserRole.TreasuryUser,
      () => Promise.resolve(authKeypair),
      options,
    );
  }

  public async ensureOperationalSession(baseUrl: string, options: ServerAuthOptions = {}): Promise<void> {
    const walletKeys = this.getWalletKeys();
    const authKeypair = await walletKeys.getUpstreamOperatorAuthKeypair();
    await this.ensureSession(
      baseUrl,
      authKeypair.address,
      UserRole.OperationalPartner,
      () => Promise.resolve(authKeypair),
      options,
    );
  }

  private async ensureSession(
    baseUrl: string,
    authAccountId: string,
    role: ServerAuthRole,
    getAuthKeypair: () => Promise<KeyringPair>,
    options: ServerAuthOptions,
  ): Promise<void> {
    const cacheKey = getCacheKey(baseUrl, authAccountId, role);
    const existingPromise = this.sessionPromisesBySessionKey.get(cacheKey);
    if (existingPromise) return existingPromise;

    const promise = this.runEnsureSession(baseUrl, authAccountId, role, getAuthKeypair, options, cacheKey);
    this.sessionPromisesBySessionKey.set(cacheKey, promise);

    try {
      return await promise;
    } finally {
      if (this.sessionPromisesBySessionKey.get(cacheKey) === promise) {
        this.sessionPromisesBySessionKey.delete(cacheKey);
      }
    }
  }

  private async runEnsureSession(
    baseUrl: string,
    authAccountId: string,
    role: ServerAuthRole,
    getAuthKeypair: () => Promise<KeyringPair>,
    options: ServerAuthOptions,
    cacheKey: string,
  ): Promise<void> {
    const failedAuth = this.failedAuthBySessionKey.get(cacheKey);
    if (failedAuth && failedAuth.retryAfter > Date.now()) {
      throw new Error(failedAuth.message);
    }
    this.failedAuthBySessionKey.delete(cacheKey);

    const cachedSession = this.verifiedSessionsBySessionKey.get(cacheKey);
    if (cachedSession && cachedSession.expiresAt - refreshSessionBeforeExpiryMs > Date.now()) {
      if (!options.forceVerify && cachedSession.verifiedUntil > Date.now()) {
        return;
      }

      try {
        if (await verifySession(baseUrl, role)) {
          this.markSessionVerified(cacheKey, cachedSession.expiresAt);
          return;
        }
      } catch {
        // Fall through to signing a fresh challenge below.
      }
    }
    this.verifiedSessionsBySessionKey.delete(cacheKey);

    try {
      const challenge = await requestAuth<IServerAuthChallenge>(`${baseUrl}/auth/challenge`, {
        role,
        authAccountId,
      });
      if (!challenge) {
        throw new Error('Server auth is not configured.');
      }

      const authKeypair = await getAuthKeypair();
      const session = await requestAuth<IServerAuthSessionResponse>(`${baseUrl}/auth/login`, {
        ...challenge,
        signature: signServerAuthChallenge(authKeypair, challenge),
      });
      if (!session) {
        throw new Error('Server auth session was not created.');
      }

      if (!(await verifySession(baseUrl, role))) {
        throw new Error('Server auth session was not accepted.');
      }

      this.markSessionVerified(cacheKey, Date.parse(session.expiresAt));
    } catch (error) {
      this.markAuthFailed(cacheKey, error);
      throw error;
    }
  }

  private markSessionVerified(cacheKey: string, expiresAt: number): void {
    this.failedAuthBySessionKey.delete(cacheKey);
    this.verifiedSessionsBySessionKey.set(cacheKey, {
      expiresAt,
      verifiedUntil: Date.now() + verifiedSessionTtlMs,
    });
  }

  private markAuthFailed(cacheKey: string, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.failedAuthBySessionKey.set(cacheKey, { message, retryAfter: Date.now() + failedAuthRetryMs });
  }
}

function getCacheKey(baseUrl: string, authAccountId: string, role: ServerAuthRole): string {
  return `${baseUrl}:${authAccountId}:${role}`;
}

async function requestAuth<T>(url: string, payload: unknown): Promise<T | null> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JsonExt.stringify(payload),
  });
  const rawBody = await response.text();

  if (response.status === 503) return null;
  if (!response.ok) {
    const error = parseError(rawBody);
    throw new Error(error || `Server auth request failed (${response.status}).`);
  }

  return JsonExt.parse<T>(rawBody);
}

async function verifySession(baseUrl: string, role: ServerAuthRole): Promise<boolean> {
  const response = await fetch(`${baseUrl}${getVerifyPath(role)}`, {
    credentials: 'include',
  });

  return response.ok;
}

function getVerifyPath(role: ServerAuthRole): string {
  if (role === UserRole.AdminOperator) return '/auth/verify/admin';
  if (role === UserRole.TreasuryUser) return '/auth/verify/treasury-coupon';
  return '/auth/verify/operational';
}

function parseError(rawBody: string): string | undefined {
  if (!rawBody) return;

  try {
    const body = JsonExt.parse<{ error?: unknown }>(rawBody);
    return typeof body.error === 'string' ? body.error : undefined;
  } catch {
    return rawBody;
  }
}
