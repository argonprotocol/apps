import {
  getObjectStringProperty,
  JsonExt,
  type IEthereumGatewayCatchUpRequest,
  type IEthereumGatewayCatchUpResponse,
  type IEthereumGatewayRelayStatus,
  type ISignBitcoinLockFeeCouponRequest,
  type IBotStateStarting,
} from '@argonprotocol/apps-core';
import type { BitcoinLockFeeCoupon } from '@argonprotocol/mainchain';
import type { IRouterErrorResponse } from './interfaces/index.ts';
import { RouterError } from './RouterError.ts';

export class BotUpstreamClient {
  constructor(private readonly botInternalUrl: string) {}

  public async signBitcoinLockFeeCoupon(request: ISignBitcoinLockFeeCouponRequest): Promise<BitcoinLockFeeCoupon> {
    return await this.request('/bitcoin-lock-fee-coupons/sign', {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: JsonExt.stringify(request),
    });
  }

  public async requestEthereumGatewayCatchUp(
    request: IEthereumGatewayCatchUpRequest,
  ): Promise<IEthereumGatewayCatchUpResponse> {
    return await this.request('/ethereum-relay-request', {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: JsonExt.stringify(request),
    });
  }

  public async getEthereumGatewayRelayStatus(): Promise<IEthereumGatewayRelayStatus> {
    return await this.request('/ethereum-relay-status');
  }

  public async getSyncStatus(): Promise<Pick<IBotStateStarting, 'isReady' | 'isSyncing' | 'syncProgress'>> {
    return await this.request('/sync-status');
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetch(`${this.botInternalUrl}${path}`, init);
    const rawBody = await response.text();
    const body = rawBody ? JsonExt.parse<T | IRouterErrorResponse>(rawBody) : undefined;

    if (!response.ok) {
      const message = getObjectStringProperty(body, 'error') ?? 'Bot request failed.';
      throw new RouterError(message, response.status);
    }

    if (!body) {
      throw new RouterError('Bot request failed.', response.status || 500);
    }

    return body as T;
  }
}
