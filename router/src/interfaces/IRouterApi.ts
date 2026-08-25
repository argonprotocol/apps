import type {
  BitcoinLockFeeCoupon,
  IOperationalAccessProof,
  IRouterAuthAccountBinding,
  IRouterAuthChallenge,
  RouterAuthRole,
  UserRole,
} from '@argonprotocol/apps-core';
import type { IBitcoinLockCouponRequest, IBitcoinLockCouponStatus } from './IBitcoinLockCoupon.js';

import type { ITreasuryUserInvite } from './ITreasuryUserInvite.js';

export const BITCOIN_FEE_COUPON_MINIMUM_DESKTOP_VERSION = '2.3.5';

export type IInitializeBitcoinLockRequest = IBitcoinLockCouponRequest;
export type InviteRole = UserRole;

export interface ICreateInviteRequest {
  name: string;
  fromName: string;
  vaultId: number;
  maxSatoshis: bigint;
  estimatedGiftUsd: number;
  feeCreditMicrogons?: bigint;
  btcPctFee?: number;
  expiresAfterTicks: number;
}

export type IRegenerateInviteRequest = Omit<ICreateInviteRequest, 'name' | 'fromName'>;

export interface IOpenInviteRequest {
  defaultAccountId: string;
  authAccountId: string;
  authBindingExpiresAt: number;
  authBindingSignature: string;
}

export interface IRequestOperationsUpgradeRequest {
  operationalAccountId: string;
  authBindingExpiresAt: number;
  authBindingSignature: string;
}

export interface IRequestOperationsUpgradeResponse {
  operationsUpgradeRequestedAt: Date;
}

export interface IMarkOperationsUpgradedRequest {
  signature: IOperationalAccessProof['signature'];
}

export interface IRouterAuthChallengeRequest {
  authAccountId: string;
  role?: RouterAuthRole;
  /** @deprecated Use restorePackageRevision. */
  hasRestorePackage?: boolean;
  restorePackageRevision?: string;
  knownBootstrapEndpointPubkey?: string;
}

export type IRouterAuthChallengeResponse = IRouterAuthChallenge & {
  restorePackageRequired: boolean;
};

export interface IRouterAuthSessionRequest extends IRouterAuthChallenge {
  signature: string;
  restorePackage?: string;
  accountBinding?: IRouterAuthAccountBinding & { signature: string };
}

export interface IRouterAuthSessionResponse {
  sessionId: string;
  expiresAt: string;
  accountId: string;
  role: RouterAuthRole;
  bootstrapEndpointSecret?: string;
  restore?: IListBitcoinLockCouponsResponse & {
    fromName: string;
    operatorAccountId: string;
    restorePackage: string;
    restorePackageRevision: string;
    hasOperationsAccess: boolean;
  };
}

export interface IRouterErrorResponse {
  error: string;
  code?: string;
  minimumDesktopVersion?: string;
}

export interface IInviteResponse {
  invite: ITreasuryUserInvite;
}

export interface IListInvitesResponse {
  invites: ITreasuryUserInvite[];
}

export interface IPreviewInviteResponse {
  maxSatoshis: bigint;
  estimatedGiftUsd: number;
  feeCreditMicrogons?: bigint;
  btcPctFee: number;
  expiresAfterTicks: number;
  expiresAt: Date;
  fromName: string;
}

export interface IListBitcoinLockCouponsResponse {
  bitcoinLockCoupons: IBitcoinLockCouponStatus[];
}

export interface IOpenInviteResponse {
  fromName: string;
  operatorAccountId: string;
  /** @deprecated Use operatorAccountId. */
  referrer: string;
  invite: ITreasuryUserInvite;
}

export interface IBitcoinLockStatusResponse {
  bitcoinLock: IBitcoinLockCouponStatus;
}

export interface IInitializeBitcoinLockResponse extends IBitcoinLockStatusResponse {
  execution: {
    type: 'FeeCoupon';
    requestId: string;
    feeCoupon: BitcoinLockFeeCoupon;
  };
}

export interface IBitcoinLockCouponUseUpdateRequest {
  status: 'Finalized' | 'Failed';
}

export interface IUpdateBitcoinLockCouponExpirationRequest {
  expiresAfterTicks: number;
}
