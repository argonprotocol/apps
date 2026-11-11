import { decodeAddress } from '@argonprotocol/mainchain';
import { toHex, type Hex } from 'viem';
import type { ArgonQueryClient } from './MainchainClients.js';

/** Minimum ordinary transfer from Ethereum, in six-decimal runtime units. */
export const ETHEREUM_MIN_TRANSFER_AMOUNT = 10_000n;

export async function getLatestArgonFinalizedExecutionHeader(client: ArgonQueryClient): Promise<{
  blockHash: string;
  blockNumber: bigint;
}> {
  const hashQuery = client.query.ethereumVerifier.latestExecutionHeaderAnchorBlockHash();
  if (!hashQuery) throw new Error('Ethereum verifier storage is unavailable');

  const blockHash = await hashQuery;
  if (!blockHash) throw new Error('No Argon finalized execution header is available yet; wait for relayer sync');

  const headerQuery = client.query.ethereumVerifier.executionHeaderAnchors(blockHash);
  if (!headerQuery) throw new Error('Ethereum verifier storage is unavailable');

  const header = await headerQuery;
  if (!header) throw new Error(`Argon finalized execution header ${blockHash} is missing`);
  return { blockHash, blockNumber: header.blockNumber };
}

export function toArgonAccountIdHex(address: string): Hex {
  return toHex(decodeAddress(address), { size: 32 });
}
