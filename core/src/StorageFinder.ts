import { type ArgonClient, getTickFromHeader } from '@argonprotocol/mainchain';
import { MainchainClients } from './MainchainClients.js';
import { NetworkConfig } from './NetworkConfig.js';

export class StorageFinder {
  public static async iterateFindStorageAddition(args: {
    client: ArgonClient;
    startingBlock: number;
    maxBlocksToCheck: number;
    storageKey: string;
  }): Promise<IBlockMeta & { blocksChecked: number[] }> {
    const { client, startingBlock, storageKey, maxBlocksToCheck } = args;
    const blocksChecked: number[] = [];
    let firstBlock = startingBlock;
    while (await this.checkIfStorageExists({ client, blockNumber: firstBlock, storageKey })) {
      firstBlock--;

      if (startingBlock - firstBlock > 100) {
        throw new Error(
          `StorageFinder cannot find a block within 100 blocks of ${startingBlock} where storage does not exist`,
        );
      }
    }
    for (let i = firstBlock; i < startingBlock + maxBlocksToCheck; i++) {
      const storageExists = await this.checkIfStorageExists({ client, blockNumber: i, storageKey });
      blocksChecked.push(i);
      if (storageExists) {
        const blockHash = await client.rpc.chain.getBlockHash(i);
        const header = await client.rpc.chain.getHeader(blockHash);
        const tick = getTickFromHeader(header)!;

        return {
          blocksChecked,
          blockNumber: i,
          blockHash,
          tick,
        };
      }
    }
    throw new Error(`StorageFinder cannot find storage added ${storageKey}`);
  }

  public static async binarySearchForStorageAddition(
    clients: MainchainClients,
    storageKey: string,
    oldestBlockNumber?: number,
  ): Promise<IBlockMeta & { blocksChecked: number[] }> {
    const name = 'StorageFinder';
    const client = await clients.archiveClientPromise;
    const currentBlock = await client.rpc.chain.getHeader();
    const valueExistsAtStart = await this.checkIfStorageExists({
      client,
      storageKey,
      blockHash: currentBlock.hash,
      blockNumber: currentBlock.number.toNumber(),
    });
    if (!valueExistsAtStart) {
      throw new Error('Storage not found');
    }
    let maxBlockNumberForExistence = currentBlock.number.toNumber();
    oldestBlockNumber ??= Math.max(0, maxBlockNumberForExistence - NetworkConfig.rewardTicksPerFrame * 365); // default to one year
    if (oldestBlockNumber > 0) oldestBlockNumber -= 1; // go one before to ensure we find the first block without storage
    // make sure it doesn't exist at the oldest block
    const existsAtOldest = await this.checkIfStorageExists({
      client,
      storageKey,
      blockNumber: oldestBlockNumber,
    });
    if (existsAtOldest) {
      throw new Error('Storage exists at the oldest block, cannot perform binary search');
    }
    // binary search to the first block where the storage exists
    let lowBlockNumberForExistence = oldestBlockNumber;
    const blocksChecked: number[] = [];
    while (lowBlockNumberForExistence < maxBlockNumberForExistence) {
      const mid = Math.floor((lowBlockNumberForExistence + maxBlockNumberForExistence) / 2);
      blocksChecked.push(mid);
      const exists = await this.checkIfStorageExists({ client, blockNumber: mid, storageKey });
      if (!exists) {
        lowBlockNumberForExistence = mid + 1; // doesn't exist, move up
      } else {
        maxBlockNumberForExistence = mid; // found present, move down
      }
    }
    const blockNumber = lowBlockNumberForExistence;
    const blockHash = await client.rpc.chain.getBlockHash(blockNumber);
    if (!blockHash) {
      throw new Error('Storage not found');
    }
    const header = await client.rpc.chain.getHeader(blockHash);
    console.log(`[${name}] Found in block ${blockNumber}`);
    const tick = getTickFromHeader(header)!;
    return {
      blocksChecked,
      blockHash,
      blockNumber,
      tick,
    };
  }

  public static async checkIfStorageExists(args: {
    client: ArgonClient;
    blockNumber: number;
    storageKey: string;
    blockHash?: Uint8Array;
  }): Promise<boolean> {
    const { client, blockNumber, storageKey, blockHash: givenBlockHash } = args;
    const blockHash = givenBlockHash ?? (await client.rpc.chain.getBlockHash(blockNumber));
    const size = await client.rpc.state.getStorageSize(storageKey, blockHash);
    return size.toNumber() > 0;
  }
}

interface IBlockMeta {
  blockHash: Uint8Array;
  blockNumber: number;
  tick: number;
}
