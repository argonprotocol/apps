import { InviteCodes, JsonExt, UserRole } from '@argonprotocol/apps-core';
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
import type { IOperationalReferral } from '../interfaces/IConfig.ts';

export class UpstreamOperatorClient {
  public static async openTreasuryAppInvite(
    operatorHost: string,
    inviteSecret: string,
    accountId: string,
  ): Promise<{ fromName: string; invite: ITreasuryUserInvite }> {
    const inviteCode = InviteCodes.getCode(inviteSecret);
    const inviteSignature = InviteCodes.signOpen(inviteSecret, UserRole.TreasuryUser, accountId);
    const body = await this.postJson<IOpenTreasuryInviteResponse>(
      operatorHost,
      `/treasury-users/${encodeURIComponent(inviteCode)}/open`,
      { accountId, inviteSignature },
    );
    return {
      fromName: body.fromName,
      invite: body.invite,
    };
  }

  public static async openOperationalInvite(
    operatorHost: string,
    inviteSecret: string,
    accountId: string,
    operationalReferral: IOperationalReferral,
  ): Promise<{ fromName: string; invite: IOperationalUserInvite }> {
    const inviteCode = InviteCodes.getCode(inviteSecret);
    const inviteSignature = InviteCodes.signOpen(inviteSecret, UserRole.OperationalPartner, accountId);
    const body = await this.postJson<IOpenOperationalInviteResponse>(
      operatorHost,
      `/operational-users/${encodeURIComponent(inviteCode)}/open`,
      { accountId, inviteSignature, ...operationalReferral },
    );
    return {
      fromName: body.fromName,
      invite: body.invite,
    };
  }

  public static async initializeBitcoinLock(
    operatorHost: string,
    offerCode: string,
    payload: IInitializeBitcoinLockRequest,
  ): Promise<IBitcoinLockCouponStatus & { status: BitcoinLockRelayStatus }> {
    const body = await this.postJson<IBitcoinLockStatusResponse>(
      operatorHost,
      `/bitcoin-lock-coupons/${encodeURIComponent(offerCode)}/initialize`,
      payload,
    );
    return body.bitcoinLock as IBitcoinLockCouponStatus & { status: BitcoinLockRelayStatus };
  }

  public static async getBitcoinLockCoupons(
    operatorHost: string,
    accountId: string,
  ): Promise<IBitcoinLockCouponStatus[]> {
    const body = await this.request<IListBitcoinLockCouponsResponse>(
      operatorHost,
      `/treasury-users/${encodeURIComponent(accountId)}/bitcoin-lock-coupons`,
    );
    return body.bitcoinLockCoupons;
  }

  public static async getBitcoinLockStatus(operatorHost: string, offerCode: string): Promise<IBitcoinLockCouponStatus> {
    const body = await this.request<IBitcoinLockStatusResponse>(
      operatorHost,
      `/bitcoin-lock-coupons/${encodeURIComponent(offerCode)}`,
    );
    return body.bitcoinLock;
  }

  private static async request<T>(operatorHost: string, path: string, init?: RequestInit): Promise<T> {
    const baseUrl = `http://${operatorHost
      .trim()
      .replace(/^https?:\/\//i, '')
      .replace(/\/+$/, '')}`;
    const response = await fetch(`${baseUrl}${path}`, init);
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

  private static postJson<T>(operatorHost: string, path: string, payload: unknown): Promise<T> {
    return this.request<T>(operatorHost, path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JsonExt.stringify(payload),
    });
  }
}
