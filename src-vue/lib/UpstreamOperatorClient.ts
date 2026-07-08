import {
  getObjectStringProperty,
  fetch,
  type IEthereumGatewayCatchUpRequest,
  type IEthereumGatewayCatchUpResponse,
  JsonExt,
  signRouterAuthAccountBinding,
} from '@argonprotocol/apps-core';
import type { KeyringPair } from '@argonprotocol/mainchain';
import type {
  BitcoinLockRelayStatus,
  IBitcoinLockCouponStatus,
  IBitcoinLockStatusResponse,
  IInviteResponse,
  IInitializeBitcoinLockRequest,
  IListBitcoinLockCouponsResponse,
  IMemberInvite,
  IOpenInviteResponse,
  IRequestOperationsUpgradeRequest,
  IRequestOperationsUpgradeResponse,
  IRouterErrorResponse,
} from '@argonprotocol/apps-router';
import type { BootstrapType, IConfig, IConfigServerDetails } from '../interfaces/IConfig.ts';
import {
  RequestStatusError,
  isUnauthenticatedServerAuthError,
  type ServerAuthClient,
  type ServerAuthOptions,
} from './ServerAuthClient.ts';

type ServerInviteDetails = Pick<IConfigServerDetails, 'ipAddress' | 'gatewayPort'>;
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

  public async getMemberSessionId(options: ServerAuthOptions = {}): Promise<string> {
    const operatorHost = this.requireOperatorHost();
    if (!this.serverAuthClient) {
      throw new Error('No upstream operator auth client configured.');
    }

    return await this.serverAuthClient.getMemberSessionId(operatorHost, options);
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

  public static async claimInvite(args: {
    operatorHost: string;
    inviteCode: string;
    defaultAccountKeypair: KeyringPair;
    authKeypair: KeyringPair;
  }): Promise<{ fromName: string; referrer: string; invite: IMemberInvite }> {
    const body = await this.postJson<IOpenInviteResponse>(
      args.operatorHost,
      `/invites/${encodeURIComponent(args.inviteCode)}/open`,
      {
        defaultAccountId: args.defaultAccountKeypair.address,
        ...createRouterAuthBinding({
          inviteCode: args.inviteCode,
          defaultAccountKeypair: args.defaultAccountKeypair,
          authKeypair: args.authKeypair,
        }),
      },
    );

    return {
      fromName: body.fromName,
      referrer: body.referrer,
      invite: body.invite,
    };
  }

  public async initializeBitcoinLock(
    offerCode: string,
    payload: IInitializeBitcoinLockRequest,
  ): Promise<IBitcoinLockCouponStatus & { status: BitcoinLockRelayStatus }> {
    const operatorHost = this.requireOperatorHost();
    const body = await this.requestWithSessionRetry(this.getMemberSessionAuth(operatorHost), sessionId =>
      UpstreamOperatorClient.postJson<IBitcoinLockStatusResponse>(
        operatorHost,
        `/bitcoin-lock-coupons/${encodeURIComponent(offerCode)}/initialize`,
        payload,
        sessionId,
      ),
    );

    return body.bitcoinLock as IBitcoinLockCouponStatus & { status: BitcoinLockRelayStatus };
  }

  public async getBitcoinLockCoupons(): Promise<IBitcoinLockCouponStatus[]> {
    const operatorHost = this.requireOperatorHost();
    const body = await this.requestWithSessionRetry(this.getMemberSessionAuth(operatorHost), sessionId =>
      UpstreamOperatorClient.request<IListBitcoinLockCouponsResponse>(
        operatorHost,
        '/invites/me/bitcoin-lock-coupons',
        undefined,
        sessionId,
      ),
    );

    return body.bitcoinLockCoupons;
  }

  public async getMemberInvite(): Promise<IMemberInvite> {
    const operatorHost = this.requireOperatorHost();
    const body = await this.requestWithSessionRetry(this.getMemberSessionAuth(operatorHost), sessionId =>
      UpstreamOperatorClient.request<IInviteResponse>(operatorHost, '/invites/me', undefined, sessionId),
    );

    return body.invite;
  }

  public async requestOperationsUpgrade(args: {
    defaultAccountKeypair: KeyringPair;
    operationalAccountId: string;
    authKeypair: KeyringPair;
  }): Promise<Date> {
    const operatorHost = this.requireOperatorHost();
    const { authBindingExpiresAt, authBindingSignature } = createRouterAuthBinding({
      defaultAccountKeypair: args.defaultAccountKeypair,
      operationalAccountId: args.operationalAccountId,
      authKeypair: args.authKeypair,
    });
    const payload: IRequestOperationsUpgradeRequest = {
      operationalAccountId: args.operationalAccountId,
      authBindingExpiresAt,
      authBindingSignature,
    };
    const body = await this.requestWithSessionRetry(this.getMemberSessionAuth(operatorHost), sessionId =>
      UpstreamOperatorClient.request<IRequestOperationsUpgradeResponse>(
        operatorHost,
        '/invites/me/request-operations-upgrade',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JsonExt.stringify(payload),
        },
        sessionId,
      ),
    );

    return body.operationsUpgradeRequestedAt;
  }

  public async requestEthereumGatewayCatchUp(
    payload: IEthereumGatewayCatchUpRequest,
  ): Promise<IEthereumGatewayCatchUpResponse> {
    const operatorHost = this.requireOperatorHost();
    const serverAuthClient = this.serverAuthClient;
    if (!serverAuthClient) {
      throw new Error('No upstream operator auth client configured.');
    }

    return await this.requestWithSessionRetry(this.getMemberSessionAuth(operatorHost), sessionId =>
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

  private getMemberSessionAuth(operatorHost: string): UpstreamOperatorSessionAuth {
    const serverAuthClient = this.serverAuthClient;
    if (!serverAuthClient) {
      throw new Error('No upstream operator auth client configured.');
    }

    return {
      getSessionId: () => serverAuthClient.getMemberSessionId(operatorHost),
      invalidateSessionId: () => serverAuthClient.invalidateMemberSessionId(operatorHost),
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

function createRouterAuthBinding(args: {
  inviteCode?: string;
  defaultAccountKeypair: KeyringPair;
  operationalAccountId?: string;
  authKeypair: KeyringPair;
}): {
  authAccountId: string;
  authBindingExpiresAt: number;
  authBindingSignature: string;
} {
  const authBindingExpiresAt = Date.now() + 5 * 60_000;
  const binding = {
    accountId: args.defaultAccountKeypair.address,
    operationalAccountId: args.operationalAccountId,
    authAccountId: args.authKeypair.address,
    inviteCode: args.inviteCode,
    expiresAt: authBindingExpiresAt,
  };

  return {
    authAccountId: binding.authAccountId,
    authBindingExpiresAt,
    authBindingSignature: signRouterAuthAccountBinding(args.defaultAccountKeypair, binding),
  };
}
