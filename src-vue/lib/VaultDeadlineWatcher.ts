import { MiningFrames, type ArgonClient } from '@argonprotocol/apps-core';
import { getMainchainClient } from '../stores/mainchain.ts';

interface CollectFrame {
  frameId: number;
  uncollectedEarnings: bigint;
}

export interface VaultDeadlineState {
  pendingCollectRevenue: bigint;
  nextCollectDueDate: number;
  expiringCollectAmount: bigint;
}

export function computeCollectDeadline(args: {
  collectFrames: CollectFrame[];
  cosignDueFrames: Iterable<number | undefined>;
  currentFrameId: number;
  timeToCollectFrames: number;
}): { nextCollectFrame: number; expiringCollectAmount: bigint } {
  const { collectFrames, currentFrameId, timeToCollectFrames } = args;

  let nextCollectFrame = currentFrameId + timeToCollectFrames;
  let expiringCollectAmount = 0n;
  const oldestToCollectFrame = currentFrameId - timeToCollectFrames;

  for (const frame of collectFrames) {
    if (frame.uncollectedEarnings > 0n) {
      expiringCollectAmount = frame.uncollectedEarnings;
      nextCollectFrame = frame.frameId + timeToCollectFrames;
    }

    if (frame.frameId < oldestToCollectFrame) break;
  }

  let earliestCosignDueFrame = Number.MAX_SAFE_INTEGER;
  for (const dueFrame of args.cosignDueFrames) {
    if (dueFrame !== undefined) {
      earliestCosignDueFrame = Math.min(earliestCosignDueFrame, dueFrame);
    }
  }

  if (earliestCosignDueFrame < Number.MAX_SAFE_INTEGER) {
    nextCollectFrame = Math.min(nextCollectFrame, earliestCosignDueFrame);
  }

  nextCollectFrame = Math.max(currentFrameId + 1, nextCollectFrame);
  return { nextCollectFrame, expiringCollectAmount };
}

export class VaultDeadlineWatcher {
  private subscriptions: VoidFunction[] = [];
  private collectFrames: CollectFrame[] = [];
  private cosignDueFrames = new Map<number, number | undefined>();
  private currentFrameId = 0;
  private timeToCollectFrames = 0;
  private pendingCollectRevenue = 0n;

  constructor(
    private vaultId: number,
    private miningFrames: MiningFrames,
    private onChange: (state: VaultDeadlineState) => void,
  ) {}

  public async start(): Promise<void> {
    const client = await getMainchainClient(false);
    this.timeToCollectFrames = client.consts.vaults.revenueCollectionExpirationFrames.toNumber();

    await this.miningFrames.load();

    const sub1 = await client.query.miningSlot.nextFrameId(frameId => {
      this.currentFrameId = frameId.toNumber() - 1;
      this.emitState();
    });

    const sub2 = await client.query.vaults.revenuePerFrameByVault(this.vaultId, frameRevenues => {
      this.collectFrames = [...frameRevenues]
        .map(frameRevenue => ({
          frameId: frameRevenue.frameId.toNumber(),
          uncollectedEarnings: frameRevenue.uncollectedRevenue.toBigInt(),
        }))
        .sort((left, right) => right.frameId - left.frameId);
      this.pendingCollectRevenue = this.collectFrames.reduce((total, frame) => total + frame.uncollectedEarnings, 0n);
      this.emitState();
    });

    const sub3 = await client.query.vaults.pendingCosignByVaultId(this.vaultId, async rawUtxoIds => {
      await this.updateCosignDueFrames(client, rawUtxoIds);
      this.emitState();
    });

    const sub4 = await client.query.vaults.lastCollectFrameByVaultId(this.vaultId, () => this.emitState());

    this.subscriptions.push(sub1, sub2, sub3, sub4);
  }

  public stop(): void {
    for (const unsubscribe of this.subscriptions) {
      unsubscribe();
    }
    this.subscriptions = [];
  }

  private async updateCosignDueFrames(
    client: ArgonClient,
    rawUtxoIds: Iterable<{ toNumber(): number }>,
  ): Promise<void> {
    const newDueFrames = new Map<number, number | undefined>();

    for (const utxoId of rawUtxoIds) {
      const id = utxoId.toNumber();
      const releaseRaw = await client.query.bitcoinLocks.lockReleaseRequestsByUtxoId(id);
      const dueFrame = releaseRaw.isSome ? releaseRaw.unwrap().cosignDueFrame.toNumber() : this.cosignDueFrames.get(id);
      newDueFrames.set(id, dueFrame);
    }

    this.cosignDueFrames = newDueFrames;
  }

  private emitState(): void {
    const { nextCollectFrame, expiringCollectAmount } = computeCollectDeadline({
      collectFrames: this.collectFrames,
      cosignDueFrames: this.cosignDueFrames.values(),
      currentFrameId: this.currentFrameId,
      timeToCollectFrames: this.timeToCollectFrames,
    });

    const dueDateMs = this.miningFrames.getFrameDate(nextCollectFrame).getTime();

    this.onChange({
      pendingCollectRevenue: this.pendingCollectRevenue,
      nextCollectDueDate: dueDateMs,
      expiringCollectAmount,
    });
  }
}
