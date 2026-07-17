import type { ICertificationProgress, IOperationalAccessProof } from '@argonprotocol/apps-core';
import type { IUserInviteRecord } from '../db/UserInvitesTable.ts';
import type { IBitcoinLockCouponStatus } from './IBitcoinLockRelay.js';

export type IUserInvite = Omit<IUserInviteRecord, 'operationsAccessProofSignature'> & {
  accessProof?: IOperationalAccessProof;
};

export type IOperationalUserInvite = IUserInvite;

export interface IInviteVaultContribution {
  bitcoinAmount: bigint;
  bondAmount: bigint;
}

export type ITreasuryUserInvite = IUserInvite & {
  vaultId?: number;
  bitcoinLockCoupon?: IBitcoinLockCouponStatus;
  certificationProgress?: ICertificationProgress;
  vaultContribution?: IInviteVaultContribution;
};

export type IMemberInvite = ITreasuryUserInvite;
