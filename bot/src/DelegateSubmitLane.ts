import { SingleFileQueue } from '@argonprotocol/apps-core';
import { type ArgonClient, type KeyringPair } from '@argonprotocol/mainchain';

export class DelegateSubmitLane {
  public client!: ArgonClient;
  private nextNonce?: number;
  private readonly queue: SingleFileQueue;

  constructor(
    public readonly keypair: KeyringPair,
    queue = new SingleFileQueue(),
  ) {
    this.queue = queue;
  }

  public get address(): string {
    return this.keypair.address;
  }

  public invalidateNonce(): void {
    this.nextNonce = undefined;
  }

  public async runExclusive<T>(fn: (client: ArgonClient, getNonce: () => Promise<number>) => Promise<T>): Promise<T> {
    return await this.queue.add(async () => {
      const client = this.client;
      if (!client) {
        throw new Error('Delegate submit client is not ready.');
      }

      let nonce: number | undefined;
      const getNonce = async (): Promise<number> => {
        nonce ??= this.nextNonce ?? (await client.rpc.system.accountNextIndex(this.address)).toNumber();
        this.nextNonce = nonce + 1;
        return nonce;
      };

      try {
        return await fn(client, getNonce);
      } catch (error) {
        if (nonce !== undefined) {
          this.invalidateNonce();
        }
        throw error;
      }
    }).promise;
  }
}
