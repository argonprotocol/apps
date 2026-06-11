import {
  getObjectStringProperty,
  InviteCodes,
  fetch,
  type IEthereumGatewayCatchUpRequest,
  type IEthereumGatewayCatchUpResponse,
  JsonExt,
  signRouterAuthAccountBinding,
  UserRole,
} from '@argonprotocol/apps-core';
import type { KeyringPair } from '@argonprotocol/mainchain';
import type {
  BitcoinLockRelayStatus,
  IBitcoinLockCouponStatus,
  IBitcoinLockStatusResponse,
  IInitializeBitcoinLockRequest,
  IListBitcoinLockCouponsResponse,
  IOpenOperationalInviteResponse,
  IOpenTreasuryInviteResponse,
  IOperationalUserInvite,
  IRouterErrorResponse,
  ITreasuryUserInvite,
} from '@argonprotocol/apps-router';
import type { BootstrapType, IConfig, IConfigServerDetails, IOperationalReferral } from '../interfaces/IConfig.ts';
import {
  RequestStatusError,
  isUnauthenticatedServerAuthError,
  type ServerAuthClient,
  type ServerAuthOptions,
} from './ServerAuthClient.ts';
import type { WalletKeys } from './WalletKeys.ts';

type ServerInviteDetails = Pick<IConfigServerDetails, 'ipAddress' | 'gatewayPort'>;
type UpstreamOperatorInviteWalletKeys = Pick<
  WalletKeys,
  'getLiquidLockingKeypair' | 'getOperationalKeypair' | 'getUpstreamOperatorAuthKeypair'
>;
type UpstreamOperatorSessionAuth = {
  getSessionId: () => Promise<string>;
  invalidateSessionId: () => Promise<void>;
};

const BOOTSTRAP_LOADING_HOST = 'loading';

export class UpstreamOperatorClient {
  constructor(
    private readonly serverAuthClient?: ServerAuthClient,
    private readonly getOperatorHost = (): string | undefined => undefined,
  ) {}

  public get operatorHost(): string | undefined {
    return this.getOperatorHost();
  }

  public getWebsocketUrl(path: string, sessionId?: string): string {
    return buildAuthenticatedUrl(this.requireOperatorHost(), path, sessionId).replace(/^http/i, 'ws');
  }

  public async getTreasurySessionId(options: ServerAuthOptions = {}): Promise<string> {
    const operatorHost = this.requireOperatorHost();
    if (!this.serverAuthClient) {
      throw new Error('No upstream operator auth client configured.');
    }

    return await this.serverAuthClient.getTreasurySessionId(operatorHost, options);
  }

  public async getOperationalSessionId(options: ServerAuthOptions = {}): Promise<string> {
    const operatorHost = this.requireOperatorHost();
    if (!this.serverAuthClient) {
      throw new Error('No upstream operator auth client configured.');
    }

    return await this.serverAuthClient.getOperationalSessionId(operatorHost, options);
  }

  public static getBootstrapHost(bootstrapDetails: IConfig['bootstrapDetails']): string | undefined {
    if (!bootstrapDetails?.routerHost) return;

    const routerHost = normalizeOperatorHost(stripScheme(bootstrapDetails.routerHost));
    if (routerHost.toLowerCase() === BOOTSTRAP_LOADING_HOST) return;

    return `https://${routerHost}`;
  }

  public static getBootstrapDetails(
    operatorHost: string,
    type: BootstrapType,
  ): NonNullable<IConfig['bootstrapDetails']> {
    return {
      type,
      routerHost: normalizeOperatorHost(stripScheme(operatorHost)),
    };
  }

  public static getInviteEndpoint(serverDetails: ServerInviteDetails): { host: string; port: string } {
    return {
      host: normalizeOperatorHost(serverDetails.ipAddress),
      port: String(serverDetails.gatewayPort ?? 443),
    };
  }

  public static async claimTreasuryAppInvite(
    operatorHost: string,
    inviteSecret: string,
    walletKeys: UpstreamOperatorInviteWalletKeys,
  ): Promise<{ fromName: string; invite: ITreasuryUserInvite }> {
    const accountKeypair = await walletKeys.getLiquidLockingKeypair();
    const accountId = accountKeypair.address;
    const inviteCode = InviteCodes.getCode(inviteSecret);
    const inviteSignature = InviteCodes.signOpen(inviteSecret, UserRole.TreasuryUser, accountId);
    const auth = createInviteAuthBinding({
      role: UserRole.TreasuryUser,
      inviteCode,
      accountKeypair,
      authKeypair: await walletKeys.getUpstreamOperatorAuthKeypair(),
    });
    const body = await this.postJson<IOpenTreasuryInviteResponse>(
      operatorHost,
      `/treasury-users/${encodeURIComponent(inviteCode)}/open`,
      { accountId, inviteSignature, ...auth },
    );
    return {
      fromName: body.fromName,
      invite: body.invite,
    };
  }

