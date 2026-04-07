import { JsonExt } from '@argonprotocol/apps-core';
import type {
  IBitcoinLockRelay,
  IBitcoinLockRelayResponse,
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
    inviteCode: string,
    payload: IInitializeBitcoinLockRequest,
  ): Promise<IBitcoinLockRelay> {
    const body = await this.request<IBitcoinLockRelayResponse>(
      operatorHost,
      `/treasury-users/${encodeURIComponent(inviteCode)}/initialize-bitcoin-lock`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JsonExt.stringify(payload),
      },
    );
    return body.relay;
  }

  public static async getBitcoinLockRelayStatus(
    operatorHost: string,
    inviteCode: string,
    relayId: number,
  ): Promise<IBitcoinLockRelay> {
    const body = await this.request<IBitcoinLockRelayResponse>(
      operatorHost,
      `/treasury-users/${encodeURIComponent(inviteCode)}/relays/${relayId}`,
    );
    return body.relay;
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
