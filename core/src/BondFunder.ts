import BigNumber from 'bignumber.js';
import type { PalletTreasuryFunderState } from '@argonprotocol/mainchain';

import { compoundXTimes } from './utils.js';

export class BondFunder {
  public readonly accountId: string;
  public readonly isOwn: boolean;
  public readonly heldPrincipal: bigint;
  public readonly targetPrincipal: bigint;
  public readonly pendingReturnAmount: bigint;
  public readonly pendingReturnAtFrame: number | null;
  public readonly lifetimeCompoundedEarnings: bigint;
  public readonly lifetimePrincipalDeployed: bigint;
  public readonly lifetimePrincipalLastBasisFrame: number;

  constructor(accountId: string, raw: PalletTreasuryFunderState, isOwn: boolean) {
    this.accountId = accountId;
    this.isOwn = isOwn;
    this.heldPrincipal = raw.heldPrincipal.toBigInt();
    this.lifetimeCompoundedEarnings = raw.lifetimeCompoundedEarnings.toBigInt();
    this.lifetimePrincipalDeployed = raw.lifetimePrincipalDeployed.toBigInt();
    this.lifetimePrincipalLastBasisFrame = raw.lifetimePrincipalLastBasisFrame.toNumber();

    if ('pendingUnlockAmount' in raw) {
      this.pendingReturnAmount = raw.pendingUnlockAmount.toBigInt();
      this.pendingReturnAtFrame = raw.pendingUnlockAtFrame.isSome ? raw.pendingUnlockAtFrame.unwrap().toNumber() : null;
      this.targetPrincipal =
        this.heldPrincipal > this.pendingReturnAmount ? this.heldPrincipal - this.pendingReturnAmount : 0n;
    } else {
      // Old model compat: targetPrincipal existed before simplified bonds
      this.targetPrincipal = (raw as { targetPrincipal: { toBigInt(): bigint } }).targetPrincipal.toBigInt();
      this.pendingReturnAmount =
        this.heldPrincipal > this.targetPrincipal ? this.heldPrincipal - this.targetPrincipal : 0n;
      this.pendingReturnAtFrame = null;
    }
  }

  public get hasPendingReturn(): boolean {
    return this.pendingReturnAmount > 0n;
  }

  public getAPY(currentFrameId: number): number {
    const framesSinceBasis = Math.max(0, currentFrameId - this.lifetimePrincipalLastBasisFrame);
    const effectiveDeployed = this.lifetimePrincipalDeployed + this.heldPrincipal * BigInt(framesSinceBasis);
    if (effectiveDeployed <= 0n) return 0;

    const perFrameReturn = BigNumber(this.lifetimeCompoundedEarnings.toString())
      .dividedBy(effectiveDeployed.toString())
      .toNumber();

    return compoundXTimes(perFrameReturn, 365) * 100;
  }
}
