import { setTimeout as sleep } from 'node:timers/promises';
import { isUnreadableBlockError, raceWithTimeout, SingleFileQueue } from '@argonprotocol/apps-core';
import { type ArgonClient, type KeyringPair } from '@argonprotocol/mainchain';

const NONCE_STABILITY_BLOCKS = 2;
const NONCE_WAIT_TIMEOUT_MS = 10 * 60_000;

export class DelegateSubmitLane {
  public client!: ArgonClient;
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

  public async runExclusive<T>(fn: (client: ArgonClient, getNonce: () => Promise<number>) => Promise<T>): Promise<T> {
    return await this.queue.add(async () => {
      const client = this.client;
      if (!client) {
        throw new Error('Delegate submit client is not ready.');
      }

      let nonce: number | undefined;
      const getNonce = async (): Promise<number> => {
        const waitDeadline = Date.now() + NONCE_WAIT_TIMEOUT_MS;
        let lastObservation = 'no nonce snapshot was available';

        while (nonce === undefined && Date.now() < waitDeadline) {
          const remainingWaitMs = waitDeadline - Date.now();
          if (remainingWaitMs <= 0) break;

          try {
            const snapshot = await raceWithTimeout(
              (async () => {
                const bestBlockHeader = await client.rpc.chain.getHeader();
                const stableBlockNumber = Math.max(0, bestBlockHeader.number.toNumber() - NONCE_STABILITY_BLOCKS);
                const stableBlockHash = await client.rpc.chain.getBlockHash(stableBlockNumber);
                const stableClient = await client.at(stableBlockHash);
                const [account, nextIndex] = await Promise.all([
                  stableClient.query.system.account(this.address),
                  client.rpc.system.accountNextIndex(this.address),
                ]);
                return {
                  stableBlockNumber,
                  stableNonce: account.nonce.toNumber(),
                  poolNextIndex: nextIndex.toNumber(),
                };
              })(),
              remainingWaitMs,
              () => undefined,
            );
            if (!snapshot) break;

            const { stableBlockNumber, stableNonce, poolNextIndex } = snapshot;
            if (poolNextIndex === stableNonce) {
              nonce = stableNonce;
              break;
            }
            lastObservation =
              `stable block ${stableBlockNumber} nonce ${stableNonce}, ` +
              `transaction pool next index ${poolNextIndex}`;
          } catch (error) {
            if (!isUnreadableBlockError(error)) {
              console.error('[DelegateSubmitLane] Failed to read delegate nonce state', error);
              throw error;
            }
            lastObservation = `stable block state was unreadable: ${String(error)}`;
          }

          const remainingSleepMs = waitDeadline - Date.now();
          if (remainingSleepMs <= 0) break;
          await sleep(Math.min(1_000, remainingSleepMs));
        }

        if (nonce === undefined) {
          throw new Error(
            `Timed out after ${NONCE_WAIT_TIMEOUT_MS / 1_000}s waiting for delegate nonce to stabilize. ` +
              `Last observation: ${lastObservation}.`,
          );
        }
        return nonce;
      };

      return await fn(client, getNonce);
    }).promise;
  }
}