  public static async claimOperationalInvite(
    operatorHost: string,
    inviteSecret: string,
    operationalReferral: IOperationalReferral,
    walletKeys: UpstreamOperatorInviteWalletKeys,
  ): Promise<{ fromName: string; invite: IOperationalUserInvite }> {
    const accountKeypair = await walletKeys.getOperationalKeypair();
    const accountId = accountKeypair.address;
    const inviteCode = InviteCodes.getCode(inviteSecret);
    const inviteSignature = InviteCodes.signOpen(inviteSecret, UserRole.OperationalPartner, accountId);
    const auth = createInviteAuthBinding({
      role: UserRole.OperationalPartner,
      inviteCode,
      accountKeypair,
      authKeypair: await walletKeys.getUpstreamOperatorAuthKeypair(),
    });
    const body = await this.postJson<IOpenOperationalInviteResponse>(
      operatorHost,
      `/operational-users/${encodeURIComponent(inviteCode)}/open`,
      { accountId, inviteSignature, ...auth, ...operationalReferral },
    );
    return {
      fromName: body.fromName,
      invite: body.invite,
    };
  }

  public async initializeBitcoinLock(
    offerCode: string,
    payload: IInitializeBitcoinLockRequest,
  ): Promise<IBitcoinLockCouponStatus & { status: BitcoinLockRelayStatus }> {
    const operatorHost = this.requireOperatorHost();
    const body = await this.requestWithSessionRetry(this.getTreasurySessionAuth(operatorHost), sessionId =>
      UpstreamOperatorClient.postJson<IBitcoinLockStatusResponse>(
        operatorHost,
        `/bitcoin-lock-coupons/${encodeURIComponent(offerCode)}/initialize`,
        payload,
        sessionId,
      ),
    );

    return body.bitcoinLock as IBitcoinLockCouponStatus & { status: BitcoinLockRelayStatus };
  }

  public async getBitcoinLockCoupons(accountId: string): Promise<IBitcoinLockCouponStatus[]> {
    const operatorHost = this.requireOperatorHost();
    const body = await this.requestWithSessionRetry(this.getTreasurySessionAuth(operatorHost), sessionId =>
      UpstreamOperatorClient.request<IListBitcoinLockCouponsResponse>(
        operatorHost,
        `/treasury-users/${encodeURIComponent(accountId)}/bitcoin-lock-coupons`,
        undefined,
        sessionId,
      ),
    );

    return body.bitcoinLockCoupons;
  }

