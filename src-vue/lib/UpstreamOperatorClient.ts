import { JsonExt } from '@argonprotocol/apps-core';
import type {
  IBitcoinLockCouponStatus,
  IBitcoinLockStatusResponse,
  IInitializeBitcoinLockRequest,
  IOpenTreasuryInviteRequest,
  IOpenTreasuryInviteResponse,
  IRouterErrorResponse,
  ITreasuryUserInvite,
} from '@argonprotocol/apps-router';

export class UpstreamOperatorClient {
  public static async openTreasuryAppInvite(
    operatorHost: string,
    inviteCode: string,
    accountAddress: string,
  ): Promise<{ fromName: string; invite: ITreasuryUserInvite }> {
    const body = await this.request<IOpenTreasuryInviteResponse>(
      operatorHost,
      `/treasury-users/${encodeURIComponent(inviteCode)}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JsonExt.stringify({
          accountAddress,
        } satisfies IOpenTreasuryInviteRequest),
      },
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
  ): Promise<IBitcoinLockCouponStatus> {
    const body = await this.request<IBitcoinLockStatusResponse>(
      operatorHost,
      `/bitcoin-lock-coupons/${encodeURIComponent(offerCode)}/initialize`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JsonExt.stringify(payload),
      },
    );
    return body.bitcoinLock;
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
}
