import type { ArgonClient } from '@argonprotocol/mainchain';
import type { BlockWatch } from './BlockWatch.js';
import { createTypedEventEmitter } from './utils.js';

export class MainchainCompat {
  public static active?: MainchainCompat;

  public static get bondFullCapacityPerFrame(): boolean {
    return MainchainCompat.active?.bondFullCapacityPerFrame ?? false;
  }

  public bondFullCapacityPerFrame = false;

  public events = createTypedEventEmitter<{
    changed: (bondFullCapacityPerFrame: boolean) => void;
  }>();

  private loadPromise?: Promise<void>;
  private unsubscribeBestBlocks?: () => void;

  constructor(private readonly blockWatch: BlockWatch) {
    MainchainCompat.active = this;
  }

  public async start(): Promise<void> {
    this.loadPromise ??= this.startInternal().catch(error => {
      this.loadPromise = undefined;
      throw error;
    });
    return this.loadPromise;
  }

  public destroy(): void {
    this.unsubscribeBestBlocks?.();
    this.unsubscribeBestBlocks = undefined;
    this.loadPromise = undefined;

    if (MainchainCompat.active === this) {
      MainchainCompat.active = undefined;
    }
  }

  private async startInternal(): Promise<void> {
    await this.blockWatch.start();

    this.unsubscribeBestBlocks?.();
    this.unsubscribeBestBlocks = this.blockWatch.events.on('best-blocks', () => {
      this.refresh();
    });

    this.refresh();
  }

  private refresh(): void {
    const client = this.blockWatch.subscriptionClient;
    if (!client) {
      return;
    }

    const bondFullCapacityPerFrame = typeof client.query.treasury.pendingUnlocksByFrame === 'function';

    if (bondFullCapacityPerFrame === this.bondFullCapacityPerFrame) {
      return;
    }

    this.bondFullCapacityPerFrame = bondFullCapacityPerFrame;
    this.events.emit('changed', bondFullCapacityPerFrame);
  }
}

export function supportsBitcoinLockDelegateSetup(client: ArgonClient): boolean {
  return typeof client.tx.vaults.setBitcoinLockDelegate === 'function';
}
