import {
  getObjectStringProperty,
  JsonExt,
  type IEthereumGatewayCatchUpRequest,
  type IEthereumGatewayCatchUpResponse,
  type IEthereumGatewayRelayStatus,
} from '@argonprotocol/apps-core';
import type {
  IActivateBitcoinLockCouponRequest,
  IBitcoinLockCouponStatus,
  IBitcoinLockRelayJobRequest,
  ICreateBitcoinLockCouponRequest,
  IRouterErrorResponse,
} from './interfaces/index.ts';
import { RouterError } from './RouterError.ts';

export class BotUpstreamClient {
  constructor(private readonly botInternalUrl: string) {}

  public async createCoupon(request: ICreateBitcoinLockCouponRequest): Promise<IBitcoinLockCouponStatus> {
    return await this.request('/bitcoin-lock-coupons', {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: JsonExt.stringify(request),
    });
  }

  public async activateLatestCoupon(request: IActivateBitcoinLockCouponRequest): Promise<IBitcoinLockCouponStatus> {
    return await this.request('/bitcoin-lock-coupons/activate', {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: JsonExt.stringify(request),
    });
  }

  public async initializeCoupon(
    offerCode: string,
    request: IBitcoinLockRelayJobRequest,
  ): Promise<IBitcoinLockCouponStatus> {
    return await this.request('/bitcoin-lock-coupons/initialize', {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: JsonExt.stringify({
        ...request,
        offerCode,
      }),
    });
  }

  public async getCoupon(offerCode: string): Promise<IBitcoinLockCouponStatus> {
    return await this.request(`/bitcoin-lock-coupons/${encodeURIComponent(offerCode)}`);
  }

  public async listCoupons(): Promise<IBitcoinLockCouponStatus[]> {
    return await this.request('/bitcoin-lock-coupons');
  }

  public async listCouponsByUserId(userId: number): Promise<IBitcoinLockCouponStatus[]> {
    return await this.request(`/bitcoin-lock-coupons/by-user/${encodeURIComponent(String(userId))}`);
  }

  public async listLatestCouponsByUserId(): Promise<Map<number, IBitcoinLockCouponStatus>> {
    const couponsByUserId = new Map<number, IBitcoinLockCouponStatus>();

    for (const coupon of await this.listCoupons()) {
      if (!couponsByUserId.has(coupon.coupon.userId)) {
        couponsByUserId.set(coupon.coupon.userId, coupon);
      }
    }

    return couponsByUserId;
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
