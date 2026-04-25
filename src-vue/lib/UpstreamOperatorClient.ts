import { InviteCodes, JsonExt, signRouterAuthAccountBinding, UserRole } from '@argonprotocol/apps-core';
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
import type { ServerAuthClient, ServerAuthOptions } from './ServerAuthClient.ts';
import type { WalletKeys } from './WalletKeys.ts';

type ServerInviteDetails = Pick<IConfigServerDetails, 'ipAddress' | 'gatewayPort'>;
type UpstreamOperatorInviteWalletKeys = Pick<
  WalletKeys,
  'getLiquidLockingKeypair' | 'getOperationalKeypair' | 'getUpstreamOperatorAuthKeypair'
>;

export class UpstreamOperatorClient {
  constructor(
    private readonly serverAuthClient?: ServerAuthClient,
    private readonly getOperatorHost = (): string | undefined => undefined,
  ) {}

  public get operatorHost(): string | undefined {
    return this.getOperatorHost();
  }

  public getWebsocketUrl(path: string): string {
    return `${this.requireOperatorHost()}${path.startsWith('/') ? path : `/${path}`}`.replace(/^http/i, 'ws');
  }

  public async ensureTreasurySession(options: ServerAuthOptions = {}): Promise<void> {
    const operatorHost = this.requireOperatorHost();
    if (!this.serverAuthClient) {
      throw new Error('No upstream operator auth client configured.');
    }

    await this.serverAuthClient.ensureTreasurySession(operatorHost, options);
  }

  public async ensureOperationalSession(options: ServerAuthOptions = {}): Promise<void> {
    const operatorHost = this.requireOperatorHost();
    if (!this.serverAuthClient) {
      throw new Error('No upstream operator auth client configured.');
    }

    await this.serverAuthClient.ensureOperationalSession(operatorHost, options);
  }

  public static getBootstrapHost(bootstrapDetails: IConfig['bootstrapDetails']): string | undefined {
    if (!bootstrapDetails?.routerHost) return;

    return `https://${normalizeOperatorHost(stripScheme(bootstrapDetails.routerHost))}`;
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
    const body = await UpstreamOperatorClient.postJson<IBitcoinLockStatusResponse>(
      operatorHost,
      `/bitcoin-lock-coupons/${encodeURIComponent(offerCode)}/initialize`,
      payload,
      {
        serverAuthClient: this.serverAuthClient,
        treasuryAuth: true,
      },
    );
    return body.bitcoinLock as IBitcoinLockCouponStatus & { status: BitcoinLockRelayStatus };
  }

  public async getBitcoinLockCoupons(accountId: string): Promise<IBitcoinLockCouponStatus[]> {
    const operatorHost = this.requireOperatorHost();
    const body = await UpstreamOperatorClient.request<IListBitcoinLockCouponsResponse>(
      operatorHost,
      `/treasury-users/${encodeURIComponent(accountId)}/bitcoin-lock-coupons`,
      undefined,
      {
        serverAuthClient: this.serverAuthClient,
        treasuryAuth: true,
      },
    );
    return body.bitcoinLockCoupons;
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
    options: { serverAuthClient?: ServerAuthClient; treasuryAuth?: boolean } = {},
  ): Promise<T> {
    const shouldAuthenticate = !!options.serverAuthClient && !!options.treasuryAuth;
    if (options.serverAuthClient && options.treasuryAuth) {
      await options.serverAuthClient.ensureTreasurySession(operatorHost);
    }

    const response = await fetch(`${operatorHost}${path}`, {
      ...init,
      credentials: shouldAuthenticate ? 'include' : init?.credentials,
      headers: {
        ...(init?.headers as Record<string, string> | undefined),
      },
    });
    const rawBody = await response.text();
    const body = rawBody ? JsonExt.parse<T | IRouterErrorResponse>(rawBody) : undefined;
    const error =
      body != null && typeof body === 'object' && 'error' in body && typeof body.error === 'string'
        ? body.error
        : undefined;

    if (!response.ok || error) {
      throw new Error(error || `Upstream operator request failed (${response.status}).`);
    }

    return body as T;
  }

  private static postJson<T>(
    operatorHost: string,
    path: string,
    payload: unknown,
    options?: { serverAuthClient?: ServerAuthClient; treasuryAuth?: boolean },
  ): Promise<T> {
    return this.request<T>(
      operatorHost,
      path,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JsonExt.stringify(payload),
      },
      options,
    );
  }
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