  public async requestEthereumGatewayCatchUp(
    payload: IEthereumGatewayCatchUpRequest,
  ): Promise<IEthereumGatewayCatchUpResponse> {
    const operatorHost = this.requireOperatorHost();
    const serverAuthClient = this.serverAuthClient;
    if (!serverAuthClient) {
      throw new Error('No upstream operator auth client configured.');
    }

    let sessionAuth = this.getTreasurySessionAuth(operatorHost);
    try {
      await sessionAuth.getSessionId();
    } catch {
      sessionAuth = this.getOperationalSessionAuth(operatorHost);
    }

    return await this.requestWithSessionRetry(sessionAuth, sessionId =>
      UpstreamOperatorClient.request<IEthereumGatewayCatchUpResponse>(
        operatorHost,
        '/ethereum-relay-request',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JsonExt.stringify(payload),
        },
        sessionId,
      ),
    );
  }

  private requireOperatorHost(): string {
    const operatorHost = this.operatorHost;
    if (!operatorHost) {
      throw new Error('No upstream operator host configured.');
    }

    return operatorHost;
  }

  public static async getBitcoinLockStatus(operatorHost: string, offerCode: string): Promise<IBitcoinLockCouponStatus> {
    const body = await this.request<IBitcoinLockStatusResponse>(
      operatorHost,
      `/bitcoin-lock-coupons/${encodeURIComponent(offerCode)}`,
    );
    return body.bitcoinLock;
  }

  private static async request<T>(
    operatorHost: string,
    path: string,
    init?: RequestInit,
    sessionId?: string,
  ): Promise<T> {
    const response = await fetch(buildAuthenticatedUrl(operatorHost, path, sessionId), {
      ...init,
      headers: {
        ...(init?.headers as Record<string, string> | undefined),
      },
    });
    const rawBody = await response.text();
    let body: T | IRouterErrorResponse | string | undefined;
    if (rawBody) {
      try {
        body = JsonExt.parse<T | IRouterErrorResponse>(rawBody);
      } catch (error) {
        if (response.ok) throw error;
        body = rawBody;
      }
    }

    let responseError = getObjectStringProperty(body, 'error');
    if (!responseError && !response.ok && typeof body === 'string') {
      responseError = body;
    }

    if (!response.ok) {
      throw new RequestStatusError(
        responseError ?? `Upstream operator request failed (${response.status}).`,
        response.status,
      );
    }
    if (responseError) {
      throw new Error(responseError);
    }

    return body as T;
  }

  private static postJson<T>(operatorHost: string, path: string, payload: unknown, sessionId?: string): Promise<T> {
    return this.request<T>(
      operatorHost,
      path,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JsonExt.stringify(payload),
      },
      sessionId,
    );
  }

  private getTreasurySessionAuth(operatorHost: string): UpstreamOperatorSessionAuth {
    const serverAuthClient = this.serverAuthClient;
    if (!serverAuthClient) {
      throw new Error('No upstream operator auth client configured.');
    }

    return {
      getSessionId: () => serverAuthClient.getTreasurySessionId(operatorHost),
      invalidateSessionId: () => serverAuthClient.invalidateTreasurySessionId(operatorHost),
    };
  }

  private getOperationalSessionAuth(operatorHost: string): UpstreamOperatorSessionAuth {
    const serverAuthClient = this.serverAuthClient;
    if (!serverAuthClient) {
      throw new Error('No upstream operator auth client configured.');
    }

    return {
      getSessionId: () => serverAuthClient.getOperationalSessionId(operatorHost),
      invalidateSessionId: () => serverAuthClient.invalidateOperationalSessionId(operatorHost),
    };
  }

  private async requestWithSessionRetry<T>(
    sessionAuth: UpstreamOperatorSessionAuth,
    request: (sessionId: string) => Promise<T>,
  ): Promise<T> {
    let sessionId = await sessionAuth.getSessionId();

    try {
      return await request(sessionId);
    } catch (error) {
      if (!isUnauthenticatedServerAuthError(error)) {
        throw error;
      }

      await sessionAuth.invalidateSessionId();
      sessionId = await sessionAuth.getSessionId();
      return await request(sessionId);
    }
  }
}

function buildAuthenticatedUrl(operatorHost: string, path: string, sessionId?: string): string {
  const url = `${operatorHost}${path.startsWith('/') ? path : `/${path}`}`;
  if (!sessionId) {
    return url;
  }

  const authenticatedUrl = new URL(url);
  authenticatedUrl.searchParams.set('sessionId', sessionId);
  return authenticatedUrl.toString();
}

function stripScheme(value: string): string {
  return value.trim().replace(/^[a-z]+:\/\//i, '');
}

function normalizeOperatorHost(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return trimmed;

  if (trimmed === '127.0.0.1' || trimmed === '::1' || trimmed === '[::1]') {
    return 'localhost';
  }

  if (trimmed.startsWith('127.0.0.1:')) {
    return `localhost:${trimmed.slice('127.0.0.1:'.length)}`;
  }

  if (trimmed.startsWith('[::1]:')) {
    return `localhost:${trimmed.slice('[::1]:'.length)}`;
  }

  return trimmed;
}

function createInviteAuthBinding(args: {
  role: UserRole;
  inviteCode: string;
  accountKeypair: KeyringPair;
  authKeypair: KeyringPair;
}): {
  authAccountId: string;
  authBindingExpiresAt: number;
  authBindingSignature: string;
} {
  const authBindingExpiresAt = Date.now() + 5 * 60_000;
  const binding = {
    role: args.role,
    accountId: args.accountKeypair.address,
    authAccountId: args.authKeypair.address,
    inviteCode: args.inviteCode,
    expiresAt: authBindingExpiresAt,
  };

  return {
    authAccountId: binding.authAccountId,
    authBindingExpiresAt,
    authBindingSignature: signRouterAuthAccountBinding(args.accountKeypair, binding),
  };
}
