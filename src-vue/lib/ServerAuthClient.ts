import {
  fetch,
  type IRouterAuthChallenge as IServerAuthChallenge,
  JsonExt,
  type RouterAuthRole as ServerAuthRole,
  signRouterAuthChallenge as signServerAuthChallenge,
  UserRole,
} from '@argonprotocol/apps-core';
import type { KeyringPair } from '@argonprotocol/mainchain';
import type { IRouterAuthSessionResponse as IServerAuthSessionResponse } from '@argonprotocol/apps-router';
import type { WalletKeys } from './WalletKeys.ts';

export type ServerAuthOptions = {
  forceVerify?: boolean;
};

type VerifiedServerSession = {
  sessionId: string;
  expiresAt: number;
};

export type ServerAuthWalletKeys = Pick<
  WalletKeys,
  'operationalAddress' | 'getOperationalKeypair' | 'getUpstreamOperatorAuthKeypair'
>;

export class RequestStatusError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
  }
}

export function isUnauthenticatedServerAuthError(error: unknown): boolean {
  if (!(error instanceof RequestStatusError)) return false;
  return error.status === 401 || error.status === 403;
}

const failedAuthRetryMs = 60_000;
const refreshSessionBeforeExpiryMs = 60_000;

export class ServerAuthClient {
  private failedAuthBySessionKey = new Map<string, { message: string; retryAfter: number }>();
  private sessionPromisesBySessionKey = new Map<string, Promise<VerifiedServerSession>>();
  private verifiedSessionsBySessionKey = new Map<string, VerifiedServerSession>();

  constructor(private readonly getWalletKeys: () => ServerAuthWalletKeys) {}

  public async getAdminOperatorSessionId(baseUrl: string, options: ServerAuthOptions = {}): Promise<string> {
    const walletKeys = this.getWalletKeys();
    const session = await this.ensureSession(
      baseUrl,
      walletKeys.operationalAddress,
      UserRole.AdminOperator,
      () => walletKeys.getOperationalKeypair(),
      options,
    );
    return session.sessionId;
  }

  public invalidateAdminOperatorSessionId(baseUrl: string): void {
    const walletKeys = this.getWalletKeys();
    const cacheKey = getCacheKey(baseUrl, walletKeys.operationalAddress, UserRole.AdminOperator);
    this.invalidateSession(cacheKey);
  }

  public async getMemberSessionId(baseUrl: string, options: ServerAuthOptions = {}): Promise<string> {
    const walletKeys = this.getWalletKeys();
    const authKeypair = await walletKeys.getUpstreamOperatorAuthKeypair();
    const session = await this.ensureSession(
      baseUrl,
      authKeypair.address,
      UserRole.Member,
      () => Promise.resolve(authKeypair),
      options,
    );
    return session.sessionId;
  }

  public async invalidateMemberSessionId(baseUrl: string): Promise<void> {
    const walletKeys = this.getWalletKeys();
    const authKeypair = await walletKeys.getUpstreamOperatorAuthKeypair();
    const cacheKey = getCacheKey(baseUrl, authKeypair.address, UserRole.Member);
    this.invalidateSession(cacheKey);
  }

  private async ensureSession(
    baseUrl: string,
    authAccountId: string,
    role: ServerAuthRole,
    getAuthKeypair: () => Promise<KeyringPair>,
    options: ServerAuthOptions,
  ): Promise<VerifiedServerSession> {
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
  ): Promise<VerifiedServerSession> {
    const failedAuth = this.failedAuthBySessionKey.get(cacheKey);
    if (failedAuth && failedAuth.retryAfter > Date.now()) {
      throw new Error(failedAuth.message);
    }
    this.failedAuthBySessionKey.delete(cacheKey);

    const cachedSession = this.verifiedSessionsBySessionKey.get(cacheKey);
    if (cachedSession && cachedSession.expiresAt - refreshSessionBeforeExpiryMs > Date.now()) {
      if (!options.forceVerify) {
        return cachedSession;
      }

      try {
        if (await verifySession(baseUrl, role, cachedSession.sessionId)) {
          return this.markSessionVerified(cacheKey, cachedSession.sessionId, cachedSession.expiresAt);
        }
      } catch {
        // Fall through to signing a fresh challenge below.
      }
    }
    this.invalidateSession(cacheKey);

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

      if (!(await verifySession(baseUrl, role, session.sessionId))) {
        throw new Error('Server auth session was not accepted.');
      }

      return this.markSessionVerified(cacheKey, session.sessionId, Date.parse(session.expiresAt));
    } catch (error) {
      if (shouldCacheAuthFailure(error)) {
        this.markAuthFailed(cacheKey, error);
      }
      throw error;
    }
  }

  private markSessionVerified(cacheKey: string, sessionId: string, expiresAt: number): VerifiedServerSession {
    this.failedAuthBySessionKey.delete(cacheKey);
    const session = {
      sessionId,
      expiresAt,
    };
    this.verifiedSessionsBySessionKey.set(cacheKey, session);
    return session;
  }

  private markAuthFailed(cacheKey: string, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.failedAuthBySessionKey.set(cacheKey, { message, retryAfter: Date.now() + failedAuthRetryMs });
  }

  private invalidateSession(cacheKey: string): void {
    this.failedAuthBySessionKey.delete(cacheKey);
    this.sessionPromisesBySessionKey.delete(cacheKey);
    this.verifiedSessionsBySessionKey.delete(cacheKey);
  }
}

function getCacheKey(baseUrl: string, authAccountId: string, role: ServerAuthRole): string {
  return `${baseUrl}:${authAccountId}:${role}`;
}

async function requestAuth<T>(url: string, payload: unknown): Promise<T | null> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JsonExt.stringify(payload),
  });
  const rawBody = await response.text();

  if (response.status === 503) return null;
  if (!response.ok) {
    const error = parseError(rawBody);
    throw new RequestStatusError(error || `Server auth request failed (${response.status}).`, response.status);
  }

  return JsonExt.parse<T>(rawBody);
}

function shouldCacheAuthFailure(error: unknown): boolean {
  if (error instanceof RequestStatusError) {
    return true;
  }

  if (!(error instanceof Error)) {
    return false;
  }

  return error.message === 'Server auth is not configured.';
}

async function verifySession(baseUrl: string, role: ServerAuthRole, sessionId: string): Promise<boolean> {
  const verifyUrl = new URL(`${baseUrl}${getVerifyPath(role)}`);
  verifyUrl.searchParams.set('sessionId', sessionId);

  const response = await fetch(verifyUrl, { cache: 'no-store' });

  return response.ok;
}

function getVerifyPath(role: ServerAuthRole): string {
  if (role === UserRole.AdminOperator) return '/auth/verify/admin';
  return '/auth/verify/member';
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
