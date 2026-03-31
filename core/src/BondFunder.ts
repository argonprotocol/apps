import type { PalletTreasuryFunderState } from '@argonprotocol/mainchain';

export class BondFunder {
  public readonly accountId: string;
  public readonly isOwn: boolean;
  public readonly heldPrincipal: bigint;
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
    } else {
      // Old model compat: targetPrincipal existed before simplified bonds
      const targetPrincipal = (raw as { targetPrincipal: { toBigInt(): bigint } }).targetPrincipal.toBigInt();
      this.pendingReturnAmount = this.heldPrincipal > targetPrincipal ? this.heldPrincipal - targetPrincipal : 0n;
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
    const perFrameReturn = Number(this.lifetimeCompoundedEarnings) / Number(effectiveDeployed);
    return (Math.pow(1 + perFrameReturn, 365) - 1) * 100;
  }
}
